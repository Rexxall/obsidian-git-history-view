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

   The local target file is ignored by Git. It must include every active development Vault. The current machine uses Projects, the second test vault, and the inbox vault; do not commit their absolute paths.
7. Open the plugin in every affected target and complete the feature-specific real Obsidian checks. A successful file copy or hash comparison does not count as UI verification; confirm the installed version, entry points, layout, read-only boundaries, and preservation of local `data.json`.
8. Commit the entire local iteration together. Push, tag, and GitHub Release creation require separate, explicit user approval. Do not add machine-specific paths, credentials, or local Obsidian state.
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

## v0.6.3 local acceptance

- [x] `npm run release:check` passes with 179 tests across 15 files, the production build, `git diff --check`, and package verification.
- [x] `dist/git-note-history-0.6.3.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `b20926d3510ddd56577a59f905bd1588ae90c6cd0b38f877409d0132a3142d07`.
- [x] both test vaults installs match the tracked build and preserve their existing `data.json`.
- [x] Obsidian 1.12.7 checks pass in both Vaults. Projects confirms the command entry and empty recovery workbench on a real note. the second test vault confirms collection from history, property-level collection with ignored blank lines enabled, item metadata, conflict analysis, merged Markdown preview, apply gating, and clean basket removal. No QA item was written into a note.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.0 local acceptance

- [x] `npm run release:check` passes with 185 tests across 16 files, the production build, `git diff --check`, and package verification.
- [x] `dist/git-note-history-0.7.0.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `97f55ae55f6e9fa02258ec6e6f2da4d345114adb875749c1185919d1e638d16f`.
- [x] both test vaults installs match the tracked build, retain their local data, and load schema v4.
- [x] Obsidian 1.12.7 in Projects confirms the historical-sandbox entry, creation from a real full commit, a locked detached worktree, read-only note permissions, the manager card, and first-open guidance without changing the current Vault. the second test vault confirms the entry after a clean application reload.
- [x] Real temporary Git repository tests cover editable upgrade, experiment changes, frozen comparison, recovery-basket collection, new-note no-overwrite copy, binary patch export, archive, deletion, symlink rejection, untrusted markers, capacity limits, and persistence migration.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.2 local acceptance

- [x] `npm run release:check` passes with 205 tests across 19 files, the production build, and package verification.
- [x] `dist/git-note-history-0.7.2.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `c98a5e4145d06fb8d02831eda6081672cf4a23ebe91e939de242bbb44030d9cf`.
- [x] both test vaults installs match the tracked build. Their current `data.json` hashes match the pre-install backups exactly.
- [x] Obsidian 1.12.7 in Projects confirms the sidebar shortcut, relationship playback, type filtering, current-target navigation, frozen exact comparison, and the expandable restore-impact wave without applying a restore. the second test vault confirms a clean reload, the new shortcut, an explicit no-change state, narrow layout, and light/dark rendering.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.3 local acceptance

- [x] `npm run release:check` passes with 215 tests across 21 files, the production build, and package verification.
- [x] `dist/git-note-history-0.7.3.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `ccd41394cb607f0c18c7ef8aac1a71580a81f034bdf2705664a036f9962b7844`.
- [x] both test vaults installs match the tracked build. Their current `data.json` hashes match the pre-install backups exactly.
- [x] Obsidian 1.12.7 in the second test vault confirms 33 block-source cards, filters and an honest empty state, evidence disclosure, frozen read-only source comparison, and immediate `Esc` exit. Projects confirms the history-sidebar shortcut, eight block-source cards, narrow layout, and light/dark rendering.
- [x] Real temporary Git tests confirm Agent trailer evidence, uncommitted and untracked working attribution, review coverage, citation-sync prompts, and unchanged HEAD / status. The live Vaults had no Agent-trailer or uncommitted Markdown fixture, so acceptance did not create a synthetic commit in user history.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.4 local acceptance

- [x] The production build, annotation-focused tests, real Git-notes integration test, and package verification pass.
- [ ] At the exact v0.7.4 commit, the complete Vitest run did not finish: the main-plugin isolation test lacked mocks for the newly imported annotation UI. v0.7.5 adds those mocks and its complete 233-test release check covers the combined v0.7.4 and v0.7.5 source.
- [x] `dist/git-note-history-0.7.4.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `48362ac87391c992d9c21e860506ec177c34b2388a235c6b251497f40d82b326`.
- [x] both test vaults installs match the tracked build. Their pre-load `data.json` hashes match the 0.7.3 installation backups exactly.
- [x] Real temporary Git tests confirm missing-note handling, dedicated-ref writes, preservation of unrelated note text, managed-marker replacement, annotation decoding, and unchanged HEAD / status.
- [ ] Obsidian 1.12.7 checks in both test vaults: commands and menus, current-version and block annotation, historical-version annotation, status editing and deletion, Markdown package copy, Git notes warning, narrow layout, and light/dark rendering.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.5 local acceptance

- [x] `npm run release:check` passes with 233 tests across 25 files, the production build, and package verification. This run includes the v0.7.4 annotation suites and the corrected main-plugin isolation test.
- [x] `dist/git-note-history-0.7.5.zip` contains only `main.js`, `manifest.json`, and `styles.css`; each file matches the tracked build. SHA-256: `0091f6f94e5ccc7c56d41e2f16af623314a0d2036bbfd9f0e09e84d377ef5054`.
- [x] both test vaults installs match the tracked build. Their current `data.json` hashes match the v0.7.4 installation backups exactly.
- [x] Pure tests cover timestamp and generated fields, property ordering, line endings, strict whitespace, YAML comments, substantive changes, ignore-revs, missing content, truncated history, and separate repository-health diagnostics.
- [x] A real repository with a bare upstream confirms ahead / behind and `.git-blame-ignore-revs` detection while HEAD and status remain unchanged.
- [ ] Obsidian 1.12.7 checks in both test vaults: command, file-menu and history shortcuts; diagnostics; balanced / strict / raw profiles; raw revision comparison; settings persistence; narrow layout; and light/dark rendering.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.

## v0.7.6 local acceptance

- [x] `npm run release:check` passes with 235 tests across 26 files, including the timeline style-contract regression.
- [x] `dist/git-note-history-0.7.6.zip` contains only `main.js`, `manifest.json`, and `styles.css`, and matches the tracked build. The initial acceptance archive had SHA-256 `012238bb3415dd1d8048a31b97996ed4cfef578f4a10751ae593ea35ae2fc9e6`; a 2026-07-31 rebuild has SHA-256 `05253998345bb9f8a614bf842def319740ff008f21ed02d6a31a0225fe95dc87` because ZIP entry timestamps are not normalized.
- [x] both test vaults installs match the tracked build. Both pre-upgrade `data.json` files remain in their 0.7.5 installation backups; the second test vault stayed byte-identical, while Projects performed the expected schema-v5-to-v6 migration when Obsidian loaded the plugin.
- [x] Obsidian 1.12.7 in Projects confirms dates, commit subjects, change statistics, and property summaries remain visible under the active theme, including the raw-commit timeline.
- Publication state: local only. Push, tag, and GitHub Release require separate user approval.
