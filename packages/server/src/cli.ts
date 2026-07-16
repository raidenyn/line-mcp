#!/usr/bin/env node
import * as path from 'path';
import type { AuthData } from '@raidenyn/line-client';
import { createServer } from './server';

// The executable owns process.cwd()/DATA_DIR resolution and all other
// environment configuration — server.ts's factory itself never reads
// DATA_DIR, and its ONLY other env reads (PORT/BASE_PATH/PUBLIC_URL, mirroring
// @raidenyn/line-mcp's own standalone.ts) are innocuous request-time
// defaults, not persistent-data paths. The one auth-affecting exception,
// the e2e test-token bypass, is resolved HERE and passed in explicitly so
// server.ts never touches TEST_TOKEN / LINE_AUTH_DATA itself.
function resolveDataRoot(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

function resolveTestAuth(): ReadonlyArray<{ token: string; authData: AuthData }> | undefined {
  const token = process.env.TEST_TOKEN;
  const authRaw = process.env.LINE_AUTH_DATA;
  if (!token || !authRaw) return undefined;
  try {
    const authData: AuthData = JSON.parse(authRaw);
    process.stderr.write('[LINE] Test token seeded from TEST_TOKEN + LINE_AUTH_DATA\n');
    return [{ token, authData }];
  } catch {
    process.stderr.write('[LINE] Warning: failed to seed test token — LINE_AUTH_DATA is not valid JSON\n');
    return undefined;
  }
}

async function main(): Promise<void> {
  const server = createServer({
    dataRoot: resolveDataRoot(),
    testAuth: resolveTestAuth(),
  });
  await server.start();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[cli] Received ${signal}, shutting down\n`);
    server.stop().then(
      () => process.exit(0),
      (err) => {
        process.stderr.write(`[cli] Error during shutdown: ${err}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only auto-starts when this file is the process entry point — never when
// imported as a module (e.g. by a test exercising createServer directly).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}
