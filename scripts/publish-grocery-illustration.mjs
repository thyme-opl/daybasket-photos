#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repository, 'grocery-illustrations/manifest.json');
const maximumBytes = 1_500_000;

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/publish-grocery-illustration.mjs --id grocery-id --name "Grocery name" --aliases "alias one|alias two" --image /absolute/file.png [--dry-run]');
  process.exit(2);
}

const values = new Map();
let dryRun = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--dry-run') { dryRun = true; continue; }
  if (!argument.startsWith('--') || index + 1 >= process.argv.length) usage(`Unexpected argument: ${argument}`);
  values.set(argument.slice(2), process.argv[++index]);
}

const id = values.get('id')?.trim();
const name = values.get('name')?.trim().replace(/\s+/g, ' ');
const imagePath = values.get('image') ? resolve(values.get('image')) : '';
const aliases = (values.get('aliases') ?? '').split('|').map(value => value.trim().replace(/\s+/g, ' ')).filter(Boolean);
if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) usage('The ID must be a lowercase slug.');
if (!name || name.length > 80) usage('The grocery name is required and must be at most 80 characters.');
if (!imagePath) usage('An absolute or relative PNG path is required.');
if (aliases.length > 40 || aliases.some(alias => alias.length > 80)) usage('Use at most 40 aliases of 80 characters each.');

const image = await readFile(imagePath).catch(error => usage(`Could not read the PNG: ${error.message}`));
if (!image || image.length < 8 || image.length > maximumBytes) usage(`The PNG must be between 8 and ${maximumBytes} bytes.`);
if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) usage('The image is not a PNG.');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.revision) || !Array.isArray(manifest.ingredients)) usage('The existing manifest is invalid.');
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const uniqueAliases = [...new Map(aliases.map(alias => [normalize(alias), alias])).values()];
const ownership = new Map();
for (const entry of manifest.ingredients) {
  if (entry.id === id) continue;
  for (const phrase of [entry.name, ...entry.aliases]) ownership.set(normalize(phrase), entry.id);
}
for (const phrase of [name, ...uniqueAliases]) {
  const owner = ownership.get(normalize(phrase));
  if (owner) usage(`"${phrase}" already belongs to ${owner}.`);
}

const sha256 = createHash('sha256').update(image).digest('hex');
const asset = `assets/${id}-${sha256.slice(0, 12)}.png`;
const entry = { id, name, aliases: uniqueAliases, asset, sha256, bytes: image.length };
const current = manifest.ingredients.find(value => value.id === id);
if (current && JSON.stringify(current) === JSON.stringify(entry)) {
  console.log(`${id} is already published at revision ${manifest.revision}.`);
  process.exit(0);
}

const next = {
  ...manifest,
  revision: manifest.revision + 1,
  updatedAt: new Date().toISOString(),
  ingredients: [...manifest.ingredients.filter(value => value.id !== id), entry].sort((left, right) => left.name.localeCompare(right.name)),
};
const destination = resolve(repository, 'grocery-illustrations', asset);
if (dryRun) {
  console.log(JSON.stringify({ destination, manifest: next }, null, 2));
  process.exit(0);
}

await mkdir(dirname(destination), { recursive: true });
try {
  const existing = await stat(destination);
  if (existing.size !== image.length) usage(`Refusing to overwrite a different asset at ${destination}.`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await copyFile(imagePath, destination);
}
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
await writeFile(temporaryManifest, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
await rename(temporaryManifest, manifestPath);
console.log(`Published ${name} as ${id}; catalog revision ${next.revision}.`);
