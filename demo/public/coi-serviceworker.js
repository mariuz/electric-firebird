/**
 * coi-serviceworker.js – retired.
 *
 * This used to be a service worker that re-issued every response with
 * COOP/COEP attached, so that GitHub Pages, which cannot send those headers,
 * served a cross-origin isolated page with SharedArrayBuffer for the threaded
 * engine.  The demo now runs the build without threads where the page is not
 * isolated, so nothing needs the headers.
 *
 * The file stays, under the same name, because visitors from before still
 * have the old worker registered, and a registered worker is only replaced
 * when the browser fetches its script again and finds it changed.  This
 * version is what they get: it takes over, unregisters itself, and handles no
 * fetches, so every response arrives as the server sent it.  The page is not
 * reloaded; it is simply not isolated from the next navigation on.  The page
 * no longer registers anything.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.registration.unregister());
});
