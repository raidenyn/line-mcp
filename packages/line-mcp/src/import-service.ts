import * as crypto from 'crypto';
import express, { type Express, type Request as ExpressRequest } from 'express';
import { parseExportFile, parseExportHeader, type MessageCache } from '@raidenyn/line-client';
import type { LinePrincipal } from './auth/line-auth-provider';
import type { RequestLineClient } from './request-client';

interface PendingUpload {
  mid: string;
  expires: number;
}

interface PendingFile {
  content: string;
  chatName: string;
  mid: string;
  expires: number;
}

export interface ImportServiceOptions {
  /** Mounted under this base path — same value the executable derives for the rest of its routes. */
  basePath: string;
  cache: MessageCache;
  /** Same request-client factory used by the messenger tools (see request-client.ts). */
  createRequestClient(principal: LinePrincipal): Promise<RequestLineClient>;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id generator; defaults to `crypto.randomUUID`. */
  randomId?: () => string;
  /** Upload-token lifetime in ms. Default 15 minutes. */
  uploadTtlMs?: number;
  /** Uploaded-file lifetime in ms. Default 1 hour. */
  fileTtlMs?: number;
  /** Overrides the auto-derived `req.protocol://req.get('host')` base for the upload URL. */
  publicUrl?: string;
  /** Test seam — defaults to the real export parser from @raidenyn/line-client. */
  parseExportFile?: typeof parseExportFile;
  parseExportHeader?: typeof parseExportHeader;
}

const DEFAULT_UPLOAD_TTL_MS = 900_000; // 15 min
const DEFAULT_FILE_TTL_MS = 3_600_000; // 1 hour

/**
 * Every distinct outcome complete_import can report, preserved 1:1 with the
 * pre-extraction inline handler so the tool wrapper can reproduce the exact
 * historical content/isError shape for each case.
 */
export type CompleteImportOutcome =
  | { kind: 'not_found_or_expired' }
  | { kind: 'wrong_owner' }
  | { kind: 'needs_timezone' }
  | { kind: 'invalid_timezone'; timezone: string }
  | { kind: 'list_chats_failed'; error: string }
  | { kind: 'no_chat_match'; chatName: string; available: string }
  | { kind: 'multiple_chat_matches'; chatName: string; candidates: Array<{ chat_mid: string; name: string }> }
  | { kind: 'import_failed'; error: string }
  | {
      kind: 'success';
      parsed: number;
      imported: number;
      chat_mid: string;
      chat_name: string;
      date_range: { from: string; to: string } | null;
    };

/**
 * Owns the import-upload flow end to end: issuing one-time upload-capability
 * tokens (initiate), the independently-mounted raw-upload HTTP route
 * (mountRoutes), and owner-scoped completion (complete). Pending-upload and
 * pending-file state is private to this instance — nothing outside this class
 * can read or mutate it. A file uploaded under principal A's token can only
 * ever be completed by principal A (see the wrong_owner check in complete()).
 */
export class ImportService {
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly pendingFiles = new Map<string, PendingFile>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly uploadTtlMs: number;
  private readonly fileTtlMs: number;
  private readonly parseFile: typeof parseExportFile;
  private readonly parseHeader: typeof parseExportHeader;

  constructor(private readonly options: ImportServiceOptions) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.uploadTtlMs = options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
    this.fileTtlMs = options.fileTtlMs ?? DEFAULT_FILE_TTL_MS;
    this.parseFile = options.parseExportFile ?? parseExportFile;
    this.parseHeader = options.parseExportHeader ?? parseExportHeader;
  }

  private pruneUploads(): void {
    const now = this.now();
    for (const [token, entry] of this.pendingUploads) {
      if (entry.expires < now) this.pendingUploads.delete(token);
    }
  }

  private pruneFiles(): void {
    const now = this.now();
    for (const [id, entry] of this.pendingFiles) {
      if (entry.expires < now) this.pendingFiles.delete(id);
    }
  }

  /** Mints a one-time upload token bound to `principal.mid` and returns its canonical URL. */
  initiate(principal: LinePrincipal, req: ExpressRequest): { upload_url: string } {
    this.pruneUploads();
    const token = this.randomId();
    this.pendingUploads.set(token, { mid: principal.mid, expires: this.now() + this.uploadTtlMs });
    const base = this.options.publicUrl?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
    const uploadUrl = `${base}${this.options.basePath}/import-upload?token=${token}`;
    return { upload_url: uploadUrl };
  }

  /**
   * Mounts the raw-upload route on its own — independent of, and never
   * touched by, OAuth route registration. The route itself carries no bearer
   * auth: the one-time token in the query string IS the capability.
   */
  mountRoutes(app: Express): void {
    app.post(
      `${this.options.basePath}/import-upload`,
      express.raw({ type: '*/*', limit: '10mb' }),
      (req, res) => {
        const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
        const entry = this.pendingUploads.get(token);
        if (!entry || entry.expires < this.now()) {
          this.pendingUploads.delete(token);
          res.status(401).json({ error: 'invalid_or_expired_token' });
          return;
        }
        const { mid } = entry;
        this.pendingUploads.delete(token); // one-time use

        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: 'Expected raw file body.' });
          return;
        }
        const content = req.body.toString('utf8');
        let chatName: string;
        try {
          chatName = this.parseHeader(content);
        } catch {
          res.status(400).json({ error: 'File does not appear to be a LINE chat export.' });
          return;
        }

        this.pruneFiles();
        const fileRefId = this.randomId();
        this.pendingFiles.set(fileRefId, { content, chatName, mid, expires: this.now() + this.fileTtlMs });
        res.json({ file_ref_id: fileRefId, chat_name: chatName });
      },
    );
  }

  /**
   * Completes an import. `principal` is the REQUESTING principal (the caller
   * of complete_import) — ownership is checked against it, and chat detection
   * (when chat_mid is omitted) lists chats for this same principal, never the
   * uploader implicitly trusted from some other source.
   */
  async complete(
    principal: LinePrincipal,
    args: { file_ref_id: string; timezone?: string; chat_mid?: string },
  ): Promise<CompleteImportOutcome> {
    const { file_ref_id, timezone, chat_mid } = args;

    const fileEntry = this.pendingFiles.get(file_ref_id);
    if (!fileEntry || fileEntry.expires < this.now()) {
      this.pendingFiles.delete(file_ref_id);
      return { kind: 'not_found_or_expired' };
    }
    if (fileEntry.mid !== principal.mid) {
      return { kind: 'wrong_owner' };
    }

    if (!timezone) {
      return { kind: 'needs_timezone' };
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      return { kind: 'invalid_timezone', timezone };
    }

    let resolvedMid = chat_mid;
    const { content, chatName } = fileEntry;

    if (!resolvedMid) {
      let chats: Array<{ mid: string; name: string }>;
      try {
        const client = await this.options.createRequestClient(principal);
        chats = await client.api.listChats();
      } catch (err) {
        return { kind: 'list_chats_failed', error: (err as Error).message };
      }
      const lower = chatName.toLowerCase();
      const matches = chats.filter((c) => c.name.toLowerCase() === lower);
      if (matches.length === 0) {
        const available = chats.map((c) => c.name).join(', ');
        return { kind: 'no_chat_match', chatName, available };
      }
      if (matches.length > 1) {
        return {
          kind: 'multiple_chat_matches',
          chatName,
          candidates: matches.map((c) => ({ chat_mid: c.mid, name: c.name })),
        };
      }
      resolvedMid = matches[0].mid;
    }

    try {
      const messages = this.parseFile(content, resolvedMid, timezone);
      if (messages.length === 0) {
        return {
          kind: 'import_failed',
          error: 'No messages were found in the LINE chat export.',
        };
      }
      // Owner-scoped write: always the completing principal's mid, never a
      // value read out of the uploaded file or request body.
      const { imported } = this.options.cache.importMessages(
        principal.mid,
        resolvedMid,
        messages,
      );
      this.pendingFiles.delete(file_ref_id); // clean up after success

      const timestamps = messages.map((m) => parseInt(m.createdTime, 10)).filter(Number.isFinite);
      const dateRange = timestamps.length > 0
        ? {
            from: new Date(timestamps.reduce((a, b) => (b < a ? b : a))).toISOString(),
            to: new Date(timestamps.reduce((a, b) => (b > a ? b : a))).toISOString(),
          }
        : null;

      return {
        kind: 'success',
        parsed: messages.length,
        imported,
        chat_mid: resolvedMid,
        chat_name: chatName,
        date_range: dateRange,
      };
    } catch (err) {
      return { kind: 'import_failed', error: (err as Error).message };
    }
  }
}
