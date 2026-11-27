// Implementation of .opencode/plugin/line-mcp-harness.ts, kept outside the
// auto-loaded plugin folder so only the plugin's default export is loaded.
// OpenCode counterpart of the session-context hook in .claude/hooks/ (wired
// there in .claude/settings.json): once per session,
// .claude/hooks/session-context.mjs is run with the same JSON payload and its
// output appended to the system prompt (Claude Code adds SessionStart stdout to
// the context). Edit lint and the verify triggers come from the agent harness
// hook runtime in .agents/harness/ (loaded through opencode.json), not from
// this plugin.
// Checked against OpenCode 2.3.2 (plugin API @opencode/plugin 2.0.14): the
// session `context` hook may push to `system`, which is rebuilt for every
// request. The hand-written `Ctx` type below mirrors dist/promise/session.d.ts
// of that package. Child (subagent) sessions get no context block, matching Claude
// Code, whose SessionStart does not fire for subagents.
// No import from @opencode/plugin: `Plugin.define` is the identity function,
// and keeping the file dependency-free lets Vitest import it.
// Every hook is guarded and degrades to a no-op; nothing here throws into
// OpenCode.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CONTEXT_HOOK = '.claude/hooks/session-context.mjs';
const CONTEXT_TIMEOUT_MS = 20_000;
const MAX_SESSIONS = 200;

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type HookRunner = (script: string, payload: unknown, timeoutMs: number) => Promise<HookRun>;

/** Run a hook script with Node (OpenCode itself runs on Bun) and the payload on stdin. */
export function runHook(root: string): HookRunner {
  return (script, payload, timeoutMs) =>
    new Promise((done) => {
      const path = resolve(root, script);
      if (!existsSync(path)) return done({ code: null, stdout: '', stderr: '' });
      let stdout = '';
      let stderr = '';
      try {
        const child = spawn('node', [path], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs });
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', () => done({ code: null, stdout, stderr }));
        child.on('close', (code) => done({ code, stdout, stderr }));
        child.stdin.on('error', () => undefined);
        child.stdin.end(JSON.stringify(payload));
      } catch {
        done({ code: null, stdout, stderr });
      }
    });
}

interface Ctx {
  location?: { directory?: string };
  session: {
    hook: (name: 'context', cb: (event: ContextEvent) => Promise<void> | void) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<{ parentID?: string | null } | undefined>;
  };
}

interface ContextEvent {
  sessionID: string;
  system: Array<{ type: 'text'; text: string }>;
}

/** True for a subagent session; unknown counts as a top-level session. */
async function isChild(ctx: Ctx, sessionID: string): Promise<boolean> {
  try {
    const info = await ctx.session.get?.({ sessionID });
    return typeof info?.parentID === 'string' && info.parentID.length > 0;
  } catch {
    return false;
  }
}

export function createPlugin(root = REPO_ROOT, run: HookRunner = runHook(root)) {
  return {
    id: 'line-mcp-harness',
    async setup(ctx: Ctx) {
      const cwd = ctx.location?.directory ?? root;
      const contexts = new Map<string, Promise<string>>();

      try {
        await ctx.session.hook('context', async (event) => {
          try {
            let pending = contexts.get(event.sessionID);
            if (!pending) {
              if (contexts.size >= MAX_SESSIONS) contexts.clear();
              pending = isChild(ctx, event.sessionID).then((child) =>
                child
                  ? ''
                  : run(CONTEXT_HOOK, { cwd, hook_event_name: 'SessionStart' }, CONTEXT_TIMEOUT_MS).then(
                      (res) => (res.code === 0 ? res.stdout.trim() : ''),
                      () => '',
                    ),
              );
              contexts.set(event.sessionID, pending);
            }
            const text = await pending;
            if (text && Array.isArray(event.system)) event.system.push({ type: 'text', text });
          } catch {
            // Context is best effort.
          }
        });
      } catch {
        // An incompatible OpenCode build: run without session context.
      }
    },
  };
}

