import type { MessageReader } from '@raidenyn/line-client';
import type { Principal } from '@raidenyn/mcp-runtime';
import type { TemplateStore } from '../template-store';
import type { CategoryStore } from '../category-store';
import type { PresetStore } from '../preset-store';
import type { RegexExecutorPort } from '../regex-executor';

/**
 * Everything the five bank tools need, injected explicitly rather than reached
 * for through module globals.
 *
 * `createMessageReader(principal)` yields a per-principal, cache-backed
 * `MessageReader` — this is the ONLY per-owner seam; two different principals
 * get two isolated readers. The stores, by contrast, are shared across every
 * principal on one data root: bank categories and templates are the explicit
 * trusted-tenant model (one set of spending categories / per-chat templates for
 * the whole server), deliberately unlike the owner-scoped line-message cache.
 */
export interface BankToolDeps<P extends Principal> {
  createMessageReader(principal: P): Promise<MessageReader>;
  templates: TemplateStore;
  categories: CategoryStore;
  presets: PresetStore;
  regex: RegexExecutorPort;
}
