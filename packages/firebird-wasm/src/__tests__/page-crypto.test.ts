/**
 * page-crypto.test.ts – WebCrypto AES-GCM page encryption at rest for
 * IndexedDBVFS and OPFSVFS.
 */

import {
  ENCRYPTED_PAGE_MAGIC,
  ENCRYPTED_PAGE_OVERHEAD,
  isEncryptedPageBuffer,
  generateEncryptionKey,
  importRawEncryptionKey,
  exportRawEncryptionKey,
  deriveEncryptionKeyFromPassphrase,
  encryptPage,
  decryptPage,
} from '../browser/page-crypto';
import { IndexedDBVFS } from '../browser/indexeddb-vfs';
import { OPFSVFS, createMemorySyncAccessHandle } from '../browser/opfs-fs';

function createFakeIDBFactory(): {
  factory: IDBFactory;
  stores: Map<string, Map<IDBValidKey, unknown>>;
} {
  const stores = new Map<string, Map<IDBValidKey, unknown>>();

  const makeRequest = <T>(
    run: () => T,
    onDone?: () => void,
  ): IDBRequest<T> => {
    const req: {
      result?: T;
      error: DOMException | null;
      onsuccess: ((ev: Event) => unknown) | null;
      onerror: ((ev: Event) => unknown) | null;
      onupgradeneeded?: ((ev: IDBVersionChangeEvent) => unknown) | null;
    } = {
      error: null,
      onsuccess: null,
      onerror: null,
    };

    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.(new Event('success'));
        onDone?.();
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.(new Event('error'));
      }
    });

    return req as unknown as IDBRequest<T>;
  };

  const factory = {
    open(name: string): IDBOpenDBRequest {
      let map = stores.get(name);
      const isNew = !map;
      if (!map) {
        map = new Map<IDBValidKey, unknown>();
        stores.set(name, map);
      }
      const dbStore = map;
      const storeNames = new Set<string>(isNew ? [] : ['pages']);

      const db = {
        objectStoreNames: {
          contains: (s: string) => storeNames.has(s),
        },
        createObjectStore: (s: string) => {
          storeNames.add(s);
          return {};
        },
        transaction: () => {
          let pending = 0;
          let completed = false;
          const tx = {
            error: null,
            oncomplete: null as ((ev: Event) => unknown) | null,
            onerror: null as ((ev: Event) => unknown) | null,
            onabort: null as ((ev: Event) => unknown) | null,
            objectStore: () => ({
              get: (key: IDBValidKey) => {
                pending += 1;
                return makeRequest(
                  () => dbStore.get(key),
                  () => {
                    pending -= 1;
                    if (pending === 0 && !completed) {
                      completed = true;
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    }
                  },
                );
              },
              put: (value: unknown, key: IDBValidKey) => {
                pending += 1;
                return makeRequest(
                  () => {
                    dbStore.set(key, value);
                    return key;
                  },
                  () => {
                    pending -= 1;
                    if (pending === 0 && !completed) {
                      completed = true;
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    }
                  },
                );
              },
              delete: (key: IDBValidKey) => {
                pending += 1;
                return makeRequest(
                  () => {
                    dbStore.delete(key);
                    return undefined;
                  },
                  () => {
                    pending -= 1;
                    if (pending === 0 && !completed) {
                      completed = true;
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    }
                  },
                );
              },
              clear: () => {
                pending += 1;
                return makeRequest(
                  () => {
                    dbStore.clear();
                    return undefined;
                  },
                  () => {
                    pending -= 1;
                    if (pending === 0 && !completed) {
                      completed = true;
                      queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                    }
                  },
                );
              },
            }),
          };
          queueMicrotask(() => {
            if (pending === 0 && !completed) {
              completed = true;
              tx.oncomplete?.(new Event('complete'));
            }
          });
          return tx;
        },
        close: () => undefined,
      };

      const req: {
        result: unknown;
        error: null;
        onupgradeneeded: ((ev: Event) => unknown) | null;
        onsuccess: ((ev: Event) => unknown) | null;
        onerror: ((ev: Event) => unknown) | null;
      } = {
        result: db,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      queueMicrotask(() => {
        if (isNew) {
          req.onupgradeneeded?.(new Event('upgradeneeded'));
        }
        req.onsuccess?.(new Event('success'));
      });

      return req as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(name: string): IDBOpenDBRequest {
      return makeRequest(() => {
        stores.delete(name);
        return undefined;
      }) as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return { factory, stores };
}

describe('page-crypto (WebCrypto AES-GCM)', () => {
  it('generates, exports, imports, and derives AES-256-GCM keys and encrypts/decrypts pages', async () => {
    const cryptoKey = await generateEncryptionKey(true);
    const rawKey = await exportRawEncryptionKey(cryptoKey);
    expect(rawKey.byteLength).toBe(32);

    const imported = await importRawEncryptionKey(rawKey);
    const page = new Uint8Array(8192);
    const secretText = new TextEncoder().encode('TOP-SECRET-FIREBIRD-RECORD');
    page.set(secretText, 128);

    const envelope = await encryptPage(page, imported, 0, 8192);
    expect(envelope.byteLength).toBe(8192 + ENCRYPTED_PAGE_OVERHEAD);
    expect(isEncryptedPageBuffer(envelope)).toBe(true);
    expect(Array.from(envelope.subarray(0, 4))).toEqual(
      Array.from(ENCRYPTED_PAGE_MAGIC),
    );

    // Ciphertext does not contain the plaintext sequence
    const envelopeHex = Buffer.from(envelope).toString('hex');
    const secretHex = Buffer.from(secretText).toString('hex');
    expect(envelopeHex.includes(secretHex)).toBe(false);

    // Round-trip decrypt with raw Uint8Array key
    const decrypted = await decryptPage(envelope, rawKey, 0, 8192);
    expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(page))).toBe(0);

    // PBKDF2 passphrase derivation
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const derived1 = await deriveEncryptionKeyFromPassphrase('correct horse battery staple', salt, 1000, true);
    const derived2 = await deriveEncryptionKeyFromPassphrase('correct horse battery staple', salt, 1000, true);
    expect(await exportRawEncryptionKey(derived1)).toEqual(
      await exportRawEncryptionKey(derived2),
    );

    // Rejects invalid raw key lengths
    await expect(importRawEncryptionKey(new Uint8Array(24))).rejects.toThrow(
      /16 or 32 bytes/,
    );
  });

  it('rejects wrong keys, tampered ciphertext, and transplanted page numbers (AAD verification)', async () => {
    const key1 = new Uint8Array(32).fill(0xaa);
    const key2 = new Uint8Array(32).fill(0xbb);
    const page = new Uint8Array(8192).fill(0x42);

    const envelope = await encryptPage(page, key1, 5, 8192);

    // 1. Wrong key fails GCM authentication
    await expect(decryptPage(envelope, key2, 5, 8192)).rejects.toThrow(
      /Failed to decrypt database page 5/,
    );

    // 2. Transplanting page 5's envelope into page 6 fails AAD check
    await expect(decryptPage(envelope, key1, 6, 8192)).rejects.toThrow(
      /Failed to decrypt database page 6/,
    );

    // 3. Flipping 1 bit in ciphertext fails GCM authentication
    const tampered = envelope.slice();
    tampered[100]! ^= 0x01;
    await expect(decryptPage(tampered, key1, 5, 8192)).rejects.toThrow(
      /Failed to decrypt database page 5/,
    );
  });

  it('encrypts and decrypts pages at rest in IndexedDBVFS', async () => {
    const { factory } = createFakeIDBFactory();
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = i + 1;

    const vfs = new IndexedDBVFS({
      pageSize: 8192,
      encryptionKey: key,
      indexedDB: factory,
    });
    expect(vfs.isEncrypted).toBe(true);
    await vfs.open('secret_idb');

    const page0 = new Uint8Array(8192);
    page0.set(new TextEncoder().encode('SENSITIVE_CUSTOMER_SSN_999'), 0);
    const page1 = new Uint8Array(8192);
    page1.fill(0x7c);

    const fullImage = new Uint8Array(2 * 8192);
    fullImage.set(page0, 0);
    fullImage.set(page1, 8192);

    await vfs.importDatabase(fullImage);

    const meta = await vfs.getMetadata();
    expect(meta).toEqual({
      pageSize: 8192,
      pageCount: 2,
      encrypted: true,
    });

    // Verify raw page stored in IndexedDB is encrypted with FBE1 header and hides plaintext
    const rawPage0 = await vfs.readRawPage(0);
    expect(rawPage0).not.toBeNull();
    expect(isEncryptedPageBuffer(rawPage0!)).toBe(true);
    expect(rawPage0!.byteLength).toBe(8192 + ENCRYPTED_PAGE_OVERHEAD);
    expect(
      Buffer.from(rawPage0!).includes(Buffer.from('SENSITIVE_CUSTOMER_SSN_999')),
    ).toBe(false);

    // Verify readPage and exportDatabase transparently decrypt
    const exported = await vfs.exportDatabase();
    expect(Buffer.compare(Buffer.from(exported), Buffer.from(fullImage))).toBe(0);
    await vfs.close();

    // Opening the same IndexedDB store WITHOUT encryptionKey rejects on readPage
    const unkeyedVfs = new IndexedDBVFS({
      pageSize: 8192,
      indexedDB: factory,
    });
    await unkeyedVfs.open('secret_idb');
    await expect(unkeyedVfs.readPage(0)).rejects.toThrow(
      /encrypted at rest, but no encryptionKey was provided/,
    );
    await unkeyedVfs.close();

    // Opening with a WRONG encryptionKey rejects on readPage
    const wrongKeyVfs = new IndexedDBVFS({
      pageSize: 8192,
      encryptionKey: new Uint8Array(32).fill(0xff),
      indexedDB: factory,
    });
    await wrongKeyVfs.open('secret_idb');
    await expect(wrongKeyVfs.readPage(0)).rejects.toThrow(
      /Failed to decrypt database page 0/,
    );
    await wrongKeyVfs.destroy();
  });

  it('encrypts and decrypts pages at rest in OPFSVFS', async () => {
    const handle = createMemorySyncAccessHandle();
    const key = await generateEncryptionKey(false);

    const vfs = new OPFSVFS({
      pageSize: 8192,
      handle,
      encryptionKey: key,
    });
    expect(vfs.isEncrypted).toBe(true);
    await vfs.open('opfs://secret_opfs');

    const page0 = new Uint8Array(8192);
    page0.set(new TextEncoder().encode('OPFS_ENCRYPTED_PAYLOAD'), 64);
    const page1 = new Uint8Array(8192);
    page1.fill(0x55);

    await vfs.writePage(0, page0);
    await vfs.writePage(1, page1);

    const meta = await vfs.getMetadata();
    expect(meta).toEqual({
      pageSize: 8192,
      pageCount: 2,
      encrypted: true,
    });

    // Underlying SyncAccessHandle holds 2 * (8192 + 32) encrypted bytes
    expect(handle.getSize()).toBe(2 * (8192 + ENCRYPTED_PAGE_OVERHEAD));
    const rawSlot0 = await vfs.readRawPage(0);
    expect(rawSlot0).not.toBeNull();
    expect(isEncryptedPageBuffer(rawSlot0!)).toBe(true);
    expect(
      Buffer.from(handle.toUint8Array()).includes(
        Buffer.from('OPFS_ENCRYPTED_PAYLOAD'),
      ),
    ).toBe(false);

    const exported = await vfs.exportDatabase();
    expect(exported.byteLength).toBe(2 * 8192);
    expect(
      Buffer.compare(Buffer.from(exported.subarray(0, 8192)), Buffer.from(page0)),
    ).toBe(0);
    expect(
      Buffer.compare(Buffer.from(exported.subarray(8192)), Buffer.from(page1)),
    ).toBe(0);
    await vfs.close();

    // Opening the same SyncAccessHandle without encryptionKey rejects on readPage
    const unkeyedOpfs = new OPFSVFS({ pageSize: 8192, handle });
    await unkeyedOpfs.open('opfs://secret_opfs');
    await expect(unkeyedOpfs.readPage(0)).rejects.toThrow(
      /encrypted at rest, but no encryptionKey was provided/,
    );
    await unkeyedOpfs.close();
  });
});
