/**
 * Credential resolution.
 *
 * Cloud-direct is the **only path** as of v0.3.
 *
 * Flow:
 *   1. User runs `opencode auth login` → picks "Sign in with Windsurf" → our
 *      `methods[0].authorize()` runs the browser OAuth flow and writes
 *      `~/.config/opencode-windsurf-auth/credentials.json`.
 *   2. On every chat: `loadCredentials()` reads the file, returns
 *      `{ apiKey, apiServerUrl, cloudDirect: true }`.
 *   3. `streamChatGenerator` dispatches to
 *      `src/cloud-direct/streamChatEvents` — straight HTTPS to
 *      `server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage`.
 *      No language_server in the loop.
 *
 * Legacy CSRF-scrape and OAuth-spawn-LS paths have been removed. The old
 * comment blocks existed here but were deleted during the v0.3.3 cleanup.
 */

import {
  WindsurfCredentials,
  WindsurfError,
  WindsurfErrorCode,
} from './auth.js';
import { loadCredentials } from '../oauth/storage.js';

/**
 * - `cloud-direct` (default + only active): bypass language_server entirely,
 *   stream chat from `server.codeium.com` over HTTPS. Requires OAuth
 *   credentials; does NOT require Windsurf to be installed or running.
 *
 * The other modes are accepted for backward-compat but currently alias to
 * `cloud-direct`. Set them in `OPENCODE_WINDSURF_AUTH_MODE`.
 */
export type ResolutionMode = 'cloud-direct' | 'oauth' | 'legacy' | 'auto';

export interface ResolveOptions {
  mode?: ResolutionMode;
}

function modeFromEnv(): ResolutionMode {
  const v = process.env.OPENCODE_WINDSURF_AUTH_MODE?.toLowerCase().trim();
  if (v === 'oauth' || v === 'legacy' || v === 'cloud-direct' || v === 'auto') return v;
  return 'cloud-direct';
}

/**
 * Memoize the on-disk credential read for a short TTL. The proxy auth
 * gate and the chat handler both used to call `loadCredentials()`
 * independently per request, opening a TOCTOU window: the auth gate
 * could validate a Bearer against key-A, then a credential rotation
 * landed, and the chat handler would forward the request with key-B.
 *
 * Sharing one short-lived snapshot closes that window for the lifetime
 * of a single chat turn while still letting credential rotation
 * propagate within ~2s.
 */
const RESOLVE_CACHE_TTL_MS = 2_000;
let resolveCache: { value: WindsurfCredentials | null; expiry: number } = { value: null, expiry: 0 };

export function clearResolveCache(): void {
  resolveCache = { value: null, expiry: 0 };
}

/**
 * Resolve credentials for chat. Cloud-direct only; other modes (oauth/legacy)
 * are accepted as aliases for forward-compat and currently route through the
 * same path.
 */
export async function resolveCredentials(opts: ResolveOptions = {}): Promise<WindsurfCredentials> {
  const mode = opts.mode ?? modeFromEnv();

  // Serve the cached snapshot if still warm.
  const now = Date.now();
  if (resolveCache.value && now < resolveCache.expiry) {
    return resolveCache.value;
  }

  // Single active code path: cloud-direct.
  const oauth = loadCredentials();
  if (!oauth) {
    throw new WindsurfError(
      'Not authenticated. Run `opencode auth login` and select "Sign in with Windsurf", ' +
      'or run `npx opencode-windsurf-auth login` directly.',
      WindsurfErrorCode.AUTH_FAILED,
    );
  }
  // Silently alias legacy/oauth modes to cloud-direct. The user explicitly
  // asked for those modes to stay disabled until they uncomment the
  // LEGACY_* blocks; no need to print noise in production. The mode value
  // is observable via the WindsurfCredentials shape returned below if anyone
  // needs to differentiate at runtime.
  void mode;

  const creds: WindsurfCredentials = {
    apiKey: oauth.apiKey,
    csrfToken: '',         // unused in cloud-direct
    port: 0,                // unused in cloud-direct
    version: '2.0.0',
    cloudDirect: true,
    apiServerUrl: oauth.apiServerUrl,
  };
  resolveCache = { value: creds, expiry: now + RESOLVE_CACHE_TTL_MS };
  return creds;
}

