import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  entry: './src/main.js',
  output: { path: path.join(here, 'dist'), filename: 'main.js', clean: true },
  // firebird-wasm's Node branch require()s the Emscripten glue. A browser
  // never takes it; keep it out of the bundle rather than bundle Node code.
  // webpack bundles the Worker (new Worker(new URL(...))) from the same
  // configuration, so this covers it too.
  externals: {
    '../dist/wasm/firebird-embedded.js': 'commonjs ../dist/wasm/firebird-embedded.js',
    '../dist/wasm/firebird-embedded-st.js': 'commonjs ../dist/wasm/firebird-embedded-st.js',
  },
  // The threaded engine needs a cross-origin isolated page; without the
  // headers the page loads the build without threads (engine-prelude.js).
  devServer: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
};
