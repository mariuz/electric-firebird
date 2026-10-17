/**
 * cdn.test.ts – the URLs cdnArtifacts() builds, and the version they name.
 *
 * Loading from a real CDN is exercised in the browser
 * (`e2e/tests/browser-cdn.spec.ts`, against a second origin that stands in for
 * one); this pins the URLs themselves and the version they carry.
 */

import * as fs from 'fs';
import * as path from 'path';
import { cdnArtifacts } from '../wasm-loader';
import { VERSION } from '../version';

describe('VERSION', () => {
  it("is package.json's version, so CDN URLs name the files this code was built with", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('cdnArtifacts', () => {
  it('points at jsDelivr by default, at this exact version', () => {
    const { glueUrl, locateFile } = cdnArtifacts({ threads: true });
    const base = `https://cdn.jsdelivr.net/npm/firebird-wasm@${VERSION}/dist/wasm/`;
    expect(glueUrl).toBe(`${base}firebird-embedded.js`);
    expect(locateFile('firebird-embedded.wasm')).toBe(`${base}firebird-embedded.wasm`);
  });

  it('names the build without threads when asked', () => {
    const { glueUrl, locateFile } = cdnArtifacts({ threads: false, cdn: 'unpkg', version: '9.9.9' });
    expect(glueUrl).toBe('https://unpkg.com/firebird-wasm@9.9.9/dist/wasm/firebird-embedded-st.js');
    expect(locateFile('firebird-embedded-st.wasm'))
      .toBe('https://unpkg.com/firebird-wasm@9.9.9/dist/wasm/firebird-embedded-st.wasm');
  });

  it('takes any base URL, with or without the trailing slash', () => {
    for (const base of ['https://mirror.example/fb', 'https://mirror.example/fb/']) {
      const { glueUrl, locateFile } = cdnArtifacts({ threads: false, cdn: base });
      expect(glueUrl).toBe('https://mirror.example/fb/firebird-embedded-st.js');
      expect(locateFile('firebird-embedded-st.wasm')).toBe('https://mirror.example/fb/firebird-embedded-st.wasm');
    }
  });

  it("picks the build as wasmGlueFile does: threads in Node when 'auto'", () => {
    expect(cdnArtifacts().glueUrl.endsWith('/firebird-embedded.js')).toBe(true);
  });
});
