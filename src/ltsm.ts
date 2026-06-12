import * as fs from 'fs';
import * as path from 'path';
import { Window } from 'happy-dom';

const SANDBOX_ID = 'node-ltsm';
const ORIGIN = 'chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc';
const WASM_PATH = path.join(__dirname, '../specs/raw/ltsm/ltsm.wasm');

// sandbox listens on window "message" events; responds via window.parent.postMessage
const responseHandlers = new Map<string, (msg: unknown) => void>();

function handleParentPost(msg: unknown): void {
  const m = msg as { sandboxId?: string; type?: string; data?: unknown };
  if (m.sandboxId !== SANDBOX_ID) return;
  responseHandlers.get(m.type ?? '')?.(m);
}

// Serializes all WASM sandbox commands — responseHandlers uses fixed keys, so concurrent
// sendCommand calls would overwrite each other's handlers. Queue ensures one at a time.
let commandQueue: Promise<unknown> = Promise.resolve();

function sendCommand(win: Window & typeof globalThis, command: string, payload?: unknown): Promise<unknown> {
  const next = commandQueue.then(
    () =>
      new Promise((resolve, reject) => {
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
      }),
  );
  // Errors must not break the queue chain
  commandQueue = next.catch(() => {});
  return next;
}

let initPromise: Promise<{ win: Window & typeof globalThis }> | null = null;

function initialize(): Promise<{ win: Window & typeof globalThis }> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
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
    // fetch must be our custom version (not the Node.js built-in)
    try { nodeGlobal['fetch'] = wasmFetch; } catch { /* skip */ }

    // Load the sandbox — self-executes and registers a DOMContentLoaded listener
    require('../specs/raw/ltsm/ltsmSandbox.js');

    // Fire DOMContentLoaded so the sandbox wires up its "message" handler and sends LOADED
    await new Promise<void>((resolve) => {
      responseHandlers.set('loaded', () => {
        responseHandlers.delete('loaded');
        resolve();
      });
      win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
    });

    // INIT: loads wasm and derives static key from the Chrome extension token
    await sendCommand(win, 'init');

    return { win };
  })();

  return initPromise;
}

export async function getHmac(params: {
  accessToken: string;
  path: string;
  body: string;
}): Promise<string> {
  const { win } = await initialize();
  return sendCommand(win, 'get_hmac', params) as Promise<string>;
}

export async function initStorageKey(params: {
  wrappedNonce: string;
  kdfParameter1: string;
  kdfParameter2: string;
}): Promise<void> {
  const { win } = await initialize();
  await sendCommand(win, 'storage_key_init', params);
}
