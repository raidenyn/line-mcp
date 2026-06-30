import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { NamedTemplate } from './template-store';

export interface Preset {
  description: string;
  templates: NamedTemplate[];
  currency_aliases: Record<string, string>;
}

function presetsDir(): string {
  return join(__dirname, 'presets');
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

function testPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 's').test(text);
  } catch {
    return false;
  }
}

export function detectPresets(
  messages: Array<{ text?: string }>,
  savedTemplates: Array<{ pattern: string }>,
  presets: Record<string, Preset>,
): Array<{ preset_name: string; matched_count: number; description: string }> {
  const suggestions: Array<{ preset_name: string; matched_count: number; description: string }> = [];

  for (const [presetName, preset] of Object.entries(presets)) {
    let gapCount = 0;
    for (const msg of messages) {
      if (!msg.text) continue;
      const matchedBySaved = savedTemplates.some((t) => testPattern(t.pattern, msg.text!));
      if (matchedBySaved) continue;
      const matchedByPreset = preset.templates.some((t) => testPattern(t.pattern, msg.text!));
      if (matchedByPreset) gapCount++;
    }
    if (gapCount > 0) {
      suggestions.push({ preset_name: presetName, matched_count: gapCount, description: preset.description });
    }
  }

  return suggestions;
}
