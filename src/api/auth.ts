/**
 * Polestar OIDC authentication — a TypeScript port of pypolestar's auth.py.
 *
 * Flow:
 *  1. GET /.well-known/openid-configuration → discover token & auth endpoints.
 *  2. GET authorization_endpoint with PKCE params → parse "resume path" from HTML.
 *  3. POST credentials (pf.username / pf.pass) to resume path → 302 with `code`.
 *     If redirect contains `uid` (T&C acceptance), POST confirmation first.
 *  4. POST code + code_verifier to token_endpoint → access/refresh tokens.
 *  5. Refresh via refresh_token grant before expiry.
 */

import crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import type { Logger } from 'homebridge';
import {
  OIDC_PROVIDER_BASE_URL,
  OIDC_CLIENT_ID,
  OIDC_REDIRECT_URI,
  OIDC_SCOPE,
  TOKEN_REFRESH_WINDOW_SECONDS,
  REQUEST_TIMEOUT_MS,
} from '../settings';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class PolestarAuthException extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'PolestarAuthException';
  }
}

export class PolestarAuthFailedException extends PolestarAuthException {
  constructor(message: string) {
    super(message);
    this.name = 'PolestarAuthFailedException';
  }
}

export class PolestarAuthUnavailableException extends PolestarAuthException {
  constructor(message: string, statusCode?: number) {
    super(message, statusCode);
    this.name = 'PolestarAuthUnavailableException';
  }
}

// ---------------------------------------------------------------------------
// OIDC configuration
// ---------------------------------------------------------------------------

interface OidcConfiguration {
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
}

// ---------------------------------------------------------------------------
// PolestarAuth
// ---------------------------------------------------------------------------

export class PolestarAuth {
  public accessToken: string | null = null;
  public refreshToken: string | null = null;
  public tokenExpiry: Date | null = null;
  public latestCallCode: number | null = null;

  private tokenLifetime: number | null = null;
  private oidcConfiguration: OidcConfiguration | null = null;
  private codeVerifier: string | null = null;
  private state: string | null = null;

  /** Per-request cookie jar (name → value). */
  private cookies: Record<string, string> = {};

  private readonly client: AxiosInstance;

  constructor(
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
  ) {
    this.client = axios.create({
      timeout: REQUEST_TIMEOUT_MS,
      // Never auto-follow redirects — we inspect them manually in _getCode.
      maxRedirects: 0,
      validateStatus: () => true,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.updateOidcConfiguration();
  }

  isTokenValid(): boolean {
    return (
      this.accessToken !== null &&
      this.tokenExpiry !== null &&
      this.tokenExpiry > new Date()
    );
  }

  needsRefresh(): boolean {
    if (!this.tokenExpiry) {
      return true;
    }
    const windowSec = Math.min((this.tokenLifetime ?? 0) / 2, TOKEN_REFRESH_WINDOW_SECONDS);
    const expiresInSec = (this.tokenExpiry.getTime() - Date.now()) / 1000;
    return expiresInSec < windowSec;
  }

  /**
   * Ensure we hold a valid access token.  Refreshes or re-authenticates as
   * needed.  Safe to call before every API request.
   */
  async getToken(force = false): Promise<void> {
    if (!force && this.tokenExpiry && this.needsRefresh()) {
      force = true;
    }

    if (
      !force &&
      this.accessToken !== null &&
      this.tokenExpiry !== null &&
      this.tokenExpiry > new Date()
    ) {
      this.log.debug('Token still valid until %s', this.tokenExpiry.toISOString());
      return;
    }

    if (this.refreshToken) {
      try {
        await this.tokenRefresh();
        this.log.debug('Token refreshed successfully');
        return;
      } catch (err) {
        this.log.warn('Token refresh failed, re-authenticating: %s', String(err));
      }
    }

    try {
      await this.authorizationCode();
      this.log.debug('Initial token acquired');
    } catch (err) {
      this.accessToken = null;
      this.refreshToken = null;
      this.tokenExpiry = null;
      if (err instanceof PolestarAuthFailedException) {
        throw err;
      }
      throw new PolestarAuthException(`Unable to acquire initial token: ${String(err)}`);
    }
  }

  logout(): void {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    this.tokenLifetime = null;
    this.codeVerifier = null;
    this.state = null;
    this.cookies = {};
  }

  // -------------------------------------------------------------------------
  // PKCE helpers (exported for testing)
  // -------------------------------------------------------------------------

  static b64UrlEncode(buf: Buffer): string {
    return buf.toString('base64url');
  }

  static generateCodeVerifier(): string {
    return PolestarAuth.b64UrlEncode(crypto.randomBytes(32));
  }

  static generateState(): string {
    return PolestarAuth.b64UrlEncode(crypto.randomBytes(32));
  }

  getCodeChallenge(): string {
    if (!this.codeVerifier) {
      this.codeVerifier = PolestarAuth.generateCodeVerifier();
    }
    // PKCE code challenge per RFC 7636: BASE64URL(SHA-256(code_verifier)).
    // codeVerifier is a randomly-generated nonce — this is NOT a password hash.
    return PolestarAuth.b64UrlEncode(
      crypto.createHash('sha256').update(this.codeVerifier).digest(),
    );
  }

  getAuthParams(): Record<string, string> {
    if (!this.state) {
      this.state = PolestarAuth.generateState();
    }
    return {
      client_id: OIDC_CLIENT_ID,
      redirect_uri: OIDC_REDIRECT_URI,
      response_type: 'code',
      scope: OIDC_SCOPE,
      state: this.state,
      code_challenge: this.getCodeChallenge(),
      code_challenge_method: 'S256',
      response_mode: 'query',
    };
  }

  // -------------------------------------------------------------------------
  // Private — OIDC discovery
  // -------------------------------------------------------------------------

  private async updateOidcConfiguration(): Promise<void> {
    const url = `${OIDC_PROVIDER_BASE_URL}/.well-known/openid-configuration`;
    const response = await this.client.get<Record<string, string>>(url);

    if (response.status !== 200) {
      throw new PolestarAuthUnavailableException(
        `Unable to get OIDC configuration (HTTP ${response.status})`,
        response.status,
      );
    }

    const data = response.data;
    this.oidcConfiguration = {
      issuer: data['issuer'],
      tokenEndpoint: data['token_endpoint'],
      authorizationEndpoint: data['authorization_endpoint'],
    };
    this.log.debug('OIDC configuration loaded from %s', this.oidcConfiguration.issuer);
  }

  // -------------------------------------------------------------------------
  // Private — Authorization code flow
  // -------------------------------------------------------------------------

  private async authorizationCode(): Promise<void> {
    const code = await this.getCode();
    if (!code) {
      throw new PolestarAuthException('Unable to obtain authorization code');
    }

    if (!this.oidcConfiguration) {
      throw new PolestarAuthException('No OIDC configuration');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OIDC_CLIENT_ID,
      code,
      redirect_uri: OIDC_REDIRECT_URI,
      ...(this.codeVerifier ? { code_verifier: this.codeVerifier } : {}),
    });

    this.log.debug('Exchanging authorization code for tokens');
    const response = await this.client.post(
      this.oidcConfiguration.tokenEndpoint,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    this.parseTokenResponse(response.status, response.data);
  }

  private async tokenRefresh(): Promise<void> {
    if (!this.oidcConfiguration) {
      throw new PolestarAuthException('No OIDC configuration');
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OIDC_CLIENT_ID,
      refresh_token: this.refreshToken!,
    });

    this.log.debug('Refreshing token');
    const response = await this.client.post(
      this.oidcConfiguration.tokenEndpoint,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    this.parseTokenResponse(response.status, response.data);
  }

  // -------------------------------------------------------------------------
  // Private — Code acquisition (PKCE redirect dance)
  // -------------------------------------------------------------------------

  private async getCode(): Promise<string> {
    const resumePath = await this.getResumePath();

    // POST credentials — expect a 302/303 redirect whose Location holds `code`.
    const credentialData = new URLSearchParams({
      'pf.username': this.username,
      'pf.pass': this.password,
    });

    const response = await this.client.post(
      `${OIDC_PROVIDER_BASE_URL}${resumePath}`,
      credentialData.toString(),
      {
        params: this.getAuthParams(),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: this.getCookieHeader(),
        },
        maxRedirects: 0,
      },
    );

    this.extractCookies(response.headers as Record<string, string | string[]>);

    if (![302, 303].includes(response.status)) {
      this.latestCallCode = response.status;
      const body: string = typeof response.data === 'string' ? response.data : '';
      if (body.includes('authMessage: "ERR001"')) {
        throw new PolestarAuthFailedException(
          'Authentication failed (ERR001) — check your Polestar email and password',
        );
      }
      throw new PolestarAuthException(
        `Unexpected status ${response.status} during credential submission`,
        response.status,
      );
    }

    const location = response.headers['location'] as string | undefined;
    if (!location) {
      throw new PolestarAuthException('No Location header in redirect response');
    }

    const redirectUrl = this.resolveUrl(location);
    let code = redirectUrl.searchParams.get('code');
    const uid = redirectUrl.searchParams.get('uid');

    // Terms & conditions acceptance step
    if (!code && uid) {
      this.log.debug('T&C confirmation required for uid=%s, submitting', uid);
      const confirmData = new URLSearchParams({
        'pf.submit': 'true',
        subject: uid,
      });

      const confirmResponse = await this.client.post(
        `${OIDC_PROVIDER_BASE_URL}${resumePath}`,
        confirmData.toString(),
        {
          params: this.getAuthParams(),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: this.getCookieHeader(),
          },
          maxRedirects: 0,
        },
      );

      this.extractCookies(confirmResponse.headers as Record<string, string | string[]>);

      const location2 = confirmResponse.headers['location'] as string | undefined;
      if (!location2) {
        throw new PolestarAuthException('No Location header in T&C redirect');
      }
      code = this.resolveUrl(location2).searchParams.get('code');
    }

    if (!code) {
      throw new PolestarAuthException('No authorization code found in redirect URL');
    }

    // Follow sign-in-callback to set any final session cookies.
    this.latestCallCode = await this.followSignInCallback(redirectUrl.toString());

    return code;
  }

  /**
   * GET the OIDC authorization endpoint and parse the "resume path" from the
   * returned HTML — matching `url: "..."` or `action: "..."`.
   */
  private async getResumePath(): Promise<string> {
    if (!this.oidcConfiguration) {
      throw new PolestarAuthException('No OIDC configuration');
    }

    const response = await this.client.get(this.oidcConfiguration.authorizationEndpoint, {
      params: this.getAuthParams(),
      headers: { Cookie: this.getCookieHeader() },
    });

    this.latestCallCode = response.status;
    this.extractCookies(response.headers as Record<string, string | string[]>);

    const html: string = typeof response.data === 'string' ? response.data : '';
    const match = html.match(/(?:url|action):\s*"([^"]+)"/);
    if (!match) {
      throw new PolestarAuthException(
        `Could not parse resume path from OIDC authorization page (HTTP ${response.status})`,
        response.status,
      );
    }

    const resumePath = match[1];
    this.log.debug('Resume path: %s', resumePath);
    return resumePath;
  }

  /**
   * Follow the sign-in-callback redirect to finalize the OIDC session.
   * Returns the HTTP status code of the final response.
   */
  private async followSignInCallback(callbackUrl: string): Promise<number> {
    try {
      const response = await this.client.get(callbackUrl, {
        headers: { Cookie: this.getCookieHeader() },
        maxRedirects: 5,
        validateStatus: () => true,
      });
      this.extractCookies(response.headers as Record<string, string | string[]>);
      return response.status;
    } catch {
      return 200;
    }
  }

  // -------------------------------------------------------------------------
  // Private — Token response parsing
  // -------------------------------------------------------------------------

  private parseTokenResponse(status: number, data: Record<string, unknown>): void {
    this.latestCallCode = status;

    if (data['error']) {
      this.log.error('Token error response: %s', JSON.stringify(data));
      throw new PolestarAuthException(`Token error: ${data['error']}`, status);
    }

    const accessToken = data['access_token'];
    const refreshToken = data['refresh_token'];
    const expiresIn = data['expires_in'];

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      throw new PolestarAuthException('Token response missing access_token or refresh_token');
    }

    this.accessToken = accessToken;
    this.refreshToken = refreshToken;

    if (expiresIn) {
      this.tokenLifetime = Number(expiresIn);
      this.tokenExpiry = new Date(Date.now() + this.tokenLifetime * 1000);
    } else {
      this.tokenLifetime = null;
      this.tokenExpiry = null;
    }

    this.log.debug('Access token updated, valid until %s', this.tokenExpiry?.toISOString());
  }

  // -------------------------------------------------------------------------
  // Private — Cookie helpers
  // -------------------------------------------------------------------------

  private extractCookies(headers: Record<string, string | string[]>): void {
    const setCookieHeader = headers['set-cookie'];
    if (!setCookieHeader) {
      return;
    }
    const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const entry of entries) {
      const [pair] = entry.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const name = pair.substring(0, eqIdx).trim();
        const value = pair.substring(eqIdx + 1).trim();
        this.cookies[name] = value;
      }
    }
  }

  private getCookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  // -------------------------------------------------------------------------
  // Private — URL helpers
  // -------------------------------------------------------------------------

  private resolveUrl(location: string): URL {
    return location.startsWith('http')
      ? new URL(location)
      : new URL(location, OIDC_PROVIDER_BASE_URL);
  }
}
