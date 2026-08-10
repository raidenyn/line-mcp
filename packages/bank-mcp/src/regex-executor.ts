import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import { REGEX_WORKER_SOURCE } from './regex-worker-source';

function defaultWorkerFactory(source: string, options: WorkerOptions): Worker {
  return new Worker(source, options);
}

export type WorkerFactory = (source: string, options: WorkerOptions) => Worker;

const DEFAULT_TIMEOUT_MS = 100;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 1000;
const WORKER_COUNT = 2;
const MAX_QUEUED_JOBS = 100;
const MAX_PATTERN_LENGTH = 16_384;
const MAX_SUBJECT_LENGTH = 65_536;

export type RegexErrorCode =
  | 'invalid'
  | 'timeout'
  | 'busy'
  | 'pattern_too_large'
  | 'subject_too_large'
  | 'worker_failure'
  | 'closed';

export interface RegexMatch {
  match: string;
  groups?: Record<string, string | undefined>;
}

export class RegexExecutionError extends Error {
  constructor(
    readonly code: RegexErrorCode,
    readonly context: string,
    readonly pattern: string,
    detail: string,
  ) {
    super(`Regex ${code} in ${context}: ${detail}`);
    this.name = 'RegexExecutionError';
  }
}

export interface RegexExecutorPort {
  validate(pattern: string, flags: string, context: string): Promise<void>;
  exec(pattern: string, flags: string, subject: string, context: string): Promise<RegexMatch | null>;
  test(pattern: string, flags: string, subject: string, context: string): Promise<boolean>;
}

export function normalizeRegexTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

type RegexOperation = 'validate' | 'exec' | 'test';

interface WorkerJob {
  id: number;
  operation: RegexOperation;
  pattern: string;
  flags: string;
  subject: string;
}

type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };

interface PendingJob extends WorkerJob {
  context: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  replacing: boolean;
  active?: PendingJob;
}

export class RegexExecutor implements RegexExecutorPort {
  private readonly timeoutMs: number;
  private readonly workerSource: string;
  private readonly workerFactory: WorkerFactory;
  private readonly queue: PendingJob[] = [];
  private readonly slots: WorkerSlot[] = [];
  private readonly retirements = new Set<Promise<number>>();
  private closePromise: Promise<void> | undefined;
  private nextId = 1;
  private closed = false;
  private degraded = false;

  constructor(options: { timeoutMs?: number; workerSource?: string; workerFactory?: WorkerFactory } = {}) {
    this.timeoutMs = normalizeRegexTimeoutMs(options.timeoutMs);
    this.workerSource = options.workerSource ?? REGEX_WORKER_SOURCE;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
  }

  validate(pattern: string, flags: string, context: string): Promise<void> {
    return this.submit<void>('validate', pattern, flags, '', context);
  }

  exec(pattern: string, flags: string, subject: string, context: string): Promise<RegexMatch | null> {
    return this.submit<RegexMatch | null>('exec', pattern, flags, subject, context);
  }

  test(pattern: string, flags: string, subject: string, context: string): Promise<boolean> {
    return this.submit<boolean>('test', pattern, flags, subject, context);
  }

  private submit<T>(
    operation: RegexOperation,
    pattern: string,
    flags: string,
    subject: string,
    context: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.failure('closed', context, pattern, 'executor is closed'));
    if (this.degraded) return Promise.reject(this.failure('worker_failure', context, pattern, 'executor is degraded'));
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return Promise.reject(this.failure(
        'pattern_too_large', context, pattern,
        `pattern exceeds ${MAX_PATTERN_LENGTH} UTF-16 code units`,
      ));
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      return Promise.reject(this.failure(
        'subject_too_large', context, pattern,
        `subject exceeds ${MAX_SUBJECT_LENGTH} UTF-16 code units`,
      ));
    }

    this.ensureWorkers();
    const hasIdleSlot = this.slots.some((slot) => this.isAvailable(slot));
    if (!hasIdleSlot && this.queue.length >= MAX_QUEUED_JOBS) {
      return Promise.reject(this.failure('busy', context, pattern, 'pending regex queue is full'));
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: this.nextId++, operation, pattern, flags, subject, context,
        resolve: (value) => resolve(value as T), reject,
      });
      this.dispatch();
    });
  }

  private ensureWorkers(): void {
    if (this.slots.length > 0) return;
    for (let index = 0; index < WORKER_COUNT; index++) this.spawn(index);
  }

  private spawn(index: number): void {
    if (this.closed || this.degraded) return;
    const worker = this.workerFactory(this.workerSource, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 4,
      },
    });
    const slot: WorkerSlot = { worker, ready: false, replacing: false };
    this.slots[index] = slot;

    worker.once('online', () => {
      if (this.slots[index]?.worker !== worker || this.closed) return;
      slot.ready = true;
      this.dispatch();
    });
    worker.on('message', (reply: WorkerReply) => this.handleReply(index, worker, reply));
    worker.once('error', (error) => this.handleWorkerFailure(index, worker, error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', (code) => {
      if (!this.closed && this.slots[index]?.worker === worker) {
        this.handleWorkerFailure(index, worker, new Error(`worker exited with code ${code}`));
      }
    });
  }

  private isAvailable(slot: WorkerSlot): boolean {
    return slot.ready && slot.active === undefined && !slot.replacing;
  }

  private dispatch(): void {
    if (this.closed || this.degraded) return;
    for (const [index, slot] of this.slots.entries()) {
      if (!this.isAvailable(slot)) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.active = job;
      job.timer = setTimeout(() => {
        if (this.slots[index]?.worker !== slot.worker || slot.active?.id !== job.id) return;
        slot.active = undefined;
        job.reject(this.failure(
          'timeout', job.context, job.pattern,
          `compilation or execution exceeded ${this.timeoutMs} ms`,
        ));
        this.replace(index, slot.worker);
      }, this.timeoutMs);
      const message: WorkerJob = {
        id: job.id,
        operation: job.operation,
        pattern: job.pattern,
        flags: job.flags,
        subject: job.subject,
      };
      slot.worker.postMessage(message);
    }
  }

  private handleReply(index: number, worker: Worker, reply: WorkerReply): void {
    const slot = this.slots[index];
    if (!slot || slot.worker !== worker || slot.active?.id !== reply.id) return;
    const job = slot.active;
    slot.active = undefined;
    if (job.timer) clearTimeout(job.timer);
    if (reply.ok) job.resolve(reply.value);
    else job.reject(this.failure('invalid', job.context, job.pattern, reply.message));
    this.dispatch();
  }

  private handleWorkerFailure(index: number, worker: Worker, error: Error): void {
    const slot = this.slots[index];
    if (!slot || slot.worker !== worker) return;
    const job = slot.active;
    slot.active = undefined;
    if (job?.timer) clearTimeout(job.timer);
    job?.reject(this.failure('worker_failure', job.context, job.pattern, error.message));
    this.replace(index, worker);
  }

  private replace(index: number, worker: Worker): void {
    const slot = this.slots[index];
    if (slot) slot.replacing = true;
    worker.removeAllListeners();
    const termination = worker.terminate();
    this.retirements.add(termination);
    void termination.then(
      () => {
        this.retirements.delete(termination);
        if (slot) slot.replacing = false;
        if (!this.closed && !this.degraded && this.slots[index]?.worker === worker) this.spawn(index);
      },
      () => {
        this.retirements.delete(termination);
        if (slot) slot.replacing = false;
        this.degrade();
      },
    );
  }

  private degrade(): void {
    if (this.degraded) return;
    this.degraded = true;
    for (const job of this.queue.splice(0)) {
      job.reject(this.failure('worker_failure', job.context, job.pattern, 'executor degraded after unconfirmed worker termination'));
    }
    for (const slot of this.slots) {
      const active = slot.active;
      if (active?.timer) clearTimeout(active.timer);
      if (active) {
        slot.active = undefined;
        active.reject(this.failure('worker_failure', active.context, active.pattern, 'executor degraded after unconfirmed worker termination'));
      }
    }
  }

  private failure(code: RegexErrorCode, context: string, pattern: string, detail: string): RegexExecutionError {
    return new RegexExecutionError(code, context, pattern, detail);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      for (const job of this.queue.splice(0)) {
        job.reject(this.failure('closed', job.context, job.pattern, 'executor is closed'));
      }
      const terminations: Promise<unknown>[] = [];
      for (const slot of this.slots) {
        const active = slot.active;
        if (active?.timer) clearTimeout(active.timer);
        if (active) {
          active.reject(this.failure('closed', active.context, active.pattern, 'executor is closed'));
        }
        if (!slot.replacing) {
          slot.worker.removeAllListeners();
          terminations.push(slot.worker.terminate());
        }
      }
      this.slots.length = 0;
      const results = await Promise.allSettled([...terminations, ...this.retirements]);
      const rejected = results.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        throw new Error(`RegexExecutor close: ${rejected.length} worker termination(s) rejected`);
      }
    })();
    return this.closePromise;
  }
}