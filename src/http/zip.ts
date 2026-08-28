/**
 * Minimal, dependency-free ZIP writer (store-only, no compression).
 *
 * Sufficient for bundling small JSON/text log files for download. Produces a
 * standard ZIP (local file headers + central directory + end-of-central-
 * directory record) with CRC-32 checksums, readable by any unzip tool.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const idx = (crc ^ (bytes[i] as number)) & 0xff;
    crc = (CRC_TABLE[idx] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time encoding for a given Date (local time). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipEntry {
  /** Path within the archive (forward slashes). */
  readonly name: string;
  readonly data: Uint8Array | string;
}

const encoder = new TextEncoder();

/** ZIP (v2.0, no ZIP64) hard limits — beyond these the 16/32-bit header fields
 *  overflow and silently corrupt the archive, so we fail loudly instead. */
const ZIP_MAX_ENTRIES = 0xffff; // total-entries field is uint16
const ZIP_MAX_UINT32 = 0xffffffff; // size/offset fields are uint32
/** Defense-in-depth caps for the log-export use case (well under the format max). */
const ZIP_ENTRY_LIMIT = 50_000;
const ZIP_TOTAL_BYTES_LIMIT = 512 * 1024 * 1024; // 512 MiB

/** Raised when the archive would exceed a ZIP (or our own) hard limit. */
export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

/** Build a ZIP archive (store method) from the given entries. */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  if (entries.length > ZIP_ENTRY_LIMIT || entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipLimitError(
      `ZIP entry count ${entries.length} exceeds the limit (${Math.min(ZIP_ENTRY_LIMIT, ZIP_MAX_ENTRIES)})`,
    );
  }
  const { time, date } = dosDateTime(now);

  interface Prepared {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }
  const prepared: Prepared[] = [];
  const localChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    // Guard the uint32 header fields: a single file >4GiB, or a local-header
    // offset past 4GiB, would silently wrap and corrupt the archive.
    if (data.length > ZIP_MAX_UINT32) {
      throw new ZipLimitError(`ZIP entry "${entry.name}" is too large for a v2.0 ZIP (>4GiB)`);
    }
    if (offset > ZIP_MAX_UINT32) {
      throw new ZipLimitError("ZIP archive exceeds the 4GiB offset limit (needs ZIP64)");
    }
    if (offset + data.length > ZIP_TOTAL_BYTES_LIMIT) {
      throw new ZipLimitError(`ZIP archive exceeds the ${ZIP_TOTAL_BYTES_LIMIT} byte cap`);
    }
    const crc = crc32(data);

    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0, true); // flags
    dv.setUint16(8, 0, true); // method: 0 = store
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true); // compressed size
    dv.setUint32(22, data.length, true); // uncompressed size
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra length
    header.set(nameBytes, 30);

    prepared.push({ nameBytes, data, crc, offset });
    localChunks.push(header, data);
    offset += header.length + data.length;
  }

  // Central directory.
  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const p of prepared) {
    const rec = new Uint8Array(46 + p.nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, 0x02014b50, true); // central dir signature
    dv.setUint16(4, 20, true); // version made by
    dv.setUint16(6, 20, true); // version needed
    dv.setUint16(8, 0, true); // flags
    dv.setUint16(10, 0, true); // method
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, p.crc, true);
    dv.setUint32(20, p.data.length, true);
    dv.setUint32(24, p.data.length, true);
    dv.setUint16(28, p.nameBytes.length, true);
    dv.setUint16(30, 0, true); // extra
    dv.setUint16(32, 0, true); // comment
    dv.setUint16(34, 0, true); // disk number
    dv.setUint16(36, 0, true); // internal attrs
    dv.setUint32(38, 0, true); // external attrs
    dv.setUint32(42, p.offset, true); // local header offset
    rec.set(p.nameBytes, 46);
    centralChunks.push(rec);
    centralSize += rec.length;
  }

  const centralOffset = offset;

  // End of central directory.
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // disk
  edv.setUint16(6, 0, true); // cd start disk
  edv.setUint16(8, prepared.length, true); // entries on disk
  edv.setUint16(10, prepared.length, true); // total entries
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true); // comment length

  // Concatenate everything.
  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(eocd, pos);
  return out;
}
