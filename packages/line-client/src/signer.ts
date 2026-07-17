import * as fs from 'fs';
import * as path from 'path';
import type { Window } from 'happy-dom';

const SANDBOX_ID = 'node-ltsm';
const ORIGIN = 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc';

// Assets live in a sibling `assets/ltsm` directory (not compiled by tsc), so the
// relative hop from this module up to the package root is the same whether
// __dirname is the source tree (packages/line-client/src, ts-node/dev) or the
// compiled output (packages/line-client/dist, since tsconfig rootDir=src strips
// the "src" segment on emit — both sit exactly one level below the package root).
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'ltsm');
const WASM_PATH = path.join(ASSETS_DIR, 'ltsm.wasm');
const SANDBOX_PATH = path.join(ASSETS_DIR, 'ltsmSandbox.js');

// sandbox listens on window "message" events; responds via window.parent.postMessage
const responseHandlers = new Map<string, (msg: unknown) => void>();

function handleParentPost(msg: unknown): void {
  const m = msg as { sandboxId?: string; type?: string; data?: unknown };
  if (m.sandboxId !== SANDBOX_ID) return;
  responseHandlers.get(m.type ?? '')?.(m);
}

// Sends a single sandbox command and waits for its response, with no queuing of
// its own. responseHandlers uses fixed keys ('response'/'error'), so calling
// this concurrently for two different in-flight commands would let one call's
// response resolve the other's promise — callers MUST serialize calls to this
// via enqueue() below.
function sendCommandNow(win: Window & typeof globalThis, command: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    responseHandlers.set('response', (m) => {
      responseHandlers.delete('response');
      responseHandlers.delete('error');
      resolve((m as Record<string, unknown>)['data']);
    });
    responseHandlers.set('error', (m) => {
      responseHandlers.delete('response');
      responseHandlers.delete('error');
      reject((m as Record<string, unknown>)['data']);
    });
    win.dispatchEvent(
      Object.assign(new win.MessageEvent('message'), {
        data: { type: 'request', sandboxId: SANDBOX_ID, data: { command, payload } },
      }),
    );
  });
}

// Serializes all WASM sandbox operations against the shared module-level state
// (responseHandlers, currentStorageKeyMid). Each call to enqueue() runs its
// callback to completion — including any number of sendCommandNow() calls
// inside it — before the next queued callback starts, so a caller that needs
// to check-and-possibly-reinitialize state before signing (see signForAccount)
// gets that as one atomic unit with no other account's operation interleaved.
let commandQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: (win: Window & typeof globalThis) => Promise<T>): Promise<T> {
  const next = commandQueue.then(() => initialize()).then(({ win }) => fn(win));
  // Errors must not break the queue chain for the next caller.
  commandQueue = next.then(() => undefined, () => undefined);
  return next;
}

let initPromise: Promise<{ win: Window & typeof globalThis }> | null = null;
let currentStorageKeyMid: string | null = null;

function initialize(): Promise<{ win: Window & typeof globalThis }> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Lazy-load happy-dom (7s parse time) — deferred until first LINE API call
    const { Window } = await import('happy-dom');
    const wasmBinary = fs.readFileSync(WASM_PATH);

    const win = new Window({
      url: `${ORIGIN}/ltsm.html?sandboxId=${SANDBOX_ID}`,
    }) as Window & typeof globalThis;

    // happy-dom returns "null" for chrome-extension:// scheme — WASM reads both
    Object.defineProperty(win, 'origin', { value: ORIGIN, configurable: true, writable: true });
    try {
      Object.defineProperty(win.location, 'origin', { value: ORIGIN, configurable: true, writable: true });
    } catch {
      (win.location as unknown as Record<string, string>)['origin'] = ORIGIN;
    }

    // Intercept window.parent.postMessage so sandbox responses reach us
    Object.defineProperty(win, 'parent', {
      value: { postMessage: handleParentPost },
      configurable: true,
    });

    // Serve ltsm.wasm from disk; the bundle calls fetch("ltsm.wasm") with bare fetch
    const wasmFetch = async (url: string) => {
      if (String(url).endsWith('ltsm.wasm')) {
        return new win.Response(wasmBinary.buffer, { headers: { 'Content-Type': 'application/wasm' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    (win as unknown as Record<string, unknown>)['fetch'] = wasmFetch;

    // Install happy-dom globals that Node.js lacks onto global so require() picks them up.
    // Excludes things already present in Node.js 18+ (URL, Blob, fetch, EventTarget, etc.)
    const nodeGlobal = global as unknown as Record<string, unknown>;
    const fromWindow: string[] = [
      'window', 'self', 'document', 'location',
      'HTMLElement', 'Element', 'ShadowRoot',
      'Document', 'DocumentFragment', 'Node', 'NodeList', 'Text', 'Comment',
      'HTMLAnchorElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
      'HTMLDivElement', 'HTMLSpanElement', 'HTMLImageElement', 'HTMLVideoElement',
      'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
      'customElements', 'CSSStyleSheet', 'DOMParser',
      'localStorage', 'sessionStorage',
      'XMLHttpRequest', 'FileReader',
      'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
      'history', 'screen', 'CSS', 'Range', 'Selection',
    ];
    for (const key of fromWindow) {
      const val = (win as unknown as Record<string, unknown>)[key];
      if (val === undefined) continue;
      try { nodeGlobal[key] = val; } catch {
        try { Object.defineProperty(global, key, { value: val, configurable: true, writable: true }); } catch { /* skip */ }
      }
    }
    // Temporarily override global fetch so the sandbox script uses wasmFetch during init
    // (the sandbox calls fetch("ltsm.wasm") as a global, not via window.fetch)
    const originalFetch = nodeGlobal['fetch'];
    try { nodeGlobal['fetch'] = wasmFetch; } catch { /* skip */ }

    // Load the sandbox — self-executes and registers a DOMContentLoaded listener
    // Loaded dynamically at runtime after global fetch/window shims are installed above;
    // cannot be a static import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(SANDBOX_PATH);

    // Fire DOMContentLoaded so the sandbox wires up its "message" handler and sends LOADED
    await new Promise<void>((resolve) => {
      responseHandlers.set('loaded', () => {
        responseHandlers.delete('loaded');
        resolve();
      });
      win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
    });

    // INIT: loads wasm and derives static key from the Chrome extension token.
    // Runs directly (not via enqueue()) because initialize() itself is only ever
    // reached from inside an enqueue() callback (or, on the very first call,
    // synchronously guarded by initPromise below) — it is already part of the
    // current queue slot, not a new one.
    await sendCommandNow(win, 'init');

    // Restore global fetch — wasmFetch is only needed during WASM load above
    try { nodeGlobal['fetch'] = originalFetch; } catch { /* skip */ }

    return { win };
  })();

  return initPromise;
}

export interface StorageKeyMaterial {
  mid: string;
  wrappedNonce: string;
  kdfParameter1: string;
  kdfParameter2: string;
}

export interface HmacInput {
  accessToken: string;
  path: string;
  body: string;
}

function keyPayload(key: StorageKeyMaterial): { wrappedNonce: string; kdfParameter1: string; kdfParameter2: string } {
  return { wrappedNonce: key.wrappedNonce, kdfParameter1: key.kdfParameter1, kdfParameter2: key.kdfParameter2 };
}

// Atomically ensures the sandbox's loaded storage key belongs to `key.mid` and
// computes the HMAC for `input`, as a single queued operation. This is the fix
// for a real race: previously "ensure the right storage key is loaded" and
// "compute get_hmac" were two separately-queued operations, so a concurrent
// call for a *different* account could enqueue its own storage-key switch in
// between them, and the HMAC would then be computed against the wrong
// account's key. Bundling both steps into one enqueue() callback means no
// other account's signForAccount() call can run until this one fully resolves.
export function signForAccount(key: StorageKeyMaterial, input: HmacInput): Promise<string> {
  return enqueue(async win => {
    if (currentStorageKeyMid !== key.mid) {
      await sendCommandNow(win, 'storage_key_init', keyPayload(key));
      currentStorageKeyMid = key.mid;
    }
    return sendCommandNow(win, 'get_hmac', input) as Promise<string>;
  });
}

export async function getHmac(params: HmacInput): Promise<string> {
  return enqueue(win => sendCommandNow(win, 'get_hmac', params) as Promise<string>);
}

export async function initStorageKey(params: StorageKeyMaterial): Promise<void> {
  await enqueue(async win => {
    await sendCommandNow(win, 'storage_key_init', keyPayload(params));
  });
  currentStorageKeyMid = params.mid;
}

export async function ensureStorageKey(params: StorageKeyMaterial): Promise<void> {
  if (currentStorageKeyMid === params.mid) return;
  await initStorageKey(params);
}
