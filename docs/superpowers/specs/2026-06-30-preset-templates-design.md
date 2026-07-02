# Design: Preset Templates for New MCP Clients

**Date:** 2026-06-30  
**Status:** Approved

## Goal

Lower the barrier for new MCP clients to start using transaction functions. Instead of deriving regex patterns from scratch, clients discover predefined working patterns (presets) automatically when sampling messages and apply them with a single tool call.

## Design

### 1. Preset Files (`src/presets/`)

One JSON file per bank/channel, e.g. `src/presets/scb.json`, `src/presets/cardx.json`.

Format is identical to existing `data/templates/<chatMid>.json` (same `templates` array + `currency_aliases` map), with one additional top-level field:

```json
{
  "description": "SCB Connect — Thai baht debit/credit notifications",
  "templates": [ ... ],
  "currency_aliases": { ... }
}
```

The existing SCB and CardX template files are the seed content — copy them into `src/presets/` with a rename and add a `description`.

**Adding a new channel = drop a JSON file. No code change required.**

### 2. `preset-store.ts`

New module in `src/`. Exports:

- `loadAllPresets(): Record<string, Preset>` — reads all `*.json` from `src/presets/` at call time. `Preset` extends the existing template file shape with a required `description: string`.
- `getPreset(name: string): Preset | null` — returns a single preset by filename stem, or `null`.

No caching — called only during `sample_messages` and `manage_templates` actions, where the overhead is negligible.

### 3. Detection in `sample_messages`

After fetching messages (existing behavior unchanged), the handler runs detection:

1. Load chat's existing saved templates via `loadTemplates(chatMid)`.
2. Load all presets via `loadAllPresets()`.
3. For each preset, scan the returned messages:
   - A message is **unmatched** if none of the chat's saved patterns match it.
   - A message is **preset-matched** if any of the preset's patterns match it.
   - If ≥1 message satisfies both → preset is a gap-filling candidate.
4. Build `preset_suggestions: Array<{ preset_name: string; matched_count: number; description: string }>`.

Response changes:
- New `preset_suggestions` field (structured; empty array when nothing detected).
- When non-empty, a text note is appended to the existing human-readable response:  
  `"X messages matched the '<name>' preset but no saved template — run manage_templates with action: apply_preset, preset_name: '<name>' to set it up."`

Detection scope is limited to the messages returned in that `sample_messages` call — consistent with existing tool behavior.

### 4. New `manage_templates` Actions

Two actions added to the existing `action` enum:

**`list_presets`**  
No extra parameters required (`chatMid` is ignored if provided). Returns `Array<{ name, description, template_count, currency_alias_count }>` for every file in `src/presets/`.

**`apply_preset`**  
Requires `preset_name` and `chatMid`. Loads the named preset, then calls `upsertTemplate` for each template and `upsertAlias` for each currency alias into the chat's template file. Existing user-defined templates are preserved — this is additive by name, not a replace-all. Returns a confirmation summary. If the preset name is not found, returns a clear error listing available preset names.

## Files Changed

| File | Change |
|------|--------|
| `src/presets/scb.json` | New — seeded from existing SCB template data |
| `src/presets/cardx.json` | New — seeded from existing CardX template data |
| `src/preset-store.ts` | New — `loadAllPresets`, `getPreset` |
| `src/index.ts` | `sample_messages` handler: add detection + structured/text response fields |
| `src/index.ts` | `manage_templates` handler: add `list_presets`, `apply_preset` action branches |
| `docs/guide/tools/manage_templates.md` | Document new actions |
| `docs/guide/tools/sample_messages.md` | Document `preset_suggestions` field |

## Out of Scope

- Auto-applying presets without client confirmation — clients always call `apply_preset` explicitly.
- Keyword pre-filtering for performance — unnecessary at expected preset library scale.
- Preset versioning or conflict resolution beyond name-based upsert.
