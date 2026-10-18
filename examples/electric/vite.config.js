import { defineConfig } from 'vite';

// As examples/vite: the threaded engine wants a cross-origin isolated page
// (server.mjs --isolated); without one the page loads the build without
// threads. The Node-only require of the glue stays out of both bundles.
const GLUE = [/firebird-embedded(-st)?\.js$/];

export default defineConfig({
  build: { rolldownOptions: { external: GLUE } },
  worker: { rolldownOptions: { external: GLUE } },
});
