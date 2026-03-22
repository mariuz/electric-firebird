import { allocString, loadFirebirdWasm } from '../wasm-loader';
import type { FirebirdWasmModule } from '../wasm-loader';

describe('wasm-loader', () => {
  it('exports loadFirebirdWasm function', () => {
    expect(typeof loadFirebirdWasm).toBe('function');
  });

  it('exports allocString function', () => {
    expect(typeof allocString).toBe('function');
  });

  it('loadFirebirdWasm rejects when WASM binary is not available', async () => {
    // In a test/CI environment the WASM binary has not been built,
    // so calling loadFirebirdWasm should fail with a descriptive error.
    await expect(loadFirebirdWasm()).rejects.toThrow();
  });

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
});
