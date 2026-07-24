import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { NamedTemplate } from './template-store';
import type { RegexExecutorPort } from './regex-executor';

export interface Preset {
  description: string;
  templates: NamedTemplate[];
  currency_aliases: Record<string, string>;
}

export interface PresetSuggestion {
  preset_name: string;
  matched_count: number;
  description: string;
}

// Packaged preset JSON ships under the package's own assets/ tree, resolved
// relative to this module (never process.cwd()). __dirname is
// packages/bank-mcp/src under ts-node and packages/bank-mcp/dist once compiled;
// `../assets/presets` points at packages/bank-mcp/assets/presets in both.
function presetsDir(): string {
  return join(__dirname, '..', 'assets', 'presets');
}

export function loadAllPresets(dir = presetsDir()): Record<string, Preset> {
  const result: Record<string, Preset> = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      const name = entry.slice(0, -5);
      result[name] = {
        description: raw.description ?? '',
        templates: raw.templates ?? [],
        currency_aliases: raw.currency_aliases ?? {},
      };
    } catch {
      // skip malformed files
    }
  }
  return result;
}

export function getPreset(name: string, dir = presetsDir()): Preset | null {
  return loadAllPresets(dir)[name] ?? null;
}

export async function detectPresets(
  regex: RegexExecutorPort,
  messages: Array<{ text?: string }>,
  savedTemplates: Array<{ pattern: string; name?: string }>,
  presets: Record<string, Preset>,
): Promise<PresetSuggestion[]> {
  const suggestions: PresetSuggestion[] = [];

  for (const [presetName, preset] of Object.entries(presets)) {
    let gapCount = 0;
    for (const msg of messages) {
      if (!msg.text) continue;
      let matchedBySaved = false;
      for (const saved of savedTemplates) {
        if (await regex.test(saved.pattern, 's', msg.text, `saved template "${saved.name ?? 'unnamed'}"`)) {
          matchedBySaved = true;
          break;
        }
      }
      if (matchedBySaved) continue;
      let matchedByPreset = false;
      for (const template of preset.templates) {
        if (await regex.test(template.pattern, 's', msg.text, `preset "${presetName}" template "${template.name}"`)) {
          matchedByPreset = true;
          break;
        }
      }
      if (matchedByPreset) gapCount++;
    }
    if (gapCount > 0) {
      suggestions.push({ preset_name: presetName, matched_count: gapCount, description: preset.description });
    }
  }

  return suggestions;
}

/**
 * Read-only accessor for the built-in bank presets. `dir` defaults to the
 * package's own `assets/presets` (resolved relative to this module, not
 * process.cwd()); tests may point it at a temp directory.
 */
export class PresetStore {
  constructor(private readonly dir: string = presetsDir()) {}

  loadAll(): Record<string, Preset> {
    return loadAllPresets(this.dir);
  }

  get(name: string): Preset | null {
    return getPreset(name, this.dir);
  }
}
