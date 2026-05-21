/**
 * Windsurf Plugin for OpenCode
 * 
 * Enables using Windsurf/Codeium models through OpenCode by intercepting
 * requests and routing them through the local Windsurf language server.
 * 
 * Architecture:
 * 1. Plugin registers a custom fetch handler for windsurf.local domain
 * 2. Requests are transformed to gRPC format and sent to local language server
 * 3. Responses are streamed back in OpenAI-compatible SSE format
 * 
 * Requirements:
 * - Windsurf must be running (launches language_server_macos process)
 * - User must be logged into Windsurf (provides API key in ~/.codeium/config.json)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PluginInput, Hooks } from '@opencode-ai/plugin';
import type { Auth } from '@opencode-ai/sdk';

// File-based debug logger because opencode-darwin-arm64 swallows our
// console.error in some invocations (TUI takes over stderr). Set
// WINDSURF_PLUGIN_DEBUG=1 to enable; logs land in
// ~/.cache/opencode-windsurf-auth/plugin.log so they're easy to tail.
const debugLog = (() => {
  const enabled = !!process.env.WINDSURF_PLUGIN_DEBUG;
  const dir = path.join(os.tmpdir(), 'opencode-windsurf-auth-debug');
  let writeStream: fs.WriteStream | null = null;
  if (enabled) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `plugin.${process.pid}.log`);
      writeStream = fs.createWriteStream(p, { flags: 'a' });
      writeStream.write(`\n=== plugin loaded at ${new Date().toISOString()} pid=${process.pid} ===\n`);
    } catch { /* don't crash on log-init failure */ }
  }
  return {
    enabled,
    log(...args: unknown[]) {
      if (!enabled) return;
      const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n';
      try { writeStream?.write(line); } catch { /* ok */ }
      // Also mirror to stderr for the cases where opencode does pipe it.
      try { console.error(...args); } catch { /* */ }
    },
  };
})();
import { isWindsurfRunning, WindsurfCredentials, WindsurfError } from './plugin/auth.js';
import { resolveCredentials } from './plugin/credentials-resolver.js';
import { loadCredentials as loadOAuthCredentials } from './oauth/storage.js';
import type { ChatHistoryItem } from './cloud-direct/index.js';
import {
  getDefaultModel,
  getCanonicalModels,
  getModelVariants,
  resolveModel,
} from './plugin/models.js';
import { PLUGIN_ID } from './constants.js';

// ============================================================================
// Types
// ============================================================================

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  providerOptions?: Record<string, unknown>;
}

type ToolDef = NonNullable<ChatCompletionRequest['tools']>[number];

function extractVariantFromProviderOptions(providerOptions: Record<string, unknown> | undefined): string | undefined {
  if (!providerOptions) return undefined;
  const windsurfRaw = providerOptions['windsurf'];
  const windsurf =
    windsurfRaw && typeof windsurfRaw === 'object'
      ? (windsurfRaw as Record<string, unknown>)
      : undefined;
  const pickString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const candidate =
    pickString(windsurf?.['variant']) ??
    pickString(windsurf?.['variantID']) ??
    pickString(windsurf?.['variantId']) ??
    pickString(providerOptions['variant']) ??
    pickString(providerOptions['variantID']) ??
    pickString(providerOptions['variantId']);
  return candidate;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

// ============================================================================
// Response Helpers
// ============================================================================

/**
 * Create a streaming response. Cloud-direct only — every message routes through
 * `streamChatEvents`, which yields text / reasoning / tool_call deltas straight
 * from the Cognition cloud's GetChatMessage stream. We translate each event into
 * the @ai-sdk-compatible OpenAI SSE chunk shape (`delta.content`,
 * `delta.reasoning`, `delta.tool_calls`) opencode expects.
 */
function createStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);

  const abort = new AbortController();

  return new ReadableStream({
    async start(controller) {
      try {
        const resolved = resolveModel(requestedModel, variantOverride);

        const tools = (request.tools ?? []).map((t) => ({
          name: t.function?.name ?? 'unknown',
          description: t.function?.description ?? '',
          parameters: t.function?.parameters ?? {},
        }));

        const { streamChatEvents } = await import('./cloud-direct/index.js');
        // Cloud-direct accepts the FULL @ai-sdk multimodal content shape
        // (text + image_url parts). We pass `request.messages` straight
        // through; streamChatEvents → normalizeContent handles it.
        // The OpenAI request shape allows wider element shapes than
        // cloud-direct's ContentPart; normalizeContent re-validates server
        // side, so cast through the public ChatHistoryItem type.
        const multimodalMessages: ChatHistoryItem[] = request.messages.map((m) => ({
          role: m.role as ChatHistoryItem['role'],
          content: m.content as ChatHistoryItem['content'],
        }));
        let toolCallIndex = -1;
        let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null = null;
        let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;
        let firstChunkSent = false;
        const t0 = Date.now();
        debugLog.log(`[windsurf-plugin] streamChatEvents starting (model=${resolved.modelUid}, msgs=${multimodalMessages.length}, tools=${tools.length})`);
        let eventCount = 0;
        let textBytes = 0;
        // Thread the caller's `max_tokens` into the proto's
        // `CompletionConfiguration.max_output_tokens` (proto field #3).
        // Without this we used to ship a hardcoded 4096-token cap — way
        // below what swe-1.6 / gpt-5.5 / claude-opus-4.7 advertise (32K-128K
        // output) — which caused long agentic responses to silently
        // truncate before the model could write the final answer. The
        // model's reasoning would happily fill 4096 tokens and the visible
        // answer never arrived.
        //
        // Resolution order:
        //   1. `request.max_tokens` (opencode/ai-sdk side, set per call)
        //   2. 128_000 fallback — matches the catalog's `maxOutputTokens`
        //      for the most permissive models. The cloud clamps to the
        //      per-model limit anyway.
        const requestedMaxTokens =
          typeof request.max_tokens === 'number' && request.max_tokens > 0
            ? request.max_tokens
            : 128_000;
        for await (const ev of streamChatEvents({
          apiKey: credentials.apiKey,
          apiServerUrl: credentials.apiServerUrl,
          modelUid: resolved.modelUid,
          messages: multimodalMessages,
          tools: tools.length > 0 ? tools : undefined,
          signal: abort.signal,
          completionOpts: {
            maxOutputTokens: requestedMaxTokens,
          },
        })) {
          eventCount++;
          if (eventCount === 1) debugLog.log(`[windsurf-plugin] streamChatEvents first event after ${Date.now() - t0}ms (kind=${ev.kind})`);
          // @ai-sdk expects `delta.role: 'assistant'` on the *first* chunk
          // of an assistant turn. Inject it into whichever event arrives
          // first (text / tool_call_start / reasoning).
          const role = firstChunkSent ? undefined : 'assistant';
          if (ev.kind === 'text') {
            textBytes += ev.text.length;
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: role ? { role, content: ev.text } : { content: ev.text },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'reasoning') {
            // @ai-sdk supports `delta.reasoning` for Anthropic/OpenAI-o*
            // hidden CoT. opencode renders it in a collapsible block.
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: role ? { role, reasoning: ev.text } : { reasoning: ev.text },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'tool_call_start') {
            toolCallIndex += 1;
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    index: toolCallIndex,
                    id: ev.id,
                    type: 'function',
                    function: { name: ev.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            firstChunkSent = true;
          } else if (ev.kind === 'tool_call_args') {
            const chunk = {
              id: responseId,
              object: 'chat.completion.chunk' as const,
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: Math.max(0, toolCallIndex),
                    function: { arguments: ev.argsDelta },
                  }],
                },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (ev.kind === 'finish') {
            finishReason = ev.reason;
          } else if (ev.kind === 'usage') {
            usage = {
              promptTokens: ev.promptTokens,
              completionTokens: ev.completionTokens,
              totalTokens: ev.totalTokens,
            };
          }
        }
        const finalReason = finishReason ?? (toolCallIndex >= 0 ? 'tool_calls' : 'stop');
        debugLog.log(`[windsurf-plugin] streamChatEvents finished: ${eventCount} events, ${textBytes}B text, ${toolCallIndex + 1} tool_calls, reason=${finalReason}, usage=${usage ? JSON.stringify(usage) : 'none'}, total=${Date.now() - t0}ms`);

        // Per OpenAI streaming spec (`stream_options.include_usage: true`):
        //   1. Finish chunk: `choices: [{ index, delta: {}, finish_reason }]`
        //      (usage MUST NOT appear here)
        //   2. Usage chunk (separate, only when include_usage is on):
        //      `choices: []` and `usage: { prompt_tokens, completion_tokens, total_tokens }`
        //   3. `data: [DONE]`
        // @ai-sdk/openai-compatible reads both chunks and merges them.
        const finishChunk = {
          id: responseId,
          object: 'chat.completion.chunk' as const,
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));

        if (usage) {
          const usageChunk = {
            id: responseId,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [],
            usage: {
              prompt_tokens: usage.promptTokens ?? 0,
              completion_tokens: usage.completionTokens ?? 0,
              total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        // Mid-stream errors used to silently truncate the response: we'd
        // emit an `{error:{...}}` chunk and close, but never send
        // `data: [DONE]\n\n` and never send a finish_reason. @ai-sdk
        // would just hang or render an incomplete turn — looked like
        // "model started writing then stopped" to the user.
        //
        // Three things now happen on any mid-stream failure:
        //   1. emit an `{error:{...}}` data event so opencode's adapter can
        //      surface it,
        //   2. emit a synthetic finish chunk with `finish_reason: 'stop'`
        //      so the adapter resolves the stream as terminated (not stuck
        //      waiting for more deltas),
        //   3. emit `data: [DONE]\n\n` per OpenAI SSE spec.
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        debugLog.log(`[windsurf-plugin] streaming error: ${errorMessage}`);
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`),
          );
          const finishChunk = {
            id: responseId,
            object: 'chat.completion.chunk' as const,
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' as const }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch {
          /* controller already closed (e.g. via cancel) */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
}

/**
 * Create a non-streaming response by collecting every text event from the
 * cloud-direct stream into a single completion. opencode emits `stream: false`
 * for ancillary calls like title generation, so this path must stay working
 * even though the streaming path is the hot one.
 */
async function createNonStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);
  const resolved = resolveModel(requestedModel, variantOverride);

  const tools = (request.tools ?? []).map((t) => ({
    name: t.function?.name ?? 'unknown',
    description: t.function?.description ?? '',
    parameters: t.function?.parameters ?? {},
  }));

  const multimodalMessages: ChatHistoryItem[] = request.messages.map((m) => ({
    role: m.role as ChatHistoryItem['role'],
    content: m.content as ChatHistoryItem['content'],
  }));

  const { streamChatEvents } = await import('./cloud-direct/index.js');

  const requestedMaxTokens =
    typeof request.max_tokens === 'number' && request.max_tokens > 0
      ? request.max_tokens
      : 128_000;

  let collected = '';
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' = 'stop';
  let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null = null;

  for await (const ev of streamChatEvents({
    apiKey: credentials.apiKey,
    apiServerUrl: credentials.apiServerUrl,
    modelUid: resolved.modelUid,
    messages: multimodalMessages,
    tools: tools.length > 0 ? tools : undefined,
    completionOpts: {
      maxOutputTokens: requestedMaxTokens,
    },
  })) {
    if (ev.kind === 'text') {
      collected += ev.text;
    } else if (ev.kind === 'finish') {
      finishReason = ev.reason;
    } else if (ev.kind === 'usage') {
      usage = {
        promptTokens: ev.promptTokens,
        completionTokens: ev.completionTokens,
        totalTokens: ev.totalTokens,
      };
    }
    // Tool-call and reasoning events are intentionally dropped for the
    // non-streaming path — opencode only consumes the text payload from a
    // synchronous completion (e.g. title generation).
  }

  const created = Math.floor(Date.now() / 1000);
  const response: ChatCompletionResponse & { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: collected },
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) {
    response.usage = {
      prompt_tokens: usage.promptTokens ?? 0,
      completion_tokens: usage.completionTokens ?? 0,
      total_tokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
    };
  }
  return response;
}

// ============================================================================
// Local Proxy Server (like cursor-auth pattern)
// ============================================================================

const WINDSURF_PROXY_HOST = '127.0.0.1';
const WINDSURF_PROXY_DEFAULT_PORT = 42100;
/**
 * Bump when the proxy's request/response wire format changes so old squatter
 * proxies don't get reused by new opencode invocations. The `/health` endpoint
 * returns this; ensureWindsurfProxyServer refuses adoption on mismatch.
 */
const WINDSURF_PROXY_BUILD = 'cloud-direct.1';

/**
 * Per-process proxy registry slot. Stashed on `globalThis` so concurrent
 * plugin loads in the same Node/Bun process share one proxy server instead of
 * racing to bind the same port. `startup` holds the in-flight promise during
 * the initial bind so concurrent callers await the same outcome.
 */
interface ProxyRegistrySlot {
  baseURL: string;
  startup?: Promise<string>;
}
interface WindsurfPluginGlobals {
  __opencode_windsurf_proxy_server__?: ProxyRegistrySlot;
  /** Bun runtime detection — undefined under vanilla Node. */
  Bun?: { serve(opts: unknown): { port: number } };
}
const globals = globalThis as unknown as WindsurfPluginGlobals;

function getGlobalKey(): '__opencode_windsurf_proxy_server__' {
  return '__opencode_windsurf_proxy_server__';
}

function openAIError(status: number, message: string, details?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: details ? `${message}\n${details}` : message,
        type: 'windsurf_error',
        param: null,
        code: null,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

async function ensureWindsurfProxyServer(): Promise<string> {
  const key = getGlobalKey();

  // Return existing server URL if already started.
  const slot = globals[key];
  if (slot && typeof slot.baseURL === 'string' && slot.baseURL.length > 0) {
    return slot.baseURL;
  }
  // If a startup is in flight, share its promise so concurrent callers don't
  // race into duplicate Bun.serve() calls or split across two random ports.
  if (slot && slot.startup instanceof Promise) {
    return slot.startup;
  }

  const handler = async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);

      // Health check endpoint — includes a build marker so opencode can
      // detect whether the squatter on port 42100 is OUR version of the
      // plugin. Bump WINDSURF_PROXY_BUILD when shipping a wire-format
      // change; new invocations whose plugin code differs will refuse to
      // adopt the running proxy and bind a random port instead.
      if (url.pathname === '/health') {
        const hasOAuth = (() => {
          try { return loadOAuthCredentials() !== null; } catch { return false; }
        })();
        return new Response(
          JSON.stringify({
            ok: true,
            windsurf: isWindsurfRunning(),
            oauth: hasOAuth,
            build: WINDSURF_PROXY_BUILD,
            pid: process.pid,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Models endpoint
      if (url.pathname === '/v1/models' || url.pathname === '/models') {
        const models = getCanonicalModels();
        return new Response(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => {
              const variants = getModelVariants(id);
              return {
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'windsurf',
                ...(variants
                  ? {
                      variants: Object.entries(variants).map(([name, meta]) => ({
                        id: name,
                        description: meta.description,
                      })),
                    }
                  : {}),
              };
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Chat completions endpoint
      if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
        try {
          // resolveCredentials prefers OAuth (no Windsurf required) and falls
          // back to scraping the running Windsurf process. It throws a
          // descriptive WindsurfError if neither is available.
          const credentials = await resolveCredentials();
          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] mode=${credentials.cloudDirect ? 'cloud-direct' : 'local-ls'} api=${credentials.apiServerUrl ?? '(default)'}`);
          }
          const body = await req.json().catch(() => ({}));
          const requestBody = body as ChatCompletionRequest;
          const isStreaming = requestBody.stream === true;

          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] /v1/chat/completions: model=${requestBody.model} stream=${isStreaming} tools=${Array.isArray(requestBody.tools) ? requestBody.tools.length : 0} msgs=${requestBody.messages?.length ?? 0}`);
            for (const m of requestBody.messages ?? []) {
              const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              debugLog.log(`  msg[${m.role}] (${txt.length}B): ${txt.slice(0, 180).replace(/\n/g, '\\n')}`);
            }
            if (Array.isArray(requestBody.tools)) {
              const names = requestBody.tools.map((t: ToolDef) => t?.function?.name);
              debugLog.log(`  tool names (all ${names.length}): ${names.join(', ')}`);
              // Dump full tool definitions for the first 3 + any whose
              // parameters look suspicious ($ref / discriminator / oneOf)
              try {
                const dumpPath = path.join(os.tmpdir(), 'opencode-windsurf-auth-debug', 'tools-dump.json');
                fs.mkdirSync(path.dirname(dumpPath), { recursive: true });
                fs.writeFileSync(dumpPath, JSON.stringify(requestBody.tools, null, 2));
                debugLog.log(`  full tools dumped to ${dumpPath}`);
              } catch (e) {
                debugLog.log(`  tools dump failed: ${(e as Error).message}`);
              }
            }
          }

          if (debugLog.enabled) {
            debugLog.log(`[windsurf-plugin] cloudDirect=${credentials.cloudDirect}`);
            // Dump first 500 chars of every message so we can see what opencode actually sends
            for (const m of requestBody.messages ?? []) {
              const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              debugLog.log(`  msg[${m.role}]: ${txt.slice(0, 200)}`);
            }
          }

          if (isStreaming) {
            const stream = createStreamingResponse(credentials, requestBody);
            return new Response(stream, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              },
            });
          }

          const responseData = await createNonStreamingResponse(credentials, requestBody);
          return new Response(JSON.stringify(responseData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (chatError) {
          if (chatError instanceof WindsurfError) {
            // Auth/discovery failures are 401/503-ish, not 500 — surface them
            // with the same JSON shape so the OpenCode CLI prints something
            // actionable instead of a generic "Chat completion failed".
            return openAIError(503, chatError.message);
          }
          const errMsg = chatError instanceof Error ? chatError.message : String(chatError);
          return openAIError(500, 'Chat completion failed', errMsg);
        }
      }

      return openAIError(404, `Unsupported path: ${url.pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return openAIError(500, 'Proxy error', message);
    }
  };

  // Detect Bun and prefer Bun.serve when available (lower latency); fall back
  // to Node http.createServer otherwise so we run in vanilla Node hosts too.
  const bunServe = globals.Bun?.serve.bind(globals.Bun);
  const hasBunServe = typeof bunServe === 'function';

  const startup = (async (): Promise<string> => {
    if (debugLog.enabled) {
      debugLog.log(`[windsurf-plugin] ensureWindsurfProxyServer (hasBunServe=${hasBunServe})`);
    }
    // If another instance is already serving on the default port AND its
    // build marker matches our own, reuse it. Stale opencode-zombie procs
    // can otherwise pin port 42100 with old plugin code (e.g. without
    // cloud-direct support) and starve every subsequent invocation.
    try {
      const res = await fetch(
        `http://${WINDSURF_PROXY_HOST}:${WINDSURF_PROXY_DEFAULT_PORT}/health`,
      ).catch(() => null);
      if (res && res.ok) {
        try {
          const j = await res.json() as { build?: string; pid?: number };
          if (j.build === WINDSURF_PROXY_BUILD) {
            debugLog.log(`[windsurf-plugin] adopting compatible proxy (pid=${j.pid}, build=${j.build})`);
            return `http://${WINDSURF_PROXY_HOST}:${WINDSURF_PROXY_DEFAULT_PORT}/v1`;
          }
          debugLog.log(`[windsurf-plugin] refusing stale proxy build=${j.build} (ours=${WINDSURF_PROXY_BUILD}); will bind random port`);
        } catch {
          debugLog.log(`[windsurf-plugin] stale proxy /health unparsable; will bind random port`);
        }
      }
    } catch {
      /* ignore */
    }

    const startBunServer = (port: number) =>
      bunServe!({
        hostname: WINDSURF_PROXY_HOST,
        port,
        fetch: handler,
        // Cascade chat can go silent for >100s during slow-model thinking
        // before the first token. Bun's idleTimeout is capped at 255s; we
        // disable it (0 = no limit) since this is a localhost-only proxy.
        idleTimeout: 0,
      });

    const startNodeServer = (port: number): Promise<{ port: number }> =>
      new Promise((resolve, reject) => {
        // Node's http needs a slightly different handler — adapt our Request→Response
        // handler. We collect headers + body then re-wrap as a WHATWG Request.
        // Lazy-import to keep the module's top-level imports clean.
        import('http').then((nodeHttp) => {
          const srv = nodeHttp.createServer(async (req, res) => {
            try {
              const chunks: Buffer[] = [];
              await new Promise<void>((r) => req.on('data', (c) => chunks.push(Buffer.from(c))).on('end', r));
              const url = `http://${req.headers.host ?? WINDSURF_PROXY_HOST}${req.url ?? '/'}`;
              const headers = new Headers();
              for (const [k, v] of Object.entries(req.headers)) {
                if (typeof v === 'string') headers.set(k, v);
                else if (Array.isArray(v)) headers.set(k, v.join(', '));
              }
              const init: RequestInit = { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined };
              const r0 = new Request(url, init);
              const r1 = await handler(r0);
              res.statusCode = r1.status;
              r1.headers.forEach((v, k) => res.setHeader(k, v));
              if (r1.body) {
                const reader = r1.body.getReader();
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (value) res.write(Buffer.from(value));
                }
              } else {
                const txt = await r1.text();
                res.write(txt);
              }
              res.end();
            } catch (e) {
              try {
                res.statusCode = 500;
                res.end(`internal error: ${(e as Error).message}`);
              } catch { /* socket already dead */ }
            }
          });
          srv.on('error', reject);
          srv.listen(port, WINDSURF_PROXY_HOST, () => {
            const addr = srv.address();
            if (!addr || typeof addr === 'string') reject(new Error('bad node http address'));
            else resolve({ port: addr.port });
          });
        }).catch(reject);
      });

    const startServer = async (port: number): Promise<{ port: number }> => {
      if (hasBunServe) {
        debugLog.log(`[windsurf-plugin] calling Bun.serve port=${port}`);
        try {
          const s = startBunServer(port);
          debugLog.log(`[windsurf-plugin] Bun.serve returned, port=${s.port}`);
          return { port: s.port };
        } catch (e) {
          debugLog.log(`[windsurf-plugin] Bun.serve threw: ${(e as Error).message}`);
          throw e;
        }
      }
      debugLog.log(`[windsurf-plugin] using Node http server`);
      return startNodeServer(port);
    };

    try {
      const server = await startServer(WINDSURF_PROXY_DEFAULT_PORT);
      if (debugLog.enabled) {
        debugLog.log(`[windsurf-plugin] proxy listening on http://${WINDSURF_PROXY_HOST}:${server.port}/v1`);
      }
      return `http://${WINDSURF_PROXY_HOST}:${server.port}/v1`;
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      debugLog.log(`[windsurf-plugin] startServer threw: ${(error as Error).message}, code=${code}`);
      if (code !== 'EADDRINUSE') {
        // Always fall back to a random port rather than dying. Plugin not
        // loading kills the whole opencode session.
        try {
          const server = await startServer(0);
          debugLog.log(`[windsurf-plugin] fallback random port ${server.port}`);
          return `http://${WINDSURF_PROXY_HOST}:${server.port}/v1`;
        } catch (e2) {
          debugLog.log(`[windsurf-plugin] random-port fallback also failed: ${(e2 as Error).message}`);
          throw error;
        }
      }

      // EADDRINUSE — port 42100 squatted but neither us nor a fresh-build
      // peer. Bind a random port and inject that via chat.params.
      const server = await startServer(0);
      debugLog.log(`[windsurf-plugin] 42100 squatted; bound random port ${server.port}`);
      return `http://${WINDSURF_PROXY_HOST}:${server.port}/v1`;
    }
  })();

  globals[key] = { baseURL: '', startup };
  try {
    const baseURL = await startup;
    globals[key] = { baseURL };
    return baseURL;
  } catch (err) {
    delete globals[key];
    throw err;
  }
}

// ============================================================================
// Plugin Factory
// ============================================================================

// ChatParamsHook mirrors the opencode-plugin Hooks['chat.params'] signature
// (input + output shapes). We pull them off the public Hooks type so a future
// SDK bump automatically retypes us instead of silently drifting.
type ChatParamsHook = NonNullable<Hooks['chat.params']>;
type ChatParamsInput = Parameters<ChatParamsHook>[0];
type ChatParamsOutput = Parameters<ChatParamsHook>[1];

/**
 * Create the Windsurf plugin (follows cursor-auth pattern)
 */
export const createWindsurfPlugin =
  (providerId: string = PLUGIN_ID) =>
  async (context: PluginInput): Promise<Hooks> => {
    // PluginInput.client is the opencode-sdk OpencodeClient. We use it for
    // writing to opencode's auth.json store (mirror of antigravity's pattern).
    const { client } = context ?? ({} as PluginInput);
    // Start proxy server on plugin load
    const proxyBaseURL = await ensureWindsurfProxyServer();

    return {
      auth: {
        provider: providerId,

        /**
         * loader runs once at plugin load + whenever opencode wants to refresh
         * provider info. Two-way mirror with credentials.json:
         *
         *   - opencode auth has a key → mirror to credentials.json (if file is
         *     missing or stale)
         *   - opencode auth was CLEARED via `opencode auth logout windsurf` →
         *     clear credentials.json so we don't keep using a stale token
         *
         * The CLI flow (`npx opencode-windsurf-auth login`) doesn't touch
         * opencode's auth store, so we DON'T delete credentials.json just
         * because opencode's store happens to be empty — we check via the
         * `lastSyncedViaOpencode` marker.
         */
        async loader(getAuth: () => Promise<Auth>) {
          try {
            const auth = await getAuth();
            // Auth is OAuth | ApiAuth | WellKnownAuth — discriminate on .type
            // to pull the right field. Both ApiAuth and WellKnownAuth expose
            // `.key`; OAuth exposes `.access` (short-lived bearer).
            let opencodeKey: string | undefined;
            if (auth && typeof auth === 'object') {
              if (auth.type === 'oauth') opencodeKey = auth.access;
              else opencodeKey = auth.key;
            }
            const existing = (() => { try { return loadOAuthCredentials(); } catch { return null; } })();

            if (opencodeKey) {
              // opencode has a key. Sync into credentials.json if file is
              // missing or stale.
              if (!existing || existing.apiKey !== opencodeKey) {
                const { saveCredentials } = await import('./oauth/storage.js');
                const { DEFAULT_REGION } = await import('./oauth/types.js');
                await saveCredentials({
                  apiKey: opencodeKey,
                  name: existing?.name ?? 'opencode-auth-stored',
                  apiServerUrl: existing?.apiServerUrl ?? 'https://server.codeium.com',
                  issuedAt: new Date().toISOString(),
                  oauthClientId: DEFAULT_REGION.oauthClientId,
                  syncedViaOpencodeAuth: true,
                });
              }
            } else if (existing?.syncedViaOpencodeAuth) {
              // opencode-managed key was cleared (logout). Mirror that to
              // credentials.json so the chat path stops accepting it.
              const { deleteCredentials } = await import('./oauth/storage.js');
              deleteCredentials();
            }
            // (otherwise leave credentials.json alone — likely written by our
            // standalone CLI without opencode involvement.)
          } catch { /* loader must never throw */ }
          return {};
        },

        /**
         * `opencode auth login` enumerates these and shows them as choices
         * after the user picks the provider. The label is what opencode
         * renders next to the bullet point.
         */
        methods: [
          {
            type: 'oauth' as const,
            label: 'Sign in with Cognition (Windsurf)',
            async authorize() {
              // Two-stage: prepareLogin BINDS the loopback NOW and returns
              // the URL with the real port. Without this, our previous
              // implementation built the URL with port=0 (placeholder)
              // before binding, and opencode opened that broken URL —
              // user reported "Failed to authorize".
              const { prepareLogin } = await import('./oauth/login.js');
              const { saveCredentials } = await import('./oauth/storage.js');
              const { DEFAULT_REGION } = await import('./oauth/types.js');

              let prepared: Awaited<ReturnType<typeof prepareLogin>>;
              try {
                prepared = await prepareLogin({ region: DEFAULT_REGION });
              } catch (err) {
                debugLog.log('[windsurf-plugin] prepareLogin failed:', err instanceof Error ? err.message : err);
                // We have to return SOMETHING shaped like AuthOuathResult, so
                // surface the error via the callback.
                return {
                  url: 'https://windsurf.com/',
                  instructions: 'Failed to start loopback listener. Re-run `opencode auth login`.',
                  method: 'auto' as const,
                  callback: async () => ({ type: 'failed' as const }),
                };
              }

              return {
                url: prepared.url,
                instructions:
                  'A browser tab is opening on windsurf.com. Sign in with your Windsurf account; ' +
                  'this CLI is listening on a local port and will capture the token automatically.',
                method: 'auto' as const,
                async callback() {
                  // opencode swallows our thrown errors and prints a generic
                  // "Failed to authorize". Mirror the *cause* to a known
                  // tmpfile so the user can `cat` it after a failure without
                  // setting any env vars.
                  const errLogPath = path.join(os.tmpdir(), 'opencode-windsurf-auth-last-error.log');
                  const writeErr = (stage: string, err: unknown) => {
                    const detail =
                      err instanceof Error
                        ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
                        : String(err);
                    try {
                      fs.writeFileSync(
                        errLogPath,
                        `[${new Date().toISOString()}] stage=${stage}\n${detail}\n`,
                      );
                    } catch { /* ok */ }
                  };

                  try {
                    let result;
                    try {
                      result = await prepared.awaitToken();
                    } catch (err) {
                      writeErr('awaitToken', err);
                      throw err;
                    }
                    try {
                      await saveCredentials({
                        apiKey: result.apiKey,
                        name: result.name,
                        apiServerUrl: result.apiServerUrl,
                        redirectUrl: result.redirectUrl,
                        issuedAt: new Date().toISOString(),
                        oauthClientId: DEFAULT_REGION.oauthClientId,
                        syncedViaOpencodeAuth: true,
                      });
                    } catch (err) {
                      writeErr('saveCredentials', err);
                      throw err;
                    }
                    try { fs.unlinkSync(errLogPath); } catch { /* ok */ }
                    return {
                      type: 'success' as const,
                      key: result.apiKey,
                    };
                  } catch (err) {
                    debugLog.log('[windsurf-plugin] OAuth flow failed:', err instanceof Error ? err.message : err);
                    return { type: 'failed' as const };
                  }
                },
              };
            },
          },
        ],
      },

      // Dynamic baseURL injection (key pattern from cursor-auth)
      async 'chat.params'(input: ChatParamsInput, output: ChatParamsOutput) {
        if (input.model?.providerID !== providerId) {
          return;
        }

        // Inject the proxy server URL dynamically. `output.options` is typed
        // `Record<string, any>` on the Hooks side, but we only ever set two
        // string fields — keep the writes narrow.
        output.options = output.options || {};
        output.options.baseURL = proxyBaseURL;
        output.options.apiKey = output.options.apiKey || 'windsurf-local';
      },
    };
    // `client` is available for future direct auth.set/get operations.
    void client;
  };

/**
 * Default Windsurf plugin export. opencode discovers this via the default
 * export and registers a single provider with id `windsurf`. (We previously
 * also exported a CodeiumPlugin alias that registered a second provider id
 * `codeium`; that surfaced as a duplicate entry in `opencode auth login`'s
 * picker and has been removed.)
 */
export const WindsurfPlugin = createWindsurfPlugin();
