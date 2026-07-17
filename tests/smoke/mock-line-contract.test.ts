import { describe, it, expect } from 'vitest';
import {
  buildMockFixtures,
  MOCK_GROUP_MID,
  MOCK_PIN,
} from '../support/mock-line-server/fixtures';
import { MockLineState } from '../support/mock-line-server/state';

const epochSeconds = Math.floor(Date.now() / 1000);
const fixtures = buildMockFixtures({ origin: 'http://127.0.0.1:19090', epochSeconds });

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
