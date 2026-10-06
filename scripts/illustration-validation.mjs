import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const maximumBytes = 1_500_000;
const maximumManifestBytes = 128_000;
const normalize = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/^\s*\d+(?:[.,]\d+)?\s*[x×]\s*(?=[a-z])/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const text = (value, maximum) => {
  if (typeof value !== 'string') throw Error('Invalid illustration text.');
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > maximum) throw Error('Invalid illustration text.');
  return clean;
};
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate structure, checksums and the bounded decompressed pixel stream, without editing it. */
export function validatePng(image) {
  if (!Buffer.isBuffer(image) || image.length < 45 || image.length > maximumBytes
    || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('Use a complete PNG of at most 1.5 MB.');
  let offset = 8, header, palette = false, ended = false, dataEnded = false;
  const compressed = [];
  while (offset < image.length) {
    if (offset + 12 > image.length) throw Error('The PNG is truncated.');
    const length = image.readUInt32BE(offset), end = offset + length + 12;
    if (end > image.length) throw Error('The PNG is truncated.');
    const type = image.toString('ascii', offset + 4, offset + 8), chunk = image.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || crc32(image.subarray(offset + 4, end - 4)) !== image.readUInt32BE(end - 4)) throw Error('The PNG has a damaged chunk.');
    if (!header && type !== 'IHDR') throw Error('The PNG is missing its header.');
    if (type === 'IHDR') {
      if (header || length !== 13) throw Error('The PNG header is invalid.');
      const width = chunk.readUInt32BE(0), height = chunk.readUInt32BE(4), depth = chunk[8], color = chunk[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304
        || !depths[color]?.includes(depth) || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] > 1) throw Error('Use a PNG of at most 4 megapixels with valid pixel encoding.');
      header = { width, height, depth, color, interlace: chunk[12], channels: { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color] };
    } else if (type === 'PLTE') {
      if (palette || compressed.length || [0, 4].includes(header.color) || !length || length % 3 || length > 768
        || (header.color === 3 && length / 3 > 2 ** header.depth)) throw Error('The PNG palette is invalid.');
      palette = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (header.color === 3 && !palette)) throw Error('The PNG pixel chunks are invalid.');
      compressed.push(chunk);
    } else if (type === 'IEND') {
      if (length || !compressed.length || end !== image.length) throw Error('The PNG ending is invalid.');
      ended = true;
    } else {
      if (type[0] === type[0].toUpperCase()) throw Error('The PNG uses an unsupported critical chunk.');
      if (compressed.length) dataEnded = true;
    }
    offset = end;
  }
  if (!ended) throw Error('The PNG is incomplete.');
  const passes = header.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.flatMap(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((header.width - x) / dx));
    const height = Math.max(0, Math.ceil((header.height - y) / dy));
    return width && height ? [{ length: Math.ceil(width * header.channels * header.depth / 8) + 1, height }] : [];
  });
  const expected = rows.reduce((sum, row) => sum + row.length * row.height, 0);
  let pixels;
  try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); }
  catch { throw Error('The PNG pixel stream is damaged.'); }
  if (pixels.length !== expected) throw Error('The PNG pixel stream has the wrong size.');
  let rowOffset = 0;
  for (const row of rows) for (let y = 0; y < row.height; y++) {
    if (pixels[rowOffset] > 4) throw Error('The PNG uses an invalid row filter.');
    rowOffset += row.length;
  }
  return { width: header.width, height: header.height };
}

/** Match mobile's ingredientIllustrationCatalog contract before writing a reader-visible revision. */
export function parseManifest(payload) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > maximumManifestBytes) throw Error('The illustration manifest exceeds the app limit.');
  const value = JSON.parse(payload);
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Array.isArray(value.ingredients) || value.ingredients.length > 500 || !Number.isFinite(Date.parse(text(value.updatedAt, 40)))) throw Error('The existing manifest is invalid.');
  const ids = new Set(), owners = new Map();
  for (const entry of value.ingredients) {
    if (!entry || Array.isArray(entry)) throw Error('Invalid illustration entry.');
    const id = text(entry.id, 64);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) throw Error('Invalid or duplicate illustration ID.');
    ids.add(id);
    const name = text(entry.name, 80);
    if (!Array.isArray(entry.aliases) || entry.aliases.length > 40) throw Error('Invalid illustration aliases.');
    const sha256 = text(entry.sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > maximumBytes
      || entry.asset !== `assets/${id}-${sha256.slice(0, 12)}.png`) throw Error('Invalid immutable illustration asset.');
    for (const phrase of [name, ...entry.aliases.map(alias => text(alias, 80))]) {
      const normalized = normalize(phrase), owner = owners.get(normalized);
      if (!normalized || (owner && owner !== id)) throw Error('Illustration aliases must be unique and match the app normalization.');
      owners.set(normalized, id);
    }
  }
  return value;
}

export function prepareIllustration(manifest, image, { id, name, aliases = [] }, now = new Date()) {
  validatePng(image);
  parseManifest(JSON.stringify(manifest));
  id = text(id, 64); name = text(name, 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !Array.isArray(aliases) || aliases.length > 40) throw Error('Invalid illustration metadata.');
  const uniqueAliases = [...new Map(aliases.map(alias => { const clean = text(alias, 80); return [normalize(clean), clean]; })).values()];
  const sha256 = createHash('sha256').update(image).digest('hex');
  const asset = `assets/${id}-${sha256.slice(0, 12)}.png`;
  const entry = { id, name, aliases: uniqueAliases, asset, sha256, bytes: image.length };
  const current = manifest.ingredients.find(value => value.id === id);
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return { changed: false, entry, manifest };
  if (manifest.revision === Number.MAX_SAFE_INTEGER) throw Error('The illustration revision cannot be incremented safely.');
  const next = { ...manifest, revision: manifest.revision + 1, updatedAt: now.toISOString(),
    ingredients: [...manifest.ingredients.filter(value => value.id !== id), entry].sort((left, right) => left.name.localeCompare(right.name)) };
  parseManifest(`${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, entry, manifest: next };
}

export function verifyImmutableAsset(existing, image) {
  if (!existing.equals(image)) throw Error('Refusing to overwrite a different immutable asset.');
}
