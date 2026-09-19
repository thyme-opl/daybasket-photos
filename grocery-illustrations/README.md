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

Use the same stable `--id` to replace an existing illustration. Do not edit an
already published asset file in place. Old checksum files may remain because
installed apps can still have an older manifest cached.
