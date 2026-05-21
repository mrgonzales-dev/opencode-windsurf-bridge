/**
 * Spawn language_server with --api_server_url pointed at a local mitmdump
 * reverse-proxy (127.0.0.1:8890 → server.codeium.com). Then drive a Cascade
 * chat through it. mitm captures every upstream call the LS makes.
 *
 * This reveals the EXACT body shape the LS sends to the cloud — letting us
 * replicate it directly without the binary.
 */

import { loadCredentials } from '../../src/oauth/storage.js';
import { LanguageServerDaemon } from '../../src/plugin/language-server-spawner.js';
import { streamChatGenerator } from '../../src/plugin/grpc-client.js';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('No OAuth creds');

  const daemon = new LanguageServerDaemon();
  const result = await daemon.start({
    apiKey: creds.apiKey,
    // !!! point the LS at our mitm reverse proxy !!!
    apiServerUrl: 'http://127.0.0.1:8890',
  });
  console.log('[mitm-rev] LS up on :' + result.port);

  try {
    const chunks: string[] = [];
    const gen = streamChatGenerator(
      { csrfToken: result.csrfToken, port: result.port, version: result.version, apiKey: creds.apiKey },
      { model: 'claude-opus-4.7', messages: [{ role: 'user', content: 'reply: hi from mitm' }] },
    );
    for await (const c of gen) chunks.push(c);
    console.log('[mitm-rev] reply:', chunks.join('').trim());
  } catch (e) {
    console.error('[mitm-rev] chat failed (expected if LS rejects http:// api server):', e instanceof Error ? e.message : e);
  }
  await daemon.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
