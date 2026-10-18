/**
 * frameworks-entry.ts – React, Vue, the library's bindings for them and its
 * REPL element, in one bundle for the browser tests (served as
 * /dist/firebird-frameworks.mjs).
 *
 * Bundled from the bindings' sources, as the library bundle is, so a test
 * runs the code in the working tree.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as Vue from 'vue';
import * as FBReact from '../../packages/firebird-wasm/src/react';
import * as FBVue from '../../packages/firebird-wasm/src/vue';
import * as FBRepl from '../../packages/firebird-wasm/src/repl';

(window as unknown as { Frameworks: unknown }).Frameworks = { React, createRoot, Vue, FBReact, FBVue, FBRepl };
