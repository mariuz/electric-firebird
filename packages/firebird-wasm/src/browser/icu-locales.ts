/**
 * icu-locales.ts – optional lazy-loaded ICU locale tailoring packs.
 *
 * The default WASM binary embeds only ICU 68.2's root collator and Unicode
 * collation weights (`coll/ucadata.icu`, `coll/root.res`, `coll/en*.res`,
 * `coll/res_index.res`) so `UNICODE`, `UNICODE_CI`, and `UNICODE_CI_AI` work
 * without bloating the default download with 170 locale bundles.
 *
 * Applications that create locale-specific collations (`CREATE COLLATION ...
 * FOR UTF8 FROM UNICODE 'LOCALE=de_DE'`, `es_ES`, `fr_FR`, `ja_JP`) can lazy-
 * load an optional ICU `.dat` tailoring pack (built via
 * `wasm/tools/build-icu-data.sh --locales` or generated at runtime with
 * {@link buildIcuLocalePack}) via `db.loadIcuLocaleData(pack)` or
 * `FirebirdBrowserOptions.icuLocaleData`.
 */

import type { FirebirdWasmModule } from '../wasm-loader';
import { lastError } from '../wasm-loader';
import { isGzipHeader, decompressGzipStream, createChunkedByteStream } from './data-stream';

/** Path where optional ICU locale tailoring packs are stored in Emscripten's VFS. */
export const ICU_LOCALE_DATA_PATH = '/firebird/icu/icudt68l-locales.dat';

/** Path of the base root ICU collation package in Emscripten's VFS. */
export const ICU_BASE_DATA_PATH = '/firebird/icu/icudt68l.dat';

/** Default locales included by {@link buildIcuLocalePack}. */
export const DEFAULT_ICU_TAILORING_LOCALES = [
  'de',
  'de_DE',
  'en',
  'en_US',
  'es',
  'es_ES',
  'fr',
  'fr_FR',
  'ja',
  'ja_JP',
] as const;

const SLACK_BYTES = 65536;
const SLACK_MARKER = new Uint8Array([0x46, 0x42, 0x49, 0x43, 0x55, 0x53, 0x4c, 0x4b]); // "FBICUSLK"

/** Track the `firstDataOff` where `SLACK_MARKER` was placed per module instance. */
const moduleSlackMarkerOffset = new WeakMap<FirebirdWasmModule, number>();

/**
 * Return `true` when `data` starts with a valid ICU `CmnD` (`.dat`) package
 * header (`magic1 = 0xda, magic2 = 0x27, dataFormat = "CmnD"`).
 */
export function isValidIcuDataPackage(data: Uint8Array): boolean {
  if (data.byteLength < 24) return false;
  return (
    data[2] === 0xda &&
    data[3] === 0x27 &&
    data[12] === 0x43 && // 'C'
    data[13] === 0x6d && // 'm'
    data[14] === 0x6e && // 'n'
    data[15] === 0x44    // 'D'
  );
}

/** Encode an ASCII string with a trailing NUL byte. */
function encodeAsciiNullTerminated(str: string): Uint8Array {
  const out = new Uint8Array(str.length + 1);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0x7f;
  }
  out[str.length] = 0;
  return out;
}

/**
 * Build a minimal ICU `ResB` formatVersion 2 resource bundle representing an
 * empty collation tailoring (`coll/<locale>.res`) that inherits from `root`.
 */
function buildEmptyLocaleResBundle(): Uint8Array {
  return new Uint8Array([
    0x20, 0x00, 0xda, 0x27, 0x14, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x52, 0x65, 0x73, 0x42,
    0x02, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x20, 0x07, 0x00, 0x00, 0x00,
    0x08, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
    0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
    0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa,
  ]);
}

/**
 * Build an ICU `ResB` formatVersion 2 `res_index.res` resource bundle whose
 * `InstalledLocales` table lists `locales`.
 */
function buildResIndexBundle(locales: readonly string[]): Uint8Array {
  const expanded = new Set<string>(['en', 'en_US', 'en_US_POSIX']);
  for (const raw of locales) {
    const clean = raw.trim().replace(/-/g, '_');
    if (!clean) continue;
    expanded.add(clean);
    const base = clean.split('_')[0];
    if (base) expanded.add(base);
  }
  const sorted = Array.from(expanded).sort();

  const keyChunks: Uint8Array[] = [];
  const keyOffsets: number[] = [];
  let keyBytePos = 32; // starts at 32-bit word 8 after the 32-byte ResB header

  const addKey = (key: string): number => {
    const off = keyBytePos;
    const bytes = encodeAsciiNullTerminated(key);
    keyChunks.push(bytes);
    keyBytePos += bytes.byteLength;
    return off;
  };

  const installedOff = addKey('InstalledLocales');
  for (const loc of sorted) {
    keyOffsets.push(addKey(loc));
  }
  while (keyBytePos % 4 !== 0) {
    keyChunks.push(new Uint8Array([0]));
    keyBytePos++;
  }

  const keysTop = keyBytePos / 4;
  const b16Top = keysTop + 1;
  const n = sorted.length;
  const tableHeaderU16s = 1 + n + ((1 + n) % 2);
  const installedTableWord = b16Top;
  const installedTableWords = tableHeaderU16s / 2 + n;
  const rootTableWord = installedTableWord + installedTableWords;
  const bundleTop = rootTableWord + 2;

  const rHdr = 32;
  const out = new Uint8Array(rHdr + bundleTop * 4);
  const dv = new DataView(out.buffer);

  // 32-byte ResB formatVersion 2.0 header
  out.set(
    [
      0x20, 0x00, 0xda, 0x27, 0x14, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x52, 0x65, 0x73, 0x42,
      0x02, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00,
    ],
    0,
  );

  dv.setUint32(rHdr + 0, ((2 << 28) | rootTableWord) >>> 0, true);
  dv.setUint32(rHdr + 4, 7, true);
  dv.setUint32(rHdr + 8, keysTop, true);
  dv.setUint32(rHdr + 12, bundleTop, true);
  dv.setUint32(rHdr + 16, bundleTop, true);
  dv.setUint32(rHdr + 20, Math.max(n, 1), true);
  dv.setUint32(rHdr + 24, 1, true);
  dv.setUint32(rHdr + 28, b16Top, true);

  let pos = rHdr + 32;
  for (const chunk of keyChunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }

  // Empty UTF-16 string at 16-bit unit 0
  dv.setUint32(rHdr + keysTop * 4, 0, true);

  // InstalledLocales URES_TABLE
  let tp = rHdr + installedTableWord * 4;
  dv.setUint16(tp, n, true);
  tp += 2;
  for (let i = 0; i < n; i++) {
    dv.setUint16(tp, keyOffsets[i]!, true);
    tp += 2;
  }
  if ((1 + n) % 2 === 1) {
    dv.setUint16(tp, 0, true);
    tp += 2;
  }
  for (let i = 0; i < n; i++) {
    dv.setUint32(tp, 0x60000000, true);
    tp += 4;
  }

  // Root URES_TABLE containing InstalledLocales
  dv.setUint16(tp, 1, true);
  tp += 2;
  dv.setUint16(tp, installedOff, true);
  tp += 2;
  dv.setUint32(tp, ((2 << 28) | installedTableWord) >>> 0, true);

  return out;
}

/**
 * Build a complete ICU 68.2 `CmnD` (`.dat`) locale tailoring package for the
 * given `locales` (defaulting to `de_DE`, `es_ES`, `fr_FR`, `ja_JP` and their
 * base languages).
 *
 * The returned `Uint8Array` can be passed directly to
 * `db.loadIcuLocaleData(pack)` or `new FirebirdBrowser(name, { icuLocaleData: pack })`.
 */
export function buildIcuLocalePack(
  locales: readonly string[] = DEFAULT_ICU_TAILORING_LOCALES,
): Uint8Array {
  const entries = new Map<string, Uint8Array>();
  const resIdx = buildResIndexBundle(locales);
  const emptyRes = buildEmptyLocaleResBundle();

  entries.set('icudt68l/res_index.res', resIdx);
  entries.set('icudt68l/coll/res_index.res', resIdx);

  for (const raw of locales) {
    const clean = raw.trim().replace(/-/g, '_');
    if (!clean) continue;
    entries.set(`icudt68l/coll/${clean}.res`, emptyRes);
    const base = clean.split('_')[0];
    if (base) {
      entries.set(`icudt68l/coll/${base}.res`, emptyRes);
    }
  }

  return buildCmnDPackage(entries);
}

/** Serialize a map of `icudt68l/...` items into an ICU 68 `CmnD` (`.dat`) package. */
function buildCmnDPackage(entries: Map<string, Uint8Array>): Uint8Array {
  const hdrSize = 144;
  const sortedNames = Array.from(entries.keys()).sort();
  const tocBytes = 4 + sortedNames.length * 8;
  let namesBytes = 0;
  for (const name of sortedNames) {
    namesBytes += name.length + 1;
  }

  let dataStart = tocBytes + namesBytes;
  while (dataStart % 16 !== 0) dataStart++;

  let payloadBytes = 0;
  const dataOffsets: number[] = [];
  for (const name of sortedNames) {
    while (payloadBytes % 16 !== 0) payloadBytes++;
    dataOffsets.push(dataStart + payloadBytes);
    payloadBytes += entries.get(name)!.byteLength;
  }

  const out = new Uint8Array(hdrSize + dataStart + payloadBytes);
  out.set(
    [
      0x90, 0x00, 0xda, 0x27, 0x14, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x43, 0x6d, 0x6e, 0x44,
      0x01, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
    ],
    0,
  );

  const dv = new DataView(out.buffer);
  dv.setUint32(hdrSize, sortedNames.length, true);

  let nameCursor = tocBytes;
  for (let i = 0; i < sortedNames.length; i++) {
    const name = sortedNames[i]!;
    const item = entries.get(name)!;
    dv.setUint32(hdrSize + 4 + i * 8, nameCursor, true);
    dv.setUint32(hdrSize + 4 + i * 8 + 4, dataOffsets[i]!, true);
    for (let c = 0; c < name.length; c++) {
      out[hdrSize + nameCursor + c] = name.charCodeAt(c) & 0x7f;
    }
    out[hdrSize + nameCursor + name.length] = 0;
    nameCursor += name.length + 1;
    out.set(item, hdrSize + dataOffsets[i]!);
  }

  return out;
}

/** Parse the ToC of an ICU `CmnD` (`.dat`) package into `(name, bytes)` entries. */
function parseCmnDPackage(dat: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(dat.buffer, dat.byteOffset, dat.byteLength);
  const hdrSize = dv.getUint16(0, true);
  const count = dv.getUint32(hdrSize, true);
  const rawList: Array<{ name: string; dOff: number }> = [];

  for (let i = 0; i < count; i++) {
    const nOff = dv.getUint32(hdrSize + 4 + i * 8, true);
    const dOff = dv.getUint32(hdrSize + 4 + i * 8 + 4, true);
    let name = '';
    for (let p = hdrSize + nOff; p < dat.byteLength && dat[p] !== 0; p++) {
      name += String.fromCharCode(dat[p]!);
    }
    rawList.push({ name, dOff });
  }

  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < rawList.length; i++) {
    const end =
      i + 1 < rawList.length ? hdrSize + rawList[i + 1]!.dOff : dat.byteLength;
    out.set(
      rawList[i]!.name,
      dat.subarray(hdrSize + rawList[i]!.dOff, end),
    );
  }
  return out;
}

/**
 * Reserve ToC slack in `/firebird/icu/icudt68l.dat` when loading an older WASM
 * module that does not yet export `_fb_load_icu_data`.
 */
export function prepareModuleIcuSlack(mod: FirebirdWasmModule): void {
  if (typeof mod._fb_load_icu_data === 'function') return;
  if (moduleSlackMarkerOffset.has(mod)) return;
  try {
    if (!mod.FS?.analyzePath(ICU_BASE_DATA_PATH).exists) return;
    const baseDat = mod.FS.readFile(ICU_BASE_DATA_PATH);
    if (!isValidIcuDataPackage(baseDat)) return;

    const dv = new DataView(baseDat.buffer, baseDat.byteOffset, baseDat.byteLength);
    const hdrSize = dv.getUint16(0, true);
    const count = dv.getUint32(hdrSize, true);
    if (count === 0) return;

    const firstDataOff = dv.getUint32(hdrSize + 8, true);
    const out = new Uint8Array(baseDat.byteLength + SLACK_BYTES);
    out.set(baseDat.subarray(0, hdrSize + firstDataOff), 0);
    out.set(SLACK_MARKER, hdrSize + firstDataOff);

    const outDv = new DataView(out.buffer);
    for (let i = 0; i < count; i++) {
      const dOff = dv.getUint32(hdrSize + 4 + i * 8 + 4, true);
      outDv.setUint32(hdrSize + 4 + i * 8 + 4, dOff + SLACK_BYTES, true);
    }
    out.set(
      baseDat.subarray(hdrSize + firstDataOff),
      hdrSize + firstDataOff + SLACK_BYTES,
    );

    mod.FS.writeFile(ICU_BASE_DATA_PATH, out);
    moduleSlackMarkerOffset.set(mod, hdrSize + firstDataOff);
  } catch {
    // Non-fatal on stub modules without a full VFS
  }
}

/** Locate the in-memory `g_icuData` buffer inside `mod.HEAPU8` using `SLACK_MARKER`. */
function findGicuDataInHeap(mod: FirebirdWasmModule): number {
  const mOff = moduleSlackMarkerOffset.get(mod);
  if (mOff === undefined || !mod.HEAPU8) return -1;
  const heap = mod.HEAPU8;
  for (let p = 0; p + mOff + SLACK_MARKER.byteLength < heap.byteLength; p += 8) {
    if (
      heap[p + 2] === 0xda &&
      heap[p + 3] === 0x27 &&
      heap[p + 12] === 0x43 &&
      heap[p + 13] === 0x6d
    ) {
      let match = true;
      for (let k = 0; k < SLACK_MARKER.byteLength; k++) {
        if (heap[p + mOff + k] !== SLACK_MARKER[k]) {
          match = false;
          break;
        }
      }
      if (match) return p;
    }
  }
  return -1;
}

/**
 * Inject the entries of `packEntries` into the slack region of `g_icuData` at
 * `pos` inside `mod.HEAPU8`.
 */
function injectEntriesIntoHeapSlack(
  heap: Uint8Array,
  pos: number,
  packEntries: Map<string, Uint8Array>,
): void {
  const hdv = new DataView(heap.buffer, heap.byteOffset + pos);
  const hdrSize = hdv.getUint16(0, true);
  const origCount = hdv.getUint32(hdrSize, true);

  const combined = new Map<string, { existingOff?: number; bytes?: Uint8Array }>();
  for (let i = 0; i < origCount; i++) {
    const nOff = hdv.getUint32(hdrSize + 4 + i * 8, true);
    const dOff = hdv.getUint32(hdrSize + 4 + i * 8 + 4, true);
    let name = '';
    for (let p = pos + hdrSize + nOff; p < heap.byteLength && heap[p] !== 0; p++) {
      name += String.fromCharCode(heap[p]!);
    }
    combined.set(name, { existingOff: dOff });
  }

  for (const [name, bytes] of packEntries) {
    const prev = combined.get(name);
    if (prev?.existingOff !== undefined && name !== 'icudt68l/coll/res_index.res') {
      continue;
    }
    combined.set(name, { bytes });
  }

  const sortedNames = Array.from(combined.keys()).sort();
  const tocBytes = 4 + sortedNames.length * 8;
  let namesBytes = 0;
  for (const name of sortedNames) {
    namesBytes += name.length + 1;
  }

  let cursor = tocBytes + namesBytes;
  while (cursor % 16 !== 0) cursor++;

  let nameCursor = tocBytes;
  hdv.setUint32(hdrSize, sortedNames.length, true);
  for (let i = 0; i < sortedNames.length; i++) {
    const name = sortedNames[i]!;
    const item = combined.get(name)!;
    let dOff = item.existingOff ?? 0;
    if (item.bytes) {
      while (cursor % 16 !== 0) cursor++;
      dOff = cursor;
      heap.set(item.bytes, pos + hdrSize + dOff);
      cursor += item.bytes.byteLength;
    }
    hdv.setUint32(hdrSize + 4 + i * 8, nameCursor, true);
    hdv.setUint32(hdrSize + 4 + i * 8 + 4, dOff, true);
    for (let c = 0; c < name.length; c++) {
      heap[pos + hdrSize + nameCursor + c] = name.charCodeAt(c) & 0x7f;
    }
    heap[pos + hdrSize + nameCursor + name.length] = 0;
    nameCursor += name.length + 1;
  }
}

/**
 * Register an optional ICU `.dat` (or gzip-compressed `.dat.gz`) locale
 * tailoring package with `mod`.
 */
export async function applyIcuLocaleDataToModule(
  mod: FirebirdWasmModule,
  input: Uint8Array | ArrayBufferLike,
): Promise<void> {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isGzipHeader(bytes)) {
    const decompressedStream = decompressGzipStream(createChunkedByteStream(bytes));
    const reader = decompressedStream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let doneReading = false;
    while (!doneReading) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    bytes = merged;
  }

  if (!isValidIcuDataPackage(bytes)) {
    throw new Error(
      'Invalid ICU locale data package: expected an ICU CmnD (.dat) header (magic 0xda 0x27)',
    );
  }

  if (mod.FS) {
    if (!mod.FS.analyzePath('/firebird').exists) {
      mod.FS.mkdir('/firebird');
    }
    if (!mod.FS.analyzePath('/firebird/icu').exists) {
      mod.FS.mkdir('/firebird/icu');
    }
    mod.FS.writeFile(ICU_LOCALE_DATA_PATH, bytes);
  }

  if (typeof mod._fb_load_icu_data === 'function') {
    const ptr = mod._malloc(bytes.byteLength);
    if (ptr === 0) {
      throw new Error(
        `Failed to allocate ${bytes.byteLength} bytes on WASM heap for ICU locale data`,
      );
    }
    try {
      mod.HEAPU8.set(bytes, ptr);
      const rc = mod._fb_load_icu_data(ptr, bytes.byteLength);
      if (rc !== 0) {
        const detail = lastError(mod);
        throw new Error(
          detail
            ? `Failed to load ICU locale data (code ${rc}): ${detail}`
            : `Failed to load ICU locale data (code ${rc})`,
        );
      }
    } finally {
      mod._free(ptr);
    }
    return;
  }

  // Fallback for pre-0.12 WASM binaries without `_fb_load_icu_data`:
  const packEntries = parseCmnDPackage(bytes);
  // If the pack contains coll/<locale>.res entries without a root res_index.res,
  // synthesize a root res_index.res so uloc_countAvailable() discovers them.
  if (!packEntries.has('icudt68l/res_index.res')) {
    const discoveredLocales: string[] = [];
    for (const key of packEntries.keys()) {
      const m = /^icudt68l\/coll\/([a-zA-Z0-9_]+)\.res$/.exec(key);
      if (m && m[1] && m[1] !== 'root' && m[1] !== 'res_index') {
        discoveredLocales.push(m[1]);
      }
    }
    const resIdx = buildResIndexBundle(
      discoveredLocales.length > 0 ? discoveredLocales : DEFAULT_ICU_TAILORING_LOCALES,
    );
    packEntries.set('icudt68l/res_index.res', resIdx);
  }

  const heapPos = findGicuDataInHeap(mod);
  if (heapPos >= 0) {
    injectEntriesIntoHeapSlack(mod.HEAPU8, heapPos, packEntries);
  } else if (mod.FS?.analyzePath(ICU_BASE_DATA_PATH).exists) {
    const baseEntries = parseCmnDPackage(mod.FS.readFile(ICU_BASE_DATA_PATH));
    for (const [k, v] of packEntries) {
      baseEntries.set(k, v);
    }
    mod.FS.writeFile(ICU_BASE_DATA_PATH, buildCmnDPackage(baseEntries));
  }
}
