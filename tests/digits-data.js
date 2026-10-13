// Load the packed digit subsets in Node (same format the page fetches).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function load(name) {
  let buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'data', name));
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const magic = buf.toString('latin1', 0, 4);
  if (magic !== 'BLD1') throw new Error('bad magic ' + magic);
  const count = buf.readUInt32LE(4), rows = buf.readUInt32LE(8), cols = buf.readUInt32LE(12);
  const labels = new Uint8Array(buf.buffer, buf.byteOffset + 16, count).slice();
  const images = new Uint8Array(buf.buffer, buf.byteOffset + 16 + count, count * rows * cols).slice();
  return { count, rows, cols, labels, images, image: (i) => images.subarray(i * rows * cols, (i + 1) * rows * cols) };
}

module.exports = { train: () => load('digits-train.bin.gz'), test: () => load('digits-test.bin.gz') };
