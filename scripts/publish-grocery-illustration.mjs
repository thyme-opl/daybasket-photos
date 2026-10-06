#!/usr/bin/env node
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, prepareIllustration, validatePng, verifyImmutableAsset } from './illustration-validation.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(repository, 'grocery-illustrations/manifest.json');
function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/publish-grocery-illustration.mjs --id grocery-id --name "Grocery name" --aliases "alias one|alias two" --image /absolute/file.png [--dry-run]');
  process.exitCode = 2;
}

async function main() {
  const values = new Map(); let dryRun = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--dry-run' && !dryRun) { dryRun = true; continue; }
    if (!['--id', '--name', '--aliases', '--image'].includes(argument) || index + 1 >= process.argv.length
      || values.has(argument.slice(2)) || process.argv[index + 1].startsWith('--')) throw Error(`Unexpected or repeated argument: ${argument}`);
    values.set(argument.slice(2), process.argv[++index]);
  }
  const imagePath = values.get('image') ? resolve(values.get('image')) : '';
  if (!imagePath) throw Error('A PNG path is required.');
  // Read once: the bytes that pass validation are the bytes copied into the immutable asset.
  const image = await readFile(imagePath); validatePng(image);
  const metadata = { id: values.get('id'), name: values.get('name'),
    aliases: (values.get('aliases') ?? '').split('|').map(value => value.trim()).filter(Boolean) };
  let lock;
  const lockPath = `${manifestPath}.lock`, temporaryManifest = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Concurrent writers must re-read the current revision while holding this exclusive lock.
    if (!dryRun) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Error('Another illustration update is active. Verify any stale manifest lock before retrying.'); throw error; }
    }
    const prepared = prepareIllustration(parseManifest(await readFile(manifestPath, 'utf8')), image, metadata);
    const destination = resolve(repository, 'grocery-illustrations', prepared.entry.asset);
    if (!prepared.changed) {
      if (!(await lstat(destination)).isFile()) throw Error('The immutable asset must be a regular file.');
      verifyImmutableAsset(await readFile(destination), image);
      console.log(`${prepared.entry.id} is already published at revision ${prepared.manifest.revision}.`); return;
    }
    if (dryRun) { console.log(JSON.stringify({ destination, manifest: prepared.manifest }, null, 2)); return; }
    await mkdir(dirname(destination), { recursive: true });
    if (await realpath(dirname(destination)) !== dirname(destination)) throw Error('The asset directory must not be a symbolic link.');
    try { await writeFile(destination, image, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(destination)).isFile()) throw Error('The immutable asset must be a regular file.');
      verifyImmutableAsset(await readFile(destination), image);
    }
    await writeFile(temporaryManifest, `${JSON.stringify(prepared.manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryManifest, manifestPath);
    console.log(`Published ${prepared.entry.name} as ${prepared.entry.id}; catalog revision ${prepared.manifest.revision}.`);
  } finally {
    if (lock) {
      try { await unlink(temporaryManifest).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally { await lock.close(); await unlink(lockPath); }
    }
  }
}
main().catch(error => usage(error.message));
