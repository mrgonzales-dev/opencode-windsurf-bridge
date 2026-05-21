/**
 * Direct cloud inference test: open the Devin Cloud ACP WebSocket at
 * wss://app.devin.ai/api/acp/live?token=<JWT> and walk through the ACP
 * JSON-RPC handshake to get a model reply. ZERO local language_server, ZERO
 * Windsurf binary involved (after this test confirms it works).
 *
 * Flow:
 *   1. open WS with `?token=<JWT>` (JWT = devin-session-token after stripping prefix)
 *   2. `initialize` — exchange protocol version + capabilities
 *   3. `session/new` { cwd, mcpServers: [] } — get a sessionId
 *   4. optionally `session/set_model` { sessionId, modelId: "CLAUDE_OPUS_4_7" }
 *   5. `session/prompt` { sessionId, prompt: [{type:"text", text:"hi"}] }
 *   6. receive streaming `session/update` notifications until `stopReason`
 */

import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const STATE_DB = path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'state.vscdb');

function getDevinJwt(): string {
  const row = execSync(`sqlite3 "${STATE_DB}" "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"`, { encoding: 'utf8' }).trim();
  const apiKey: string = JSON.parse(row).apiKey;
  if (!apiKey.startsWith('devin-session-token$')) {
    throw new Error(`apiKey doesn't have devin-session-token prefix: ${apiKey.slice(0, 30)}…`);
  }
  return apiKey.slice('devin-session-token$'.length);
}

type RpcId = number | string;
interface RpcRequest { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown }
interface RpcResponse { jsonrpc: '2.0'; id: RpcId; result?: any; error?: { code: number; message: string; data?: any } }
interface RpcNotification { jsonrpc: '2.0'; method: string; params?: any }

class AcpClient {
  private ws: WebSocket;
  private pending = new Map<RpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  public onNotification: (n: RpcNotification) => void = () => {};
  public onError: (e: Error) => void = () => {};

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('error', (err) => this.onError(err as Error));
    this.ws.on('message', (data) => {
      const text = data.toString('utf8');
      let msg: RpcResponse | RpcNotification;
      try { msg = JSON.parse(text); } catch (e) { console.error('[acp] bad JSON:', text); return; }
      if ('id' in msg && msg.id !== undefined) {
        // response
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if ('error' in msg && msg.error) waiter.reject(new Error(`RPC ${msg.id}: ${msg.error.message}`));
          else waiter.resolve(msg.result);
        } else {
          console.log('[acp] orphan response:', JSON.stringify(msg).slice(0, 200));
        }
      } else if ('method' in msg) {
        this.onNotification(msg);
      }
    });
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (e) => reject(e as Error));
      this.ws.once('close', (code, reason) => reject(new Error(`WS closed before open (code=${code}, reason=${reason})`)));
    });
  }

  async call<T = any>(method: string, params?: any): Promise<T> {
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(req));
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* */ }
  }
}

async function main(): Promise<void> {
  const jwt = getDevinJwt();
  const url = `wss://app.devin.ai/api/acp/live?token=${jwt}`;
  console.log(`[devin-ws] connecting to ${url.replace(jwt, jwt.slice(0,12) + '...' + jwt.slice(-8))}`);

  const acp = new AcpClient(url);
  acp.onError = (e) => console.error('[acp:ws error]', e.message);

  const updates: any[] = [];
  let finalText = '';
  let stopReason: string | undefined;
  acp.onNotification = (n) => {
    if (n.method === 'session/update') {
      updates.push(n.params);
      const update = n.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const text = update.content?.text;
        if (text) finalText += text;
      }
      if (n.params?.stopReason) stopReason = n.params.stopReason;
    } else {
      console.log('[acp:notify]', n.method, JSON.stringify(n.params).slice(0, 200));
    }
  };

  await acp.open();
  console.log('[devin-ws] ✓ connected');

  // 1. initialize
  const init = await acp.call('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'windsurf', version: '2.0.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      elicitation: { form: {} },
      _meta: {
        'cognition.ai/subagentSupport': true,
        'cognition.ai/multiRootWorkspace': true,
        'cognition.ai/partialContent': true,
        'cognition.ai/messageGrouping': true,
        'cognition.ai/groupedSessionConfigOptions': true,
        'cognition.ai/windsurfConfigBridge': true,
        'cognition.ai/revert': true,
        'cognition.ai/mcp': true,
        'cognition.ai/requestDiagnostics': false,
        terminal_output: true,
      },
    },
  });
  console.log('[devin-ws] ✓ initialize →', JSON.stringify(init).slice(0, 400));

  // 2. session/new — full output to see configOptions / model list
  const cwd = process.cwd();
  const newSess = await acp.call('session/new', { cwd, mcpServers: [] });
  const sessionId = newSess.sessionId ?? newSess.session?.sessionId;
  if (!sessionId) throw new Error(`session/new returned no sessionId: ${JSON.stringify(newSess)}`);
  console.log('[devin-ws] ✓ session/new → sessionId', sessionId);
  console.log('\n[devin-ws] FULL session/new result:');
  console.log(JSON.stringify(newSess, null, 2));

  // 3. session/prompt — minimal "say hi"
  console.log('\n[devin-ws] sending session/prompt …');
  try {
    const promptRes = await acp.call('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with EXACTLY: hi from devin ws' }],
    });
    console.log('[devin-ws] ✓ session/prompt result:', JSON.stringify(promptRes).slice(0, 200));
  } catch (e) {
    console.error('[devin-ws] session/prompt failed:', (e as Error).message);
  }

  console.log('');
  console.log(`[devin-ws] Accumulated text: ${JSON.stringify(finalText)}`);
  console.log(`[devin-ws] Stop reason     : ${stopReason ?? '(none)'}`);
  console.log(`[devin-ws] # updates       : ${updates.length}`);

  // Dump all updates for inspection
  console.log('\n[devin-ws] all session/update notifications:');
  for (let i = 0; i < updates.length; i++) {
    console.log(`  --- update[${i}]`);
    console.log('  ' + JSON.stringify(updates[i]).slice(0, 600));
  }

  acp.close();
}

main().catch((e) => {
  console.error('[devin-ws] FATAL:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
