import * as crypto from 'crypto';
import * as fs from 'fs';
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

const SAFE_MID_RE = /^[a-zA-Z0-9_-]+$/;

function safeFilePath(chatMid: string, storeDir: string): string {
  if (!SAFE_MID_RE.test(chatMid)) throw new Error(`Invalid chatMid: ${chatMid}`);
  return join(storeDir, `${chatMid}.json`);
}

export function loadTemplates(
  chatMid: string,
  storeDir: string,
): { templates: NamedTemplate[]; currency_aliases: Record<string, string> } {
  const path = safeFilePath(chatMid, storeDir);
  let contents: string;
  try {
    contents = fs.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { templates: [], currency_aliases: {} };
    }
    throw error;
  }

  const raw = JSON.parse(contents);
  const rawAliases: Record<string, string> = raw.currency_aliases ?? {};
  const rawTemplates: NamedTemplate[] = raw.templates ?? [];
  const migrated = rawTemplates.map((t) => {
    let newPattern = t.pattern;
    // Only rename old group names to new ones if the new name isn't already present,
    // otherwise we'd create duplicate named capture groups (invalid regex).
    if (!/\(\?<original_amount>/.test(newPattern)) {
      newPattern = newPattern.replace(/\(\?<amount>/g, '(?<original_amount>');
    }
    if (!/\(\?<original_currency>/.test(newPattern)) {
      newPattern = newPattern.replace(/\(\?<currency>/g, '(?<original_currency>');
    }
    return newPattern === t.pattern ? t : { ...t, pattern: newPattern };
  });
  if (migrated.some((t, i) => t !== rawTemplates[i])) {
    writeTemplates(chatMid, migrated, rawAliases, storeDir);
    process.stderr.write(
      `[LINE] Migrated template patterns for chat ${chatMid}: renamed legacy capture group names where safe\n`,
    );
  }
  return { templates: migrated, currency_aliases: rawAliases };
}

function writeTemplates(
  chatMid: string,
  templates: NamedTemplate[],
  aliases: Record<string, string>,
  storeDir: string,
): void {
  const destination = safeFilePath(chatMid, storeDir);
  const serialized = JSON.stringify({ templates, currency_aliases: aliases }, null, 2);
  fs.mkdirSync(storeDir, { recursive: true });
  const temporary = join(
    storeDir,
    `.${chatMid}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    fs.writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created or may already be gone.
    }
    throw error;
  }
}

export function upsertTemplate(chatMid: string, template: NamedTemplate, storeDir: string): void {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === template.name);
  if (idx >= 0) templates[idx] = template;
  else templates.push(template);
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
}

export function deleteTemplate(chatMid: string, name: string, storeDir: string): boolean {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  const idx = templates.findIndex((t) => t.name === name);
  if (idx < 0) return false;
  templates.splice(idx, 1);
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
  return true;
}

export function listTemplates(chatMid: string, storeDir: string): NamedTemplate[] {
  return loadTemplates(chatMid, storeDir).templates;
}

export function upsertAlias(
  chatMid: string,
  alias: string,
  canonical: string,
  storeDir: string,
): void {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  currency_aliases[alias] = canonical;
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
}

export function deleteAlias(
  chatMid: string,
  alias: string,
  storeDir: string,
): boolean {
  const { templates, currency_aliases } = loadTemplates(chatMid, storeDir);
  if (!(alias in currency_aliases)) return false;
  delete currency_aliases[alias];
  writeTemplates(chatMid, templates, currency_aliases, storeDir);
  return true;
}

export function listAliases(
  chatMid: string,
  storeDir: string,
): Record<string, string> {
  return loadTemplates(chatMid, storeDir).currency_aliases;
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

/**
 * File-backed store for per-chat transaction templates and currency aliases,
 * bound to an explicit `storeDir` (one JSON file per chat MID beneath it). The
 * directory is injected — there is no implicit process.cwd()-derived default —
 * so the composed server, a standalone bank server, and tests can each point
 * it at their own data root. Templates and aliases are intentionally shared
 * across principals on one data root (the trusted-tenant model): the store is
 * keyed only by chatMid, never by owner.
 */
export class TemplateStore {
  constructor(private readonly storeDir: string) {}

  load(chatMid: string): { templates: NamedTemplate[]; currency_aliases: Record<string, string> } {
    return loadTemplates(chatMid, this.storeDir);
  }

  upsert(chatMid: string, template: NamedTemplate): void {
    upsertTemplate(chatMid, template, this.storeDir);
  }

  delete(chatMid: string, name: string): boolean {
    return deleteTemplate(chatMid, name, this.storeDir);
  }

  list(chatMid: string): NamedTemplate[] {
    return listTemplates(chatMid, this.storeDir);
  }

  upsertAlias(chatMid: string, alias: string, canonical: string): void {
    upsertAlias(chatMid, alias, canonical, this.storeDir);
  }

  deleteAlias(chatMid: string, alias: string): boolean {
    return deleteAlias(chatMid, alias, this.storeDir);
  }

  listAliases(chatMid: string): Record<string, string> {
    return listAliases(chatMid, this.storeDir);
  }
}
