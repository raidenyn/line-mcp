#!/usr/bin/env node
import * as path from 'path';
import { createStandaloneServer } from './standalone';

// The executable owns process.cwd()/DATA_DIR resolution — standalone.ts's
// factory itself never reads either, so importing @raidenyn/line-mcp always
// stays side-effect free.
function resolveDataRoot(): string {
  return process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
}

async function main(): Promise<void> {
  const server = createStandaloneServer({ dataRoot: resolveDataRoot() });
  const { port } = await server.start();
  process.stderr.write(`LINE messenger MCP (standalone) listening on port ${port}\n`);

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
// imported as a module (e.g. by a test exercising createStandaloneServer directly).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}
