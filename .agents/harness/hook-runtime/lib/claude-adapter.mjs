// Generated from src/hook-runtime/lib/claude-adapter.mts by scripts/build.mts. Do not edit.
// Claude Code adapter (design D2 tool kinds, D3 event mapping and result delivery): hook payload to
// normalized event, and merged dispatch result to the host's hook JSON.
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const HOST = 'claude-code';

// Event -> host timeout in seconds, written by install into .claude/settings.json.
export const CLAUDE_EVENTS = Object.freeze({
  PreToolUse: 10,
  PostToolUse: 1800,
  PostToolUseFailure: 1800,
  UserPromptSubmit: 10,
  Stop: 1800,
  SubagentStop: 1800,
  PreCompact: 10,
  SessionStart: 10,
});

const TYPES = {
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
  PostToolUseFailure: 'tool.after',
  UserPromptSubmit: 'prompt',
  Stop: 'turn.end',
  SubagentStop: 'turn.end',
  PreCompact: 'compact',
  SessionStart: 'session.start',
};

const KINDS = {
  Bash: 'shell',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const JOIN = '\n\n';

// Repo-relative path with forward slashes, or null when it lies outside the root.
function repoRelative(path, repoRoot, base) {
  if (typeof path !== 'string' || !path) return null;
  const rel = relative(repoRoot, resolve(base, path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function editFiles(input, repoRoot, base) {
  const paths = [input.file_path, input.notebook_path].filter((p) => typeof p === 'string');
  return [...new Set(paths.map((p) => repoRelative(p, repoRoot, base)).filter((p) => p !== null))];
}

export function toEvent(payload, repoRoot) {
  if (!isObject(payload)) return null;
  const name = payload.hook_event_name;
  const type = Object.hasOwn(TYPES, name) ? TYPES[name] : undefined;
  if (!type) return null;
  if (typeof payload.session_id !== 'string' || !payload.session_id) return null;
  // Compaction's own internal agent stops with an empty agent_type; it is not a subagent's turn end.
  if (name === 'SubagentStop' && payload.agent_type === '') return null;
  const agentId = typeof payload.agent_id === 'string' && payload.agent_id ? payload.agent_id : 'main';
  const event = { type, host: HOST };

  if (type === 'tool.before' || type === 'tool.after') {
    const toolName = String(payload.tool_name ?? '');
    const input = isObject(payload.tool_input) ? payload.tool_input : {};
    const kind = Object.hasOwn(KINDS, toolName) ? KINDS[toolName] : 'other';
    event.tool = { name: toolName, kind, input, callId: payload.tool_use_id };
    if (kind === 'shell' && typeof input.command === 'string') event.command = input.command;
    if (kind === 'edit') {
      const base = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : repoRoot;
      event.files = editFiles(input, repoRoot, base);
    }
  } else if (type === 'prompt') {
    event.prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  } else if (type === 'session.start') {
    event.afterCompact = payload.source === 'compact';
  } else if (type === 'turn.end') {
    // Only Stop reads background_tasks; on SubagentStop the list can include the stopping agent.
    // stop_hook_active is ignored: block counting is the handler's job.
    const tasks = name === 'Stop' && Array.isArray(payload.background_tasks) ? payload.background_tasks : [];
    event.background = tasks.filter((t) => isObject(t) && t.type === 'subagent' && t.status === 'running').length;
  }
  return { event, sessionId: payload.session_id, agentId };
}

const unique = (list) => [...new Set(list.filter((t) => typeof t === 'string' && t))];

// The host's hook JSON for a merged dispatch result, or null for no output.
export function toOutput(hookEventName, merged = {}) {
  const notices = unique(merged.notices ?? []);
  const text = (...parts) => unique(parts.flat()).join(JOIN);
  const specific = (fields) => ({
    hookSpecificOutput: { hookEventName, ...fields },
  });
  switch (hookEventName) {
    case 'PreToolUse': {
      if (typeof merged.deny === 'string') {
        const out = specific({ permissionDecision: 'deny', permissionDecisionReason: merged.deny });
        if (notices.length) out.hookSpecificOutput.additionalContext = text(notices);
        return out;
      }
      // A failure notice goes out without a permissionDecision, so the command still runs.
      return notices.length ? specific({ additionalContext: text(notices) }) : null;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'UserPromptSubmit':
    case 'SessionStart': {
      const all = text(merged.context ?? [], notices);
      return all ? specific({ additionalContext: all }) : null;
    }
    case 'Stop':
    case 'SubagentStop': {
      // systemMessage reaches the user only; a block's reason reaches the model.
      const message = text(merged.context ?? [], notices);
      if (typeof merged.block === 'string') {
        const out = { decision: 'block', reason: merged.block };
        if (message) out.systemMessage = message;
        return out;
      }
      return message ? { systemMessage: message } : null;
    }
    default:
      return null; // PreCompact has no channel; its notices are dropped.
  }
}
