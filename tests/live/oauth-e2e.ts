/**
 * End-to-end test: OAuth credentials → spawn LS → Cascade chat → reply.
 *
 * Drives the same code path opencode does:
 *   resolveCredentials() → ensureLanguageServer() → streamChatGenerator(...)
 *
 * Reads the OAuth credentials file, talks to the cloud through *our* spawned
 * language_server (not Windsurf's), and prints the model's reply. The default
 * model is `claude-opus-4.7`; override via the CLI argv.
 *
 * Usage:
 *   bun run tests/live/oauth-e2e.ts                       # claude-opus-4.7
 *   bun run tests/live/oauth-e2e.ts gpt-5.5               # any single model
 *   bun run tests/live/oauth-e2e.ts all                   # all 6 README base models
 */

import { resolveCredentials } from '../../src/plugin/credentials-resolver.js';
import { streamChatGenerator } from '../../src/plugin/grpc-client.js';
import { stopLanguageServer } from '../../src/plugin/language-server-spawner.js';

const README_MODELS = [
  'claude-opus-4.7',
  'gpt-5.5',
  'deepseek-v4',
  'kimi-k2.6',
  'gemini-3.5-flash',
  'claude-opus-4.6',
];

async function runOne(model: string, attempt = 1): Promise<{ model: string; ok: boolean; reply: string; ms: number; err?: string }> {
  const t0 = Date.now();
  const prompt = `Reply with exactly: hi from ${model}`;
  // Force OAuth mode so we don't accidentally use the legacy scraper path.
  process.env.OPENCODE_WINDSURF_AUTH_MODE = 'oauth';
  try {
    const credentials = await resolveCredentials();
    const chunks: string[] = [];
    const gen = streamChatGenerator(credentials, {
      model,
      messages: [{ role: 'user', content: prompt }],
    });
    for await (const c of gen) chunks.push(c);
    const reply = chunks.join('').trim();
    return { model, ok: true, reply, ms: Date.now() - t0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < 2 && /Cascade session error/i.test(msg)) {
      // Transient: a fresh-spawned LS sometimes drops the very first call
      // while it finishes registering its panel state. One retry is usually
      // enough.
      return runOne(model, attempt + 1);
    }
    return { model, ok: false, reply: '', ms: Date.now() - t0, err: msg };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = argv[0] ?? 'claude-opus-4.7';
  const models = target === 'all' ? README_MODELS : [target];

  console.log(`[oauth-e2e] targets: ${models.join(', ')}`);
  console.log('');

  const results: Array<Awaited<ReturnType<typeof runOne>>> = [];
  for (const m of models) {
    process.stdout.write(`[${m}] … `);
    const r = await runOne(m);
    results.push(r);
    if (r.ok) {
      const oneLine = r.reply.replace(/\s+/g, ' ').slice(0, 80);
      console.log(`OK (${r.ms}ms) → ${oneLine}`);
    } else {
      console.log(`FAIL (${r.ms}ms): ${r.err}`);
    }
  }

  console.log('');
  const okCount = results.filter((r) => r.ok).length;
  console.log(`[oauth-e2e] ${okCount}/${results.length} models replied`);
  await stopLanguageServer();
  if (okCount !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error('[oauth-e2e] fatal:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
