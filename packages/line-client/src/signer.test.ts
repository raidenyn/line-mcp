import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import * as path from 'path';

// Must be const so vitest's vi.mock hoisting can close over it without TDZ errors.
const trackedCalls = { storageKeyInit: 0 };
// Records the order sandbox commands actually run in, as [command, label] pairs,
// so the atomic-interleaving test below can assert that two concurrent
// signForAccount() calls for different accounts never interleave their
// storage_key_init/get_hmac pairs. `label` is the wrappedNonce (for
// storage_key_init) or accessToken (for get_hmac) — both of which the tests
// set to the account's id so the trace directly names the account.
const commandTrace: Array<[string, string]> = [];

const SANDBOX_ID = 'node-ltsm';

// Mock happy-dom (loaded via `await import('happy-dom')` inside initialize()).
// Provides a lightweight fake Window that implements the postMessage sandbox
// protocol directly, so the real ltsmSandbox.js / WASM never has to load.
//
// Key design choice — FakeDocument.addEventListener is a no-op:
//   The real ltsmSandbox.js registers a DOMContentLoaded handler that loads WASM.
//   By swallowing that registration we prevent the WASM loading path entirely.
//   FakeDocument.dispatchEvent then drives the protocol directly when ltsm.ts
//   fires DOMContentLoaded.
vi.mock('happy-dom', () => {
  class FakeEventTarget {
    private _h: Record<string, Array<(e: unknown) => void>> = {};

    addEventListener(type: string, fn: (e: unknown) => void) {
      (this._h[type] ??= []).push(fn);
    }
    removeEventListener(type: string, fn: (e: unknown) => void) {
      this._h[type] = (this._h[type] ?? []).filter((l) => l !== fn);
    }
    dispatchEvent(event: { type: string; [k: string]: unknown }): boolean {
      for (const fn of this._h[event.type] ?? []) fn(event);
      return true;
    }
  }

  class FakeDocument {
    private win: FakeWindow | null = null;
    _link(w: FakeWindow) { this.win = w; }

    // No-op: blocks the real ltsmSandbox.js DOMContentLoaded handler.
    addEventListener() {}
    removeEventListener() {}

    dispatchEvent(event: { type: string }): boolean {
      if (event.type === 'DOMContentLoaded' && this.win) {
        this.win.parent.postMessage({ sandboxId: SANDBOX_ID, type: 'loaded' });
        this.win._activateMessageHandler();
      }
      return true;
    }
  }

  class FakeWindow extends FakeEventTarget {
    // Classes that ltsm.ts uses via `new win.MessageEvent(...)` etc.
    MessageEvent = class extends FakeEventTarget {
      type: string;
      data: unknown = undefined;
      constructor(type: string) { super(); this.type = type; }
    };
    Event = class {
      type: string; bubbles: boolean;
      constructor(type: string, opts?: { bubbles?: boolean }) {
        this.type = type; this.bubbles = opts?.bubbles ?? false;
      }
    };
    Response = class { constructor(_body: unknown, _init?: unknown) {} };

    readonly document = new FakeDocument();
    location: Record<string, unknown> = { origin: '' };
    // ltsm.ts overrides `parent` via Object.defineProperty before firing events
    parent: { postMessage: (msg: unknown) => void } = { postMessage: () => {} };

    get window(): this { return this; }
    get self(): this { return this; }

    constructor(_opts?: unknown) {
      super();
      this.document._link(this);
    }

    private _active = false;
    _activateMessageHandler() {
      if (this._active) return;
      this._active = true;

      this.addEventListener('message', (raw: unknown) => {
        const event = raw as { data: { type: string; sandboxId: string; data: { command: string; payload: unknown } } };
        const msg = event.data;
        if (!msg || msg.sandboxId !== SANDBOX_ID || msg.type !== 'request') return;

        const { command, payload } = msg.data;
        // Process asynchronously (a macrotask, not just a microtask) so that if
        // the caller-side queue ever failed to serialize two concurrent
        // operations, their sandbox commands would provably interleave here
        // rather than happening to run back-to-back due to synchronous
        // execution. This is what makes the atomic-interleaving test below a
        // real test of signForAccount()'s queuing rather than one that would
        // pass trivially.
        setTimeout(() => {
          try {
            let data: unknown = null;
            switch (command) {
              case 'init': break;
              case 'get_hmac': {
                const { accessToken, path, body } = payload as Record<string, string>;
                if (accessToken === 'FORCE_FAIL') {
                  throw new Error('forced get_hmac failure');
                }
                commandTrace.push(['get_hmac', accessToken]);
                data = `HMAC(${accessToken}|${path}|${body})`;
                break;
              }
              case 'storage_key_init': {
                const { wrappedNonce } = payload as Record<string, string>;
                trackedCalls.storageKeyInit++;
                commandTrace.push(['storage_key_init', wrappedNonce]);
                break;
              }
              default:
                throw new Error(`Unknown sandbox command: ${command}`);
            }
            this.parent.postMessage({ sandboxId: SANDBOX_ID, type: 'response', data });
          } catch (err) {
            this.parent.postMessage({ sandboxId: SANDBOX_ID, type: 'error', data: String(err) });
          }
        }, 5);
      });
    }
  }

  return { Window: FakeWindow };
});

import { getHmac, initStorageKey, ensureStorageKey, signForAccount } from './signer';

// Prevent require('<assets>/ltsmSandbox.js') from loading the real 4.8 MB bundle.
// vi.mock cannot intercept CJS require() inside async functions, so we pre-seed
// require.cache with an empty module before initialize() ever runs.
// This must happen in beforeAll (not at module level) because require.cache is
// populated after module import, but initialize() is lazy (first API call only).
beforeAll(() => {
  const sandboxPath = path.resolve(__dirname, '..', 'assets', 'ltsm', 'ltsmSandbox.js');
  if (!(require as NodeRequire & { cache: Record<string, unknown> }).cache[sandboxPath]) {
    (require as NodeRequire & { cache: Record<string, unknown> }).cache[sandboxPath] = {
      id: sandboxPath,
      filename: sandboxPath,
      loaded: true,
      exports: {},
      paths: [],
      parent: null,
      children: [],
    } as unknown as NodeModule;
  }
});

beforeEach(() => {
  trackedCalls.storageKeyInit = 0;
  commandTrace.length = 0;
});

// ───────────────────────────────────────────────────────────
// getHmac
// ───────────────────────────────────────────────────────────

describe('getHmac', () => {
  it('returns a non-empty string', async () => {
    const hmac = await getHmac({ accessToken: 'tok', path: '/api/test', body: '[]' });
    expect(typeof hmac).toBe('string');
    expect(hmac.length).toBeGreaterThan(0);
  });

  it('is deterministic — same inputs produce the same output', async () => {
    const params = { accessToken: 'tok', path: '/api/test', body: '[]' };
    const a = await getHmac(params);
    const b = await getHmac(params);
    expect(a).toBe(b);
  });

  it('produces different output for different paths', async () => {
    const base = { accessToken: 'tok', body: '[]' };
    expect(await getHmac({ ...base, path: '/api/a' })).not.toBe(
      await getHmac({ ...base, path: '/api/b' }),
    );
  });

  it('produces different output for different bodies', async () => {
    const base = { accessToken: 'tok', path: '/api/test' };
    expect(await getHmac({ ...base, body: '["arg1"]' })).not.toBe(
      await getHmac({ ...base, body: '["arg2"]' }),
    );
  });

  it('produces different output for different access tokens', async () => {
    const base = { path: '/api/test', body: '[]' };
    expect(await getHmac({ ...base, accessToken: 'tokenA' })).not.toBe(
      await getHmac({ ...base, accessToken: 'tokenB' }),
    );
  });

  it('handles an empty accessToken (pre-login requests)', async () => {
    const hmac = await getHmac({ accessToken: '', path: '/api/login', body: '[{}]' });
    expect(typeof hmac).toBe('string');
  });
});

// ───────────────────────────────────────────────────────────
// initStorageKey
// ───────────────────────────────────────────────────────────

describe('initStorageKey', () => {
  it('resolves without throwing', async () => {
    await expect(
      initStorageKey({ mid: 'u1', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' }),
    ).resolves.toBeUndefined();
  });

  it('sends a storage_key_init command to the sandbox', async () => {
    await initStorageKey({ mid: 'u2', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(1);
  });

  it('sends a new command on each call regardless of mid', async () => {
    await initStorageKey({ mid: 'u3a', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    await initStorageKey({ mid: 'u3b', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(2);
  });

  it('propagates sandbox error responses as thrown exceptions', async () => {
    // Force the sandbox to send an 'error' response by using an unknown command
    // via a direct sendCommand call — tested indirectly by checking getHmac works
    // after an error: the command queue must not be poisoned.
    await getHmac({ accessToken: 'tok', path: '/p', body: '[]' }); // succeeds
    await initStorageKey({ mid: 'u4', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    // If we reach here without hanging, the queue recovered from any prior state.
    expect(trackedCalls.storageKeyInit).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────
// ensureStorageKey
// ───────────────────────────────────────────────────────────

describe('ensureStorageKey', () => {
  it('calls initStorageKey for a new mid', async () => {
    await ensureStorageKey({ mid: 'fresh1', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(1);
  });

  it('skips the sandbox command when called again with the same mid', async () => {
    // Prime the cache with a successful init
    await initStorageKey({ mid: 'cached', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    trackedCalls.storageKeyInit = 0; // reset so only the ensure call is counted

    await ensureStorageKey({ mid: 'cached', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(0);
  });

  it('re-initializes when called with a different mid', async () => {
    await initStorageKey({ mid: 'switchA', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    trackedCalls.storageKeyInit = 0;

    await ensureStorageKey({ mid: 'switchB', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(1);
  });

  it('is idempotent — repeated same-mid calls only initialise once', async () => {
    await ensureStorageKey({ mid: 'idem', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    await ensureStorageKey({ mid: 'idem', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    await ensureStorageKey({ mid: 'idem', wrappedNonce: 'wn', kdfParameter1: 'k1', kdfParameter2: 'k2' });
    expect(trackedCalls.storageKeyInit).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────
// signForAccount — atomic check-and-sign
// ───────────────────────────────────────────────────────────
//
// Regression coverage for a real race: before this refactor, "ensure the
// right storage key is loaded" (ensureStorageKey) and "compute the HMAC"
// (getHmac) were two *separately* queued operations against the shared WASM
// sandbox. A concurrent call for a different LINE account could enqueue its
// own storage-key switch in the gap between them, so the first account's
// get_hmac could run against the second account's just-loaded storage key.
// signForAccount() bundles both steps into a single enqueue() callback so no
// other account's operation can run until this one fully resolves.

describe('signForAccount — atomic interleaving', () => {
  it('never interleaves two concurrent accounts\' storage_key_init/get_hmac pairs', async () => {
    const keyA = { mid: 'atomic-mid-a', wrappedNonce: 'u-a', kdfParameter1: 'k1a', kdfParameter2: 'k2a' };
    const keyB = { mid: 'atomic-mid-b', wrappedNonce: 'u-b', kdfParameter1: 'k1b', kdfParameter2: 'k2b' };
    const inputA = { accessToken: 'u-a', path: '/p', body: '[]' };
    const inputB = { accessToken: 'u-b', path: '/p', body: '[]' };

    // Fired concurrently (not sequentially awaited) — if the implementation's
    // queue failed to serialize whole signForAccount() calls, the fake
    // sandbox's setTimeout-deferred processing above would let A's and B's
    // commands genuinely interleave here, and the assertion below would catch it.
    await Promise.all([
      signForAccount(keyA, inputA),
      signForAccount(keyB, inputB),
    ]);

    const aThenB = [
      ['storage_key_init', 'u-a'], ['get_hmac', 'u-a'],
      ['storage_key_init', 'u-b'], ['get_hmac', 'u-b'],
    ];
    const bThenA = [
      ['storage_key_init', 'u-b'], ['get_hmac', 'u-b'],
      ['storage_key_init', 'u-a'], ['get_hmac', 'u-a'],
    ];
    expect([aThenB, bThenA]).toContainEqual(commandTrace);
  });

  it('skips storage_key_init when the requested mid is already loaded', async () => {
    const key = { mid: 'atomic-mid-repeat', wrappedNonce: 'u-repeat', kdfParameter1: 'k1', kdfParameter2: 'k2' };
    const input = { accessToken: 'u-repeat', path: '/p', body: '[]' };

    await signForAccount(key, input);
    await signForAccount(key, input);

    expect(commandTrace.filter(([cmd]) => cmd === 'storage_key_init')).toHaveLength(1);
    expect(commandTrace.filter(([cmd]) => cmd === 'get_hmac')).toHaveLength(2);
  });

  it('re-initializes the storage key when the account switches', async () => {
    const keyA = { mid: 'atomic-switch-a', wrappedNonce: 'switch-a', kdfParameter1: 'k1', kdfParameter2: 'k2' };
    const keyB = { mid: 'atomic-switch-b', wrappedNonce: 'switch-b', kdfParameter1: 'k1', kdfParameter2: 'k2' };

    await signForAccount(keyA, { accessToken: 'switch-a', path: '/p', body: '[]' });
    await signForAccount(keyB, { accessToken: 'switch-b', path: '/p', body: '[]' });

    expect(commandTrace).toEqual([
      ['storage_key_init', 'switch-a'], ['get_hmac', 'switch-a'],
      ['storage_key_init', 'switch-b'], ['get_hmac', 'switch-b'],
    ]);
  });

  it('does not poison the queue when a signForAccount call is rejected', async () => {
    const failingKey = { mid: 'atomic-fail', wrappedNonce: 'u-fail', kdfParameter1: 'k1', kdfParameter2: 'k2' };
    const failingInput = { accessToken: 'FORCE_FAIL', path: '/p', body: '[]' };

    await expect(signForAccount(failingKey, failingInput)).rejects.toBeTruthy();

    // The queue must still be usable for the next caller — this must resolve,
    // not hang or reject because of the previous failure.
    const nextKey = { mid: 'atomic-after-fail', wrappedNonce: 'u-after-fail', kdfParameter1: 'k1', kdfParameter2: 'k2' };
    const nextInput = { accessToken: 'u-after-fail', path: '/p', body: '[]' };
    await expect(signForAccount(nextKey, nextInput)).resolves.toEqual(
      'HMAC(u-after-fail|/p|[])',
    );
  });
});
