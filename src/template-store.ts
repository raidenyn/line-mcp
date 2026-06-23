import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { TransactionTemplateSchema } from './transaction-parser';
import { templatesDir } from './data-dir';

export const NamedTemplateSchema = TransactionTemplateSchema.extend({
  name: z.string().min(1).describe('Unique name for this template within the chat'),
  valid_from: z.string().optional().describe(
    'ISO 8601 datetime with timezone offset e.g. "2025-03-01T00:00:00+07:00". ' +
    'Messages before this time skip this template. Omit for beginning of time.'
  ),
  valid_until: z.string().optional().describe(
    'ISO 8601 datetime with timezone offset e.g. "2025-02-28T23:59:59+07:00". ' +
    'Messages after this time skip this template. Omit if template is still active.'
  ),
});
export type NamedTemplate = z.infer<typeof NamedTemplateSchema>;

const SAFE_MID_RE = /^[a-zA-Z0-9_-]+$/;

function safeFilePath(chatMid: string, storeDir: string): string {
  if (!SAFE_MID_RE.test(chatMid)) throw new Error(`Invalid chatMid: ${chatMid}`);
  return join(storeDir, `${chatMid}.json`);
}

export function loadTemplates(
  chatMid: string,
  storeDir = templatesDir(),
): { templates: NamedTemplate[]; warning?: string } {
  const path = safeFilePath(chatMid, storeDir);
  if (!existsSync(path)) return { templates: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const rawTemplates: NamedTemplate[] = raw.templates ?? [];
    const migrated = rawTemplates.map((t) => {
      const newPattern = t.pattern
        .replace(/\(\?<amount>/g, '(?<original_amount>')
        .replace(/\(\?<currency>/g, '(?<original_currency>');
      return newPattern === t.pattern ? t : { ...t, pattern: newPattern };
    });
    if (migrated.some((t, i) => t !== rawTemplates[i])) {
      writeFileSync(path, JSON.stringify({ templates: migrated }, null, 2));
      process.stderr.write(
        `[LINE] Migrated template patterns for chat ${chatMid}: renamed (?<amount>→(?<original_amount>), (?<currency>→(?<original_currency>)\n`,
      );
    }
    return { templates: migrated };
  } catch {
    return { templates: [], warning: `Template file for ${chatMid} is corrupt or unreadable — returning empty list.` };
  }
}

function writeTemplates(chatMid: string, templates: NamedTemplate[], storeDir: string): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(safeFilePath(chatMid, storeDir), JSON.stringify({ templates }, null, 2));
}

export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir = templatesDir()): void {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  writeTemplates(chatMid, templates, storeDir);
}

export function deleteTemplate(chatMid: string, name: string, storeDir = templatesDir()): boolean {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  templates.splice(idx, 1);
  writeTemplates(chatMid, templates, storeDir);
  return true;
}

export function listTemplates(chatMid: string, storeDir = templatesDir()): NamedTemplate[] {
  return loadTemplates(chatMid, storeDir).templates;
}

export function filterByTime(templates: NamedTemplate[], timestampMs: number): NamedTemplate[] {
  return templates.filter((t) => {
    if (t.valid_from) {
      const from = new Date(t.valid_from).getTime();
      if (Number.isFinite(from) && timestampMs < from) return false;
    }
    if (t.valid_until) {
      const until = new Date(t.valid_until).getTime();
      if (Number.isFinite(until) && timestampMs > until) return false;
    }
    return true;
  });
}
