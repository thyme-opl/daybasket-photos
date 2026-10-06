# Grocery illustrations

Day Basket reads `manifest.json` at app launch, whenever the app returns to the
foreground, and every five minutes while it is active. Images use immutable,
checksum-based names, so adding or replacing an illustration updates carts
without requiring a new app release.

## Publish an approved PNG

From the `daybasket-photos` repository:

```sh
node scripts/publish-grocery-illustration.mjs \
  --id poppy-seeds \
  --name "Poppy seeds" \
  --aliases "khus khus|gasagasalu" \
  --image /absolute/path/to/poppy-seeds.png
```

The script verifies the PNG, copies it to an immutable asset path, updates the
catalog entry, and increments the revision. Review the image and manifest diff,
then commit and push both together. Existing cart rows saved with the generic
illustration are re-matched from their grocery name after the new revision loads.

Use `--dry-run` to validate and inspect the proposed revision without writing.
PNG files must be complete, at most 1.5 MB and 4 megapixels, with neither dimension
above 4096. The validator checks chunk checksums, encoding and the decompressed
pixel stream. IDs, aliases and manifest size must also meet the app's contract.
Alias matching removes accents and uses ASCII shopping words, matching the app.

Updates hold an exclusive `manifest.json.lock` so concurrent writers cannot lose
a revision. If a process stops unexpectedly, verify no publisher is running before
removing a stale lock. Existing immutable files are compared by their actual bytes.

Run pure validation regression tests without publishing:

```sh
node --test scripts/illustration-validation.test.mjs
```

Use the same stable `--id` to replace an existing illustration. Do not edit an
already published asset file in place. Old checksum files may remain because
installed apps can still have an older manifest cached.
