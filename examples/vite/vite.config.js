import { defineConfig } from 'vite';

// The threaded engine needs SharedArrayBuffer, which needs a cross-origin
// isolated page. Set the headers on `preview` as well as `server`: having them
// only in development is how a build ships that fails once deployed. Without
// them the page loads the build without threads instead (engine-prelude.js).
const GLUE = [/firebird-embedded(-st)?\.js$/];

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  // firebird-wasm's Node branch require()s the Emscripten glue. A browser
  // never takes it; keep it out of both bundles rather than bundle Node code.
  // The Worker is a bundle of its own, so it needs the setting too.
  build: { rolldownOptions: { external: GLUE } },
  worker: { rolldownOptions: { external: GLUE } },
});
