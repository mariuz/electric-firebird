/**
 * coi-serviceworker.js – synthesises cross-origin isolation on a static host.
 *
 * The engine is compiled with pthreads, so it needs `SharedArrayBuffer`, and
 * browsers only hand that out to a **cross-origin isolated** page.  Isolation
 * requires two response headers on the document:
 *
 *   Cross-Origin-Opener-Policy:   same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * GitHub Pages serves a fixed header set and offers no way to add them.  A
 * service worker is the way out: it sits in front of the network for its own
 * scope, so it can re-issue every response with the headers attached.  The
 * page is then isolated even though the server never said so.
 *
 * The catch is inherent to service workers, not to this file: a worker cannot
 * control the very load that registered it.  The first visit therefore arrives
 * un-isolated and reloads once, and the second load is served through the
 * worker.  That is why the demo shows a brief "enabling…" state on a cold
 * visit and nothing on subsequent ones.
 *
 * This file is loaded in two different contexts and behaves differently in
 * each — as the page's registration script, and as the service worker itself.
 */

if (typeof self !== 'undefined' && typeof window === 'undefined') {
  // ─────────────────────────────────────────────────────────────────────────
  // Service worker context
  // ─────────────────────────────────────────────────────────────────────────

  // Take over as soon as possible; the page is waiting on us to reload.
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const request = event.request;

    // A cache-only revalidation request cannot be re-issued with fetch(); let
    // it pass untouched rather than turning it into an error.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
      return;
    }

    event.respondWith(
      fetch(request)
        .then((response) => {
          // An opaque response has no readable headers or body to copy.
          if (response.status === 0) return response;

          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          // Without this, `require-corp` would block our own subresources:
          // the policy applies to everything the document pulls in.
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        .catch((err) => {
          // Offline or a genuine network failure.  Report it as such instead
          // of resolving to undefined, which surfaces as an opaque error.
          return new Response(`network error: ${err.message}`, { status: 503 });
        }),
    );
  });
} else if (typeof window !== 'undefined') {
  // ─────────────────────────────────────────────────────────────────────────
  // Page context – register the worker, then reload once
  // ─────────────────────────────────────────────────────────────────────────

  (() => {
    if (window.crossOriginIsolated) return; // already isolated: nothing to do

    if (!window.isSecureContext) {
      // Service workers need HTTPS or localhost.  Say so plainly — the demo
      // would otherwise fail later with a confusing SharedArrayBuffer error.
      console.warn(
        '[firebird-demo] not a secure context, so cross-origin isolation ' +
          'cannot be enabled. Serve this over HTTPS or from localhost.',
      );
      return;
    }

    if (!('serviceWorker' in navigator)) {
      console.warn('[firebird-demo] service workers are unavailable.');
      return;
    }

    // A registration that never yields isolation would reload forever.  Cap
    // the attempts: one failure is a race, two is a real problem worth
    // surfacing to the user instead of hiding in a loop.
    const ATTEMPT_KEY = 'firebird-demo:coi-attempts';
    const attempts = Number(sessionStorage.getItem(ATTEMPT_KEY) ?? '0');
    if (attempts >= 2) {
      console.error(
        '[firebird-demo] cross-origin isolation could not be enabled after ' +
          'two attempts; giving up rather than reloading again.',
      );
      return;
    }

    const scriptUrl = document.currentScript.src;

    navigator.serviceWorker.register(scriptUrl).then(
      (registration) => {
        // `controller` is null when this load was not served by a worker,
        // which is exactly the first-visit case that needs the reload.
        if (registration.active && !navigator.serviceWorker.controller) {
          sessionStorage.setItem(ATTEMPT_KEY, String(attempts + 1));
          window.location.reload();
          return;
        }

        registration.addEventListener('updatefound', () => {
          sessionStorage.setItem(ATTEMPT_KEY, String(attempts + 1));
          window.location.reload();
        });
      },
      (err) => {
        console.error('[firebird-demo] service worker registration failed', err);
      },
    );
  })();
}
