import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { crc32, parseManifest, prepareIllustration, validatePng, verifyImmutableAsset } from './illustration-validation.mjs';

function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
  return output;
}
const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))), chunk('IEND', Buffer.alloc(0))]);
const manifest = { schemaVersion: 1, revision: 1, updatedAt: '2026-09-19T00:00:00.000Z', ingredients: [] };
const metadata = { id: 'poppy-seeds', name: 'Poppy seeds', aliases: ['khus khus', 'gasagasalu'] };

test('complete PNG validates, while signature-only, truncated and damaged images fail', () => {
  assert.deepEqual(validatePng(png), { width: 1, height: 1 });
  assert.throws(() => validatePng(png.subarray(0, 8)));
  assert.throws(() => validatePng(png.subarray(0, -1)));
  const damaged = Buffer.from(png); damaged[damaged.length - 15] ^= 1;
  assert.throws(() => validatePng(damaged), /damaged/);
});
test('invalid compressed stream and oversized dimensions fail before any file writes', () => {
  const malformed = Buffer.concat([png.subarray(0, 33), chunk('IDAT', Buffer.from('invalid zlib')), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => validatePng(malformed), /pixel stream/);
  const oversized = Buffer.from(header); oversized.writeUInt32BE(4097);
  assert.throws(() => validatePng(Buffer.concat([png.subarray(0, 8), chunk('IHDR', oversized), png.subarray(33)])), /megapixels/);
});
test('prepared metadata uses stable checksum paths and increments exactly once', () => {
  const prepared = prepareIllustration(manifest, png, metadata, new Date('2026-09-30T00:00:00Z'));
  assert.equal(prepared.manifest.revision, 2);
  assert.equal(prepared.entry.asset, `assets/poppy-seeds-${prepared.entry.sha256.slice(0, 12)}.png`);
  assert.equal(prepared.entry.bytes, png.length);
  assert.equal(parseManifest(JSON.stringify(prepared.manifest)).ingredients.length, 1);
  assert.equal(prepareIllustration(prepared.manifest, png, metadata).changed, false);
  assert.equal(manifest.ingredients.length, 0);
});
test('validation matches app normalization for diacritics and rejects unmatchable aliases', () => {
  const first = prepareIllustration(manifest, png, { id: 'cafe', name: 'Café', aliases: [] });
  assert.throws(() => prepareIllustration(first.manifest, png, { id: 'another', name: 'Cafe', aliases: [] }), /unique/);
  assert.throws(() => prepareIllustration(manifest, png, { ...metadata, aliases: ['తెలుగు'] }), /normalization/);
  const deduplicated = prepareIllustration(manifest, png, { ...metadata, aliases: ['KHUS KHUS', 'khus-khus'] });
  assert.equal(deduplicated.entry.aliases.length, 1);
});
test('IDs, duplicate manifest entries, unsafe revisions and UTF-8 limits fail closed', () => {
  assert.throws(() => prepareIllustration(manifest, png, { ...metadata, id: '../escape' }));
  assert.throws(() => prepareIllustration({ ...manifest, revision: Number.MAX_SAFE_INTEGER }, png, metadata), /safely/);
  const entry = prepareIllustration(manifest, png, metadata).entry;
  assert.throws(() => parseManifest(JSON.stringify({ ...manifest, ingredients: [entry, entry] })), /duplicate/);
  assert.throws(() => parseManifest(JSON.stringify({ ...manifest, padding: 'é'.repeat(70_000) })), /limit/);
});
test('same byte length never permits different immutable content', () => {
  assert.throws(() => verifyImmutableAsset(Buffer.from('aaaa'), Buffer.from('bbbb')), /immutable/);
  assert.doesNotThrow(() => verifyImmutableAsset(png, Buffer.from(png)));
});
