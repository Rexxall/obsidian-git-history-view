# Release process

Every iteration keeps the source, documentation, build output, install archive, and version metadata in one commit.

## Required updates

1. Update the implementation and tests.
2. Update `README.md`, `ROADMAP.md`, and `CHANGELOG.md` when behavior or planning changes.
3. Keep the version aligned in `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.
4. Build the plugin and create the matching `git-note-history-<version>.zip` archive:

   ```bash
   npm run package:release
   ```

5. Validate the complete release surface:

   ```bash
   npm run release:check
   ```

6. Commit and push the entire iteration together. Do not add generated attribution, automated co-author trailers, machine-specific paths, credentials, or local Obsidian state.

## Release contents

The install archive must contain exactly:

- `main.js`
- `manifest.json`
- `styles.css`

`node_modules`, test caches, editor state, and operating-system metadata are not release content.
