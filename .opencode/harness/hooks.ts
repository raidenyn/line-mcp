// Implementation of .opencode/plugin/line-mcp-harness.ts, kept outside the
// auto-loaded plugin folder so only the plugin's default export is loaded.
// OpenCode counterpart of the Claude Code hooks in .claude/hooks/ (wired there
// in .claude/settings.json). Both hosts run the same Node scripts with the same
// JSON payload, so the behaviour stays aligned and tests/harness covers both:
//   - after an edit tool, .claude/hooks/lint-on-edit.mjs lints the edited
//     TypeScript file; its remaining errors are appended to the tool result
//     (Claude Code gets them through the PostToolUse exit code 2);
//   - once per session, .claude/hooks/session-context.mjs is run and its
//     output appended to the system prompt (Claude Code adds SessionStart
//     stdout to the context).
// Checked against OpenCode 2.3.2 (plugin API @opencode/plugin 2.0.14): the edit
// tools are `write` and `edit` with a `path` relative to the session directory,
// and `patch` (alias `apply_patch`, used for GPT models) with `patchText`;
// `execute.after` may replace `result`; the session `context` hook may push to
// `system`, which is rebuilt for every request. The hand-written `Ctx` types
// below mirror dist/promise/tool.d.ts and dist/promise/session.d.ts of that
// package. Child (subagent) sessions get no context block, matching Claude
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
const LINT_HOOK = '.claude/hooks/lint-on-edit.mjs';
const CONTEXT_HOOK = '.claude/hooks/session-context.mjs';
const LINT_TIMEOUT_MS = 30_000;
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

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

/** File paths an edit tool call wrote, as given in its input. Empty for other tools. */
export function editedPaths(tool: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const name = tool.toLowerCase();
  if (name === 'apply_patch' || name === 'patch') {
    const text = args.patchText ?? args.patch ?? args.input;
    if (typeof text !== 'string') return [];
    return [...new Set([...text.matchAll(PATCH_HEADER)].map((match) => match[1].trim()))];
  }
  if (!['edit', 'write', 'multiedit'].includes(name)) return [];
  const path = args.path ?? args.filePath ?? args.file_path;
  return typeof path === 'string' && path.length > 0 ? [path] : [];
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ToolResult {
  output?: unknown;
  content?: string | readonly unknown[];
  metadata?: unknown;
}

/**
 * Copy of a tool result with `text` appended to what the model reads. A result
 * without content is read from `output`, so that is kept as the first part.
 */
export function appendText(result: ToolResult | undefined, text: string): ToolResult {
  const part: TextContent = { type: 'text', text };
  const base = result ?? {};
  const content = base.content;
  if (typeof content === 'string' && content.length > 0) return { ...base, content: `${content}\n\n${text}` };
  if (Array.isArray(content) && content.length > 0) return { ...base, content: [...content, part] };
  const output = base.output;
  if (output === undefined || output === null || output === '') return { ...base, content: [part] };
  const original = typeof output === 'string' ? output : JSON.stringify(output);
  return { ...base, content: [{ type: 'text', text: original }, part] };
}

interface Ctx {
  location?: { directory?: string };
  tool: { hook: (name: 'execute.after', cb: (event: AfterEvent) => Promise<void> | void) => Promise<unknown> };
  session: {
    hook: (name: 'context', cb: (event: ContextEvent) => Promise<void> | void) => Promise<unknown>;
    get?: (input: { sessionID: string }) => Promise<{ parentID?: string | null } | undefined>;
  };
}

interface AfterEvent {
  tool: string;
  input: unknown;
  status: 'completed' | 'error';
  result?: ToolResult;
}

interface ContextEvent {
  sessionID: string;
  system: Array<{ type: 'text'; text: string }>;
}

/** `hookSpecificOutput.additionalContext` from a hook's JSON stdout, if any. */
export function additionalContext(stdout: string): string | null {
  if (!stdout.trim()) return null;
  try {
    const text = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
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
        await ctx.tool.hook('execute.after', async (event) => {
          try {
            if (event.status !== 'completed') return;
            const feedback: string[] = [];
            for (const file of editedPaths(event.tool, event.input)) {
              const res = await run(LINT_HOOK, { cwd, tool_input: { file_path: file } }, LINT_TIMEOUT_MS);
              if (res.code === 2 && res.stderr.trim()) feedback.push(res.stderr.trim());
              else if (res.code === 0) {
                const note = additionalContext(res.stdout);
                if (note) feedback.push(note);
              }
            }
            if (feedback.length > 0) event.result = appendText(event.result, feedback.join('\n'));
          } catch {
            // Lint feedback is best effort.
          }
        });
      } catch {
        // An incompatible OpenCode build: run without lint feedback.
      }

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

