// The engine's Worker. Order matters: the prelude sets the engine up, then
// the library's Worker entry starts answering the page.
import './engine-prelude.js';
import 'firebird-wasm/browser/worker-entry';
