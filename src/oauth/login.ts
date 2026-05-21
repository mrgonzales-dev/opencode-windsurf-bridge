/**
 * Browser-based OAuth login flow.
 *
 * Mirrors the implicit-grant flow `WindsurfAuthProvider.getLoginUrl` builds in
 * `/Applications/Windsurf.app/.../extension.js`:
 *
 *   https://windsurf.com/windsurf/signin
 *     ?response_type=token
 *     &client_id=3GUryQ7ldAeKEuD2obYnppsnmj58eP5u
 *     &redirect_uri=<R>
 *     &state=<uuid>
 *     &prompt=login
 *     &redirect_parameters_type=<query|fragment>
 *
 * The desktop extension ships `redirect_uri=windsurf://codeium.windsurf` so the
 * OS routes the callback through the Windsurf protocol handler. We can't
 * register an OS-level scheme from a Node CLI, so we use two strategies:
 *
 *   1. **Loopback callback (preferred)**: bind a one-shot HTTP server on
 *      `127.0.0.1:<port>/auth` and pass that as `redirect_uri`. The Windsurf
 *      SPA hands the token off as a query string. This is the same trick the
 *      older Codeium VS plugin used (see `LanguageServer.cs:SignInAsync`).
 *
 *   2. **Manual paste fallback**: pass `redirect_uri=show-auth-token`. The
 *      Windsurf SPA renders the raw token in a `<code>` block for the user to
 *      copy. We prompt for it in the terminal.
 *
 * Whichever path produces the token, we hand it to `registerUser` to exchange
 * for the long-lived API key.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { registerUser, WindsurfRegistrationError } from './register-user.js';
import { saveCredentials } from './storage.js';
import { DEFAULT_REGION, type OAuthLoginResult, type WindsurfRegion } from './types.js';

/** How long to wait for the user to finish the browser flow. */
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface LoginOptions {
  region?: WindsurfRegion;
  /** Override the random callback port (mostly useful for tests). */
  callbackPort?: number;
  /** Force the manual-paste flow instead of attempting a loopback callback. */
  manualPaste?: boolean;
  /** Treat this as a new-user onboarding flow (uses /windsurf/signup). */
  signUp?: boolean;
  /** Pre-fill the email on the sign-in page. */
  loginHint?: string;
  /** Abort signal to cancel the in-flight login. */
  signal?: AbortSignal;
  /** Custom timeout. */
  timeoutMs?: number;
  /** Hook called once the URL is ready, before we open the browser. */
  onUrl?: (url: string) => void | Promise<void>;
  /** Custom token-paste prompt for the manual fallback. Defaults to readline on stdin. */
  promptForToken?: () => Promise<string>;
}

/**
 * Run the full browser sign-in flow and persist credentials. Returns the
 * resolved API key + account name + apiServerUrl for the caller to display.
 */
export async function login(opts: LoginOptions = {}): Promise<OAuthLoginResult> {
  const region = opts.region ?? DEFAULT_REGION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const token = opts.manualPaste
    ? await loginWithManualPaste(region, opts)
    : await loginWithLoopback(region, opts, timeoutMs);

  const result = await registerUser(token, region, opts.signal);

  await saveCredentials({
    apiKey: result.apiKey,
    name: result.name,
    apiServerUrl: result.apiServerUrl,
    redirectUrl: result.redirectUrl,
    issuedAt: new Date().toISOString(),
    oauthClientId: region.oauthClientId,
  });

  return result;
}

/**
 * Two-stage version of {@link login} for the opencode `auth.methods[*].authorize`
 * flow.
 *
 * Why: opencode's `AuthOuathResult` requires us to return `{ url, callback }`
 * *synchronously*, and opencode immediately opens the URL in the browser. The
 * loopback callback's port must therefore be known BEFORE we return — we can't
 * bind it lazily in `callback()` like the standalone CLI does. This function:
 *
 *   1. Binds the loopback HTTP server NOW (real ephemeral port)
 *   2. Builds the sign-in URL with that real port
 *   3. Hands back `{ url, awaitToken }` — `awaitToken` is what opencode calls
 *      after the user finishes in the browser; it waits for the loopback to
 *      fire, exchanges the firebase_id_token via RegisterUser, and persists.
 */
export interface PreparedLogin {
  /** Fully-formed sign-in URL with the loopback redirect baked in. */
  url: string;
  /** Wait for browser callback, exchange token, persist credentials. */
  awaitToken: () => Promise<OAuthLoginResult>;
  /** Tear down the loopback if the caller bails out. */
  cancel: () => void;
}

export async function prepareLogin(opts: LoginOptions = {}): Promise<PreparedLogin> {
  const region = opts.region ?? DEFAULT_REGION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const state = crypto.randomUUID();

  // Bind the loopback FIRST so we have a real port to put in the URL.
  const server = await startCallbackServer(opts.callbackPort);
  const callbackUrl = `http://127.0.0.1:${server.port}/auth`;
  const url = buildLoginUrl({
    region,
    redirectUri: callbackUrl,
    redirectParametersType: 'query',
    state,
    signUp: opts.signUp,
    loginHint: opts.loginHint,
  });

  // Open the system browser pointed at the sign-in URL. We do this in
  // prepareLogin (not awaitToken) because opencode invokes authorize()
  // synchronously, prints the URL, and only THEN polls callback(). If we
  // waited until awaitToken to call openBrowser, the user would never see
  // a browser tab pop — opencode would just hang printing the URL until the
  // user manually clicks it. (This is the regression that produced the "not
  // opening the auth tab" symptom after the first refactor.)
  //
  // If the user passes onUrl, give them a chance to handle the URL their own
  // way (logging, copy-to-clipboard, etc.) — that's fine in parallel.
  opts.onUrl?.(url);
  // Don't await — openBrowser shells out and we don't need to block on it.
  // Errors are non-fatal: opencode also prints "Go to: <url>" so the user
  // can always click it manually.
  openBrowser(url).catch(() => { /* swallow — fallback URL is shown */ });

  let closed = false;
  const cancel = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch { /* ok */ }
  };

  return {
    url,
    cancel,
    awaitToken: async () => {
      try {
        const callback = await waitWithTimeout(
          server.callback(state),
          timeoutMs,
          opts.signal,
          'Sign-in timed out — try again and complete the browser flow within 5 minutes.',
        );
        if (callback.state && callback.state !== state) {
          throw new Error(
            `OAuth state mismatch (expected ${state.slice(0, 8)}…, got ${callback.state.slice(0, 8)}…). ` +
            'Possible CSRF — re-run sign-in.',
          );
        }
        const result = await registerUser(callback.token, region, opts.signal);
        await saveCredentials({
          apiKey: result.apiKey,
          name: result.name,
          apiServerUrl: result.apiServerUrl,
          redirectUrl: result.redirectUrl,
          issuedAt: new Date().toISOString(),
          oauthClientId: region.oauthClientId,
        });
        return result;
      } finally {
        cancel();
      }
    },
  };
}

// ============================================================================
// Strategy 1 — loopback callback
// ============================================================================

interface CallbackResult {
  /** Either `access_token` (Auth0 native) or `firebase_id_token` (Windsurf-renamed). */
  token: string;
  state: string;
}

/**
 * Bind a one-shot HTTP server on a free port, open the browser, and wait for
 * the user to complete sign-in. Resolves with the firebase_id_token from the
 * callback URL's query string.
 */
async function loginWithLoopback(
  region: WindsurfRegion,
  opts: LoginOptions,
  timeoutMs: number,
): Promise<string> {
  const state = crypto.randomUUID();
  const server = await startCallbackServer(opts.callbackPort);
  const cleanup = () => server.close();

  try {
    const callbackUrl = `http://127.0.0.1:${server.port}/auth`;
    const loginUrl = buildLoginUrl({
      region,
      redirectUri: callbackUrl,
      redirectParametersType: 'query',
      state,
      signUp: opts.signUp,
      loginHint: opts.loginHint,
    });

    await opts.onUrl?.(loginUrl);
    await openBrowser(loginUrl);

    const callback = await waitWithTimeout(
      server.callback(state),
      timeoutMs,
      opts.signal,
      'Sign-in timed out — re-run `login` and complete the browser flow within 5 minutes.',
    );

    if (callback.state !== state) {
      throw new Error(
        `OAuth state mismatch (expected ${state.slice(0, 8)}…, got ${callback.state.slice(0, 8)}…). ` +
        'Possible CSRF — re-run sign-in.',
      );
    }
    return callback.token;
  } finally {
    cleanup();
  }
}

interface CallbackServer {
  port: number;
  close: () => void;
  callback: (expectedState: string) => Promise<CallbackResult>;
}

/**
 * Bind a transient HTTP server on a free ephemeral port. Resolves the
 * `callback(state)` promise the first time `/auth` is hit with both a token
 * and a matching state, then keeps the server alive a beat longer so the
 * browser can render the "you can close this tab" page.
 *
 * Bind order: try the requested port first if any, then port 0 (let the OS
 * pick). Picking 0 is safer than hand-rolling a port-scan loop.
 */
function startCallbackServer(requestedPort?: number): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let captured: { token: string; state: string; error?: string } | null = null;
    const waiters: Array<{ state: string; resolve: (r: CallbackResult) => void; reject: (e: Error) => void }> = [];

    const server = http.createServer((req, res) => {
      // Defensive: ignore everything but /auth
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (url.pathname !== '/auth') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const tokenParam =
        url.searchParams.get('firebase_id_token') ??
        url.searchParams.get('access_token') ??
        url.searchParams.get('token');
      const stateParam = url.searchParams.get('state') ?? '';
      const errorParam = url.searchParams.get('error') ?? url.searchParams.get('error_description');

      if (errorParam) {
        captured = { token: '', state: stateParam, error: errorParam };
        renderResponse(res, false, `Sign-in failed: ${errorParam}`);
        flushWaiters();
        return;
      }
      if (!tokenParam) {
        // Some Auth0 configs deliver the token in the URL fragment. Render a
        // tiny HTML page that grabs the fragment client-side and re-POSTs it
        // back to /auth so we can capture it server-side.
        renderFragmentHarvester(res);
        return;
      }

      captured = { token: tokenParam, state: stateParam };
      renderResponse(res, true, 'Sign-in complete — you can close this tab.');
      flushWaiters();
    });

    server.on('error', reject);

    function flushWaiters() {
      if (!captured) return;
      const c = captured;
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        if (c.error) {
          w.reject(new Error(c.error));
        } else if (c.state && w.state !== c.state) {
          // Wrong state — keep listening (rare; an attacker hitting /auth
          // with garbage shouldn't kill the legitimate flow).
          // But also surface for diagnostics.
          w.resolve({ token: c.token, state: c.state });
        } else {
          w.resolve({ token: c.token, state: c.state });
        }
      }
    }

    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind loopback server'));
        return;
      }
      resolve({
        port: address.port,
        close: () => server.close(),
        callback: (expectedState: string) =>
          new Promise((res, rej) => {
            if (captured) {
              const c = captured;
              if (c.error) rej(new Error(c.error));
              else res({ token: c.token, state: c.state });
            } else {
              waiters.push({ state: expectedState, resolve: res, reject: rej });
            }
          }),
      });
    });
  });
}

function renderResponse(res: http.ServerResponse, ok: boolean, message: string): void {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>opencode-windsurf-auth</title>
<style>
  body{font:14px -apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0d12;color:#e7e9ee}
  .card{max-width:520px;padding:28px 32px;border-radius:14px;background:#151823;border:1px solid #232838;text-align:center}
  h1{font-size:18px;margin:0 0 10px;color:${ok ? '#71d784' : '#ff8585'}}
  p{margin:6px 0;color:#9aa3b2}
</style></head>
<body><div class="card"><h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  res.writeHead(ok ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function renderFragmentHarvester(res: http.ServerResponse): void {
  // The implicit-grant callback sometimes lands with the token in #fragment.
  // Browsers don't send fragments to the server, so we serve a 1-line JS shim
  // that re-issues the request with the fragment params as query params.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><script>
(function(){
  var h=window.location.hash.replace(/^#/,'');
  if(!h){document.body.innerText='No token in URL.';return}
  window.location.replace('/auth?'+h);
})();
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

// ============================================================================
// Strategy 2 — manual paste
// ============================================================================

async function loginWithManualPaste(region: WindsurfRegion, opts: LoginOptions): Promise<string> {
  const state = crypto.randomUUID();
  const loginUrl = buildLoginUrl({
    region,
    redirectUri: 'show-auth-token',
    redirectParametersType: 'query',
    state,
    signUp: opts.signUp,
    loginHint: opts.loginHint,
  });

  await opts.onUrl?.(loginUrl);
  await openBrowser(loginUrl).catch(() => {
    // openBrowser failing is fine in manual mode — the user just opens it
    // themselves from the URL we already printed via onUrl.
  });

  const prompt = opts.promptForToken ?? defaultPromptForToken;
  const pasted = (await prompt()).trim();

  if (!pasted) {
    throw new Error('No token pasted — aborting.');
  }

  return pasted;
}

function defaultPromptForToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Cannot prompt for token on a non-TTY stdin. Pipe the token in or run interactively.'));
      return;
    }
    process.stdout.write('\nPaste your Windsurf auth token (from the browser page) and press Enter:\n> ');
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      buf += s;
      if (buf.includes('\n')) {
        process.stdin.removeListener('data', onData);
        const idx = buf.indexOf('\n');
        resolve(buf.slice(0, idx).trim());
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

// ============================================================================
// URL construction
// ============================================================================

interface BuildLoginUrlArgs {
  region: WindsurfRegion;
  redirectUri: string;
  redirectParametersType: 'query' | 'fragment';
  state: string;
  signUp?: boolean;
  loginHint?: string;
}

function buildLoginUrl(args: BuildLoginUrlArgs): string {
  const params = new URLSearchParams([
    ['response_type', 'token'],
    ['client_id', args.region.oauthClientId],
    ['redirect_uri', args.redirectUri],
    ['state', args.state],
    ['prompt', 'login'],
    ['redirect_parameters_type', args.redirectParametersType],
  ]);
  if (args.loginHint) params.append('login_hint', args.loginHint);
  const path = args.signUp ? 'windsurf/signup' : 'windsurf/signin';
  return `${args.region.website.replace(/\/$/, '')}/${path}?${params.toString()}`;
}

// ============================================================================
// Helpers
// ============================================================================

/** Cross-platform "open this URL in the user's default browser". */
async function openBrowser(url: string): Promise<void> {
  // We deliberately avoid `import open from 'open'` to keep our dependency
  // surface tiny. The three OS commands below cover macOS / Linux / Windows.
  const cmds: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin' ? [{ cmd: 'open', args: [url] }]
    : process.platform === 'win32' ? [{ cmd: 'cmd', args: ['/c', 'start', '""', url.replace(/&/g, '^&')] }]
    : [{ cmd: 'xdg-open', args: [url] }, { cmd: 'sensible-browser', args: [url] }];

  for (const c of cmds) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(c.cmd, c.args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    });
    if (ok) return;
  }
  throw new Error(
    `Unable to open browser automatically. Open this URL manually:\n  ${url}`,
  );
}

function waitWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error('Sign-in cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

// Re-export for callers that want a clean public surface from a single module.
export { WindsurfRegistrationError };
