// Minimal ZIP writer — "store" method (no compression), enough for the
// Workspace panel's "download folder" action. Zero dependencies; CRC32 and the
// local/central/end records are implemented directly so a generated project can
// be packed and opened by any OS without pulling in a zip library.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time (year 1980+), as ZIP headers expect.
function dosDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  const date = (((dt.getFullYear() - 1980) & 0x7f) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  return { time, date };
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

/**
 * Packs `files` into a ZIP buffer.
 * @param {Array<{ path: string, data: Buffer, mtime?: number }>} files
 *        `path` is the in-archive path, `/`-separated.
 * @returns {Buffer}
 */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.path, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data ?? ''), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(f.mtime || Date.now());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 flag
    local.writeUInt16LE(0, 8);         // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);          // version made by
    centralEntry.writeUInt16LE(20, 6);          // version needed
    centralEntry.writeUInt16LE(0x0800, 8);      // UTF-8
    centralEntry.writeUInt16LE(0, 10);          // method: store
    centralEntry.writeUInt16LE(time, 12);
    centralEntry.writeUInt16LE(date, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(name.length, 28);
    centralEntry.writeUInt16LE(0, 30);          // extra
    centralEntry.writeUInt16LE(0, 32);          // comment
    centralEntry.writeUInt16LE(0, 34);          // disk
    centralEntry.writeUInt16LE(0, 36);          // internal attrs
    centralEntry.writeUInt32LE(0, 38);          // external attrs
    centralEntry.writeUInt32LE(offset, 42);     // local header offset
    central.push(centralEntry, name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

module.exports = { zipStore, crc32 };
