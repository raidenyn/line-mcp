import type { AuthData } from '@raidenyn/line-client';
import {
  buildMockFixtures,
  makeMockLineJwt,
  MOCK_CERTIFICATE,
  MOCK_ACCOUNT_MID,
  type MockFixtures,
} from './fixtures';

export type MockScenarioMode = 'seeded' | 'full-auth' | 'contract';
export type LoginBranch = 'pin' | 'certificate';
export type ExpectedRejectionKind =
  | 'missing_hmac' | 'invalid_hmac' | 'expired_access_token'
  | 'superseded_access_token' | 'unknown_access_token' | 'unknown_refresh_token'
  | 'missing_auth_header' | 'invalid_body' | 'invalid_session'
  | 'illegal_transition' | 'unknown_boundary' | 'unknown_route';

export interface MockScenarioConfig {
  scenarioId: string;
  mode: MockScenarioMode;
  epochSeconds: number;
  expectedRefreshCount: number;
  expectedLoginBranches: readonly LoginBranch[];
  expectedRejections: Partial<Record<ExpectedRejectionKind, number>>;
  /**
   * Optional: when set, verifyFinal() asserts that the observed routeCounts
   * match this map EXACTLY — every named route must match its expected count,
   * and no extra routes may appear. Mismatches are appended to
   * verificationErrors (and thus flip report.ok to false). Routes that are
   * observed but not listed here are flagged as unexpected; routes listed
   * here but not observed are flagged as missing.
   */
  expectedRouteCounts?: Readonly<Record<string, number>>;
}

export interface MockReport {
  scenarioId: string | null;
  routeCounts: Readonly<Record<string, number>>;
  observedLoginBranches: readonly LoginBranch[];
  refreshCount: number;
  expectedRejections: Readonly<Record<string, number>>;
  observedExpectedRejections: Readonly<Record<string, number>>;
  violations: readonly { route: string; kind: ExpectedRejectionKind; diagnostic: unknown }[];
  pendingLineRequests: number;
  unresolvedSessions: number;
  verificationErrors: readonly string[];
  ok: boolean;
}

type AccessKind = 'current' | 'superseded' | 'unknown' | 'expired';

interface RefreshEntry {
  status: 'current' | 'superseded';
}

type SessionPhase =
  | 'created' | 'qr-created' | 'qr-verified'
  | 'cert-accepted' | 'certificate-rejected'
  | 'pin-created' | 'pin-verified' | 'completed';

interface Session {
  authSessionId: string;
  phase: SessionPhase;
  certificate: string | null;
  pinRequired: boolean;
  branch: LoginBranch | null;
  issuedAuth: AuthData | null;
}

interface AccessEntry {
  status: 'current' | 'superseded';
  exp: number;
  issuedBySession?: string;
}

interface BoundaryEnd { kind: 'end'; chatMid: string; }
interface BoundaryPrev { kind: 'boundary'; chatMid: string; messageId: string; deliveredTime: string; }
interface BoundaryInvalid { kind: 'invalid'; }
type BoundaryResult = BoundaryEnd | BoundaryPrev | BoundaryInvalid;

export class MockLineState {
  fixtures: MockFixtures;
  private readonly input: { origin: string };
  private config: MockScenarioConfig | null = null;
  private readonly issuedAccessTokens = new Map<string, AccessEntry>();
  private readonly issuedRefreshTokens = new Map<string, RefreshEntry>();
  private readonly refreshToAccess = new Map<string, string>();
  private readonly accessToRefresh = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private readonly knownCertificates = new Set<string>();
  private readonly routeCounts: Record<string, number> = {};
  private readonly observedLoginBranches: LoginBranch[] = [];
  private readonly violations: { route: string; kind: ExpectedRejectionKind; diagnostic: unknown }[] = [];
  private readonly observedExpectedRejections: Record<string, number> = {};
  private remainingExpectedRejections: Record<string, number> = {};
  private refreshCount = 0;
  private rotationCounter = 0;
  private sessionCounter = 0;
  private pendingLineRequests = 0;

  constructor(input: { origin: string }) {
    this.input = input;
    this.fixtures = buildMockFixtures({
      origin: input.origin,
      epochSeconds: Math.floor(Date.now() / 1000),
    });
  }

  configure(config: MockScenarioConfig): void {
    this.reset();
    this.config = config;
    this.fixtures = buildMockFixtures({ origin: this.input.origin, epochSeconds: config.epochSeconds });
    this.registerScenarioTokens();
  }

  setOrigin(newOrigin: string): void {
    this.input.origin = newOrigin;
    if (this.config) {
      this.fixtures = buildMockFixtures({ origin: newOrigin, epochSeconds: this.config.epochSeconds });
    } else {
      this.fixtures = buildMockFixtures({ origin: newOrigin, epochSeconds: Math.floor(Date.now() / 1000) });
    }
  }

  nextSessionCounter(): number {
    return this.sessionCounter + 1;
  }

  recordRoute(route: string): void {
    this.routeCounts[route] = (this.routeCounts[route] ?? 0) + 1;
  }

  beginLineRequest(): void {
    this.pendingLineRequests += 1;
  }

  endLineRequest(): void {
    this.pendingLineRequests = Math.max(0, this.pendingLineRequests - 1);
  }

  private reset(): void {
    this.config = null;
    this.issuedAccessTokens.clear();
    this.issuedRefreshTokens.clear();
    this.refreshToAccess.clear();
    this.accessToRefresh.clear();
    this.sessions.clear();
    this.knownCertificates.clear();
    for (const k of Object.keys(this.routeCounts)) delete this.routeCounts[k];
    this.observedLoginBranches.length = 0;
    this.violations.length = 0;
    for (const k of Object.keys(this.observedExpectedRejections)) delete this.observedExpectedRejections[k];
    this.remainingExpectedRejections = {};
    this.refreshCount = 0;
    this.rotationCounter = 0;
    this.sessionCounter = 0;
    this.pendingLineRequests = 0;
  }

  private registerScenarioTokens(): void {
    if (!this.config) return;
    const mode = this.config.mode;
    if (mode === 'seeded' || mode === 'contract') {
      const access = this.fixtures.seededAuth.accessToken;
      const refresh = this.fixtures.seededAuth.refreshToken;
      const exp = this.extractExp(access);
      this.issuedAccessTokens.set(access, { status: 'current', exp });
      this.issuedRefreshTokens.set(refresh, { status: 'current' });
      this.refreshToAccess.set(refresh, access);
      this.accessToRefresh.set(access, refresh);
    }
    for (const [k, v] of Object.entries(this.config.expectedRejections)) {
      this.remainingExpectedRejections[k] = v ?? 0;
    }
  }

  private extractExp(token: string): number {
    try {
      const payload = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
      return (JSON.parse(payload) as { exp: number }).exp;
    } catch {
      return 0;
    }
  }

  authenticateAccess(token: string): { kind: AccessKind; mid?: string } {
    const entry = this.issuedAccessTokens.get(token);
    if (!entry) return { kind: 'unknown' };
    if (entry.status === 'superseded') return { kind: 'superseded' };
    const now = Math.floor(Date.now() / 1000);
    if (entry.exp > 0 && entry.exp <= now) return { kind: 'expired' };
    return { kind: 'current', mid: MOCK_ACCOUNT_MID };
  }

  /**
   * Returns the authSessionId of the completed login session that issued this
   * access token, or null if the token was not issued by a login (e.g. the
   * seeded token configured at scenario setup).
   */
  resolveLoginSessionForAccess(token: string): string | null {
    const entry = this.issuedAccessTokens.get(token);
    if (!entry || !entry.issuedBySession) return null;
    const session = this.sessions.get(entry.issuedBySession);
    if (!session) return null;
    if (session.phase !== 'completed') return null;
    return session.authSessionId;
  }

  refresh(refreshToken: string): AuthData | null {
    const entry = this.issuedRefreshTokens.get(refreshToken);
    if (!entry || entry.status !== 'current') return null;
    entry.status = 'superseded';
    const oldAccess = this.refreshToAccess.get(refreshToken);
    if (oldAccess) {
      const accessEntry = this.issuedAccessTokens.get(oldAccess);
      if (accessEntry) accessEntry.status = 'superseded';
    }
    this.rotationCounter += 1;
    const epoch = this.config?.epochSeconds ?? Math.floor(Date.now() / 1000);
    let newAccess: string;
    let newRefresh: string;
    if (this.rotationCounter === 1) {
      newAccess = this.fixtures.tokenFixtures.rotatedAccessToken;
      newRefresh = this.fixtures.tokenFixtures.rotatedRefreshToken;
    } else {
      newAccess = makeMockLineJwt(
        `rotated-access-${this.rotationCounter}`,
        epoch + this.rotationCounter,
        epoch + 86400 + 7200,
      );
      newRefresh = makeMockLineJwt(
        `rotated-refresh-${this.rotationCounter}`,
        epoch + this.rotationCounter,
        epoch + 31_536_000,
      );
    }
    const newExp = this.extractExp(newAccess);
    const oldAccessEntry = oldAccess ? this.issuedAccessTokens.get(oldAccess) : undefined;
    this.issuedAccessTokens.set(newAccess, {
      status: 'current',
      exp: newExp,
      issuedBySession: oldAccessEntry?.issuedBySession,
    });
    this.issuedRefreshTokens.set(newRefresh, { status: 'current' });
    this.refreshToAccess.set(newRefresh, newAccess);
    this.accessToRefresh.set(newAccess, newRefresh);
    this.refreshCount += 1;
    const base = this.fixtures.seededAuth;
    return {
      accessToken: newAccess,
      refreshToken: newRefresh,
      certificate: base.certificate,
      mid: base.mid,
      wrappedNonce: base.wrappedNonce,
      kdfParameter1: base.kdfParameter1,
      kdfParameter2: base.kdfParameter2,
    };
  }

  createSession(authSessionId?: string): { authSessionId: string } {
    this.sessionCounter += 1;
    const id = authSessionId ?? `auth-session-${this.sessionCounter}`;
    this.sessions.set(id, {
      authSessionId: id,
      phase: 'created',
      certificate: null,
      pinRequired: false,
      branch: null,
      issuedAuth: null,
    });
    return { authSessionId: id };
  }

  requireSession(authSessionId: string): Session {
    const session = this.sessions.get(authSessionId);
    if (!session) {
      throw new Error(`unknown authSessionId: ${authSessionId}`);
    }
    return session;
  }

  markQrCreated(authSessionId: string): void {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'created') {
      throw new Error(`illegal transition: ${session.phase} -> qr-created`);
    }
    session.phase = 'qr-created';
  }

  markQrVerified(authSessionId: string): void {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'qr-created') {
      throw new Error(`illegal transition: ${session.phase} -> qr-verified`);
    }
    session.phase = 'qr-verified';
  }

  verifyCertificate(authSessionId: string, certificate: string): { accepted: boolean; pinRequired: boolean } {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'qr-verified') {
      throw new Error(`illegal transition: ${session.phase} -> verifyCertificate`);
    }
    const cert = certificate.trim();
    if (cert && this.knownCertificates.has(cert)) {
      session.phase = 'cert-accepted';
      session.certificate = cert;
      session.pinRequired = false;
      session.branch = 'certificate';
      this.observedLoginBranches.push('certificate');
      return { accepted: true, pinRequired: false };
    }
    session.phase = 'certificate-rejected';
    session.pinRequired = true;
    session.branch = 'pin';
    this.observedLoginBranches.push('pin');
    return { accepted: false, pinRequired: true };
  }

  markPinCreated(authSessionId: string): void {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'certificate-rejected') {
      throw new Error(`illegal transition: ${session.phase} -> pin-created`);
    }
    session.phase = 'pin-created';
  }

  markPinVerified(authSessionId: string): void {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'pin-created') {
      throw new Error(`illegal transition: ${session.phase} -> pin-verified`);
    }
    session.phase = 'pin-verified';
  }

  completeLogin(authSessionId: string): {
    certificate: string;
    accessToken: string;
    refreshToken: string;
    mid: string;
    wrappedNonce: string;
    kdfParameter1: string;
    kdfParameter2: string;
  } {
    const session = this.requireSession(authSessionId);
    if (session.phase !== 'pin-verified' && session.phase !== 'cert-accepted') {
      throw new Error(`illegal transition: ${session.phase} -> completed`);
    }
    const epoch = this.config?.epochSeconds ?? Math.floor(Date.now() / 1000);
    const accessId = `login-access-${authSessionId}`;
    const refreshId = `login-refresh-${authSessionId}`;
    const accessToken = makeMockLineJwt(accessId, epoch, epoch + 86400 + 7200);
    const refreshToken = makeMockLineJwt(refreshId, epoch, epoch + 31_536_000);
    const certificate = session.certificate ?? MOCK_CERTIFICATE;
    this.knownCertificates.add(certificate);
    const base = this.fixtures.seededAuth;
    const issued: AuthData = {
      accessToken,
      refreshToken,
      certificate,
      mid: base.mid,
      wrappedNonce: base.wrappedNonce,
      kdfParameter1: base.kdfParameter1,
      kdfParameter2: base.kdfParameter2,
    };
    this.issuedAccessTokens.set(accessToken, { status: 'current', exp: this.extractExp(accessToken), issuedBySession: authSessionId });
    this.issuedRefreshTokens.set(refreshToken, { status: 'current' });
    this.refreshToAccess.set(refreshToken, accessToken);
    this.accessToRefresh.set(accessToken, refreshToken);
    this.supersedePriorLoginTokens(authSessionId);
    session.issuedAuth = issued;
    session.phase = 'completed';
    return issued;
  }

  /**
   * Marks every access token issued by a previously completed login session as
   * superseded. The current session's freshly issued token is preserved. This
   * prevents an old login's token from being reused for identity after a newer
   * login completes.
   */
  private supersedePriorLoginTokens(currentSessionId: string): void {
    for (const [, entry] of this.issuedAccessTokens) {
      if (entry.issuedBySession == null) continue;
      if (entry.issuedBySession === currentSessionId) continue;
      const priorSession = this.sessions.get(entry.issuedBySession);
      if (!priorSession || priorSession.phase !== 'completed') continue;
      if (entry.status === 'current') entry.status = 'superseded';
    }
  }

  resolveBoundary(chatMid: string, messageId: string, _deliveredTime: string): BoundaryResult {
    const history = this.fixtures.messagesByChat[chatMid];
    if (!history) return { kind: 'invalid' };
    const index = history.findIndex((m) => m.id === messageId);
    if (index === -1) return { kind: 'invalid' };
    if (index === 0) return { kind: 'end', chatMid };
    const prev = history[index - 1];
    return {
      kind: 'boundary',
      chatMid,
      messageId: prev.id,
      deliveredTime: prev.deliveredTime,
    };
  }

  reject(kind: ExpectedRejectionKind, route: string = '', diagnostic?: unknown): void {
    const remaining = this.remainingExpectedRejections[kind] ?? 0;
    if (remaining > 0) {
      this.remainingExpectedRejections[kind] = remaining - 1;
      this.observedExpectedRejections[kind] = (this.observedExpectedRejections[kind] ?? 0) + 1;
    } else {
      this.violations.push({ route, kind, diagnostic: this.redact(diagnostic) });
    }
  }

  abandonSession(authSessionId: string): void {
    const session = this.sessions.get(authSessionId);
    if (session && session.phase !== 'completed') {
      session.phase = 'completed';
    }
  }

  private redact(diagnostic: unknown): unknown {
    if (typeof diagnostic === 'string') return { message: diagnostic.length > 200 ? diagnostic.slice(0, 200) + '...' : diagnostic };
    if (diagnostic && typeof diagnostic === 'object') {
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(diagnostic as Record<string, unknown>)) {
        if (typeof v === 'string' && /token|secret|password|nonce/i.test(k)) continue;
        safe[k] = v;
      }
      return safe;
    }
    return diagnostic;
  }

  private computeVerificationErrors(r: MockReport): string[] {
    const errors: string[] = [];
    const config = this.config;
    if (!config) {
      errors.push('verifyFinal called before configure');
    } else {
      if (r.refreshCount !== config.expectedRefreshCount) {
        errors.push(`refreshCount mismatch: expected ${config.expectedRefreshCount}, got ${r.refreshCount}`);
      }
      if (r.observedLoginBranches.length !== config.expectedLoginBranches.length ||
          !r.observedLoginBranches.every((b, i) => b === config.expectedLoginBranches[i])) {
        errors.push(`loginBranches mismatch: expected ${JSON.stringify(config.expectedLoginBranches)}, got ${JSON.stringify(r.observedLoginBranches)}`);
      }
      for (const [kind, expected] of Object.entries(config.expectedRejections)) {
        const observed = r.observedExpectedRejections[kind] ?? 0;
        if (observed !== (expected ?? 0)) {
          errors.push(`expectedRejection ${kind} mismatch: expected ${expected}, got ${observed}`);
        }
      }
      for (const kind of Object.keys(r.observedExpectedRejections)) {
        if (config.expectedRejections[kind as ExpectedRejectionKind] == null) {
          errors.push(`unexpected observed rejection kind: ${kind}`);
        }
      }
      if (r.violations.length > 0) {
        errors.push(`unexpected rejections: ${JSON.stringify(r.violations)}`);
      }
      if (r.pendingLineRequests !== 0) {
        errors.push(`pendingLineRequests: expected 0, got ${r.pendingLineRequests}`);
      }
      if (r.unresolvedSessions !== 0) {
        errors.push(`unresolvedSessions: expected 0, got ${r.unresolvedSessions}`);
      }
      if (config.expectedRouteCounts) {
        const expected = config.expectedRouteCounts;
        const observed = r.routeCounts;
        for (const [route, wantCount] of Object.entries(expected)) {
          const got = observed[route] ?? 0;
          if (got !== (wantCount ?? 0)) {
            errors.push(`routeCount ${route} mismatch: expected ${wantCount}, got ${got}`);
          }
        }
        for (const route of Object.keys(observed)) {
          if (expected[route] == null) {
            errors.push(`unexpected route observed: ${route} (count=${observed[route]})`);
          }
        }
      }
    }
    return errors;
  }

  report(): MockReport {
    let unresolvedSessions = 0;
    for (const s of this.sessions.values()) {
      if (s.phase !== 'completed') unresolvedSessions += 1;
    }
    const snapshot: MockReport = {
      scenarioId: this.config?.scenarioId ?? null,
      routeCounts: { ...this.routeCounts },
      observedLoginBranches: [...this.observedLoginBranches],
      refreshCount: this.refreshCount,
      expectedRejections: { ...(this.config?.expectedRejections ?? {}) },
      observedExpectedRejections: { ...this.observedExpectedRejections },
      violations: [...this.violations],
      pendingLineRequests: this.pendingLineRequests,
      unresolvedSessions,
      verificationErrors: [],
      ok: false,
    };
    const verificationErrors = this.computeVerificationErrors(snapshot);
    snapshot.verificationErrors = verificationErrors;
    snapshot.ok = verificationErrors.length === 0;
    return snapshot;
  }

  verifyFinal(): MockReport {
    const r = this.report();
    return r;
  }
}
