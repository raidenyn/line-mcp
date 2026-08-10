import { afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  RegexExecutor,
  normalizeRegexTimeoutMs,
} from './regex-executor';
import type { WorkerFactory } from './regex-executor';

const executors: RegexExecutor[] = [];
function createExecutor(timeoutMs = 100, workerFactory?: WorkerFactory): RegexExecutor {
  const executor = new RegexExecutor({ timeoutMs, workerFactory });
  executors.push(executor);
  return executor;
}

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe('normalizeRegexTimeoutMs', () => {
  it.each([
    [undefined, 100], [Number.NaN, 100], [0, 10], [9, 10],
    [10, 10], [250, 250], [1000, 1000], [1001, 1000],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRegexTimeoutMs(input)).toBe(expected);
  });
});

describe('RegexExecutor', () => {
  it('executes named groups, lookarounds, and backreferences with native JS semantics', async () => {
    const executor = createExecutor();
    await expect(executor.exec(
      '(?<word>[A-Z]+):(?=\\k<word>)\\k<word>',
      'u',
      'USD:USD',
      'compatibility pattern',
    )).resolves.toMatchObject({ groups: { word: 'USD' } });
  });

  it('rejects invalid syntax with pattern context', async () => {
    const executor = createExecutor();
    await expect(executor.validate('([invalid', 's', 'template "bad"')).rejects.toMatchObject({
      name: 'RegexExecutionError',
      code: 'invalid',
      context: 'template "bad"',
    });
  });

  it('rejects oversized patterns and subjects before worker dispatch', async () => {
    const executor = createExecutor();
    await expect(executor.validate('a'.repeat(16_385), 's', 'large pattern'))
      .rejects.toMatchObject({ code: 'pattern_too_large' });
    await expect(executor.test('a', 's', 'a'.repeat(65_537), 'large subject'))
      .rejects.toMatchObject({ code: 'subject_too_large' });
  });

  it.each(['(a|aa)+$', '(a+){10}$'])(
    'times out catastrophic pattern %s',
    async (pattern) => {
      const executor = createExecutor(10);
      await expect(executor.test(pattern, 's', `${'a'.repeat(40)}!`, `pattern ${pattern}`))
        .rejects.toMatchObject({ code: 'timeout' });
    },
  );

  it('keeps the main event loop responsive during catastrophic matching', async () => {
    const executor = createExecutor(10);
    await executor.validate('safe', 's', 'warm worker');
    let timerFired = false;
    const match = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'responsive test');
    setTimeout(() => { timerFired = true; }, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(timerFired).toBe(true);
    await expect(match).rejects.toMatchObject({ code: 'timeout' });
  });

  it('replaces a timed-out worker and runs the next normal job', async () => {
    const executor = createExecutor(10);
    await expect(executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'bad'))
      .rejects.toMatchObject({ code: 'timeout' });
    await expect(executor.test('safe', 's', 'safe', 'good')).resolves.toBe(true);
  });

  it('caps the pending queue at 100 jobs', async () => {
    const executor = createExecutor(1000);
    await executor.validate('safe', 's', 'warm workers');
    const jobs = Array.from({ length: 102 }, () =>
      executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'queued').catch((error) => error),
    );
    await expect(executor.test('safe', 's', 'safe', 'overflow'))
      .rejects.toMatchObject({ code: 'busy' });
    await executor.close();
    await Promise.all(jobs);
  });

  it('reports a worker crash', async () => {
    const crashSource = `
      const { parentPort } = require('node:worker_threads');
      parentPort.once('message', () => process.exit(9));
    `;
    const executor = new RegexExecutor({ workerSource: crashSource });
    executors.push(executor);
    await expect(executor.test('a', 's', 'a', 'crash'))
      .rejects.toMatchObject({ code: 'worker_failure' });
  });

  it('closes idempotently and rejects queued work', async () => {
    const executor = createExecutor(1000);
    const active = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'active')
      .catch((error) => error);
    const queued = executor.test('safe', 's', 'safe', 'queued')
      .catch((error) => error);
    await executor.close();
    await expect(active).resolves.toMatchObject({ code: 'closed' });
    await expect(queued).resolves.toMatchObject({ code: 'closed' });
    await expect(executor.close()).resolves.toBeUndefined();
  });

  it('concurrent close calls share one shutdown promise', async () => {
    const executor = createExecutor(1000);
    const active = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'active')
      .catch((error) => error);
    const closeA = executor.close();
    const closeB = executor.close();
    expect(closeA).toBe(closeB);
    await closeA;
    await expect(active).resolves.toMatchObject({ code: 'closed' });
  });

  it('does not spawn a replacement worker before termination settles', async () => {
    const deferreds: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const factory: WorkerFactory = (source, options) => {
      const worker = new Worker(source, options);
      const origTerminate = worker.terminate.bind(worker);
      let terminated = false;
      worker.terminate = () => {
        if (terminated) return origTerminate();
        terminated = true;
        const deferred = Promise.withResolvers<void>();
        deferreds.push({
          resolve: () => {
            origTerminate();
            deferred.resolve();
          },
          reject: deferred.reject,
        });
        return deferred.promise.then(() => 0);
      };
      return worker;
    };
    const executor = createExecutor(10, factory) as unknown as {
      test(pattern: string, flags: string, subject: string, context: string): Promise<boolean>;
      validate(pattern: string, flags: string, context: string): Promise<void>;
      close(): Promise<void>;
      slots: Array<{ worker: { threadId: number }; replacing: boolean }>;
    };
    await executor.validate('warm1', 's', 'warm1');
    await executor.validate('warm2', 's', 'warm2');
    const initialThreadIds = new Set(executor.slots.map((s) => s.worker.threadId));
    expect(initialThreadIds.size).toBe(2);

    const timeoutJob = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'bad');
    await expect(timeoutJob).rejects.toMatchObject({ code: 'timeout' });

    const replacingSlots = executor.slots.filter((s) => s.replacing);
    expect(replacingSlots.length).toBe(1);

    const currentThreadIds = new Set(executor.slots.map((s) => s.worker.threadId));
    const newWorkers = [...currentThreadIds].filter((id) => !initialThreadIds.has(id));
    expect(newWorkers).toHaveLength(0);

    deferreds[0].resolve();
    await executor.test('safe', 's', 'safe', 'good');

    const finalThreadIds = new Set(executor.slots.map((s) => s.worker.threadId));
    const newWorkersAfter = [...finalThreadIds].filter((id) => !initialThreadIds.has(id));
    expect(newWorkersAfter.length).toBeGreaterThanOrEqual(1);

    for (const d of deferreds) d.resolve();
    const closePromise = executor.close();
    for (const d of deferreds) d.resolve();
    await closePromise;
  });

  it('does not admit jobs beyond the queue cap while a slot is replacing', async () => {
    const deferreds: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    const factory: WorkerFactory = (source, options) => {
      const worker = new Worker(source, options);
      const origTerminate = worker.terminate.bind(worker);
      let terminated = false;
      worker.terminate = () => {
        if (terminated) return origTerminate();
        terminated = true;
        const deferred = Promise.withResolvers<void>();
        deferreds.push({
          resolve: () => {
            origTerminate().then(
              () => deferred.resolve(),
              (e) => deferred.reject(e),
            );
          },
          reject: deferred.reject,
        });
        return deferred.promise.then(() => 0);
      };
      return worker;
    };
    const executor = createExecutor(10, factory) as unknown as {
      test(pattern: string, flags: string, subject: string, context: string): Promise<boolean>;
      validate(pattern: string, flags: string, context: string): Promise<void>;
      close(): Promise<void>;
      slots: Array<{ replacing: boolean }>;
    };
    await executor.validate('warm1', 's', 'warm1');
    await executor.validate('warm2', 's', 'warm2');

    const t1 = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'bad1').catch((e) => e);
    const t2 = executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'bad2').catch((e) => e);
    await Promise.all([t1, t2]);

    expect(executor.slots.every((s) => s.replacing)).toBe(true);

    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      jobs.push(executor.test('safe', 's', 'safe', `queued ${i}`).catch((e) => e));
    }
    await expect(executor.test('safe', 's', 'safe', 'overflow'))
      .rejects.toMatchObject({ code: 'busy' });

    for (const d of deferreds) d.resolve();
    await executor.close();
    await Promise.all(jobs);
  });
});