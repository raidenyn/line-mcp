import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { TransactionTemplateSchema } from './transaction-parser';

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

const DEFAULT_STORE_DIR = join(process.cwd(), '.line-templates');
const SAFE_MID_RE = /^[a-zA-Z0-9_-]+$/;

function safeFilePath(chatMid: string, storeDir: string): string {
  if (!SAFE_MID_RE.test(chatMid)) throw new Error(`Invalid chatMid: ${chatMid}`);
  return join(storeDir, `${chatMid}.json`);
}

export function loadTemplates(
  chatMid: string,
  storeDir = DEFAULT_STORE_DIR,
): { templates: NamedTemplate[]; warning?: string } {
  const path = safeFilePath(chatMid, storeDir);
  if (!existsSync(path)) return { templates: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { templates: raw.templates ?? [] };
  } catch {
    return { templates: [], warning: `Template file for ${chatMid} is corrupt or unreadable — returning empty list.` };
  }
}

function writeTemplates(chatMid: string, templates: NamedTemplate[], storeDir: string): void {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  writeFileSync(safeFilePath(chatMid, storeDir), JSON.stringify({ templates }, null, 2));
}

export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir = DEFAULT_STORE_DIR): void {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  writeTemplates(chatMid, templates, storeDir);
}

export function deleteTemplate(chatMid: string, name: string, storeDir = DEFAULT_STORE_DIR): boolean {
  const { templates } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  templates.splice(idx, 1);
  writeTemplates(chatMid, templates, storeDir);
  return true;
}

export function listTemplates(chatMid: string, storeDir = DEFAULT_STORE_DIR): NamedTemplate[] {
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
