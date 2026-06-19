import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import type { Express, Request, Response } from 'express';
import { LineClient, AuthData } from './line-client';

// ─── Signing key ──────────────────────────────────────────────────────────────

function loadOrCreateSecret(): string {
  const secretFile = path.join(process.env.DATA_DIR ?? process.cwd(), '.line-mcp-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret, 'utf8');
    return secret;
  }
}

const SERVER_SECRET = loadOrCreateSecret();

// ─── Token helpers ────────────────────────────────────────────────────────────

function signToken(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken<T>(token: string): T | null {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    return JSON.parse(Buffer.from(data, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

// ─── In-memory LINE credential cache (updated on LINE token refresh) ──────────

// Keyed by mid — updated via onTokenRefreshed callback in LineClient
export const latestAuthData = new Map<string, AuthData>();

// ─── Persistent credential storage ───────────────────────────────────────────

function isSafeMid(mid: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(mid);
}

export function persistAuthData(authData: AuthData): void {
  if (!isSafeMid(authData.mid)) return;
  try {
    const baseDir = process.env.DATA_DIR ?? process.cwd();
    const dir = path.resolve(baseDir, 'auth');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // enforce 0o700 even if dir already existed
    const filePath = path.resolve(dir, `${authData.mid}.json`);
    fs.writeFileSync(filePath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[OAuth] Failed to persist auth for ${authData.mid}: ${err}\n`);
  }
}

export function loadAuthFromDisk(mid: string): AuthData | null {
  if (!isSafeMid(mid)) return null;
  try {
    const baseDir = process.env.DATA_DIR ?? process.cwd();
    const authDir = path.resolve(baseDir, 'auth');
    const file = path.resolve(authDir, `${mid}.json`);
    if (!file.startsWith(authDir + path.sep)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const authData = JSON.parse(raw) as AuthData;
    if (!authData.mid || authData.mid !== mid || !authData.accessToken) return null;
    latestAuthData.set(mid, authData);
    return authData;
  } catch {
    return null;
  }
}

// ─── Test token bypass (e2e tests only) ──────────────────────────────────────

const testOverrides = new Map<string, AuthData>();

export function seedTestToken(token: string, authData: AuthData): void {
  testOverrides.set(token, authData);
}

// ─── Public token API ─────────────────────────────────────────────────────────

export function validateBearerToken(token: string): AuthData | null {
  if (testOverrides.has(token)) return testOverrides.get(token)!;
  const payload = verifyToken<{ authData: AuthData; expiresAt: number }>(token);
  if (!payload || payload.expiresAt < Date.now()) return null;
  const mid = payload.authData.mid;
  return latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? payload.authData;
}

export function issueTokens(authData: AuthData): { access_token: string; refresh_token: string } {
  const mid = authData.mid;
  const freshAuth = latestAuthData.get(mid) ?? loadAuthFromDisk(mid) ?? authData;
  const access_token = signToken({ authData: freshAuth, expiresAt: Date.now() + 86_400_000 });
  const refresh_token = signToken({ authData: freshAuth });
  return { access_token, refresh_token };
}

// ─── Login session types ──────────────────────────────────────────────────────

interface LoginSession {
  lineClient: LineClient;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  clientId: string;
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

const loginSessions = new Map<string, LoginSession>();
const pendingCodes = new Map<string, PendingCode>();

// ─── OAuth helpers ────────────────────────────────────────────────────────────

// Loopback redirect URIs allowed per RFC 8252 §7.3 — any path is valid on loopback
function isLoopbackRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

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

    latestAuthData.set(authData.mid, authData);
    persistAuthData(authData);
  } catch (err) {
    session.phase = 'failed';
    session.error = String(err);
  }
}

function authorizePageHtml(qrDataUrl: string, sid: string, state: string, redirectUri: string): string {
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
<script>
const sid = ${JSON.stringify(sid)};
const state = ${JSON.stringify(state)};
const redirectUri = ${JSON.stringify(redirectUri)};
const status = document.getElementById('status');
const pinBox = document.getElementById('pin-box');
const pinEl = document.getElementById('pin');

async function poll() {
  try {
    const res = await fetch('/authorize/poll?sid=' + encodeURIComponent(sid));
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

export function setupOAuthRoutes(app: Express, port: number): void {
  const base = `http://localhost:${port}`;

  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['line'],
    });
  });

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
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
  app.post('/register', (req: Request, res: Response) => {
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

  app.get('/authorize', async (req: Request, res: Response) => {
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

    try {
      const lineClient = new LineClient();
      const { qrUrl } = await lineClient.login();
      const qrDataUrl = await QRCode.toDataURL(qrUrl);
      const sid = crypto.randomBytes(16).toString('hex');

      loginSessions.set(sid, {
        lineClient,
        state: state ?? '',
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method ?? 'S256',
        redirectUri: redirect_uri,
        clientId: client_id,
        phase: 'qr',
      });

      monitorLogin(sid).catch((err) => {
        process.stderr.write(`[OAuth] monitorLogin error for ${sid}: ${err}\n`);
      });

      res.setHeader('Content-Type', 'text/html');
      res.send(authorizePageHtml(qrDataUrl, sid, state ?? '', redirect_uri));
    } catch (err) {
      res.status(500).send(`Failed to start LINE login: ${(err as Error).message}`);
    }
  });

  app.get('/authorize/poll', (req: Request, res: Response) => {
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

  app.post('/token', (req: Request, res: Response) => {
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
      const { access_token, refresh_token: new_refresh } = issueTokens(pending.authData);
      res.json({ access_token, refresh_token: new_refresh, token_type: 'Bearer', expires_in: 86400 });

    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token required' });
        return;
      }
      const payload = verifyToken<{ authData: AuthData }>(refresh_token);
      if (!payload?.authData) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token not found or expired' });
        return;
      }
      const { access_token, refresh_token: new_refresh } = issueTokens(payload.authData);
      res.json({ access_token, refresh_token: new_refresh, token_type: 'Bearer', expires_in: 86400 });

    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });
}

export function makeWwwAuthenticate(port: number): string {
  return `Bearer error="invalid_token", resource_metadata="http://localhost:${port}/.well-known/oauth-protected-resource"`;
}
