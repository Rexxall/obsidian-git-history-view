# Release process

Every iteration commits the source, documentation, tracked build output, and version metadata together. The matching install archive is generated and verified under the ignored `dist` directory; it is not force-added to the source commit.

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
7. Open the plugin in both both test vaults and complete the feature-specific real Obsidian checks. A successful file copy or hash comparison does not count as UI verification; confirm the installed version, entry points, layout, read-only boundaries, and preservation of local `data.json`.
8. Commit the entire local iteration together. Push, tag, and GitHub Release creation require separate, explicit user approval. Do not add generated attribution, automated co-author trailers, machine-specific paths, credentials, or local Obsidian state.
9. After explicit publication approval, create a GitHub Release whose tag exactly matches `manifest.json`, and attach:

   - `dist/git-note-history-<version>.zip`
   - `main.js`
   - `manifest.json`
   - `styles.css`

10. Download the published assets and verify that their SHA-256 hashes match the local release files.

## Release contents

The install archive must contain exactly:

- `main.js`
- `manifest.json`
- `styles.css`

`dist`, `node_modules`, test caches, editor state, and operating-system metadata are local build content and are not committed to the source repository. Published packages live in GitHub Releases.

## v0.6.1 local acceptance

- [x] `npm run release:check` on 2026-07-30: 10 test files and 124 tests passed; package verification passed.
- [x] `dist/git-note-history-0.6.1.zip` SHA-256: `a6eb7060c1f46d3658cf5e17eeb62cc0142d46ad583b1589835b6819aa4148b4`.
- [x] The archive contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build.
- [x] both test vaults installs match the tracked build and preserve their existing `data.json`.
- [x] Obsidian 1.12.7 checks passed in both Vaults, including command entry, exact and inferred events, current snapshots, explicit resampling, read-only comparison boundaries, responsive layout, and theme behavior.
- Publication state: local only. No push, tag, or GitHub Release was created.

## v0.6.2 local acceptance

- [x] `npm run release:check` passes with 168 tests across 14 files, the production build, `git diff --check`, and package verification.
- [x] `dist/git-note-history-0.6.2.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `d99395657936234950feccefec9307734bdf79058063ad6ea5ea843d95053a44`.
- [x] both test vaults installs match the tracked build and preserve their existing `data.json`.
- [x] Obsidian 1.12.7 checks pass in both Vaults: Projects confirms the sidebar entry, an automatic false-to-true boundary, candidate and verified cards, frozen read-only comparison, and absence of restore controls; the second test vault confirms the entry on a 299-revision note, the 80-version safety cap and scoped conclusion, narrow layout, and light/dark rendering. Automated regressions cover manual correction, repeated and unknown states, stale snapshots, keyboard focus, and open/unload races.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.
