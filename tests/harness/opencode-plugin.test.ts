import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin from '../../.opencode/plugin/line-mcp-harness';
import {
  appendText,
  createPlugin,
  editedPaths,
  REPO_ROOT,
  runHook,
  type HookRun,
} from '../../.opencode/harness/hooks';

type Callback = (event: unknown) => Promise<void> | void;
type Ctx = Parameters<ReturnType<typeof createPlugin>['setup']>[0];

function fakeContext() {
  const hooks: Record<string, Callback> = {};
  return {
    hooks,
    ctx: {
      location: { directory: '/repo' },
      tool: { hook: async (name: string, cb: Callback) => void (hooks[`tool.${name}`] = cb) },
      session: { hook: async (name: string, cb: Callback) => void (hooks[`session.${name}`] = cb) },
    },
  };
}

describe('OpenCode harness plugin', () => {
  it('is the only export of the auto-loaded plugin file and runs the shared Claude hook scripts', () => {
    expect(plugin.id).toBe('line-mcp-harness');
    expect(typeof plugin.setup).toBe('function');
    expect(REPO_ROOT).toBe(resolve('.'));
    const source = readFileSync('.opencode/harness/hooks.ts', 'utf8');
    expect(source).toContain(".claude/hooks/lint-on-edit.mjs");
    expect(source).toContain(".claude/hooks/session-context.mjs");
  });

  it('extracts edited paths from OpenCode edit tools and patches', () => {
    expect(editedPaths('write', { path: 'a.ts', content: '' })).toEqual(['a.ts']);
    expect(editedPaths('edit', { path: 'b.ts', oldString: 'x', newString: 'y' })).toEqual(['b.ts']);
    expect(editedPaths('edit', { filePath: '/abs/c.ts' })).toEqual(['/abs/c.ts']);
    expect(
      editedPaths('apply_patch', {
        patchText: '*** Begin Patch\n*** Update File: a.ts\n@@\n*** Add File: b.ts\n+x\n*** Delete File: c.ts\n*** End Patch',
      }),
    ).toEqual(['a.ts', 'b.ts']);
    expect(editedPaths('bash', { command: 'echo > a.ts' })).toEqual([]);
    expect(editedPaths('read', { path: 'a.ts' })).toEqual([]);
  });

  it('appends text to array and string tool content', () => {
    expect(appendText({ content: [{ type: 'text', text: 'ok' }] }, 'lint')).toEqual({
      content: [
        { type: 'text', text: 'ok' },
        { type: 'text', text: 'lint' },
      ],
    });
    expect(appendText({ content: 'ok', metadata: { a: 1 } }, 'lint')).toEqual({ content: 'ok\n\nlint', metadata: { a: 1 } });
    expect(appendText(undefined, 'lint')).toEqual({ content: [{ type: 'text', text: 'lint' }] });
  });

  it('feeds lint errors back into the edit tool result with the Claude payload shape', async () => {
    const calls: Array<{ script: string; payload: unknown }> = [];
    const run = async (script: string, payload: unknown): Promise<HookRun> => {
      calls.push({ script, payload });
      return { code: 2, stdout: '', stderr: 'ESLint: 1 error(s) remain in a.ts after --fix. Fix them now:\na.ts:1:7 bad\n' };
    };
    const { ctx, hooks } = fakeContext();
    await createPlugin('/repo', run).setup(ctx as unknown as Ctx);

    const event = { tool: 'edit', input: { path: 'a.ts' }, status: 'completed', result: { content: [{ type: 'text', text: 'Edited' }] } };
    await hooks['tool.execute.after'](event);
    expect(calls).toEqual([{ script: '.claude/hooks/lint-on-edit.mjs', payload: { cwd: '/repo', tool_input: { file_path: 'a.ts' } } }]);
    expect(event.result.content.at(-1)).toEqual({ type: 'text', text: 'ESLint: 1 error(s) remain in a.ts after --fix. Fix them now:\na.ts:1:7 bad' });

    // Failed tools, non-edit tools and clean files leave the result alone.
    const untouched = { content: [{ type: 'text', text: 'x' }] };
    for (const other of [
      { tool: 'edit', input: { path: 'a.ts' }, status: 'error', result: untouched },
      { tool: 'read', input: { path: 'a.ts' }, status: 'completed', result: untouched },
    ]) {
      await hooks['tool.execute.after'](other);
      expect(other.result).toBe(untouched);
    }
  });

  it('adds the session context to the system prompt, computed once per session', async () => {
    let runs = 0;
    const run = async (): Promise<HookRun> => {
      runs += 1;
      return { code: 0, stdout: '# Session context (line-mcp)\nBranch: feat/x\n', stderr: '' };
    };
    const { ctx, hooks } = fakeContext();
    await createPlugin('/repo', run).setup(ctx as unknown as Ctx);

    for (let i = 0; i < 3; i += 1) {
      const event = { sessionID: 's1', system: [{ type: 'text', text: 'base' }] };
      await hooks['session.context'](event);
      expect(event.system).toEqual([
        { type: 'text', text: 'base' },
        { type: 'text', text: '# Session context (line-mcp)\nBranch: feat/x' },
      ]);
    }
    expect(runs).toBe(1);
    await hooks['session.context']({ sessionID: 's2', system: [] });
    expect(runs).toBe(2);
  });

  it('never throws into OpenCode when a hook script fails', async () => {
    const run = async (): Promise<HookRun> => {
      throw new Error('boom');
    };
    const { ctx, hooks } = fakeContext();
    await createPlugin('/repo', run).setup(ctx as unknown as Ctx);
    const event = { sessionID: 's1', system: [] as unknown[] };
    await expect(hooks['session.context'](event)).resolves.toBeUndefined();
    expect(event.system).toEqual([]);
    await expect(
      hooks['tool.execute.after']({ tool: 'write', input: { path: 'a.ts' }, status: 'completed', result: {} }),
    ).resolves.toBeUndefined();
  });

  it('runs the real hook scripts with node', async () => {
    const result = await runHook(REPO_ROOT)('.claude/hooks/session-context.mjs', {}, 60_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^# Session context \(line-mcp\)\nBranch: /);
    const missing = await runHook(REPO_ROOT)('.claude/hooks/missing.mjs', {}, 1_000);
    expect(missing.code).toBeNull();
  });
});
