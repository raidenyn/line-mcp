import { signForAccount } from '@raidenyn/line-client';
import { createMockLineServer } from './server';
import { VALID_STORAGE_KEY } from './fixtures';

const controlToken = process.env.MOCK_LINE_CONTROL_TOKEN ?? '';

if (!controlToken) {
  process.stderr.write('MOCK_LINE_CONTROL_TOKEN must be set\n');
  process.exit(2);
}

async function main(): Promise<void> {
  await signForAccount(VALID_STORAGE_KEY, {
    accessToken: '',
    path: '/__mock/prewarm',
    body: '[]',
  });
  const server = createMockLineServer({
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? '0'),
    controlToken,
  });
  const address = await server.start();
  process.stdout.write(JSON.stringify({
    event: 'mock-line-ready',
    host: address.host,
    port: address.port,
    protocol: 'mock-line-v1',
  }) + '\n');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[mock-cli] Received ${signal}, shutting down\n`);
    try {
      const report = await server.stop({ verify: true });
      if (!report.ok) {
        process.stderr.write(`[mock-cli] Final report not clean: ${JSON.stringify(report.verificationErrors)}\n`);
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[mock-cli] Error during shutdown: ${err}\n`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exit(1);
  });
}