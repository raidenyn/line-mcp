import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CHANGES_DIR = 'openspec/changes';

type UnverifiedTask = {
  line: number;
  task: string;
};

/**
 * Every unchecked task in an active change must end with a `Verify:` line, so
 * an implementer can prove the task is done with an exact command.
 */
export function findUnverifiedTasks(tasksMarkdown: string): UnverifiedTask[] {
  const lines = tasksMarkdown.split(/\r?\n/);
  const unverified: UnverifiedTask[] = [];
  const taskPattern = /^\s*- \[ \]\s+/;
  const blockEndPattern = /^\s*- \[[ xX]\]\s+|^#{1,6}\s/;
  const verifyPattern = /^\s+(?:[-*]\s+)?Verify:\s+\S/;

  for (let index = 0; index < lines.length; index += 1) {
    if (!taskPattern.test(lines[index])) {
      continue;
    }

    let verified = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (blockEndPattern.test(lines[next])) {
        break;
      }
      if (verifyPattern.test(lines[next])) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      unverified.push({ line: index + 1, task: lines[index].trim() });
    }
  }

  return unverified;
}

describe('OpenSpec task verification', () => {
  it('flags an unchecked task without a Verify line', () => {
    const tasks = [
      '## 1. Implementation',
      '',
      '- [ ] 1.1 Add the parser',
      '',
      '## 2. Validation',
      '',
      '- [ ] 2.1 Run the suite',
      '  Verify: `npm run test:unit`',
      '',
    ].join('\n');

    expect(findUnverifiedTasks(tasks)).toEqual([
      { line: 3, task: '- [ ] 1.1 Add the parser' },
    ]);
  });

  it('accepts an unchecked task with a Verify line', () => {
    const tasks = ['- [ ] 1.1 Add the parser', '  Verify: `npm run test:unit`'].join('\n');

    expect(findUnverifiedTasks(tasks)).toEqual([]);
  });

  it('accepts a Verify line written as a nested list item', () => {
    const tasks = ['- [ ] 1.1 Add the parser', '  - Verify: `npm run test:unit`'].join('\n');

    expect(findUnverifiedTasks(tasks)).toEqual([]);
  });

  it('does not require Verify on completed tasks', () => {
    const tasks = ['- [x] 1.1 Add the parser'].join('\n');

    expect(findUnverifiedTasks(tasks)).toEqual([]);
  });

  it('does not accept a Verify line that belongs to the next task', () => {
    const tasks = [
      '- [ ] 1.1 Add the parser',
      '- [ ] 1.2 Run the suite',
      '  Verify: `npm run test:unit`',
    ].join('\n');

    expect(findUnverifiedTasks(tasks)).toEqual([
      { line: 1, task: '- [ ] 1.1 Add the parser' },
    ]);
  });

  it('requires a Verify line in every non-archived change', () => {
    const failures: string[] = [];

    for (const entry of readdirSync(CHANGES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'archive') {
        continue;
      }

      const tasksPath = join(CHANGES_DIR, entry.name, 'tasks.md');
      if (!existsSync(tasksPath)) {
        continue;
      }

      for (const violation of findUnverifiedTasks(readFileSync(tasksPath, 'utf8'))) {
        failures.push(`${tasksPath}:${violation.line} ${violation.task}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
