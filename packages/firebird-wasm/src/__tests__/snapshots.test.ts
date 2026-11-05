/**
 * snapshots.test.ts – Copy-on-Write page-level point-in-time snapshots,
 * branching, and incremental binary page diffs (`exportPageDiff`,
 * `inspectPageDiff`, `applyPageDiff`, `store.exportDiff`, `store.applyDiff`)
 * for CowSnapshotStore, IndexedDBVFS, OPFSVFS, FirebirdBrowser, and
 * FirebirdLite.
 */

import {
  CowSnapshotStore,
  PAGE_DIFF_HEADER_BYTES,
  isPageDiffPayload,
  exportPageDiff,
  inspectPageDiff,
  applyPageDiff,
} from '../browser/snapshots';
import { OPFSVFS, createMemorySyncAccessHandle } from '../browser/opfs-fs';

describe('CowSnapshotStore & Incremental Binary Page Diffs', () => {
  it('shares unchanged 8 KB pages across snapshots via Copy-on-Write', () => {
    const store = new CowSnapshotStore(8192);

    const image1 = new Uint8Array(4 * 8192);
    image1.subarray(0, 8192).fill(0x11);
    image1.subarray(8192, 2 * 8192).fill(0x22);
    image1.subarray(2 * 8192, 3 * 8192).fill(0x33);
    image1.subarray(3 * 8192, 4 * 8192).fill(0x44);

    const snap1 = store.createSnapshot(image1, 'v1');
    expect(snap1.id).toBe('v1');
    expect(snap1.label).toBe('v1');
    expect(snap1.pageCount).toBe(4);
    expect(snap1.uniquePages).toBe(4);
    expect(snap1.sharedPages).toBe(0);
    expect(snap1.parentId).toBeNull();

    // Modify only page 2 (leaving pages 0, 1, 3 untouched)
    const image2 = image1.slice();
    image2.subarray(2 * 8192, 3 * 8192).fill(0x99);

    const snap2 = store.createSnapshot(image2, 'v2');
    expect(snap2.id).toBe('v2');
    expect(snap2.parentId).toBe('v1');
    expect(snap2.pageCount).toBe(4);
    expect(snap2.uniquePages).toBe(1);
    expect(snap2.sharedPages).toBe(3);

    // Reference equality: pages 0, 1, 3 share the exact same Uint8Array buffer
    expect(snap2.pages[0]).toBe(snap1.pages[0]);
    expect(snap2.pages[1]).toBe(snap1.pages[1]);
    expect(snap2.pages[2]).not.toBe(snap1.pages[2]);
    expect(snap2.pages[3]).toBe(snap1.pages[3]);

    // Reassembled images match original bytes
    expect(Buffer.compare(Buffer.from(snap1.toUint8Array()), Buffer.from(image1))).toBe(0);
    expect(Buffer.compare(Buffer.from(snap2.toUint8Array()), Buffer.from(image2))).toBe(0);

    // Listing & deleting snapshots
    expect(store.listSnapshots().map((s) => s.id)).toEqual(['v1', 'v2']);
    expect(store.deleteSnapshot('v1')).toBe(true);
    expect(store.hasSnapshot('v1')).toBe(false);
    expect(store.hasSnapshot('v2')).toBe(true);
    expect(() => store.getSnapshot('v1')).toThrow(/not found/);
  });

  it('exports and applies compact incremental binary page diffs (FBDF\\x01) with CRC32 verification', () => {
    const store = new CowSnapshotStore(8192);

    // Base 4-page database image (32 KB)
    const imageV1 = new Uint8Array(4 * 8192);
    imageV1.subarray(0, 8192).fill(0x10);
    imageV1.subarray(8192, 2 * 8192).fill(0x20);
    imageV1.subarray(2 * 8192, 3 * 8192).fill(0x30);
    imageV1.subarray(3 * 8192, 4 * 8192).fill(0x40);
    store.createSnapshot(imageV1, 'v1');

    // Target 5-page database image (40 KB): page 1 modified, page 4 appended
    const imageV2 = new Uint8Array(5 * 8192);
    imageV2.set(imageV1, 0);
    imageV2.subarray(8192, 2 * 8192).fill(0x77);
    imageV2.subarray(4 * 8192, 5 * 8192).fill(0x50);
    store.createSnapshot(imageV2, 'v2');

    // 1. Export incremental diff between v1 and v2
    const diffBytes = store.exportDiff('v1', 'v2');
    expect(isPageDiffPayload(diffBytes)).toBe(true);

    // Only 2 pages changed out of 5: 32-byte header + 2 * (6 + 8192) = 16,428 bytes (< half of 40 KB)
    expect(diffBytes.byteLength).toBe(PAGE_DIFF_HEADER_BYTES + 2 * (6 + 8192));

    const parsed = inspectPageDiff(diffBytes);
    expect(parsed.version).toBe(1);
    expect(parsed.hasBase).toBe(true);
    expect(parsed.pageSize).toBe(8192);
    expect(parsed.baseByteLength).toBe(4 * 8192);
    expect(parsed.targetByteLength).toBe(5 * 8192);
    expect(parsed.changedPageCount).toBe(2);
    expect(parsed.entries.map((e) => e.pageIndex)).toEqual([1, 4]);

    // 2. Apply diff onto v1 in a remote replica store and verify byte-exact reconstruction
    const replicaStore = new CowSnapshotStore(8192);
    replicaStore.createSnapshot(imageV1, 'v1');
    const reconstructedV2 = replicaStore.applyDiff(diffBytes, 'v1', {
      snapshotLabel: 'v2-replica',
    });

    expect(Buffer.compare(Buffer.from(reconstructedV2), Buffer.from(imageV2))).toBe(0);
    expect(replicaStore.hasSnapshot('v2-replica')).toBe(true);
    expect(replicaStore.getSnapshot('v2-replica').sharedPages).toBe(3);

    // 3. Export full initial checkpoint diff (base = null) and apply to empty base
    const fullDiff = exportPageDiff(null, imageV1, { pageSize: 8192 });
    const parsedFull = inspectPageDiff(fullDiff);
    expect(parsedFull.hasBase).toBe(false);
    expect(parsedFull.changedPageCount).toBe(4);
    const fromScratch = applyPageDiff(null, fullDiff);
    expect(Buffer.compare(Buffer.from(fromScratch), Buffer.from(imageV1))).toBe(0);

    // 4. Reject applying diff onto wrong base image (CRC32 mismatch)
    const corruptedBase = imageV1.slice();
    corruptedBase[0] ^= 0xff;
    expect(() => applyPageDiff(corruptedBase, diffBytes)).toThrow(
      /base checksum mismatch/,
    );

    // 5. Reject corrupted diff payload (target CRC32 mismatch)
    const corruptedDiff = diffBytes.slice();
    corruptedDiff[corruptedDiff.byteLength - 1] ^= 0xff;
    expect(() => applyPageDiff(imageV1, corruptedDiff)).toThrow(
      /target checksum mismatch/,
    );
  });

  it('captures and restores CoW snapshots in OPFSVFS', async () => {
    const handle = createMemorySyncAccessHandle();
    const vfs = new OPFSVFS({ pageSize: 8192, handle });
    await vfs.open('opfs://snap_opfs');

    const p0 = new Uint8Array(8192).fill(0x01);
    const p1 = new Uint8Array(8192).fill(0x02);
    await vfs.writePage(0, p0);
    await vfs.writePage(1, p1);

    const checkpoint = await vfs.snapshot('before-migration');
    expect(checkpoint.pageCount).toBe(2);

    // Mutate page 1 and add page 2
    await vfs.writePage(1, new Uint8Array(8192).fill(0xaa));
    await vfs.writePage(2, new Uint8Array(8192).fill(0xbb));
    expect((await vfs.getMetadata())?.pageCount).toBe(3);

    // Restore back to 'before-migration'
    await vfs.restoreSnapshot('before-migration');
    expect((await vfs.getMetadata())?.pageCount).toBe(2);
    const restoredP1 = await vfs.readPage(1);
    expect(restoredP1?.[0]).toBe(0x02);

    expect(vfs.listSnapshots()).toHaveLength(1);
    expect(vfs.deleteSnapshot(checkpoint)).toBe(true);
    expect(vfs.listSnapshots()).toHaveLength(0);
    await vfs.close();
  });
});
