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