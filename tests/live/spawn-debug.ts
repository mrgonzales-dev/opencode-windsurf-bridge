/**
 * Spawn the language_server and dump diagnostics: pid, listening ports, args,
 * env. Used to debug "Failed to connect" — the LS opens multiple ports and we
 * need to figure out which one carries the Cascade gRPC service.
 */

import { loadCredentials } from '../../src/oauth/storage.js';
import { LanguageServerDaemon } from '../../src/plugin/language-server-spawner.js';
import { execSync } from 'child_process';

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) throw new Error('No OAuth credentials. Run login first.');

  const daemon = new LanguageServerDaemon();
  const result = await daemon.start({
    apiKey: creds.apiKey,
    apiServerUrl: creds.apiServerUrl,
  });

  console.log('[spawn-debug] daemon up:');
  console.log('  port (we picked for --server_port):', result.port);
  console.log('  csrf:', result.csrfToken.slice(0, 8) + '…');

  // Now find the actual PID and list all its listening ports
  const child = (daemon as any).child;
  const pid = child?.pid;
  console.log('  pid:', pid);

  if (pid) {
    try {
      const lsof = execSync(`lsof -p ${pid} -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true`, { encoding: 'utf8' });
      console.log('\n[spawn-debug] listening ports:');
      console.log(lsof);
    } catch (e) {
      console.error('lsof failed:', e);
    }

    try {
      const psOut = execSync(`ps -ww -p ${pid} -o command 2>/dev/null || true`, { encoding: 'utf8' });
      console.log('[spawn-debug] command line:');
      console.log(psOut);
    } catch {/* */}
  }

  // Hold longer, re-probe ports periodically, dump stderr
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (pid) {
      try {
        const out = execSync(`lsof -p ${pid} -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep LISTEN || true`, { encoding: 'utf8' });
        console.log(`[t+${(i + 1) * 1.5}s] listening:\n${out.split('\n').filter(Boolean).map(l => '  ' + l).join('\n')}`);
      } catch {}
    }
    const stderr = (daemon as any).lastStderr ?? [];
    if (stderr.length > 0) {
      console.log(`[t+${(i + 1) * 1.5}s] last stderr lines:\n  ${stderr.join('\n  ')}`);
    }
  }
  await daemon.stop();
  console.log('[spawn-debug] done.');
}

main().catch((err) => {
  console.error('[spawn-debug] fatal:', err);
  process.exit(1);
});
