import * as http from 'http';
import { URL } from 'url';
import {
  MockLineState,
  type MockScenarioConfig,
  type MockReport,
} from './state';
import {
  MOCK_ACCOUNT_MID,
  MOCK_DIRECT_MID,
  MOCK_GROUP_MID,
  MOCK_BANK_SENDER_MID,
  MOCK_PIN,
  JPEG_BYTES,
} from './fixtures';
import {
  LINE_ROUTES,
  lineOk,
  lineApiError,
  lineHttpStatus,
  lineApiCode,
  readRawBody,
  validateHeaders,
  validateHmac,
  parseJsonBody,
  redact,
  timingSafeEqualString,
  type MockRawRequest,
} from './contracts';

export interface MockLineServerOptions {
  port?: number;
  controlToken: string;
  pinPollDelayMs?: number;
}

export interface MockLineServerStopOptions {
  verify?: boolean;
}

export interface MockLineServer {
  state: MockLineState;
  start(): Promise<{ origin: string; port: number }>;
  stop(options?: MockLineServerStopOptions): Promise<void>;
}

const IMAGE_ROUTES: ReadonlySet<string> = new Set<string>([
  '/fixtures/images/message-preview.jpg',
  '/fixtures/images/message-full.jpg',
]);

const CONTROL_ROUTES = new Set<string>([
  '/__mock/health',
  '/__mock/reset',
  '/__mock/configure',
  '/__mock/report',
  '/__mock/shutdown',
]);

export function createMockLineServer(options: MockLineServerOptions): MockLineServer {
  const controlToken = options.controlToken;
  const pinPollDelayMs = options.pinPollDelayMs ?? 50;
  const desiredPort = options.port ?? 0;
  const state = new MockLineState({ origin: '' });

  let server: http.Server | null = null;
  let origin = '';

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('content-length', String(payload.length));
    res.end(payload);
  }

  function rawBytes(res: http.ServerResponse, status: number, bytes: Buffer, contentType: string): void {
    res.statusCode = status;
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(bytes.length));
    res.end(bytes);
  }

  function rejectLine(
    res: http.ServerResponse,
    kind: Parameters<typeof lineApiCode>[0],
    route: string,
    diagnostic?: unknown,
  ): void {
    state.reject(kind, route, redact(diagnostic));
    const status = lineHttpStatus(kind);
    const { code, message } = lineApiCode(kind);
    json(res, status, lineApiError(code, message));
  }

  function rejectLineWithSession(
    res: http.ServerResponse,
    kind: Parameters<typeof lineApiCode>[0],
    route: string,
    authSessionId: string,
    diagnostic?: unknown,
  ): void {
    if (kind === 'illegal_transition' || kind === 'invalid_session') {
      state.abandonSession(authSessionId);
    }
    rejectLine(res, kind, route, diagnostic);
  }

  function controlAuthenticated(req: http.IncomingMessage): boolean {
    const token = req.headers['x-mock-control-token'];
    const value = Array.isArray(token) ? token[0] : token;
    if (typeof value !== 'string') return false;
    return timingSafeEqualString(value, controlToken);
  }

  async function handleControl(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!controlAuthenticated(req)) {
      json(res, 401, lineApiError(10013, 'UNAUTHORIZED'));
      return;
    }
    if (pathname === '/__mock/health') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/__mock/reset') {
      state.configure({
        scenarioId: 'reset',
        mode: 'contract',
        epochSeconds: Math.floor(Date.now() / 1000),
        expectedRefreshCount: 0,
        expectedLoginBranches: [],
        expectedRejections: {},
      });
      json(res, 200, { status: 'ok' });
      return;
    }
    if (pathname === '/__mock/configure') {
      const raw = await readRawBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        json(res, 400, lineApiError(10002, 'REQUEST_INVALID_BODY'));
        return;
      }
      try {
        const cfg = parsed.value as MockScenarioConfig;
        state.configure(cfg);
        json(res, 200, { status: 'ok' });
      } catch (err) {
        json(res, 400, lineApiError(10002, 'REQUEST_INVALID_BODY', { error: (err as Error).message }));
      }
      return;
    }
    if (pathname === '/__mock/report') {
      const report: MockReport = state.report();
      json(res, 200, report);
      return;
    }
    if (pathname === '/__mock/shutdown') {
      json(res, 200, { status: 'ok' });
      shutdown();
      return;
    }
    json(res, 404, lineApiError(10004, 'REQUEST_UNKNOWN_ROUTE'));
  }

  function isLineRoute(pathname: string): boolean {
    return Object.values(LINE_ROUTES).includes(pathname as typeof LINE_ROUTES[keyof typeof LINE_ROUTES]);
  }

  async function handleLine(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): Promise<void> {
    if (!isLineRoute(pathname)) {
      rejectLine(res, 'unknown_route', pathname);
      return;
    }
    state.recordRoute(pathname);

    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch {
      rejectLine(res, 'invalid_body', pathname, { reason: 'payload-too-large' });
      return;
    }

    if (pathname === LINE_ROUTES.refresh) {
      const h = lowerHeadersOnce(req.headers);
      if (h['x-line-access'] != null || h['x-hmac'] != null) {
        rejectLine(res, 'invalid_body', pathname, { reason: 'auth/hmac headers forbidden on refresh' });
        return;
      }
      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        rejectLine(res, parsed.rejection!, pathname);
        return;
      }
      handleRefresh(res, parsed.value);
      return;
    }

    const rawReq: MockRawRequest = {
      pathname,
      method: req.method ?? 'POST',
      headers: req.headers,
      rawBody,
    };

    const headerResult = validateHeaders(rawReq);
    if (!headerResult.ok) {
      rejectLine(res, headerResult.rejection!, pathname, headerResult.diagnostic);
      return;
    }

    const hmacResult = await validateHmac(rawReq, headerResult.accessToken);
    if (!hmacResult.ok) {
      rejectLine(res, hmacResult.rejection!, pathname);
      return;
    }

    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) {
      rejectLine(res, parsed.rejection!, pathname);
      return;
    }

    await dispatchLine(res, pathname, headerResult.accessToken, parsed.value, headerResult);
  }

  function lowerHeadersOnce(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
    return out;
  }

  async function dispatchLine(
    res: http.ServerResponse,
    pathname: string,
    accessToken: string,
    body: unknown,
    _headerResult: { longPoll: boolean; sessionId?: string },
  ): Promise<void> {
    if (pathname === LINE_ROUTES.createSession) {
      handleCreateSession(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.createQrCode) {
      handleCreateQrCode(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.checkQr) {
      handleCheckQr(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.verifyCertificate) {
      handleVerifyCertificate(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.createPin) {
      handleCreatePin(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.checkPin) {
      await handleCheckPin(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.login) {
      handleLogin(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.identity) {
      handleIdentity(res, body);
      return;
    }
    if (pathname === LINE_ROUTES.profile) {
      handleProfile(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.allChatMids) {
      handleAllChatMids(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.allContactIds) {
      handleAllContactIds(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.chats) {
      handleChats(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.contacts) {
      handleContacts(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.recent) {
      handleRecent(res, body, accessToken);
      return;
    }
    if (pathname === LINE_ROUTES.previous) {
      handlePrevious(res, body, accessToken);
      return;
    }
    rejectLine(res, 'unknown_route', pathname);
  }

  function asArray(value: unknown): unknown[] | null {
    if (!Array.isArray(value)) return null;
    return value;
  }

  function handleCreateSession(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1 || typeof arr[0] !== 'object' || arr[0] === null || Array.isArray(arr[0])) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.createSession, { expected: '[ {} ]' });
      return;
    }
    const counter = state.nextSessionCounter();
    const authSessionId = `SQ${counter}`;
    state.createSession(authSessionId);
    json(res, 200, lineOk({ authSessionId }));
  }

  function handleCreateQrCode(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.createQrCode, { expected: '[{ authSessionId }]' });
      return;
    }
    const arg = arr[0] as { authSessionId?: string } | null;
    const authSessionId = arg?.authSessionId;
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.createQrCode, { missing: 'authSessionId' });
      return;
    }
    try {
      state.requireSession(authSessionId);
      state.markQrCreated(authSessionId);
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.createQrCode, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
    const callbackUrl = `${origin}/line/qr/callback?session=${encodeURIComponent(authSessionId)}`;
    json(res, 200, lineOk({
      callbackUrl,
      longPollingMaxCount: 2,
      longPollingIntervalSec: 150,
    }));
  }

  function handleCheckQr(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.checkQr, { expected: '[{ authSessionId }]' });
      return;
    }
    const arg = arr[0] as { authSessionId?: string } | null;
    const authSessionId = arg?.authSessionId;
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.checkQr, { missing: 'authSessionId' });
      return;
    }
    try {
      state.requireSession(authSessionId);
      state.markQrVerified(authSessionId);
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.checkQr, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
    json(res, 200, lineOk({}));
  }

  function handleVerifyCertificate(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.verifyCertificate, { expected: '[{ authSessionId, certificate }]' });
      return;
    }
    const arg = arr[0] as { authSessionId?: string; certificate?: string } | null;
    const authSessionId = arg?.authSessionId;
    const certificate = arg?.certificate ?? '';
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.verifyCertificate, { missing: 'authSessionId' });
      return;
    }
    try {
      const result = state.verifyCertificate(authSessionId, String(certificate));
      if (result.accepted) {
        json(res, 200, lineOk({}));
        return;
      }
      json(res, 200, lineApiError(10051, 'CERTIFICATE_REJECTED', { code: 2, alertMessage: 'PIN required' }));
      return;
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.verifyCertificate, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
  }

  function handleCreatePin(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.createPin, { expected: '[{ authSessionId }]' });
      return;
    }
    const arg = arr[0] as { authSessionId?: string } | null;
    const authSessionId = arg?.authSessionId;
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.createPin, { missing: 'authSessionId' });
      return;
    }
    try {
      state.requireSession(authSessionId);
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.createPin, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
    json(res, 200, lineOk({ pinCode: MOCK_PIN }));
  }

  async function handleCheckPin(res: http.ServerResponse, body: unknown): Promise<void> {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.checkPin, { expected: '[{ authSessionId }]' });
      return;
    }
    const arg = arr[0] as { authSessionId?: string } | null;
    const authSessionId = arg?.authSessionId;
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.checkPin, { missing: 'authSessionId' });
      return;
    }
    try {
      state.requireSession(authSessionId);
      state.markPinVerified(authSessionId);
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.checkPin, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pinPollDelayMs));
    json(res, 200, lineOk({}));
  }

  function handleLogin(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.login, { expected: '[{ systemName, modelName, autoLoginIsRequired, authSessionId }]' });
      return;
    }
    const arg = arr[0] as {
      systemName?: string; modelName?: string; autoLoginIsRequired?: boolean; authSessionId?: string;
    } | null;
    const authSessionId = arg?.authSessionId;
    if (typeof authSessionId !== 'string' || !authSessionId) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.login, { missing: 'authSessionId' });
      return;
    }
    if (arg?.systemName !== 'CHROMEOS' || arg?.modelName !== 'CHROME' || arg?.autoLoginIsRequired !== false) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.login, { unexpected: { systemName: arg?.systemName, modelName: arg?.modelName, autoLoginIsRequired: arg?.autoLoginIsRequired } });
      return;
    }
    try {
      const issued = state.completeLogin(authSessionId);
      json(res, 200, lineOk({
        certificate: issued.certificate,
        tokenV3IssueResult: { accessToken: issued.accessToken, refreshToken: issued.refreshToken },
        mid: issued.mid,
      }));
      return;
    } catch (err) {
      const kind = extractRejectionFromError(err);
      rejectLineWithSession(res, kind, LINE_ROUTES.login, authSessionId, { authSessionId, error: (err as Error).message });
      return;
    }
  }

  function handleIdentity(res: http.ServerResponse, body: unknown): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 0) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.identity, { expected: '[]' });
      return;
    }
    json(res, 200, lineOk({
      wrappedNonce: state.fixtures.seededAuth.wrappedNonce,
      kdfParameter1: state.fixtures.seededAuth.kdfParameter1,
      kdfParameter2: state.fixtures.seededAuth.kdfParameter2,
    }));
  }

  function requireCurrentAccess(res: http.ServerResponse, route: string, accessToken: string): boolean {
    const auth = state.authenticateAccess(accessToken);
    if (auth.kind === 'current') return true;
    let kind: Parameters<typeof lineApiCode>[0];
    if (auth.kind === 'unknown') kind = 'unknown_access_token';
    else if (auth.kind === 'expired') kind = 'expired_access_token';
    else kind = 'superseded_access_token';
    rejectLine(res, kind, route, { mid: auth.mid });
    return false;
  }

  function handleProfile(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1 || arr[0] !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.profile, { expected: '[2]' });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.profile, accessToken)) return;
    json(res, 200, lineOk({ mid: MOCK_ACCOUNT_MID, displayName: 'Mock LINE Account' }));
  }

  function handleAllChatMids(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.allChatMids, { expected: '[{ withMemberChats, withInvitedChats }, 2]' });
      return;
    }
    const arg = arr[0] as { withMemberChats?: boolean; withInvitedChats?: boolean } | null;
    if (arg?.withMemberChats !== true || arg?.withInvitedChats !== true || arr[1] !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.allChatMids, { unexpected: arr });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.allChatMids, accessToken)) return;
    json(res, 200, lineOk({
      memberChatMids: [MOCK_GROUP_MID],
      invitedChatMids: [] as string[],
    }));
  }

  function handleAllContactIds(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1 || arr[0] !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.allContactIds, { expected: '[2]' });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.allContactIds, accessToken)) return;
    json(res, 200, lineOk([MOCK_DIRECT_MID]));
  }

  function handleChats(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.chats, { expected: '[{ chatMids }, 2]' });
      return;
    }
    const arg = arr[0] as { chatMids?: string[] } | null;
    const chatMids = arg?.chatMids;
    if (!Array.isArray(chatMids) || arr[1] !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.chats, { unexpected: arr });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.chats, accessToken)) return;
    const known = new Set<string>(Object.keys(state.fixtures.messagesByChat));
    const chats = chatMids
      .filter((m): m is string => typeof m === 'string' && known.has(m))
      .map((mid) => ({
        chatMid: mid,
        chatName: mid === MOCK_GROUP_MID ? 'Mock Bank Group' : mid,
        memberCount: 2,
        picturePath: mid === MOCK_GROUP_MID ? '/mock-group-picture.png' : undefined,
      }));
    json(res, 200, lineOk({ chats }));
  }

  function handleContacts(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.contacts, { expected: '[{ targetUserMids }]' });
      return;
    }
    const arg = arr[0] as { targetUserMids?: string[] } | null;
    const mids = arg?.targetUserMids;
    if (!Array.isArray(mids) || mids.length === 0 || mids.length > 50) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.contacts, { unexpected: arr });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.contacts, accessToken)) return;
    const knownContacts: Record<string, { displayName: string }> = {
      [MOCK_DIRECT_MID]: { displayName: 'Alice Mock' },
      [MOCK_BANK_SENDER_MID]: { displayName: 'Mock Bank' },
    };
    const contacts: Record<string, { contact: { mid: string; displayName: string } }> = {};
    for (const mid of mids) {
      const known = knownContacts[mid];
      if (known) {
        contacts[mid] = { contact: { mid, displayName: known.displayName } };
      }
    }
    json(res, 200, lineOk({ contacts }));
  }

  function handleRecent(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.recent, { expected: '[chatMid, count]' });
      return;
    }
    const chatMid = arr[0];
    const count = arr[1];
    if (typeof chatMid !== 'string' || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 200) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.recent, { unexpected: arr });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.recent, accessToken)) return;
    const history = state.fixtures.messagesByChat[chatMid];
    if (!history) {
      rejectLine(res, 'invalid_session', LINE_ROUTES.recent, { unknownChatMid: chatMid });
      return;
    }
    const slice = history.slice(-count).reverse();
    json(res, 200, lineOk(slice));
  }

  function handlePrevious(res: http.ServerResponse, body: unknown, accessToken: string): void {
    const arr = asArray(body);
    if (!arr || arr.length !== 2) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.previous, { expected: '[{ messageBoxId, endMessageId, messagesCount }, 1]' });
      return;
    }
    const arg = arr[0] as {
      messageBoxId?: string;
      endMessageId?: { messageId: string; deliveredTime: string };
      messagesCount?: number;
    } | null;
    const chatMid = arg?.messageBoxId;
    const endMessageId = arg?.endMessageId;
    const messagesCount = arg?.messagesCount;
    if (typeof chatMid !== 'string' || !endMessageId || typeof endMessageId.messageId !== 'string' ||
        typeof endMessageId.deliveredTime !== 'string' || typeof messagesCount !== 'number' || arr[1] !== 1) {
      rejectLine(res, 'invalid_body', LINE_ROUTES.previous, { unexpected: arr });
      return;
    }
    if (!requireCurrentAccess(res, LINE_ROUTES.previous, accessToken)) return;
    const history = state.fixtures.messagesByChat[chatMid];
    if (!history) {
      rejectLine(res, 'unknown_boundary', LINE_ROUTES.previous, { unknownChatMid: chatMid });
      return;
    }
    const boundaryIdx = history.findIndex((m) => m.id === endMessageId.messageId);
    if (boundaryIdx === -1) {
      rejectLine(res, 'unknown_boundary', LINE_ROUTES.previous, { unknownMessageId: endMessageId.messageId });
      return;
    }
    if (boundaryIdx === 0) {
      json(res, 200, lineOk([]));
      return;
    }
    const start = Math.max(0, boundaryIdx - messagesCount + 1);
    const slice = history.slice(start, boundaryIdx + 1).reverse();
    json(res, 200, lineOk(slice));
  }

  function handleRefresh(res: http.ServerResponse, body: unknown): void {
    const obj = body as { refreshToken?: string } | null;
    if (!obj || typeof obj !== 'object' || typeof obj.refreshToken !== 'string') {
      rejectLine(res, 'invalid_body', LINE_ROUTES.refresh, { expected: '{ refreshToken }' });
      return;
    }
    const auth = state.refresh(obj.refreshToken);
    if (!auth) {
      rejectLine(res, 'unknown_refresh_token', LINE_ROUTES.refresh, {});
      return;
    }
    json(res, 200, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
  }

  function extractRejectionFromError(err: Error): Parameters<typeof lineApiCode>[0] {
    const msg = err.message;
    if (msg.startsWith('unknown authSessionId')) return 'invalid_session';
    if (msg.startsWith('illegal transition')) return 'illegal_transition';
    return 'invalid_body';
  }

  async function handleImage(res: http.ServerResponse, pathname: string): Promise<void> {
    if (!IMAGE_ROUTES.has(pathname)) {
      json(res, 404, lineApiError(10004, 'REQUEST_UNKNOWN_ROUTE'));
      return;
    }
    rawBytes(res, 200, JPEG_BYTES, 'image/jpeg');
  }

  const requestHandler = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const pathname = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      if (CONTROL_ROUTES.has(pathname)) {
        await handleControl(req, res, pathname);
        return;
      }
      if (IMAGE_ROUTES.has(pathname) && method === 'GET') {
        await handleImage(res, pathname);
        return;
      }
      if (method === 'POST' && (isLineRoute(pathname) || true)) {
        await handleLine(req, res, pathname);
        return;
      }
      json(res, 404, lineApiError(10004, 'REQUEST_UNKNOWN_ROUTE'));
    } catch (err) {
      try {
        json(res, 500, lineApiError(10099, 'INTERNAL_ERROR', { error: (err as Error).message }));
      } catch {
        res.end();
      }
    }
  };

  function shutdown(): void {
    if (server) {
      server.close();
      server = null;
    }
  }

  async function start(): Promise<{ origin: string; port: number }> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        Promise.resolve(requestHandler(req, res)).catch((err) => {
          try {
            json(res, 500, lineApiError(10099, 'INTERNAL_ERROR', { error: (err as Error).message }));
          } catch {
            res.end();
          }
        });
      });
      srv.on('error', reject);
      srv.listen(desiredPort, '127.0.0.1', () => {
        const addr = srv.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('failed to bind'));
          return;
        }
        server = srv;
        origin = `http://127.0.0.1:${addr.port}`;
        state.setOrigin(origin);
        resolve({ origin, port: addr.port });
      });
    });
  }

  async function stop(stopOptions?: MockLineServerStopOptions): Promise<void> {
    if (stopOptions?.verify) {
      state.verifyFinal();
    }
    shutdown();
  }

  return { state, start, stop };
}