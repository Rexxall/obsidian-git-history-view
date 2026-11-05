<p align="right"><a href="README_zh.md">中文</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-dark.svg">
  <img src="assets/readme/hero-light.svg" width="100%" alt="Git Note History: find the sentence you deleted, see which commit removed it, and take back only that part.">
</picture>

<p align="center"><a href="https://community.obsidian.md/plugins/git-note-history"><b>Install from Obsidian</b></a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/demo-dark.gif">
  <img src="assets/readme/demo-light.gif" width="100%" alt="Typing “one afternoon empty” into the history sidebar of a note. The content trail shows when the sentence first appeared and which commit deleted it, then that commit opens next to the current note with the removed lines in red.">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/cards-dark.svg">
  <img src="assets/readme/cards-light.svg" width="100%" alt="Search the past: find what you deleted, and when. Compare any two: side by side, or heading by heading. Take back one part: preview first, undo any time.">
</picture>

## Start in three steps

1. Install **Git Note History** from *Settings → Community plugins → Browse* and enable it.
2. Open a note and click the clock icon in the ribbon.
3. Pick a version and choose *Compare with current*.

No Git yet? Run **See an example (no repository needed)** from the command palette.

**Needs** Obsidian 1.13+ on desktop, Git installed, and a vault inside a Git repository. **Costs** nothing: no account, no network, no telemetry. It only reads Git and never commits for you.

## Everything else

<details>
<summary><b>Every feature</b></summary>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/restore-dark.png">
  <img src="assets/readme/restore-light.png" width="100%" alt="The restore preview lists every structure change and the links that would be removed before anything is written.">
</picture>

- **Timeline** of the current note in the right sidebar, grouped by day, with `+/-` counts and milestones you name yourself (*sent*, *submitted*, *confirmed*). Pick a version, then *Compare with current* or *Restore this version* from the bar at the bottom.
- **Compare** any two versions: side by side, unified diff, rendered Markdown changes, two previews, or a structure view that understands properties, headings, lists, tasks, tables, callouts, code and wiki links. A narrow pane switches to the unified diff by itself.
- **Restore just a part.** Bring back a paragraph, a change block, or several blocks collected from different versions, after a preview that shows the merged result and any links that would break.
- **Safe writes.** Right before writing, the note is compared with what you saw; if it changed in between, the restore stops. Every restore can be undone (12 steps), and undo also stops if you have edited since.
- **Conflict resolver** for Git merge conflicts in a note, three panes, writes only the working file.
- **Paragraph history** for the paragraph under the cursor, including versions where it was later deleted.
- **Search old content**: find a sentence that used to exist, see when it appeared and when it was removed. A long search shows its progress and can be stopped.
- **Status bar**: how long ago the active note was last committed, with a dot when it has uncommitted edits.
- **Version links**: *Copy version link* in a version's menu; clicking the link later opens that version against the current note.

Lab tools (review inbox, work events, knowledge tracing, provenance lens, annotations, history health, knowledge-graph playback, historical sandboxes, history sources) sit behind *Show lab tools* in settings and are off by default. The full feature list, in Chinese, is in [docs/FEATURES_zh.md](docs/FEATURES_zh.md).

</details>

<details>
<summary><b>Safety, privacy and what the plugin touches</b></summary>

| What the plugin does | What it never does |
|---|---|
| Runs `git log`, `git show`, `git diff`, `git status` and similar read-only commands | Commit, push, pull, fetch, checkout, reset, revert, stage, initialise a repository, or move HEAD |
| Writes to the working file only when you confirm a restore, after re-checking the file | Write anything to the repository on its own |
| Stores milestones, snapshots, undo history and settings in this vault's plugin data | Send anything over the network |

**Network:** none. Every Git call runs with `GIT_NO_LAZY_FETCH=1` and `GIT_OPTIONAL_LOCKS=0`, so reading history never fetches from a remote or rewrites the index.

**Files outside the vault:** the repository may start in a folder above your vault; the plugin reads it with `git`. The lab tool *historical sandboxes* writes copies of an old vault state to a per-user application data folder (`~/Library/Application Support/Git Note History` on macOS, `%LOCALAPPDATA%\Git Note History` on Windows, `~/.local/share/git-note-history` on Linux), only when you create a sandbox. Nothing else outside the vault is read or written.

#### What the plugin touches

The community directory's scorecard lists two warnings and two other items for this plugin. None of them touches the network.

| Scorecard item | Why it is needed | Where it is used |
|---|---|---|
| **Shell Execution** (`child_process`) | Git history lives in the repository, not in the vault, so the plugin starts the `git` program you set in the settings. It calls `git` directly with a list of arguments, never through a shell, so nothing in a note or file name can run as a command. | Reading history (`git log`, `show`, `diff`, `status`, `blame`), and the lab tool *historical sandboxes*, which also runs `git worktree` to check out an old state. |
| **Direct Filesystem Access** (`fs`) | The vault API cannot see folders above the vault, where the repository may start. | Resolving the repository folder and checking that a moved repository still exists; and, only when you create a historical sandbox, writing and later removing its copy in the application data folder named above. |
| **Vault Enumeration** (`getMarkdownFiles`) | Restoring an old version can remove a heading or block that other notes link to. To warn you, the plugin looks through the link index Obsidian already keeps for every note. | The restore preview's link check, and the backlink counts in the *Link impact* view. Only links are read from Obsidian's cache, not note contents. |
| **Clipboard Access** | Copy buttons. The plugin only writes to the clipboard and never reads it. | Only when you click a copy button: a version link, a commit hash, a block or a whole version's text, a restore result, a file path, or a review pack. |

</details>

<details>
<summary><b>No Git yet? Start one</b></summary>

Git Note History reads history that already exists. To start one:

1. Install Git from [git-scm.com](https://git-scm.com/downloads).
2. Either install the Obsidian Git community plugin and follow its setup, or open a terminal in your vault folder and run `git init`, then `git add -A` and `git commit -m "First snapshot"`.
3. Commit again whenever you want a version you can come back to. Obsidian Git can do this on a timer.

The plugin itself never runs any of these commands for you.

</details>

<details>
<summary><b>Language and themes</b></summary>

The whole interface, lab tools included, follows Obsidian's language: Chinese, or English for every other language.

Colours, radii and spacing come from your theme's variables, and styles only apply inside the plugin's own views. Checked in light and dark mode with Default, Minimal, Blue Topaz and AnuPpuccin, including a narrow sidebar, the side-by-side diff (line numbers, horizontal space, long paths) and dropdowns. *Reduce transparency* and *Reduce motion* are respected.

</details>

<details>
<summary><b>Limits</b></summary>

- Desktop only (it runs `git`).
- History reads are bounded (100 commits per note by default, configurable).
- Shallow or partial clones, LFS pointers and missing objects are reported as such; the plugin does not try to repair them.
- Renames are followed with `git log --follow`.

</details>

<details>
<summary><b>Development and verifying a release</b></summary>

```bash
npm ci
npm run check          # type-check, build, official lint, tests
npm run package:release
```

TypeScript + esbuild, tested with Vitest and linted with the official `eslint-plugin-obsidianmd` rules. See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and reporting issues, [RELEASING.md](RELEASING.md) for the release checklist and [CHANGELOG.md](CHANGELOG.md) for versions.

From 0.12.1 on, the release files carry a GitHub build attestation; check one with `gh attestation verify main.js -R Rexxall/obsidian-git-history-view`.

</details>

MIT License
