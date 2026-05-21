/**
 * Spawn language_server with HTTPS_PROXY pointing at mitmdump (port 8889) and
 * drive one Cascade chat. mitm captures the upstream traffic so we can see
 * exactly what the LS POSTs to server.codeium.com / inference.codeium.com.
 */

import { loadCredentials } from '../../src/oauth/storage.js';
import { LanguageServerDaemon } from '../../src/plugin/language-server-spawner.js';
import { streamChatGenerator } from '../../src/plugin/grpc-client.js';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('No creds');

  // Mitmproxy proxy: GoLang net/http honors HTTPS_PROXY and HTTP_PROXY env
  process.env.HTTPS_PROXY = 'http://127.0.0.1:8889';
  process.env.HTTP_PROXY  = 'http://127.0.0.1:8889';

  // Tell the spawner about it - it inherits process.env by default
  const daemon = new LanguageServerDaemon();
  const result = await daemon.start({
    apiKey: creds.apiKey,
    apiServerUrl: creds.apiServerUrl,
  });
  console.log(`[mitm-spawn] LS up on :${result.port}`);

  console.log(`[mitm-spawn] sending cascade chat …`);
  const chunks: string[] = [];
  try {
    const gen = streamChatGenerator(
      { csrfToken: result.csrfToken, port: result.port, version: result.version, apiKey: creds.apiKey },
      { model: 'claude-opus-4.7', messages: [{ role: 'user', content: 'Reply with: hi from mitm' }] },
    );
    for await (const c of gen) chunks.push(c);
  } catch (e) {
    console.error('[mitm-spawn] chat failed:', e instanceof Error ? e.message : e);
  }
  console.log(`[mitm-spawn] reply: ${chunks.join('').trim()}`);
  await daemon.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
