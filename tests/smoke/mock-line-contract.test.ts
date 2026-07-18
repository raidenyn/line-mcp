import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signForAccount } from '@raidenyn/line-client';
import { createMockLineServer, type MockLineServer } from '../support/mock-line-server/server';
import { VALID_STORAGE_KEY, MOCK_GROUP_MID, MOCK_DIRECT_MID, MOCK_ACCOUNT_MID, MOCK_PIN, JPEG_BYTES } from '../support/mock-line-server/fixtures';
import { REQUIRED_LINE_HEADERS } from '../support/mock-line-server/contracts';
import { MockLineState } from '../support/mock-line-server/state';
import { buildMockFixtures } from '../support/mock-line-server/fixtures';

const epochSeconds = Math.floor(Date.now() / 1000);
const fixtures = buildMockFixtures({ origin: 'http://127.0.0.1:19090', epochSeconds });

let mock: MockLineServer;
let origin: string;

async function signedPost(pathname: string, body: string, accessToken = ''): Promise<Response> {
  const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken, path: pathname, body });
  return fetch(origin + pathname, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US',
      'content-type': 'application/json',
      origin: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'x-lal': 'en_US',
      'x-line-chrome-version': '3.7.2',
      'x-hmac': hmac,
      ...(accessToken ? { 'x-line-access': accessToken } : {}),
    },
    body,
  });
}

async function signedPostLongPoll(pathname: string, body: string, authSessionId: string): Promise<Response> {
  const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken: '', path: pathname, body });
  return fetch(origin + pathname, {
    method: 'POST',
    headers: {
      ...REQUIRED_LINE_HEADERS,
      'x-hmac': hmac,
      'x-lst': '150000',
      'x-line-session-id': authSessionId,
    },
    body,
  });
}

async function signedPostWithHeaders(
  pathname: string,
  body: string,
  headerOverrides: Record<string, string>,
  accessToken = '',
): Promise<Response> {
  const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken, path: pathname, body });
  return fetch(origin + pathname, {
    method: 'POST',
    headers: {
      ...REQUIRED_LINE_HEADERS,
      'x-hmac': hmac,
      ...(accessToken ? { 'x-line-access': accessToken } : {}),
      ...headerOverrides,
    },
    body,
  });
}

async function signedPostLongPollWithHeaders(
  pathname: string,
  body: string,
  headerOverrides: Record<string, string>,
): Promise<Response> {
  const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken: '', path: pathname, body });
  return fetch(origin + pathname, {
    method: 'POST',
    headers: {
      ...REQUIRED_LINE_HEADERS,
      'x-hmac': hmac,
      'x-lst': '150000',
      ...headerOverrides,
    },
    body,
  });
}

function controlHeaders(): Record<string, string> {
  return { 'x-mock-control-token': 'contract-control-token' };
}

beforeAll(async () => {
  mock = createMockLineServer({ port: 0, controlToken: 'contract-control-token', pinPollDelayMs: 50 });
  ({ origin } = await mock.start());
});

afterAll(async () => {
  await mock.stop({ verify: false });
});

describe('mock LINE fixtures and state', () => {
  it('provides deterministic paginated message and image data', () => {
    expect(fixtures.messagesByChat[MOCK_GROUP_MID]).toHaveLength(205);
    expect(fixtures.messagesByChat[MOCK_GROUP_MID].at(-1)?.contentType).toBe(1);
    expect(fixtures.image.previewUrl).toBe('http://127.0.0.1:19090/fixtures/images/message-preview.jpg');
    expect(MOCK_PIN).toBe('592130');
  });

  it('rotates seeded credentials and supersedes the old pair', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-refresh', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
    });
    const oldAccess = state.fixtures.seededAuth.accessToken;
    const oldRefresh = state.fixtures.seededAuth.refreshToken;

    const rotated = state.refresh(oldRefresh);

    expect(rotated).not.toBeNull();
    expect(state.authenticateAccess(oldAccess).kind).toBe('superseded');
    expect(state.authenticateAccess(rotated!.accessToken).kind).toBe('current');
    expect(state.report().refreshCount).toBe(1);
  });

  it('requires the PIN branch before first login and accepts the issued certificate next', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-login', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
    });

    const first = state.createSession();
    state.markQrCreated(first.authSessionId);
    state.markQrVerified(first.authSessionId);
    expect(state.verifyCertificate(first.authSessionId, '')).toEqual({ accepted: false, pinRequired: true });
    state.markPinCreated(first.authSessionId);
    state.markPinVerified(first.authSessionId);
    const issued = state.completeLogin(first.authSessionId);

    const second = state.createSession();
    state.markQrCreated(second.authSessionId);
    state.markQrVerified(second.authSessionId);
    expect(state.verifyCertificate(second.authSessionId, issued.certificate)).toEqual({ accepted: true, pinRequired: false });
  });

  it('distinguishes end-of-history from a foreign boundary', () => {
    const state = new MockLineState({ origin: 'http://127.0.0.1:19090' });
    state.configure({
      scenarioId: 'state-boundary', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const history = fixtures.messagesByChat[MOCK_GROUP_MID];
    const oldest = history[0];

    expect(state.resolveBoundary(MOCK_GROUP_MID, oldest.id, oldest.deliveredTime!)).toMatchObject({ kind: 'end' });
    expect(state.resolveBoundary(MOCK_GROUP_MID, 'missing', '0')).toEqual({ kind: 'invalid' });
  });
});

describe('mock LINE HTTP contract', () => {
  it('accepts an exact createSession body signed over raw bytes', async () => {
    mock.state.configure({
      scenarioId: 'valid-create-session', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const response = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, data: { authSessionId: expect.stringMatching(/^SQ/) } });
  });

  it('rejects a wrong HMAC and records the configured rejection', async () => {
    mock.state.configure({
      scenarioId: 'bad-hmac', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_hmac: 1 },
    });
    const response = await fetch(origin + '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': Buffer.alloc(32).toString('base64') },
      body: '[{}]',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10005, message: 'REQUEST_INVALID_HMAC' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a missing HMAC header', async () => {
    mock.state.configure({
      scenarioId: 'missing-hmac', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { missing_hmac: 1 },
    });
    const response = await fetch(origin + '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS },
      body: '[{}]',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10005, message: 'REQUEST_MISSING_HMAC' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an unknown route', async () => {
    mock.state.configure({
      scenarioId: 'unknown-route', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_route: 1 },
    });
    const response = await signedPost('/api/talk/thrift/Talk/TalkService/unknownRoute', '[]');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 10004, message: 'REQUEST_UNKNOWN_ROUTE' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an invalid JSON body', async () => {
    mock.state.configure({
      scenarioId: 'invalid-body', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const hmac = await signForAccount(VALID_STORAGE_KEY, {
      accessToken: '',
      path: '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      body: 'not-json',
    });
    const response = await fetch(origin + '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': hmac },
      body: 'not-json',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a post-auth request missing the x-line-access header', async () => {
    mock.state.configure({
      scenarioId: 'missing-auth', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { missing_auth_header: 1 },
    });
    const path = '/api/talk/thrift/Talk/TalkService/getProfile';
    const body = '[2]';
    const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken: '', path, body });
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': hmac },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10003, message: 'REQUEST_MISSING_AUTH' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an unknown access token', async () => {
    mock.state.configure({
      scenarioId: 'unknown-access', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_access_token: 1 },
    });
    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      'unknown-token',
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10006, message: 'REQUEST_UNKNOWN_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an expired access token', async () => {
    mock.state.configure({
      scenarioId: 'expired-access', mode: 'contract', epochSeconds: epochSeconds - 100000,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { expired_access_token: 1 },
    });
    const expiredAccess = mock.state.fixtures.seededAuth.accessToken;
    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      expiredAccess,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10007, message: 'REQUEST_EXPIRED_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a superseded access token after refresh', async () => {
    mock.state.configure({
      scenarioId: 'superseded-access', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: { superseded_access_token: 1 },
    });
    const oldRefresh = mock.state.fixtures.seededAuth.refreshToken;
    const oldAccess = mock.state.fixtures.seededAuth.accessToken;
    const refreshResponse = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers: REQUIRED_LINE_HEADERS,
      body: JSON.stringify({ refreshToken: oldRefresh }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshData = await refreshResponse.json() as { accessToken: string; refreshToken: string };
    expect(refreshData.accessToken).not.toBe(oldAccess);

    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      oldAccess,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10008, message: 'REQUEST_SUPERSEDED_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an unknown refresh token', async () => {
    mock.state.configure({
      scenarioId: 'unknown-refresh', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_refresh_token: 1 },
    });
    const response = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers: REQUIRED_LINE_HEADERS,
      body: JSON.stringify({ refreshToken: 'not-a-known-refresh' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10009, message: 'REQUEST_UNKNOWN_REFRESH_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an unknown authSessionId', async () => {
    mock.state.configure({
      scenarioId: 'invalid-session', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_session: 1 },
    });
    const path = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode';
    const body = JSON.stringify([{ authSessionId: 'not-a-session' }]);
    const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken: '', path, body });
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': hmac },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10010, message: 'REQUEST_INVALID_SESSION' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an illegal session transition', async () => {
    mock.state.configure({
      scenarioId: 'illegal-transition', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { illegal_transition: 1 },
    });
    const createResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
    );
    const created = await createResponse.json() as { code: number; data: { authSessionId: string } };
    const authSessionId = created.data.authSessionId;
    const path = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate';
    const body = JSON.stringify([{ authSessionId, certificate: '' }]);
    const hmac = await signForAccount(VALID_STORAGE_KEY, { accessToken: '', path, body });
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'x-hmac': hmac },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10011, message: 'REQUEST_ILLEGAL_TRANSITION' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects an invalid pagination boundary', async () => {
    mock.state.configure({
      scenarioId: 'unknown-boundary', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_boundary: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const body = JSON.stringify([
      { messageBoxId: MOCK_GROUP_MID, endMessageId: { messageId: 'foreign-id', deliveredTime: '0' }, messagesCount: 50 },
      1,
    ]);
    const path = '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest';
    const response = await signedPost(path, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10012, message: 'REQUEST_UNKNOWN_BOUNDARY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('performs a full PIN login sequence over HTTP', async () => {
    mock.state.configure({
      scenarioId: 'full-pin-login', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin'], expectedRejections: {},
    });

    const createResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
    );
    const created = await createResponse.json() as { code: number; data: { authSessionId: string } };
    const authSessionId = created.data.authSessionId;
    expect(authSessionId).toMatch(/^SQ/);

    const qrBody = JSON.stringify([{ authSessionId }]);
    const qrResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode',
      qrBody,
    );
    const qrData = await qrResponse.json() as { code: number; data: { callbackUrl: string; longPollingMaxCount: number; longPollingIntervalSec: number } };
    expect(qrData.code).toBe(0);
    expect(qrData.data).toMatchObject({ longPollingMaxCount: 2, longPollingIntervalSec: 150 });
    expect(qrData.data.callbackUrl).toMatch(/^https?:\/\//);

    const checkQrResponse = await signedPostLongPoll(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
      JSON.stringify([{ authSessionId }]),
      authSessionId,
    );
    expect(checkQrResponse.status).toBe(200);
    expect(await checkQrResponse.json()).toMatchObject({ code: 0, data: {} });

    const certBody = JSON.stringify([{ authSessionId, certificate: '' }]);
    const certResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate',
      certBody,
    );
    expect(certResponse.status).toBe(200);
    expect(await certResponse.json()).toMatchObject({ code: 10051, message: expect.any(String), data: { code: 2 } });

    const pinResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode',
      JSON.stringify([{ authSessionId }]),
    );
    const pinData = await pinResponse.json() as { code: number; data: { pinCode: string } };
    expect(pinData.code).toBe(0);
    expect(pinData.data.pinCode).toBe(MOCK_PIN);

    const checkPinResponse = await signedPostLongPoll(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified',
      JSON.stringify([{ authSessionId }]),
      authSessionId,
    );
    expect(checkPinResponse.status).toBe(200);
    expect(await checkPinResponse.json()).toMatchObject({ code: 0, data: {} });

    const loginBody = JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]);
    const loginResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
      loginBody,
    );
    const loginData = await loginResponse.json() as { code: number; data: { certificate: string; tokenV3IssueResult: { accessToken: string; refreshToken: string }; mid: string } };
    expect(loginData.code).toBe(0);
    expect(loginData.data.mid).toBe(MOCK_ACCOUNT_MID);
    expect(loginData.data.certificate).toBeTruthy();
    expect(loginData.data.tokenV3IssueResult.accessToken).toBeTruthy();
    expect(loginData.data.tokenV3IssueResult.refreshToken).toBeTruthy();

    const identityResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
      '[]',
      loginData.data.tokenV3IssueResult.accessToken,
    );
    const identityData = await identityResponse.json() as { code: number; data: { wrappedNonce: string; kdfParameter1: string; kdfParameter2: string } };
    expect(identityData.code).toBe(0);
    expect(identityData.data).toMatchObject({
      wrappedNonce: VALID_STORAGE_KEY.wrappedNonce,
      kdfParameter1: VALID_STORAGE_KEY.kdfParameter1,
      kdfParameter2: VALID_STORAGE_KEY.kdfParameter2,
    });

    expect(mock.state.report().ok).toBe(true);
  });

  it('performs a certificate login sequence over HTTP after a PIN login registers the cert', async () => {
    mock.state.configure({
      scenarioId: 'cert-login', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
    });

    const create1 = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', '[ {} ]');
    const id1 = (await create1.json() as { data: { authSessionId: string } }).data.authSessionId;
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode', JSON.stringify([{ authSessionId: id1 }]));
    await signedPostLongPoll('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified', JSON.stringify([{ authSessionId: id1 }]), id1);
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate', JSON.stringify([{ authSessionId: id1, certificate: '' }]));
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode', JSON.stringify([{ authSessionId: id1 }]));
    await signedPostLongPoll('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified', JSON.stringify([{ authSessionId: id1 }]), id1);
    const login1 = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2', JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId: id1 }]));
    const cert = (await login1.json() as { data: { certificate: string } }).data.certificate;

    const create2 = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', '[ {} ]');
    const id2 = (await create2.json() as { data: { authSessionId: string } }).data.authSessionId;
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode', JSON.stringify([{ authSessionId: id2 }]));
    await signedPostLongPoll('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified', JSON.stringify([{ authSessionId: id2 }]), id2);

    const certOk = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate', JSON.stringify([{ authSessionId: id2, certificate: cert }]));
    expect(certOk.status).toBe(200);
    expect(await certOk.json()).toMatchObject({ code: 0, data: {} });

    const login2 = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2', JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId: id2 }]));
    const login2Data = await login2.json() as { code: number; data: { mid: string } };
    expect(login2Data.code).toBe(0);
    expect(login2Data.data.mid).toBe(MOCK_ACCOUNT_MID);

    expect(mock.state.report().ok).toBe(true);
  });

  it('rotates the token pair via /api/auth/tokenRefresh', async () => {
    mock.state.configure({
      scenarioId: 'refresh-rotation', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
    });
    const oldRefresh = mock.state.fixtures.seededAuth.refreshToken;
    const response = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers: REQUIRED_LINE_HEADERS,
      body: JSON.stringify({ refreshToken: oldRefresh }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { accessToken: string; refreshToken: string };
    expect(data.accessToken).toBe(mock.state.fixtures.tokenFixtures.rotatedAccessToken);
    expect(data.refreshToken).toBe(mock.state.fixtures.tokenFixtures.rotatedRefreshToken);
    expect(mock.state.report().ok).toBe(true);
  });

  it('returns list/chat/contact response shapes', async () => {
    mock.state.configure({
      scenarioId: 'list-shapes', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;

    const chatMidsResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getAllChatMids',
      JSON.stringify([{ withMemberChats: true, withInvitedChats: true }, 2]),
      accessToken,
    );
    const chatMidsData = await chatMidsResponse.json() as { code: number; data: { memberChatMids: string[]; invitedChatMids: string[] } };
    expect(chatMidsData.code).toBe(0);
    expect(chatMidsData.data.memberChatMids).toEqual([MOCK_GROUP_MID]);
    expect(chatMidsData.data.invitedChatMids).toEqual([]);

    const contactIdsResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getAllContactIds',
      '[2]',
      accessToken,
    );
    const contactIdsData = await contactIdsResponse.json() as { code: number; data: string[] };
    expect(contactIdsData.code).toBe(0);
    expect(contactIdsData.data).toEqual([MOCK_DIRECT_MID]);

    const chatsResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getChats',
      JSON.stringify([{ chatMids: [MOCK_GROUP_MID] }, 2]),
      accessToken,
    );
    const chatsData = await chatsResponse.json() as { code: number; data: { chats: Array<{ chatMid: string; chatName: string; memberCount: number; picturePath?: string }> } };
    expect(chatsData.code).toBe(0);
    expect(chatsData.data.chats).toHaveLength(1);
    expect(chatsData.data.chats[0]).toMatchObject({ chatMid: MOCK_GROUP_MID, chatName: 'Mock Bank Group', memberCount: 2 });

    const contactsResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getContactsV2',
      JSON.stringify([{ targetUserMids: [MOCK_DIRECT_MID] }]),
      accessToken,
    );
    const contactsData = await contactsResponse.json() as { code: number; data: { contacts: Record<string, { contact: { mid: string; displayName: string } }> } };
    expect(contactsData.code).toBe(0);
    expect(contactsData.data.contacts[MOCK_DIRECT_MID].contact).toMatchObject({ mid: MOCK_DIRECT_MID, displayName: 'Alice Mock' });

    const profileResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      accessToken,
    );
    const profileData = await profileResponse.json() as { code: number; data: { mid: string; displayName: string } };
    expect(profileData.code).toBe(0);
    expect(profileData.data).toMatchObject({ mid: MOCK_ACCOUNT_MID, displayName: 'Mock LINE Account' });

    expect(mock.state.report().ok).toBe(true);
  });

  it('returns recent messages newest-first honoring count', async () => {
    mock.state.configure({
      scenarioId: 'recent', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];

    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2',
      JSON.stringify([MOCK_GROUP_MID, 3]),
      accessToken,
    );
    const data = await response.json() as { code: number; data: Array<{ id: string; createdTime: string }> };
    expect(data.code).toBe(0);
    expect(data.data).toHaveLength(3);
    expect(data.data[0].id).toBe(history[history.length - 1].id);
    expect(data.data[2].id).toBe(history[history.length - 3].id);
    expect(mock.state.report().ok).toBe(true);
  });

  it('returns boundary-inclusive previous pages and re-includes the boundary', async () => {
    mock.state.configure({
      scenarioId: 'previous', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];

    const recentResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2',
      JSON.stringify([MOCK_GROUP_MID, 3]),
      accessToken,
    );
    const recentData = await recentResponse.json() as { code: number; data: Array<{ id: string; createdTime: string; deliveredTime: string }> };
    const boundary = recentData.data[recentData.data.length - 1];

    const prevBody = JSON.stringify([
      { messageBoxId: MOCK_GROUP_MID, endMessageId: { messageId: boundary.id, deliveredTime: boundary.createdTime }, messagesCount: 3 },
      1,
    ]);
    const prevResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
      prevBody,
      accessToken,
    );
    const prevData = await prevResponse.json() as { code: number; data: Array<{ id: string }> };
    expect(prevData.code).toBe(0);
    expect(prevData.data).toHaveLength(3);
    expect(prevData.data[0].id).toBe(boundary.id);
    const boundaryIndex = history.findIndex((m) => m.id === boundary.id);
    expect(prevData.data[1].id).toBe(history[boundaryIndex - 1].id);
    expect(prevData.data[2].id).toBe(history[boundaryIndex - 2].id);
    expect(mock.state.report().ok).toBe(true);
  });

  it('returns an empty page at the end of history', async () => {
    mock.state.configure({
      scenarioId: 'previous-end', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];
    const oldest = history[0];

    const prevBody = JSON.stringify([
      { messageBoxId: MOCK_GROUP_MID, endMessageId: { messageId: oldest.id, deliveredTime: oldest.createdTime }, messagesCount: 3 },
      1,
    ]);
    const prevResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest',
      prevBody,
      accessToken,
    );
    const prevData = await prevResponse.json() as { code: number; data: unknown[] };
    expect(prevData.code).toBe(0);
    expect(prevData.data).toEqual([]);
    expect(mock.state.report().ok).toBe(true);
  });

  it('serves exact JPEG bytes from both image routes', async () => {
    mock.state.configure({
      scenarioId: 'images', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
    });
    const previewResponse = await fetch(origin + '/fixtures/images/message-preview.jpg');
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await previewResponse.arrayBuffer())).toEqual(JPEG_BYTES);

    const fullResponse = await fetch(origin + '/fixtures/images/message-full.jpg');
    expect(fullResponse.status).toBe(200);
    expect(fullResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await fullResponse.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('requires a control token on control routes', async () => {
    const noToken = await fetch(origin + '/__mock/health');
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(origin + '/__mock/health', { headers: { 'x-mock-control-token': 'wrong' } });
    expect(wrongToken.status).toBe(401);

    const ok = await fetch(origin + '/__mock/health', { headers: controlHeaders() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'ok' });
  });

  it('configures and reports via control routes', async () => {
    const configureResponse = await fetch(origin + '/__mock/configure', {
      method: 'POST',
      headers: { ...controlHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'control-configured',
        mode: 'contract',
        epochSeconds,
        expectedRefreshCount: 0,
        expectedLoginBranches: [],
        expectedRejections: {},
      }),
    });
    expect(configureResponse.status).toBe(200);

    const reportResponse = await fetch(origin + '/__mock/report', { headers: controlHeaders() });
    expect(reportResponse.status).toBe(200);
    const report = await reportResponse.json();
    expect(report).toMatchObject({ scenarioId: 'control-configured', ok: true });
  });

  it('resets state via the control route', async () => {
    await fetch(origin + '/__mock/configure', {
      method: 'POST',
      headers: { ...controlHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        scenarioId: 'before-reset', mode: 'contract', epochSeconds,
        expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: {},
      }),
    });
    const resetResponse = await fetch(origin + '/__mock/reset', { method: 'POST', headers: controlHeaders() });
    expect(resetResponse.status).toBe(200);
    const report = await (await fetch(origin + '/__mock/report', { headers: controlHeaders() })).json();
    expect(report.scenarioId).not.toBe('before-reset');
  });
});

describe('mock LINE strict header value validation', () => {
  it('rejects a wrong x-line-chrome-version value', async () => {
    mock.state.configure({
      scenarioId: 'wrong-chrome-version', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const response = await signedPostWithHeaders(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
      { 'x-line-chrome-version': '9.9.9' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a wrong origin value', async () => {
    mock.state.configure({
      scenarioId: 'wrong-origin', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const response = await signedPostWithHeaders(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
      { origin: 'chrome-extension://evil' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a wrong x-lst value on long-poll routes', async () => {
    mock.state.configure({
      scenarioId: 'wrong-lst', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    // Header validation (including x-lst) runs before any session lookup, so an
    // unknown authSessionId in the body is fine — the request never reaches the
    // session phase.
    const response = await signedPostLongPollWithHeaders(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
      JSON.stringify([{ authSessionId: 'unused-sid' }]),
      { 'x-line-session-id': 'unused-sid', 'x-lst': '999' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects a mismatched x-line-session-id on long-poll routes', async () => {
    mock.state.configure({
      scenarioId: 'wrong-session-id', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_session: 1 },
    });
    // The session-id mismatch check runs after headers+hmac+JSON validation and
    // abandons the body's session before rejecting, so no unresolved session
    // remains. Use an unknown authSessionId — the mismatch is detected first.
    const response = await signedPostLongPollWithHeaders(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
      JSON.stringify([{ authSessionId: 'body-sid' }]),
      { 'x-line-session-id': 'header-sid' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10010, message: 'REQUEST_INVALID_SESSION' });
    expect(mock.state.report().ok).toBe(true);
  });
});

describe('mock LINE strict body key validation', () => {
  it('rejects extra keys in createSession body', async () => {
    mock.state.configure({
      scenarioId: 'create-session-extra', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const response = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ { unexpected: true } ]',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects extra keys in login body', async () => {
    mock.state.configure({
      scenarioId: 'login-extra', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    // The login handler validates exact body keys before consulting the
    // session, so an unknown authSessionId avoids leaving an unresolved session.
    const body = JSON.stringify([{
      systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false,
      authSessionId: 'never-registered', extra: 'nope',
    }]);
    const response = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
      body,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects extra keys in refresh body', async () => {
    mock.state.configure({
      scenarioId: 'refresh-extra', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const oldRefresh = mock.state.fixtures.seededAuth.refreshToken;
    const response = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers: REQUIRED_LINE_HEADERS,
      body: JSON.stringify({ refreshToken: oldRefresh, extra: 'nope' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });
});

describe('mock LINE identity requires the current access token', () => {
  it('rejects identity with no access token', async () => {
    mock.state.configure({
      scenarioId: 'identity-no-token', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { missing_auth_header: 1 },
    });
    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
      '[]',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10003, message: 'REQUEST_MISSING_AUTH' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects identity with a wrong access token', async () => {
    mock.state.configure({
      scenarioId: 'identity-wrong-token', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_access_token: 1 },
    });
    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
      '[]',
      'definitely-not-a-known-token',
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10006, message: 'REQUEST_UNKNOWN_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('accepts identity with the current access token after a PIN login', async () => {
    mock.state.configure({
      scenarioId: 'identity-ok', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin'], expectedRejections: {},
    });
    const createResponse = await signedPost(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
    );
    const authSessionId = (await createResponse.json() as { data: { authSessionId: string } }).data.authSessionId;
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode', JSON.stringify([{ authSessionId }]));
    await signedPostLongPoll('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified', JSON.stringify([{ authSessionId }]), authSessionId);
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate', JSON.stringify([{ authSessionId, certificate: '' }]));
    await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode', JSON.stringify([{ authSessionId }]));
    await signedPostLongPoll('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified', JSON.stringify([{ authSessionId }]), authSessionId);
    const loginResponse = await signedPost('/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2', JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]));
    const loginData = await loginResponse.json() as { data: { tokenV3IssueResult: { accessToken: string } } };
    const accessToken = loginData.data.tokenV3IssueResult.accessToken;

    const identityResponse = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
      '[]',
      accessToken,
    );
    const identityData = await identityResponse.json() as { code: number; data: { wrappedNonce: string; kdfParameter1: string; kdfParameter2: string } };
    expect(identityData.code).toBe(0);
    expect(identityData.data).toMatchObject({
      wrappedNonce: VALID_STORAGE_KEY.wrappedNonce,
      kdfParameter1: VALID_STORAGE_KEY.kdfParameter1,
      kdfParameter2: VALID_STORAGE_KEY.kdfParameter2,
    });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects identity with the seeded access token (no login issued it)', async () => {
    mock.state.configure({
      scenarioId: 'identity-seeded-token', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { unknown_access_token: 1 },
    });
    const seededAccess = mock.state.fixtures.seededAuth.accessToken;
    const response = await signedPost(
      '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3',
      '[]',
      seededAccess,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10006, message: 'REQUEST_UNKNOWN_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects identity with a prior login token after a second login (superseded)', async () => {
    mock.state.configure({
      scenarioId: 'identity-superseded', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'pin'], expectedRejections: { superseded_access_token: 1 },
    });
    const identityPath = '/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3';
    const createSessionPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession';
    const createQrPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode';
    const checkQrPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified';
    const verifyCertPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate';
    const createPinPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode';
    const checkPinPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified';
    const loginPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2';

    async function runPinLogin(): Promise<string> {
      const created = await signedPost(createSessionPath, '[ {} ]');
      const authSessionId = (await created.json() as { data: { authSessionId: string } }).data.authSessionId;
      await signedPost(createQrPath, JSON.stringify([{ authSessionId }]));
      await signedPostLongPoll(checkQrPath, JSON.stringify([{ authSessionId }]), authSessionId);
      await signedPost(verifyCertPath, JSON.stringify([{ authSessionId, certificate: '' }]));
      await signedPost(createPinPath, JSON.stringify([{ authSessionId }]));
      await signedPostLongPoll(checkPinPath, JSON.stringify([{ authSessionId }]), authSessionId);
      const login = await signedPost(loginPath, JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]));
      return (await login.json() as { data: { tokenV3IssueResult: { accessToken: string } } }).data.tokenV3IssueResult.accessToken;
    }

    const firstToken = await runPinLogin();
    // First login's token must be accepted for identity before the second login.
    const firstIdentity = await signedPost(identityPath, '[]', firstToken);
    expect(firstIdentity.status).toBe(200);
    expect((await firstIdentity.json() as { code: number }).code).toBe(0);

    await runPinLogin();

    // After the second login, the first login's token is superseded.
    const response = await signedPost(identityPath, '[]', firstToken);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 10008, message: 'REQUEST_SUPERSEDED_ACCESS_TOKEN' });
    expect(mock.state.report().ok).toBe(true);
  });
});

describe('mock LINE QR/PIN transition enforcement', () => {
  const createSessionPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession';
  const createQrPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode';
  const checkQrPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified';
  const verifyCertPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate';
  const createPinPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode';
  const checkPinPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified';
  const loginPath = '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2';

  async function createSessionAndReachQrVerified(): Promise<string> {
    const created = await signedPost(createSessionPath, '[ {} ]');
    const authSessionId = (await created.json() as { data: { authSessionId: string } }).data.authSessionId;
    await signedPost(createQrPath, JSON.stringify([{ authSessionId }]));
    await signedPostLongPoll(checkQrPath, JSON.stringify([{ authSessionId }]), authSessionId);
    return authSessionId;
  }

  it('rejects createPinCode after checkQr (skipping verifyCertificate)', async () => {
    mock.state.configure({
      scenarioId: 'pin-skip-cert', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { illegal_transition: 1 },
    });
    const authSessionId = await createSessionAndReachQrVerified();
    const response = await signedPost(createPinPath, JSON.stringify([{ authSessionId }]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10011, message: 'REQUEST_ILLEGAL_TRANSITION' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects checkPin after checkQr (skipping verifyCertificate + createPinCode)', async () => {
    mock.state.configure({
      scenarioId: 'pin-skip-all', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { illegal_transition: 1 },
    });
    const authSessionId = await createSessionAndReachQrVerified();
    const response = await signedPostLongPoll(checkPinPath, JSON.stringify([{ authSessionId }]), authSessionId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10011, message: 'REQUEST_ILLEGAL_TRANSITION' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects login after checkQr (skipping both verifyCertificate and createPinCode)', async () => {
    mock.state.configure({
      scenarioId: 'login-skip-all', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { illegal_transition: 1 },
    });
    const authSessionId = await createSessionAndReachQrVerified();
    const body = JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]);
    const response = await signedPost(loginPath, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10011, message: 'REQUEST_ILLEGAL_TRANSITION' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('succeeds on the happy PIN path verifyCertificate(reject) -> createPinCode -> checkPin -> login', async () => {
    mock.state.configure({
      scenarioId: 'happy-pin', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin'], expectedRejections: {},
    });
    const authSessionId = await createSessionAndReachQrVerified();
    await signedPost(verifyCertPath, JSON.stringify([{ authSessionId, certificate: '' }]));
    await signedPost(createPinPath, JSON.stringify([{ authSessionId }]));
    await signedPostLongPoll(checkPinPath, JSON.stringify([{ authSessionId }]), authSessionId);
    const loginBody = JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }]);
    const login = await signedPost(loginPath, loginBody);
    const loginData = await login.json() as { code: number; data: { mid: string } };
    expect(loginData.code).toBe(0);
    expect(loginData.data.mid).toBe(MOCK_ACCOUNT_MID);
    expect(mock.state.report().ok).toBe(true);
  });

  it('succeeds on the happy certificate path verifyCertificate(accept) -> login', async () => {
    // Register a known certificate via a first PIN login.
    mock.state.configure({
      scenarioId: 'happy-cert', mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
    });
    const firstAuthSessionId = await createSessionAndReachQrVerified();
    await signedPost(verifyCertPath, JSON.stringify([{ authSessionId: firstAuthSessionId, certificate: '' }]));
    await signedPost(createPinPath, JSON.stringify([{ authSessionId: firstAuthSessionId }]));
    await signedPostLongPoll(checkPinPath, JSON.stringify([{ authSessionId: firstAuthSessionId }]), firstAuthSessionId);
    const firstLogin = await signedPost(loginPath, JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId: firstAuthSessionId }]));
    const cert = (await firstLogin.json() as { data: { certificate: string } }).data.certificate;

    // Second session: certificate is accepted, login proceeds without PIN.
    const secondAuthSessionId = await createSessionAndReachQrVerified();
    const certOk = await signedPost(verifyCertPath, JSON.stringify([{ authSessionId: secondAuthSessionId, certificate: cert }]));
    expect(certOk.status).toBe(200);
    expect(await certOk.json()).toMatchObject({ code: 0, data: {} });

    const login = await signedPost(loginPath, JSON.stringify([{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId: secondAuthSessionId }]));
    const loginData = await login.json() as { code: number; data: { mid: string } };
    expect(loginData.code).toBe(0);
    expect(loginData.data.mid).toBe(MOCK_ACCOUNT_MID);
    expect(mock.state.report().ok).toBe(true);
  });
});

describe('mock LINE forbidden-header enforcement', () => {
  it('rejects refresh with a wrong content-type value', async () => {
    mock.state.configure({
      scenarioId: 'refresh-wrong-content-type', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const oldRefresh = mock.state.fixtures.seededAuth.refreshToken;
    const response = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers: { ...REQUIRED_LINE_HEADERS, 'content-type': 'text/plain' },
      body: JSON.stringify({ refreshToken: oldRefresh }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects refresh missing the origin header', async () => {
    mock.state.configure({
      scenarioId: 'refresh-missing-origin', mode: 'seeded', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const oldRefresh = mock.state.fixtures.seededAuth.refreshToken;
    const headers = { ...REQUIRED_LINE_HEADERS };
    delete headers.origin;
    const response = await fetch(origin + '/api/auth/tokenRefresh', {
      method: 'POST',
      headers,
      body: JSON.stringify({ refreshToken: oldRefresh }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects createSession with x-line-access present', async () => {
    mock.state.configure({
      scenarioId: 'create-session-x-line-access', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const response = await signedPostWithHeaders(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      '[ {} ]',
      { 'x-line-access': 'forbidden-token' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects getProfile with x-lst present', async () => {
    mock.state.configure({
      scenarioId: 'profile-x-lst', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const response = await signedPostWithHeaders(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      { 'x-lst': '150000' },
      accessToken,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects getProfile with x-line-session-id present', async () => {
    mock.state.configure({
      scenarioId: 'profile-x-session-id', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const response = await signedPostWithHeaders(
      '/api/talk/thrift/Talk/TalkService/getProfile',
      '[2]',
      { 'x-line-session-id': 'some-session' },
      accessToken,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });
});

describe('mock LINE pagination boundary validation', () => {
  const previousPath = '/api/talk/thrift/Talk/TalkService/getPreviousMessagesV2WithRequest';
  const chatsPath = '/api/talk/thrift/Talk/TalkService/getChats';
  const contactsPath = '/api/talk/thrift/Talk/TalkService/getContactsV2';
  const recentPath = '/api/talk/thrift/Talk/TalkService/getRecentMessagesV2';

  it('rejects previous with an extra key inside endMessageId', async () => {
    mock.state.configure({
      scenarioId: 'previous-extra-endkey', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];
    const boundary = history[10];
    const body = JSON.stringify([
      {
        messageBoxId: MOCK_GROUP_MID,
        endMessageId: { messageId: boundary.id, deliveredTime: boundary.deliveredTime, extra: 'nope' },
        messagesCount: 3,
      },
      1,
    ]);
    const response = await signedPost(previousPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects previous with a negative messagesCount', async () => {
    mock.state.configure({
      scenarioId: 'previous-negative-count', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];
    const boundary = history[10];
    const body = JSON.stringify([
      {
        messageBoxId: MOCK_GROUP_MID,
        endMessageId: { messageId: boundary.id, deliveredTime: boundary.deliveredTime },
        messagesCount: -5,
      },
      1,
    ]);
    const response = await signedPost(previousPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects previous with a zero messagesCount', async () => {
    mock.state.configure({
      scenarioId: 'previous-zero-count', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];
    const boundary = history[10];
    const body = JSON.stringify([
      {
        messageBoxId: MOCK_GROUP_MID,
        endMessageId: { messageId: boundary.id, deliveredTime: boundary.deliveredTime },
        messagesCount: 0,
      },
      1,
    ]);
    const response = await signedPost(previousPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects previous with a wrong deliveredTime for the given messageId', async () => {
    mock.state.configure({
      scenarioId: 'previous-wrong-delivered-time', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const history = mock.state.fixtures.messagesByChat[MOCK_GROUP_MID];
    const boundary = history[10];
    const body = JSON.stringify([
      {
        messageBoxId: MOCK_GROUP_MID,
        endMessageId: { messageId: boundary.id, deliveredTime: String(Date.UTC(2030, 0, 1)) },
        messagesCount: 3,
      },
      1,
    ]);
    const response = await signedPost(previousPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects chats with an unknown chat MID', async () => {
    mock.state.configure({
      scenarioId: 'chats-unknown-mid', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const body = JSON.stringify([{ chatMids: ['c_unknown_chat_9999'] }, 2]);
    const response = await signedPost(chatsPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects contacts with an unknown contact MID', async () => {
    mock.state.configure({
      scenarioId: 'contacts-unknown-mid', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const body = JSON.stringify([{ targetUserMids: ['u_unknown_contact_9999'] }]);
    const response = await signedPost(contactsPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects contacts with a duplicate MID', async () => {
    mock.state.configure({
      scenarioId: 'contacts-duplicate-mid', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const body = JSON.stringify([{ targetUserMids: [MOCK_DIRECT_MID, MOCK_DIRECT_MID] }]);
    const response = await signedPost(contactsPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });

  it('rejects recent with an unknown chat MID', async () => {
    mock.state.configure({
      scenarioId: 'recent-unknown-mid', mode: 'contract', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: [], expectedRejections: { invalid_body: 1 },
    });
    const accessToken = mock.state.fixtures.seededAuth.accessToken;
    const body = JSON.stringify(['c_unknown_chat_9999', 3]);
    const response = await signedPost(recentPath, body, accessToken);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 10002, message: 'REQUEST_INVALID_BODY' });
    expect(mock.state.report().ok).toBe(true);
  });
});