/**
 * Windsurf Credential types
 *
 * NOTE: The legacy CSRF-scrape and LS process-discovery code that lived here
 * was removed in the v0.3 cloud-direct cleanup. Only the type definitions and
 * error class remain, used by credentials-resolver.ts and plugin.ts.
 */

// ============================================================================
// Types
// ============================================================================

export interface WindsurfCredentials {
  /** CSRF token for authenticating with local language server (unused in cloud-direct mode) */
  csrfToken: string;
  /** Port where the language server is listening (0 in cloud-direct mode) */
  port: number;
  /** Codeium API key (devin-session-token$<JWT> for current Cognition tier) */
  apiKey: string;
  /** Windsurf version string */
  version: string;
  /**
   * When true, the plugin bypasses the local language_server entirely and
   * streams chat completions from `server.codeium.com` directly. `csrfToken`
   * + `port` are unused; `apiServerUrl` becomes load-bearing.
   */
  cloudDirect?: boolean;
  /**
   * Tenant-specific API server URL (`https://server.codeium.com`,
   * `https://server.self-serve.windsurf.com`, etc.). Returned by RegisterUser;
   * only used when `cloudDirect` is true.
   */
  apiServerUrl?: string;
}

export enum WindsurfErrorCode {
  NOT_RUNNING = 'NOT_RUNNING',
  CSRF_MISSING = 'CSRF_MISSING',
  API_KEY_MISSING = 'API_KEY_MISSING',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  AUTH_FAILED = 'AUTH_FAILED',
  STREAM_ERROR = 'STREAM_ERROR',
}

export class WindsurfError extends Error {
  code: WindsurfErrorCode;
  details?: unknown;

  constructor(message: string, code: WindsurfErrorCode, details?: unknown) {
    super(message);
    this.name = 'WindsurfError';
    this.code = code;
    this.details = details;
  }
}
