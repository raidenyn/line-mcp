import * as crypto from 'crypto';
import { getHmac, initStorageKey, ensureStorageKey } from './ltsm';

const BASE_URL = 'https://line-chrome-gw.line-apps.com';

const BASE_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US',
  'content-type': 'application/json',
  origin: 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'x-lal': 'en_US',
  'x-line-chrome-version': '3.7.2',
};

export interface AuthData {
  accessToken: string;
  refreshToken: string;
  certificate: string;
  mid: string;
  wrappedNonce: string;
  kdfParameter1: string;
  kdfParameter2: string;
}

export interface Chat {
  mid: string;
  name: string;
  type: 'group' | 'user';
  memberCount?: number;
  pictureUrl?: string;
}

export interface Message {
  id: string;
  from: string;
  senderName?: string;
  to: string;
  toType: number;
  createdTime: string;
  contentType: number;
  text?: string;
  hasContent: boolean;
  contentMetadata?: Record<string, string>;
  previewUrl?: string;
  downloadUrl?: string;
}

export class LineClient {
  private auth: AuthData | null = null;
  private completedAuth: AuthData | null = null;
  private contactNameCache = new Map<string, string>();
  private pendingLogin: (() => Promise<void>) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pendingLoginError: Error | null = null;
  private pendingAuthSessionId: string | null = null;
  private pendingCertificate: string | null = null;
  private pendingLongPollingMaxCount = 2;
  // Resolves with the PIN code once createPinCode is called, or null if no PIN needed
  private loginPinPromise: Promise<string | null> | null = null;
  private loginPinResolve: ((v: string | null) => void) | null = null;
  private pinAcknowledged = false;
  // Aborts all in-flight fetch calls when a new login() cancels the previous session
  private loginAbortController: AbortController | null = null;

  constructor(
    auth?: AuthData | null,
    private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch,
  ) {
    if (auth) this.auth = auth;
  }

  isAuthenticated(): boolean {
    return this.auth !== null || this.pendingLogin !== null;
  }

  getCompletedAuth(): AuthData | null {
    return this.completedAuth;
  }

  async waitForPin(): Promise<string | null> {
    return this.loginPinPromise;
  }

  async waitForCompletion(): Promise<void> {
    if (this.pendingLogin) await this.pendingLogin();
  }

  private async request<T>(
    path: string,
    args: unknown[],
    opts: { longPoll?: boolean; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const body = JSON.stringify(args);
    const accessToken = this.auth?.accessToken ?? '';
    const hmac = await getHmac({ accessToken, path, body });

    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'x-hmac': hmac,
    };
    if (this.auth?.accessToken) {
      headers['x-line-access'] = this.auth.accessToken;
    }
    if (opts.longPoll) {
      headers['x-lst'] = '150000';
      if (opts.sessionId) headers['x-line-session-id'] = opts.sessionId;
    }

    const response = await this.fetchFn(BASE_URL + path, {
      method: 'POST',
      headers,
      body,
      signal: opts.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      process.stderr.write(`[LINE] HTTP ${response.status} on ${path}: ${errBody}\n`);
      throw new Error(`HTTP ${response.status} on ${path}: ${errBody}`);
    }
    const rawText = await response.text();
    const json = JSON.parse(rawText) as { code: number; message: string; data: T };
    if (json.code !== 0) {
      throw new Error(`LINE API error ${json.code}: ${json.message} (${path})`);
    }
    return json.data;
  }

  private jwtExp(): number {
    if (!this.auth) return 0;
    try {
      const payload = Buffer.from(this.auth.accessToken.split('.')[1], 'base64').toString('utf8');
      return (JSON.parse(payload) as { exp: number }).exp;
    } catch {
      return 0;
    }
  }

  private async refreshIfExpired(): Promise<void> {
    if (!this.auth) return;
    const exp = this.jwtExp();
    if (exp > 0 && exp - Date.now() / 1000 < 86400) {
      if (!this.refreshPromise) {
        this.refreshPromise = (async () => {
          if (!this.auth) return;
          const response = await this.fetchFn(`${BASE_URL}/api/auth/tokenRefresh`, {
            method: 'POST',
            headers: { ...BASE_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: this.auth.refreshToken }),
          });
          if (response.ok) {
            const data = await response.json() as { accessToken: string; refreshToken?: string };
            this.auth.accessToken = data.accessToken;
            if (data.refreshToken) this.auth.refreshToken = data.refreshToken;
          }
        })().finally(() => { this.refreshPromise = null; });
      }
      await this.refreshPromise;
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.pendingLogin) {
      // If PIN hasn't been shown yet, wait for it to become available, then surface it
      if (this.loginPinPromise && !this.pinAcknowledged) {
        const pin = await this.loginPinPromise;
        if (pin !== null) {
          this.pinAcknowledged = true;
          throw new Error(
            `PIN required: Enter "${pin}" in your LINE mobile app to confirm the login, then call list_chats again.`,
          );
        }
      }
      // PIN not needed (certificate accepted) or already acknowledged — wait for full completion
      await this.pendingLogin();
      // If we reach here, the current session succeeded. An aborted previous session's .catch()
      // may have set pendingLoginError (AbortError) before we got here — clear it so callers
      // don't see a stale failure after a successful re-login.
      this.pendingLoginError = null;
    }
    if (this.pendingLoginError) {
      throw new Error(`Login failed: ${this.pendingLoginError.message}`);
    }
    if (!this.auth) {
      throw new Error('Not authenticated. Call the login tool first and scan the QR code.');
    }
    await ensureStorageKey({
      mid: this.auth.mid,
      wrappedNonce: this.auth.wrappedNonce,
      kdfParameter1: this.auth.kdfParameter1,
      kdfParameter2: this.auth.kdfParameter2,
    });
    await this.refreshIfExpired();
  }

  async login(): Promise<{ qrUrl: string }> {
    // Cancel any in-flight HTTP requests from a previous login session
    if (this.loginAbortController) {
      this.loginAbortController.abort();
    }
    this.loginAbortController = new AbortController();

    const { authSessionId } = await this.request<{ authSessionId: string }>(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession',
      [{}],
    );

    const { callbackUrl, longPollingMaxCount } = await this.request<{
      callbackUrl: string;
      longPollingMaxCount: number;
      longPollingIntervalSec: number;
    }>(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createQrCode',
      [{ authSessionId }],
    );

    // Generate a valid X25519 (Curve25519) keypair — LINE mobile app performs
    // ECDH with the public key, so it must be a valid curve point.
    const { publicKey: pubKeyObj } = crypto.generateKeyPairSync('x25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    // SPKI DER wraps the 32-byte raw key with a 12-byte header; strip the header.
    const rawPublicKey = Buffer.from(pubKeyObj).slice(-32);
    // Chrome extension uses window.btoa (standard base64) and adds e2eeVersion=1
    const qrUrlObj = new URL(callbackUrl);
    qrUrlObj.searchParams.set('secret', rawPublicKey.toString('base64'));
    qrUrlObj.searchParams.set('e2eeVersion', '1');
    const qrUrl = qrUrlObj.toString();

    // Save certificate for use after QR scan confirmation (spec: verifyCertificate follows checkQrCodeVerified)
    this.pendingCertificate = this.auth?.certificate ?? null;

    this.pendingAuthSessionId = authSessionId;
    this.pendingLongPollingMaxCount = longPollingMaxCount ?? 2;

    // Set up PIN signal promise before starting background task
    this.pinAcknowledged = false;
    this.loginPinPromise = new Promise<string | null>(resolve => {
      this.loginPinResolve = resolve;
    });

    // Start the long-poll immediately so it's active while the user scans.
    // completeLogin() blocks on checkQrCodeVerified — must be running before scan.
    this.pendingLoginError = null;
    const completionPromise = this.completeLogin().catch((err: Error) => {
      this.pendingLoginError = err;
      if (this.pendingLogin === loginCompletion) {
        this.pendingLogin = null;
      }
      this.loginPinResolve?.(null);
      this.loginPinResolve = null;
      process.stderr.write(`completeLogin error: ${err.message}\n${err.stack}\n`);
    });
    const loginCompletion = () => completionPromise;
    this.pendingLogin = loginCompletion;

    return { qrUrl };
  }

  async completeLogin(): Promise<void> {
    const authSessionId = this.pendingAuthSessionId;
    if (!authSessionId) throw new Error('No pending login session');
    const certificate = this.pendingCertificate;

    // Long-poll until QR is scanned. A 400 means the session may already be confirmed
    // (race: mobile confirmed before our poll registered) — treat as success and proceed.
    for (let i = 0; i < this.pendingLongPollingMaxCount; i++) {
      try {
        process.stderr.write(`[LINE] checkQrCodeVerified attempt ${i + 1}/${this.pendingLongPollingMaxCount}\n`);
        await this.request(
          '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkQrCodeVerified',
          [{ authSessionId }],
          { longPoll: true, sessionId: authSessionId, signal: this.loginAbortController?.signal },
        );
        break;
      } catch (err) {
        const msg = (err as Error).message;
        process.stderr.write(`[LINE] checkQrCodeVerified error: ${msg}\n`);
        if (msg.includes('HTTP 400') || msg.includes('HTTP 403')) {
          // 400/403 may mean the scan already completed before our poll arrived — proceed anyway
          break;
        }
        if (i === this.pendingLongPollingMaxCount - 1) throw err;
      }
    }

    // verifyCertificate is always required as a state-machine transition on the server.
    // With a valid saved certificate it skips PIN; with no/invalid certificate the server
    // returns an error and we proceed to PIN flow.
    let pinRequired = true;
    try {
      await this.request(
        '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/verifyCertificate',
        [{ authSessionId, certificate: certificate ?? '' }],
      );
      pinRequired = false; // Certificate accepted — skip PIN
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.includes('HTTP 4') && !msg.includes('LINE API error')) {
        throw err; // Transient network or 5xx — don't silently swallow
      }
      process.stderr.write(`[LINE] verifyCertificate: certificate rejected (${msg}), proceeding with PIN\n`);
    }

    if (pinRequired) {
      // Get PIN from server and signal it to any waiting list_chats call
      const pinData = await this.request<{ pinCode: string }>(
        '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createPinCode',
        [{ authSessionId }],
      );
      const pinCode = pinData.pinCode;
      process.stderr.write(`[LINE] PIN code: ${pinCode}\n`);
      this.loginPinResolve?.(pinCode);
      this.loginPinResolve = null;

      // Long-poll until user enters PIN in LINE mobile app
      process.stderr.write(`[LINE] Waiting for PIN entry...\n`);
      await this.request(
        '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginPermitNoticeService/checkPinCodeVerified',
        [{ authSessionId }],
        { longPoll: true, sessionId: authSessionId, signal: this.loginAbortController?.signal },
      );
      process.stderr.write(`[LINE] PIN confirmed\n`);
    } else {
      this.loginPinResolve?.(null);
      this.loginPinResolve = null;
    }

    const loginData = await this.request<{
      certificate: string;
      tokenV3IssueResult: { accessToken: string; refreshToken: string };
      mid: string;
    }>(
      '/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/qrCodeLoginV2',
      [{ systemName: 'CHROMEOS', modelName: 'CHROME', autoLoginIsRequired: false, authSessionId }],
    );

    const { accessToken, refreshToken } = loginData.tokenV3IssueResult;

    // Set auth so HMAC uses accessToken for the identity fetch below
    this.auth = {
      accessToken,
      refreshToken,
      certificate: loginData.certificate,
      mid: loginData.mid,
      wrappedNonce: '',
      kdfParameter1: '',
      kdfParameter2: '',
    };

    const identityData = await this.request<{
      wrappedNonce: string;
      kdfParameter1: string;
      kdfParameter2: string;
    }>('/api/talk/thrift/Talk/TalkService/getEncryptedIdentityV3', []);

    await initStorageKey({
      mid: loginData.mid,
      wrappedNonce: identityData.wrappedNonce,
      kdfParameter1: identityData.kdfParameter1,
      kdfParameter2: identityData.kdfParameter2,
    });

    this.completedAuth = {
      accessToken,
      refreshToken,
      certificate: loginData.certificate,
      mid: loginData.mid,
      wrappedNonce: identityData.wrappedNonce,
      kdfParameter1: identityData.kdfParameter1,
      kdfParameter2: identityData.kdfParameter2,
    };
    this.auth = this.completedAuth;

    this.pendingLogin = null;
    this.pendingAuthSessionId = null;
  }

  async listChats(): Promise<Chat[]> {
    await this.ensureAuthenticated();

    const [chatMidsData, contactIds] = await Promise.all([
      this.request<{ memberChatMids: string[]; invitedChatMids: string[] }>(
        '/api/talk/thrift/Talk/TalkService/getAllChatMids',
        [{ withMemberChats: true, withInvitedChats: true }, 2],
      ),
      this.request<string[]>('/api/talk/thrift/Talk/TalkService/getAllContactIds', [2]),
    ]);

    const groupMids = chatMidsData.memberChatMids ?? [];

    const [groupChatsData, contactsData] = await Promise.all([
      groupMids.length > 0
        ? this.request<{ chats: Array<{ chatMid: string; chatName: string; memberCount: number; picturePath?: string }> }>(
            '/api/talk/thrift/Talk/TalkService/getChats',
            [{ chatMids: groupMids }, 2],
          )
        : Promise.resolve({ chats: [] }),
      contactIds.length > 0
        ? this.fetchContactsV2(contactIds)
        : Promise.resolve([] as Array<{ mid: string; displayName: string; pictureStatus?: string }>),
    ]);

    const groups: Chat[] = (groupChatsData.chats ?? []).map((c) => ({
      mid: c.chatMid,
      name: c.chatName,
      type: 'group' as const,
      memberCount: c.memberCount,
      pictureUrl: c.picturePath ? `https://profile.line-scdn.net${c.picturePath}/preview` : undefined,
    }));

    const contacts: Chat[] = contactsData.map((c) => ({
      mid: c.mid,
      name: c.displayName,
      type: 'user' as const,
      pictureUrl: c.pictureStatus ? `https://profile.line-scdn.net/${c.pictureStatus}/preview` : undefined,
    }));

    for (const c of contactsData) {
      this.contactNameCache.set(c.mid, c.displayName);
    }

    return [...groups, ...contacts];
  }

  private async fetchContactsV2(
    mids: string[],
  ): Promise<Array<{ mid: string; displayName: string; pictureStatus?: string }>> {
    const batches: string[][] = [];
    for (let i = 0; i < mids.length; i += 50) {
      batches.push(mids.slice(i, i + 50));
    }
    const batchResults = await Promise.all(
      batches.map(async (batch) => {
        const data = await this.request<{
          contacts: Record<string, { contact: { mid: string; displayName: string; pictureStatus?: string } }>;
        }>('/api/talk/thrift/Talk/TalkService/getContactsV2', [{ targetUserMids: batch }]);
        return Object.values(data.contacts ?? {})
          .filter((entry) => entry?.contact != null)
          .map((entry) => ({
            mid: entry.contact.mid,
            displayName: entry.contact.displayName,
            pictureStatus: entry.contact.pictureStatus,
          }));
      }),
    );
    return batchResults.flat();
  }

  async getMessages(chatMid: string, count = 50): Promise<Message[]> {
    await this.ensureAuthenticated();

    const raw = await this.request<Array<{
      id: string;
      from: string;
      to: string;
      toType: number;
      createdTime: string;
      contentType: number;
      text?: string;
      hasContent: boolean;
      contentMetadata?: Record<string, string>;
    }>>('/api/talk/thrift/Talk/TalkService/getRecentMessagesV2', [chatMid, count]);

    const unknownMids = [...new Set((raw ?? []).map((m) => m.from))]
      .filter((mid) => !this.contactNameCache.has(mid));
    if (unknownMids.length > 0) {
      const resolved = await this.fetchContactsV2(unknownMids);
      for (const c of resolved) this.contactNameCache.set(c.mid, c.displayName);
    }

    return (raw ?? []).map((m) => ({
      id: m.id,
      from: m.from,
      senderName: this.contactNameCache.get(m.from),
      to: m.to,
      toType: m.toType,
      createdTime: m.createdTime,
      contentType: m.contentType,
      text: m.text,
      hasContent: m.hasContent,
      contentMetadata: m.contentMetadata,
      previewUrl: m.contentType === 1 ? m.contentMetadata?.['PREVIEW_URL'] : undefined,
      downloadUrl: m.contentType === 1 ? m.contentMetadata?.['DOWNLOAD_URL'] : undefined,
    }));
  }

  async getImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`Image fetch failed: ${response.status} ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg';
    return { buffer, mimeType };
  }
}
