# Release process

Every iteration keeps the source, documentation, build output, install archive, and version metadata in one commit.

## Required updates

1. Update the implementation and tests.
2. Update `README.md`, `ROADMAP.md`, and `CHANGELOG.md` when behavior or planning changes.
3. Keep the version aligned in `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.
4. Build the plugin and create the matching `dist/git-note-history-<version>.zip` archive:

   ```bash
   npm run package:release
   ```

5. Validate the complete release surface:

   ```bash
   npm run release:check
   ```

6. Install and verify the release in every local target listed in `.local-install-targets.json`:

   ```bash
   npm run install:local
   ```

   The local target file is ignored by Git. It must include the active both test vaults vault plugin directories on the development machine.
7. Commit the entire local iteration together. Push, tag, and GitHub Release creation require separate, explicit user approval. Do not add generated attribution, automated co-author trailers, machine-specific paths, credentials, or local Obsidian state.
8. After explicit publication approval, create a GitHub Release whose tag exactly matches `manifest.json`, and attach:

   - `dist/git-note-history-<version>.zip`
   - `main.js`
   - `manifest.json`
   - `styles.css`

9. Download the published assets and verify that their SHA-256 hashes match the local release files.

## Release contents

The install archive must contain exactly:

- `main.js`
- `manifest.json`
- `styles.css`

`dist`, `node_modules`, test caches, editor state, and operating-system metadata are local build content and are not committed to the source repository. Published packages live in GitHub Releases.
