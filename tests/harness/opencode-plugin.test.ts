import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import plugin from '../../.opencode/plugin/line-mcp-harness';
import { createPlugin, REPO_ROOT, runHook, type HookRun } from '../../.opencode/harness/hooks';

type Callback = (event: unknown) => Promise<void> | void;
type Ctx = Parameters<ReturnType<typeof createPlugin>['setup']>[0];

function fakeContext(parents: Record<string, string> = {}) {
  const hooks: Record<string, Callback> = {};
  return {
    hooks,
    ctx: {
      location: { directory: '/repo' },
      tool: { hook: async (name: string, cb: Callback) => void (hooks[`tool.${name}`] = cb) },
      session: {
        hook: async (name: string, cb: Callback) => void (hooks[`session.${name}`] = cb),
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] }),
      },
    },
  };
}

describe('OpenCode harness plugin', () => {
  it('is the only export of the auto-loaded plugin file and runs the shared session-context script', () => {
    expect(plugin.id).toBe('line-mcp-harness');
    expect(typeof plugin.setup).toBe('function');
    expect(REPO_ROOT).toBe(resolve('.'));
    const source = readFileSync('.opencode/harness/hooks.ts', 'utf8');
    expect(source).toContain(".claude/hooks/session-context.mjs");
    expect(source).not.toContain('lint-on-edit');
  });

  it('registers no tool hook: edit lint comes from the agent harness hook runtime', async () => {
    const { ctx, hooks } = fakeContext();
    await createPlugin('/repo', async () => ({ code: 0, stdout: '', stderr: '' })).setup(ctx as unknown as Ctx);
    expect(Object.keys(hooks)).toEqual(['session.context']);
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

  it('gives subagent (child) sessions no context block, like Claude Code', async () => {
    let runs = 0;
    const run = async (): Promise<HookRun> => {
      runs += 1;
      return { code: 0, stdout: '# Session context (line-mcp)\n', stderr: '' };
    };
    const { ctx, hooks } = fakeContext({ child: 'parent' });
    await createPlugin('/repo', run).setup(ctx as unknown as Ctx);
    const event = { sessionID: 'child', system: [] as unknown[] };
    await hooks['session.context'](event);
    expect(event.system).toEqual([]);
    expect(runs).toBe(0);
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
  });

  it('runs the real hook scripts with node', async () => {
    const result = await runHook(REPO_ROOT)('.claude/hooks/session-context.mjs', {}, 60_000);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^# Session context \(line-mcp\)\nBranch: /);
    const missing = await runHook(REPO_ROOT)('.claude/hooks/missing.mjs', {}, 1_000);
    expect(missing.code).toBeNull();
  });
});
