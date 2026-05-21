/**
 * On-disk credential storage for the OAuth flow.
 *
 * Path: `$XDG_CONFIG_HOME/opencode-windsurf-auth/credentials.json`
 *       (defaults to `~/.config/opencode-windsurf-auth/credentials.json` on Linux,
 *        `~/Library/Application Support/opencode-windsurf-auth/credentials.json` on macOS
 *        — xdg-basedir resolves both).
 *
 * We deliberately store on disk (mode 0600) rather than in the OS keychain
 * because:
 *   1. We need a *cross-process* token — opencode invokes the plugin in many
 *      short-lived Node subprocesses, and Keychain prompts every time would be
 *      unusable.
 *   2. The token grants Cascade chat access but doesn't unlock anything else
 *      on the user's machine; chmod 0600 is the same risk envelope as
 *      `~/.codeium/config.json` (Codeium plugins' own storage choice).
 *
 * We previously used `proper-lockfile` for cross-process locking, but its
 * CJS/ESM interop blew up in opencode's Bun runtime
 * (`(await getLockfile()).lock is not a function` — `mod.default` resolves to
 * the namespace object, not the callable). For a single-user OAuth flow we
 * don't actually need cross-process locking; `O_EXCL` lockfile + atomic
 * tmp-rename gives us identical safety without the dependency.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { xdgConfig } from 'xdg-basedir';
import type { PersistedCredentials } from './types.js';

const APP_DIR_NAME = 'opencode-windsurf-auth';
const CREDS_FILENAME = 'credentials.json';

export function getCredentialsDir(): string {
  // xdgConfig is undefined on Windows; pick a sensible per-user fallback.
  const base = xdgConfig ?? path.join(os.homedir(), '.config');
  return path.join(base, APP_DIR_NAME);
}

export function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), CREDS_FILENAME);
}

function ensureDir(): void {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Atomically write credentials with file mode 0600.
 *
 * Strategy:
 *   1. Create an O_EXCL lockfile (`credentials.json.lock`) — fails fast if
 *      another writer is in the middle of an update. We retry with backoff
 *      a handful of times before giving up.
 *   2. Write the payload to a process-scoped tmp file (`credentials.json.<pid>.tmp`).
 *   3. `rename()` is atomic on POSIX — the reader either sees the OLD file
 *      or the FULLY-WRITTEN new file, never a half-written one.
 *   4. Always unlink the lockfile on the way out.
 *
 * Stale-lock guard: if the existing lockfile is older than 30s, we assume the
 * prior writer crashed and steal it.
 */
const LOCK_FILENAME = 'credentials.json.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_BASE_MS = 80;
const LOCK_RETRIES = 6;

async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = getCredentialsDir();
  const lockPath = path.join(dir, LOCK_FILENAME);

  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      try {
        return await fn();
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* ok */ }
      }
    } catch (err) {
      const code =
        err instanceof Error && 'code' in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code !== 'EEXIST') throw err;
      // Check staleness — steal a lock older than LOCK_STALE_MS.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* race: lock disappeared, loop and retry */ }
      if (attempt === LOCK_RETRIES) {
        throw new Error(`Could not acquire credentials lock at ${lockPath}. Another process is writing.`);
      }
      const wait = LOCK_RETRY_BASE_MS * Math.pow(1.5, attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  // Unreachable
  throw new Error('lock acquisition exhausted retries');
}

export async function saveCredentials(creds: PersistedCredentials): Promise<void> {
  ensureDir();
  const finalPath = getCredentialsPath();
  await withLock(() => {
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
  });
}

/**
 * Read persisted credentials. Returns null if none exist; throws if the file
 * exists but is malformed (we don't want to silently fall back to "no auth"
 * if the user's `login` already ran).
 */
export function loadCredentials(): PersistedCredentials | null {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Credentials file at ${p} is not valid JSON. Run 'opencode-windsurf-auth login' to re-authenticate, or delete the file.`);
  }
  if (!isPersistedCredentials(parsed)) {
    throw new Error(`Credentials file at ${p} is missing required fields. Run 'opencode-windsurf-auth login' to re-authenticate.`);
  }
  return parsed;
}

export function deleteCredentials(): boolean {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

function isPersistedCredentials(value: unknown): value is PersistedCredentials {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiKey === 'string' && v.apiKey.length > 0 &&
    typeof v.name === 'string' && v.name.length > 0 &&
    typeof v.apiServerUrl === 'string' && v.apiServerUrl.length > 0 &&
    typeof v.issuedAt === 'string' &&
    typeof v.oauthClientId === 'string'
  );
}
