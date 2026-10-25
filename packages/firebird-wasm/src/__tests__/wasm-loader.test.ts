import * as fs from 'fs';
import * as path from 'path';
import { allocString, loadFirebirdWasm } from '../wasm-loader';
import type { FirebirdWasmModule } from '../wasm-loader';

const WASM_JS_PATH = path.resolve(__dirname, '../../dist/wasm/firebird-embedded.js');
const hasWasm = fs.existsSync(WASM_JS_PATH);

describe('wasm-loader', () => {
  it('exports loadFirebirdWasm function', () => {
    expect(typeof loadFirebirdWasm).toBe('function');
  });

  it('exports allocString function', () => {
    expect(typeof allocString).toBe('function');
  });

  // This negative test only applies when the WASM binary has not been built.
  // When the binary is present, the wasm-integration tests exercise the module.
  (hasWasm ? it.skip : it)(
    'loadFirebirdWasm rejects when WASM binary is not available',
    async () => {
      // In a test/CI environment the WASM binary has not been built,
      // so calling loadFirebirdWasm should fail with a descriptive error.
      await expect(loadFirebirdWasm()).rejects.toThrow();
    },
  );

  describe('allocString', () => {
    it('allocates and fills a UTF-8 C string on the WASM heap', () => {
      // Create a minimal mock of the FirebirdWasmModule interface
      const heap = new Uint8Array(256);
      let nextPtr = 8;

      const mod: Pick<
        FirebirdWasmModule,
        'lengthBytesUTF8' | '_malloc' | 'stringToUTF8' | '_free'
      > = {
        lengthBytesUTF8: (str: string) => new TextEncoder().encode(str).length,
        _malloc: (size: number) => {
          const ptr = nextPtr;
          nextPtr += size;
          return ptr;
        },
        stringToUTF8: (str: string, outPtr: number, maxBytes: number) => {
          const encoded = new TextEncoder().encode(str);
          const bytesToWrite = Math.min(encoded.length, maxBytes - 1);
          heap.set(encoded.subarray(0, bytesToWrite), outPtr);
          heap[outPtr + bytesToWrite] = 0; // null terminator
        },
        _free: () => { /* noop in mock */ },
      };

      const ptr = allocString(mod as FirebirdWasmModule, 'hello');
      expect(ptr).toBeGreaterThan(0);
      // The allocated region should contain 'hello\0'
      expect(heap[ptr]).toBe('h'.charCodeAt(0));
      expect(heap[ptr + 4]).toBe('o'.charCodeAt(0));
      expect(heap[ptr + 5]).toBe(0); // null terminator
    });
  });

  describe('wasm/build.sh and CI incremental rebuild guards', () => {
    it('preserves autoconfig.h, parse.h/parse.cpp, and epp-generated mtimes across incremental rebuilds and runs a second build in CI', () => {
      const buildShPath = path.resolve(__dirname, '../../wasm/build.sh');
      const buildSh = fs.readFileSync(buildShPath, 'utf8');

      // 1. Saves previous 32-bit WASM autoconfig.h before native bootstrap and restores it if byte-identical
      expect(buildSh).toContain('AUTOCONFIG_PREV=');
      expect(buildSh).toContain('cp -p "${AUTOCONFIG_SRC}" "${AUTOCONFIG_PREV}"');
      expect(buildSh).toContain('cmp -s "${AUTOCONFIG_SRC}" "${AUTOCONFIG_PREV}"');
      expect(buildSh).toContain('mv -f "${AUTOCONFIG_PREV}" "${AUTOCONFIG_SRC}"');

      // 2. Preserves parse.h and parse.cpp mtimes when generated parser output is unchanged
      expect(buildSh).toContain('cmp -s "${PARSE_H_NATIVE}" "${PARSE_H_SRC}"');
      expect(buildSh).toContain('cmp -s "${PARSE_CPP_NATIVE}" "${PARSE_CPP_SRC}"');

      // 3. Caches epp-generated outputs across build-native-config wipes and compares .tmp before overwriting
      expect(buildSh).toContain('EPP_CACHE_DIR=');
      expect(buildSh).toContain('cmp -s "${out}.tmp" "${out}"');

      // 4. CI workflow runs an incremental rebuild check after wiping build-native-config and touching fb_wasm_api.cpp
      const workflowPath = path.resolve(__dirname, '../../../../.github/workflows/build-wasm.yml');
      const workflow = fs.readFileSync(workflowPath, 'utf8');
      expect(workflow).toContain('Incremental WASM rebuild check');
      expect(workflow).toContain('rm -rf wasm/build-native-config');
      expect(workflow).toContain('rm -f wasm/firebird-src/.wasm-patches-applied');
      expect(workflow).toContain('touch wasm/fb_wasm_api.cpp');
      expect(workflow).toContain('test "$AFTER_TOUCHED" -gt "$BEFORE_TOUCHED"');
      expect(workflow).toContain('test "$AFTER_UNTOUCHED" -eq "$BEFORE_UNTOUCHED"');
    });

    it('wires ICU collation data (UNICODE, UNICODE_CI, UNICODE_CI_AI) into the WASM build', () => {
      const patch2 = fs.readFileSync(
        path.resolve(__dirname, '../../wasm/patches/0002-unicode-util-static-icu-wasm.patch'),
        'utf8',
      );
      expect(patch2).toContain('wasmUcolGetContractionsAndExpansions');

      const icuDataCpp = fs.readFileSync(
        path.resolve(__dirname, '../../wasm/fb_wasm_icu_data.cpp'),
        'utf8',
      );
      expect(icuDataCpp).toContain('udata_setCommonData');
      expect(icuDataCpp).toContain('static_assert(U_ICU_VERSION_MAJOR_NUM == 68');

      const cmake = fs.readFileSync(
        path.resolve(__dirname, '../../wasm/CMakeLists.txt'),
        'utf8',
      );
      expect(cmake).toContain('option(FB_WASM_ICU_COLLATION "Embed ICU collation data so UNICODE collations work" ON)');
      expect(cmake).toContain('--embed-file ${FB_ICU_DATA}@/firebird/icu/icudt68l.dat');

      const buildIcuSh = fs.readFileSync(
        path.resolve(__dirname, '../../wasm/tools/build-icu-data.sh'),
        'utf8',
      );
      expect(buildIcuSh).toContain('icupkg');
    });
  });
});
