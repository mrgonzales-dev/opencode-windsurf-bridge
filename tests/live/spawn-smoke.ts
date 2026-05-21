/**
 * Spawner smoke test.
 *
 * Loads the OAuth credentials file, spawns our own language_server, and
 * verifies the gRPC port comes up. No Cascade RPCs yet — just "did the binary
 * start with our bootstrap metadata?" Doesn't disturb the user's running
 * Windsurf (we use a separate database_dir + random ports).
 */

import { loadCredentials } from '../../src/oauth/storage.js';
import {
  ensureLanguageServer,
  stopLanguageServer,
} from '../../src/plugin/language-server-spawner.js';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('No OAuth credentials. Run `node dist/src/cli.js login` first.');

  console.log(`[spawn-smoke] account: ${creds.name}`);
  console.log(`[spawn-smoke] apiServerUrl: ${creds.apiServerUrl}`);
  console.log(`[spawn-smoke] spawning language_server …`);

  const t0 = Date.now();
  const result = await ensureLanguageServer({
    apiKey: creds.apiKey,
    apiServerUrl: creds.apiServerUrl,
  });
  const dt = Date.now() - t0;
  console.log(`[spawn-smoke] ✓ ready in ${dt}ms`);
  console.log(`[spawn-smoke] port      : ${result.port}`);
  console.log(`[spawn-smoke] csrf      : ${result.csrfToken.slice(0, 8)}…`);
  console.log(`[spawn-smoke] version   : ${result.version}`);

  await stopLanguageServer();
  console.log(`[spawn-smoke] ✓ stopped`);
}

main().catch((err) => {
  console.error('[spawn-smoke] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
