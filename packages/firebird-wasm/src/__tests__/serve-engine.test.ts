/**
 * serve-engine.test.ts – where the engine is served, and where it is not.
 *
 * The engine answers whatever arrives at the scope it serves.  A dedicated
 * Worker hears only its owner; a page's window hears every window that can
 * postMessage to it, other origins included.  Serving a window would hand
 * the database to all of them, so it must never happen, by import or by call.
 */

import { type Mock } from 'vitest';
import { serveEngine } from '../browser/serve-engine';
import type { EngineTransport } from '../browser/engine-transport';

const transport = {} as EngineTransport;

type Scope = {
  postMessage: Mock;
  addEventListener: Mock;
  document?: unknown;
};
const scope = (extra: Partial<Scope> = {}): Scope => ({
  postMessage: vi.fn(),
  addEventListener: vi.fn(),
  ...extra,
});

describe('serveEngine', () => {
  it('serves a Worker scope', () => {
    const worker = scope();
    serveEngine(worker, transport);
    expect(worker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('refuses a page window, which every window that can message it would reach', () => {
    const page = scope({ document: {} });
    expect(() => serveEngine(page, transport)).toThrow(/Worker/);
    expect(page.addEventListener).not.toHaveBeenCalled();
  });
});

describe('worker-entry', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g['self'];
    delete g['WorkerGlobalScope'];
    vi.resetModules();
  });

  it('starts nothing outside a Worker, though the scope has postMessage', async () => {
    // A page's window: postMessage and addEventListener, no WorkerGlobalScope.
    const page = scope();
    g['self'] = page;
    vi.resetModules();
    await import('../browser/worker-entry');
    expect(page.addEventListener).not.toHaveBeenCalled();
  });

  it("starts serving when loaded as a dedicated Worker's script", async () => {
    class WorkerGlobalScope {}
    const worker = Object.assign(new WorkerGlobalScope(), scope());
    g['WorkerGlobalScope'] = WorkerGlobalScope;
    g['self'] = worker;
    vi.resetModules();
    await import('../browser/worker-entry');
    expect(worker.addEventListener).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('is not loaded by the library index, so importing the library starts nothing', async () => {
    class WorkerGlobalScope {}
    const worker = Object.assign(new WorkerGlobalScope(), scope());
    g['WorkerGlobalScope'] = WorkerGlobalScope;
    g['self'] = worker;
    vi.resetModules();
    await import('../browser/index');
    expect(worker.addEventListener).not.toHaveBeenCalled();
  });
});
