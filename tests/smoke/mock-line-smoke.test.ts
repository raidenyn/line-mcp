import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  startMockLineServer,
  reserveFreePort,
  createTemporaryDataRoot,
  startApplication,
  connectMcp,
  type RunningMock,
  type RunningApp,
  type McpConnection,
} from '../support/process-harness';
import {
  buildMockFixtures,
  MOCK_ACCOUNT_MID,
  MOCK_GROUP_MID,
} from '../support/mock-line-server/fixtures';
import { loadStoredAuthRecord } from '@raidenyn/line-mcp';
import {
  prepareSeededDataRoot,
  assertTargetSurface,
  runMessengerAssertions,
  runComposedBankAssertions,
  authorizeWithPkce,
  refreshMcpToken,
  assertMcpUnauthorized,
  extractText,
} from '../support/smoke-helpers';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const epochSeconds = Math.floor(Date.now() / 1000);

// Pinned route-count expectations for the seeded scenarios (composed +
// standalone). These were determined empirically by running the scenarios
// against the strict mock and reading mock.report().routeCounts. They pin
// exactly which LINE routes the production client path hits, so a missing
// or duplicate LINE call flips report.ok to false (state.ts verifyFinal
// compares these in computeVerificationErrors).
//
// Breakdown (composed):
//   refresh:1        — seeded access token is near-expiry; first authenticated
//                      call triggers on-demand token refresh.
//   allChatMids:2    — list_chats tool (1) + complete_import's listChats (1,
//                      because the import resolves the chat by name when no
//                      chat_mid is supplied).
//   allContactIds:2  — same two listChats calls.
//   chats:2          — same.
//   contacts:4       — list_chats (1) + complete_import (1) +
//                      get_messages #1 contact-name resolution (1) +
//                      get_messages #2 contact-name resolution (1).
//   recent:9         — get_messages #1 (1) + get_messages #2 (1) +
//                      bank sample_messages (1) + get_transactions x2 (2) +
//                      get_transactions with `since` (1) +
//                      summarize_transactions x2 (2) + the third cache-backed
//                      get_messages repeat (1). (get_messages warms the cache
//                      for MOCK_GROUP_MID, so bank reads and the repeat hit
//                      the getRecentMessagesV2 first page only.)
//   previous:1       — get_messages #1 paginates backwards (cache empty for
//                      MOCK_GROUP_MID, 205 fixture messages > 200 first page).
//                      Drives getPreviousMessagesV2WithRequest via the real
//                      MCP -> cache wrapper -> LineClient.getMessagesInRange
//                      production path.
// The standalone scenario is identical minus the five bank reads (recent:2).
const SEEDED_COMPOSED_ROUTE_COUNTS = {
  refresh: 1,
  allChatMids: 2,
  allContactIds: 2,
  chats: 2,
  contacts: 4,
  recent: 9,
  previous: 1,
} as const;

const SEEDED_STANDALONE_ROUTE_COUNTS = {
  refresh: 1,
  allChatMids: 2,
  allContactIds: 2,
  chats: 2,
  contacts: 4,
  recent: 3,
  previous: 1,
} as const;

// Pinned route-count expectations for the full-OAuth scenarios. Two full
// logins (PIN branch, then certificate branch) drive every pre-auth route
// twice except createPin/checkPin (PIN branch only, once each). The auth
// provider calls getProfileDisplayName once per login (profile:2). One
// list_chats tool call after the first login drives the post-auth routes
// once each.
const OAUTH_ROUTE_COUNTS = {
  createSession: 2,
  createQrCode: 2,
  checkQr: 2,
  verifyCertificate: 2,
  createPin: 1,
  checkPin: 1,
  login: 2,
  identity: 2,
  profile: 2,
  allChatMids: 1,
  allContactIds: 1,
  chats: 1,
  contacts: 1,
} as const;

describe.sequential('mock-backed LINE smoke', () => {
  let mock: RunningMock;

  beforeAll(async () => {
    mock = await startMockLineServer(PROJECT_ROOT);
  }, 60_000);

  afterAll(async () => {
    await mock.shutdown({ verify: true });
  }, 15_000);

  it.each(['composed', 'standalone'] as const)('%s seeded credentials', async (target) => {
    const port = await reserveFreePort();
    // The dataRoot is created BEFORE the outer try so the finally can always
    // remove it. EVERYTHING else — mock.reset, mock.configure,
    // prepareSeededDataRoot, startApplication, connectMcp, assertions — goes
    // inside the try so a setup failure after root creation cannot leak the
    // root. The finally handles nullable app/connection handles.
    const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-seeded-`);
    const fixtures = buildMockFixtures({ origin: mock.origin, epochSeconds });
    let app: RunningApp | undefined;
    let connection: McpConnection | undefined;
    try {
      await mock.reset();
      await mock.configure({
        scenarioId: `${target}-seeded`, mode: 'seeded', epochSeconds,
        expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
        expectedRouteCounts:
          target === 'composed' ? SEEDED_COMPOSED_ROUTE_COUNTS : SEEDED_STANDALONE_ROUTE_COUNTS,
      });
      const bearer = prepareSeededDataRoot({ dataRoot, appPort: port, fixtures });
      app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
      connection = await connectMcp(app.mcpUrl, bearer);
      await assertTargetSurface(connection.client, target);

      await assertTargetSurface(connection.client, target);

      // Capture the previous-route count BEFORE runMessengerAssertions. The
      // first get_messages inside the helper warms the cache for
      // MOCK_GROUP_MID and drives getPreviousMessagesV2WithRequest via the
      // production client path (cache wrapper -> LineClient.getMessagesInRange
      // -> getPreviousMessagesV2WithRequest) — previous must increase by
      // exactly 1. The second get_messages (cache-backed repeat) must NOT
      // increase it further.
      const previousBefore = (await mock.report()).routeCounts.previous ?? 0;
      await runMessengerAssertions(connection.client, fixtures, app.origin);
      const previousAfterHelper = (await mock.report()).routeCounts.previous ?? 0;
      expect(previousAfterHelper - previousBefore).toBe(1);

      if (target === 'composed') await runComposedBankAssertions(connection.client, fixtures);

      // A third get_messages call (another cache-backed repeat) must also NOT
      // trigger another getPreviousMessagesV2WithRequest call — the previous
      // count is unchanged relative to after runMessengerAssertions.
      await connection.client.callTool({ name: 'get_messages', arguments: { chatMid: MOCK_GROUP_MID, count: 5 } });
      const previousAfterRepeat = (await mock.report()).routeCounts.previous ?? 0;
      expect(previousAfterRepeat).toBe(previousAfterHelper);

      const stored = loadStoredAuthRecord(MOCK_ACCOUNT_MID, path.join(dataRoot, 'auth'))!;
      expect(stored.accessToken).toBe(fixtures.tokenFixtures.rotatedAccessToken);
      expect(stored.refreshToken).toBe(fixtures.tokenFixtures.rotatedRefreshToken);
      expect(stored.displayName).toBe('Mock LINE Account');

      // verifyFinal compares routeCounts against expectedRouteCounts (set in
      // configure above) and folds any mismatch into verificationErrors, so
      // a missing or duplicate LINE call flips report.ok to false.
      const finalReport = await mock.report();
      expect(finalReport.verificationErrors).toEqual([]);
      expect(finalReport.ok).toBe(true);
    } finally {
      await connection?.close().catch(() => {});
      await app?.stop().catch(() => {});
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['composed', 'standalone'] as const)('%s full OAuth login', async (target) => {
    const port = await reserveFreePort();
    // Same outer-try/finally discipline as the seeded scenario: the dataRoot
    // is created first, everything else (including mock.reset/configure)
    // lives inside the try so a setup failure cannot leak the root.
    const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-oauth-`);
    let app: RunningApp | undefined;
    let firstConnection: McpConnection | undefined;
    let refreshedConnection: McpConnection | undefined;
    try {
      await mock.reset();
      await mock.configure({
        scenarioId: `${target}-full-auth`, mode: 'full-auth', epochSeconds,
        expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
        expectedRouteCounts: OAUTH_ROUTE_COUNTS,
      });
      app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
      await assertMcpUnauthorized(app.origin, dataRoot, port);
      const first = await authorizeWithPkce(app.origin, { expectPin: true });
      firstConnection = await connectMcp(app.mcpUrl, first.accessToken);
      await assertTargetSurface(firstConnection.client, target);
      expect(extractText(await firstConnection.client.callTool({ name: 'list_chats', arguments: {} })))
        .toBe(buildMockFixtures({ origin: mock.origin, epochSeconds }).expected.listChatsText);
      await firstConnection.close();
      firstConnection = undefined;

      const refreshed = await refreshMcpToken(app.origin, first.refreshToken);
      refreshedConnection = await connectMcp(app.mcpUrl, refreshed.accessToken);
      await refreshedConnection.client.listTools();
      await refreshedConnection.close();
      refreshedConnection = undefined;

      await authorizeWithPkce(app.origin, { expectPin: false });
      const report = await mock.report();
      expect(report.observedLoginBranches).toEqual(['pin', 'certificate']);
      expect(report.routeCounts.createPin).toBe(1);
      expect(report.routeCounts.checkPin).toBe(1);
      // verifyFinal compares routeCounts against expectedRouteCounts (set in
      // configure above) — a missing or duplicate LINE call flips report.ok.
      expect(report.ok).toBe(true);
    } finally {
      await refreshedConnection?.close().catch(() => {});
      await firstConnection?.close().catch(() => {});
      await app?.stop().catch(() => {});
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 120_000);
});