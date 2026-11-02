/**
 * snapshots.test.ts – Copy-on-Write page-level point-in-time snapshots and
 * branching for CowSnapshotStore, IndexedDBVFS, OPFSVFS, and FirebirdBrowser.
 */

import { CowSnapshotStore } from '../browser/snapshots';
import { OPFSVFS, createMemorySyncAccessHandle } from '../browser/opfs-fs';

describe('CowSnapshotStore', () => {
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
