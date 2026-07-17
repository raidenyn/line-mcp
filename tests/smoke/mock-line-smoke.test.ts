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
} from '../support/process-harness';
import {
  buildMockFixtures,
  MOCK_ACCOUNT_MID,
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
    const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-seeded-`);
    const fixtures = buildMockFixtures({ origin: mock.origin, epochSeconds });
    await mock.reset();
    await mock.configure({
      scenarioId: `${target}-seeded`, mode: 'seeded', epochSeconds,
      expectedRefreshCount: 1, expectedLoginBranches: [], expectedRejections: {},
    });
    const bearer = prepareSeededDataRoot({ dataRoot, appPort: port, fixtures });
    const app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
    const connection = await connectMcp(app.mcpUrl, bearer);
    try {
      await assertTargetSurface(connection.client, target);
      await runMessengerAssertions(connection.client, fixtures, app.origin);
      if (target === 'composed') await runComposedBankAssertions(connection.client, fixtures);
      const stored = loadStoredAuthRecord(MOCK_ACCOUNT_MID, path.join(dataRoot, 'auth'))!;
      expect(stored.accessToken).toBe(fixtures.tokenFixtures.rotatedAccessToken);
      expect(stored.refreshToken).toBe(fixtures.tokenFixtures.rotatedRefreshToken);
      expect(stored.displayName).toBe('Mock LINE Account');
      expect((await mock.report()).ok).toBe(true);
    } finally {
      await connection.close();
      await app.stop();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it.each(['composed', 'standalone'] as const)('%s full OAuth login', async (target) => {
    const port = await reserveFreePort();
    const dataRoot = createTemporaryDataRoot(`line-smoke-${target}-oauth-`);
    await mock.reset();
    await mock.configure({
      scenarioId: `${target}-full-auth`, mode: 'full-auth', epochSeconds,
      expectedRefreshCount: 0, expectedLoginBranches: ['pin', 'certificate'], expectedRejections: {},
    });
    const app = await startApplication({ target, projectRoot: PROJECT_ROOT, dataRoot, port, lineApiBaseUrl: mock.origin });
    try {
      await assertMcpUnauthorized(app.origin, dataRoot, port);
      const first = await authorizeWithPkce(app.origin, { expectPin: true });
      const firstConnection = await connectMcp(app.mcpUrl, first.accessToken);
      await assertTargetSurface(firstConnection.client, target);
      expect(extractText(await firstConnection.client.callTool({ name: 'list_chats', arguments: {} })))
        .toBe(buildMockFixtures({ origin: mock.origin, epochSeconds }).expected.listChatsText);
      await firstConnection.close();

      const refreshed = await refreshMcpToken(app.origin, first.refreshToken);
      const refreshedConnection = await connectMcp(app.mcpUrl, refreshed.accessToken);
      await refreshedConnection.client.listTools();
      await refreshedConnection.close();

      await authorizeWithPkce(app.origin, { expectPin: false });
      const report = await mock.report();
      expect(report.observedLoginBranches).toEqual(['pin', 'certificate']);
      expect(report.routeCounts.createPin).toBe(1);
      expect(report.routeCounts.checkPin).toBe(1);
      expect(report.ok).toBe(true);
    } finally {
      await app.stop();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
