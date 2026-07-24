import { afterEach, describe, expect, it } from 'vitest';
import {
  RegexExecutor,
  normalizeRegexTimeoutMs,
} from './regex-executor';

const executors: RegexExecutor[] = [];
function createExecutor(timeoutMs = 100): RegexExecutor {
  const executor = new RegexExecutor({ timeoutMs });
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
    const [a, b] = await Promise.all([executor.close(), executor.close()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    await expect(active).resolves.toMatchObject({ code: 'closed' });
  });

  it('awaits worker termination before spawning a replacement', async () => {
    const executor = createExecutor(10);
    await expect(executor.test('(a|aa)+$', 's', `${'a'.repeat(40)}!`, 'bad'))
      .rejects.toMatchObject({ code: 'timeout' });
    await expect(executor.test('safe', 's', 'safe', 'good')).resolves.toBe(true);
    await executor.close();
  });
});