import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import { type Express, type Request, type Response } from 'express';
import { LineClient, AuthData } from '@raidenyn/line-client';
import {
  CredentialStore,
  StoredAuthRecord,
  listStoredAuthRecords,
  loadStoredAuthRecord,
  maskMid,
} from './credential-store';

// ─── Issued token pair ──────────────────────────────────────────────────────

export interface IssuedTokenPair {
  access_token: string;
  refresh_token: string;
}

// Everything the OAuth router needs from its host provider. Token issuance and
// legacy-safe refresh handling live on the provider (it owns the typed codec);
// the router owns only the ephemeral login/PKCE state and the HTTP surface.
export interface OAuthRouterDeps {
  /** Canonical issuer base, e.g. `http://localhost:3000/line-mcp` (no trailing slash). */
  base: string;
  /** Origin of the issuer, e.g. `http://localhost:3000`, for the well-known challenge URL. */
  origin: string;
  basePath: string;
  requiredScopes: readonly string[];
  authStoreDir: string;
  credentialStore: CredentialStore;
  lineApiBaseUrl?: string;
  issueTokens(authData: AuthData): IssuedTokenPair;
  issueFromRefresh(refreshToken: string): Promise<IssuedTokenPair | null>;
  /** Records a just-completed login's credential as the freshest known snapshot for its MID. */
  recordRefreshedAuth(authData: AuthData): void;
}

// ─── Login session types ──────────────────────────────────────────────────────

interface LoginSession {
  lineClient: LineClient;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  authStoreDir: string;
  selectedMid?: string;
  previousDisplayName?: string;
  phase: 'qr' | 'pin_needed' | 'complete' | 'failed';
  pin?: string;
  code?: string;
  error?: string;
}

interface PendingCode {
  authData: AuthData;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
}

interface AccountSelectionSession {
  request: AuthorizationRequest;
  choices: Map<string, string>;
  expiresAt: number;
}

// ─── OAuth helpers ────────────────────────────────────────────────────────────

// Loopback redirect URIs allowed per RFC 8252 §7.3 — any path is valid on loopback.
// The scheme MUST be http(s): a `//localhost` authority parses under any scheme, so
// checking only hostname would let `javascript:`/`data:`/`file:` URIs through and the
// authorize page would then navigate the browser to attacker-controlled JavaScript
// (reflected-XSS / token-exfiltration vector).
function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
           (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function accountLabel(record: StoredAuthRecord): string {
  return record.displayName ?? maskMid(record.mid);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function accountSelectorHtml(
  basePath: string,
  selectionSession: string,
  choices: Array<{ id: string; label: string }>,
): string {
  const options = choices.map(({ id, label }, index) => `
    <label>
      <input type="radio" name="choice" value="${escapeHtml(id)}"${index === 0 ? ' checked' : ''}>
      ${escapeHtml(label)}
    </label>`).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Select LINE account</title></head><body>
<h1>Select LINE account</h1>
<form method="post" action="${escapeHtml(basePath)}/authorize/select">
<input type="hidden" name="selection_session" value="${escapeHtml(selectionSession)}">
${options}
<button type="submit">Continue</button>
</form></body></html>`;
}

function authorizePageHtml(qrDataUrl: string, sid: string, state: string, redirectUri: string, basePath: string): string {
  const oauthContext = JSON.stringify({ sid, state, redirectUri, basePath })
    .replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LINE Login — Authorize Claude Code</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; text-align: center; background: #f8f8f8; }
  h1 { font-size: 1.4rem; color: #06c755; }
  img { width: 220px; height: 220px; margin: 16px auto; display: block; border: 8px solid #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.1); }
  #status { margin: 16px 0; font-size: 1rem; color: #555; }
  #pin-box { display: none; margin: 20px 0; }
  #pin { font-size: 2.5rem; font-weight: bold; letter-spacing: .25rem; color: #06c755; background: #fff; padding: 12px 28px; border-radius: 10px; border: 2px solid #06c755; display: inline-block; }
  .hint { font-size: 0.85rem; color: #888; margin-top: 8px; }
  .error { color: #c00; }
</style>
</head>
<body>
<h1>LINE Login</h1>
<p id="status">Scan the QR code below with your LINE mobile app</p>
<img id="qr" src="${qrDataUrl}" alt="LINE QR code">
<div id="pin-box">
  <p>Enter this PIN in your LINE mobile app:</p>
  <span id="pin"></span>
  <p class="hint">Go to LINE → Settings → Account → Allow login or check the login prompt.</p>
</div>
<script type="application/json" id="oauth-context">${oauthContext}</script>
<script>
const { sid, state, redirectUri, basePath } = JSON.parse(
  document.getElementById('oauth-context').textContent,
);
const status = document.getElementById('status');
const pinBox = document.getElementById('pin-box');
const pinEl = document.getElementById('pin');

async function poll() {
  try {
    const res = await fetch(basePath + '/authorize/poll?sid=' + encodeURIComponent(sid));
    const data = await res.json();
    if (data.phase === 'qr') {
      status.textContent = 'Scan the QR code below with your LINE mobile app';
      setTimeout(poll, 2000);
    } else if (data.phase === 'pin_needed') {
      status.textContent = 'QR scanned! Enter the PIN in your LINE mobile app:';
      pinEl.textContent = data.pin;
      pinBox.style.display = 'block';
      setTimeout(poll, 2000);
    } else if (data.phase === 'complete') {
      status.textContent = 'Login successful! Redirecting back to Claude Code…';
      const url = new URL(redirectUri);
      url.searchParams.set('code', data.code);
      if (state) url.searchParams.set('state', state);
      window.location.href = url.toString();
    } else if (data.phase === 'failed') {
      status.innerHTML = '<span class="error">Login failed: ' + (data.error || 'unknown error') + '. Please close this window and try again.</span>';
    }
  } catch (e) {
    setTimeout(poll, 3000);
  }
}
poll();
</script>
</body>
</html>`;
}

export function mountOAuthRoutes(app: Express, deps: OAuthRouterDeps): void {
  const { base, basePath, requiredScopes, authStoreDir, credentialStore } = deps;

  // Ephemeral, login-flow-only state (never persisted, unlike StoredAuthRecord).
  const loginSessions = new Map<string, LoginSession>();
  const pendingCodes = new Map<string, PendingCode>();
  const accountSelectionSessions = new Map<string, AccountSelectionSession>();

  async function monitorLogin(sid: string): Promise<void> {
    const session = loginSessions.get(sid);
    if (!session) return;
    try {
      const pin = await session.lineClient.waitForPin();
      if (pin) {
        session.phase = 'pin_needed';
        session.pin = pin;
      }
      await session.lineClient.waitForCompletion();
      const authData = session.lineClient.getCompletedAuth();
      if (!authData) throw new Error('Login completed but no auth data returned');

      let displayName = session.selectedMid === authData.mid
        ? session.previousDisplayName
        : undefined;
      try {
        displayName = await session.lineClient.getProfileDisplayName();
      } catch {
        process.stderr.write(`[OAuth] Profile name unavailable for ${maskMid(authData.mid)}\n`);
      }

      // Credentials are persisted durably BEFORE any authorization code is
      // issued — a code that cannot later resolve fresh credentials must never
      // exist.
      try {
        await credentialStore.saveAtomic(authData, displayName);
      } catch {
        process.stderr.write(`[OAuth] Could not persist completed login for ${maskMid(authData.mid)}\n`);
        session.phase = 'failed';
        session.error = 'Unable to save LINE login securely; check DATA_DIR/auth permissions and try again.';
        return;
      }

      deps.recordRefreshedAuth(authData);
      const code = crypto.randomBytes(16).toString('hex');
      pendingCodes.set(code, {
        authData,
        codeChallenge: session.codeChallenge,
        codeChallengeMethod: session.codeChallengeMethod,
        redirectUri: session.redirectUri,
        clientId: session.clientId,
        expiresAt: Date.now() + 600_000, // 10 min
      });
      session.code = code;
      session.phase = 'complete';
    } catch (err) {
      session.phase = 'failed';
      session.error = String(err);
    }
  }

  async function startQrLogin(
    request: AuthorizationRequest,
    selected: StoredAuthRecord | null,
    res: Response,
  ): Promise<void> {
    const lineClient = new LineClient(undefined, globalThis.fetch, undefined, deps.lineApiBaseUrl);
    const { qrUrl } = await lineClient.login(selected?.certificate);
    const qrDataUrl = await QRCode.toDataURL(qrUrl);
    const sid = crypto.randomBytes(16).toString('hex');
    loginSessions.set(sid, {
      lineClient,
      ...request,
      authStoreDir,
      selectedMid: selected?.mid,
      previousDisplayName: selected?.displayName,
      phase: 'qr',
    });
    void monitorLogin(sid);
    res.type('html').send(authorizePageHtml(
      qrDataUrl,
      sid,
      request.state,
      request.redirectUri,
      basePath,
    ));
  }

  // RFC 9728 requires the well-known segment inserted before the *full* path of the
  // protected resource itself (basePath + /mcp), not just the server's base path.
  app.get(`/.well-known/oauth-protected-resource${basePath}/mcp`, (_req: Request, res: Response) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: [...requiredScopes],
    });
  });

  app.get(`/.well-known/oauth-authorization-server${basePath}`, (_req: Request, res: Response) => {
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });

  // RFC 7591 Dynamic Client Registration
  app.post(`${basePath}/register`, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const client_id = crypto.randomBytes(16).toString('hex');
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
      ...(body.redirect_uris !== undefined && { redirect_uris: body.redirect_uris }),
      ...(body.client_name !== undefined && { client_name: body.client_name }),
      ...(body.grant_types !== undefined && { grant_types: body.grant_types }),
      ...(body.response_types !== undefined && { response_types: body.response_types }),
      ...(body.scope !== undefined && { scope: body.scope }),
    });
  });

  app.get(`${basePath}/authorize`, async (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query as Record<string, string>;

    if (response_type !== 'code' || !client_id || !redirect_uri || !code_challenge) {
      res.status(400).send('Missing required OAuth parameters');
      return;
    }
    if (!isLoopbackRedirectUri(redirect_uri)) {
      res.status(400).send('redirect_uri must be a loopback (http://localhost:*/callback or http://127.0.0.1:*/callback)');
      return;
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      res.status(400).send('Only S256 code_challenge_method is supported');
      return;
    }

    const authorizationRequest: AuthorizationRequest = {
      state: state ?? '',
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method ?? 'S256',
      redirectUri: redirect_uri,
      clientId: client_id,
    };
    const records = listStoredAuthRecords(authStoreDir);

    if (records.length > 1) {
      const now = Date.now();
      for (const [sid, selection] of accountSelectionSessions) {
        if (selection.expiresAt < now) accountSelectionSessions.delete(sid);
      }
      const selectionSession = crypto.randomBytes(16).toString('hex');
      const choices = records.map(record => ({
        id: crypto.randomBytes(16).toString('hex'),
        mid: record.mid,
        label: accountLabel(record),
      }));
      accountSelectionSessions.set(selectionSession, {
        request: authorizationRequest,
        choices: new Map(choices.map(choice => [choice.id, choice.mid])),
        expiresAt: now + 600_000,
      });
      res.type('html').send(accountSelectorHtml(basePath, selectionSession, choices));
      return;
    }

    try {
      await startQrLogin(authorizationRequest, records[0] ?? null, res);
    } catch {
      process.stderr.write('[OAuth] Failed to start LINE login\n');
      res.status(500).send('Failed to start LINE login; please try again.');
    }
  });

  app.post(`${basePath}/authorize/select`, async (req: Request, res: Response) => {
    const sessionId = typeof req.body?.selection_session === 'string'
      ? req.body.selection_session : '';
    const choice = typeof req.body?.choice === 'string' ? req.body.choice : '';
    const selection = accountSelectionSessions.get(sessionId);
    accountSelectionSessions.delete(sessionId);
    if (!selection || selection.expiresAt < Date.now()) {
      res.status(400).send('Account selection expired or invalid; restart authorization.');
      return;
    }
    const mid = selection.choices.get(choice);
    const record = mid ? loadStoredAuthRecord(mid, authStoreDir) : null;
    if (!record) {
      res.status(400).send('Selected account is no longer available; restart authorization.');
      return;
    }
    try {
      await startQrLogin(selection.request, record, res);
    } catch {
      process.stderr.write('[OAuth] Failed to start LINE login\n');
      res.status(500).send('Failed to start LINE login; please try again.');
    }
  });

  app.get(`${basePath}/authorize/poll`, (req: Request, res: Response) => {
    const sid = req.query.sid as string;
    const session = loginSessions.get(sid);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      phase: session.phase,
      pin: session.pin,
      code: session.code,
      error: session.error,
    });
  });

  app.post(`${basePath}/token`, async (req: Request, res: Response) => {
    // Accept both JSON and form-encoded per RFC 6749
    const body: Record<string, string> = typeof req.body === 'string'
      ? Object.fromEntries(new URLSearchParams(req.body))
      : (req.body as Record<string, string>) ?? {};

    const { grant_type, code, code_verifier, refresh_token } = body;

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'code and code_verifier required' });
        return;
      }
      const pending = pendingCodes.get(code);
      if (!pending || pending.expiresAt < Date.now()) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or not found' });
        return;
      }
      if (s256(code_verifier) !== pending.codeChallenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      pendingCodes.delete(code);
      const { access_token, refresh_token: new_refresh } = deps.issueTokens(pending.authData);
      res.json({ access_token, refresh_token: new_refresh, token_type: 'Bearer', expires_in: 86400 });

    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
        return;
      }
      // Breaking cutover: only a well-formed, signature-valid, MID-only refresh
      // token whose account still has resolvable credentials is honoured. Legacy
      // embedded-auth refresh tokens fail the typed codec's schema check and are
      // rejected here — the client must reauthorize once.
      const issued = await deps.issueFromRefresh(refresh_token);
      if (!issued) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token not found or expired' });
        return;
      }
      res.json({ access_token: issued.access_token, refresh_token: issued.refresh_token, token_type: 'Bearer', expires_in: 86400 });

    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });
}

// The `WWW-Authenticate` challenge value pointing at the protected-resource
// metadata URL. The well-known segment sits before the full resource path
// (basePath + /mcp) per RFC 9728, on the issuer's own origin.
export function makeWwwAuthenticate(origin: string, basePath: string): string {
  return `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource${basePath}/mcp"`;
}
