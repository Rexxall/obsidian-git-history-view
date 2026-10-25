# Git Note History

**See how a note changed, and take back only the part you need.**

在 Obsidian 里查看一篇笔记的 Git 历史，比较任意两个版本，只把需要的那一段、那一块或整篇安全地取回来。

> Desktop only. Your vault has to be inside a Git repository (for example one kept by the Obsidian Git plugin or a daily backup script). This plugin only *reads* Git; it never commits, pushes, checks out or resets.

## Why

Daily Git backups mean every old version of a note is still there. The problem is getting one line back: restoring a whole file overwrites everything written since. Git Note History treats a note's history as something to read and pick from, not something to roll back wholesale.

- **Timeline** of the current note in the right sidebar, grouped by day, with `+/-` counts and milestones you name yourself (*sent*, *submitted*, *confirmed*).
- **Compare** any two versions: side by side, unified diff, rendered Markdown changes, two previews, or a structure view that understands YAML properties, headings, lists, tasks, tables, callouts, code and wiki links.
- **Restore just a part.** Bring back a paragraph, a change block, or several blocks collected from different versions, after a preview that shows the merged result and any links that would break.
- **Safe writes.** Right before writing, the note is compared with what you saw; if it changed in between, the restore stops. Every restore can be undone (12 steps), and undo also stops if you have edited since.
- **Conflict resolver** for Git merge conflicts in a note, three panes, writes only the working file.
- **Paragraph history** for the paragraph under the cursor, including versions where it was later deleted.
- **Search old content**: find a sentence that used to exist, see when it appeared and when it was removed, and open the versions on either side.

### Lab tools

Behind a single switch in settings (*Show lab tools*) are the more experimental views: a review inbox for changed notes, work-event view across files, knowledge-boundary tracing, content-age lens, provenance lens that reads commit trailers, version annotations, history health checks, knowledge-graph playback, historical sandboxes (read-only time capsules of the whole vault at a commit), and a map of every history source (Git, local snapshots, File Recovery, Sync). They are off by default so the command palette stays short.

The full feature list, in Chinese, is in [docs/FEATURES_zh.md](docs/FEATURES_zh.md).

## Quick start

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release and put them in `<vault>/.obsidian/plugins/git-note-history/`.
2. Enable **Git Note History** in *Settings → Community plugins*.
3. Open a Markdown note and run **Open Git history of the current note** (command palette, ribbon icon, or the file menu).
4. Click a version to compare it with the current note. In the comparison, hover a change block and choose *Restore this block*, or use *Recovery basket* to collect blocks from several versions first.

Looks: follows your Obsidian theme by default. Settings → 显示 → 纸与墨外观 switches on an optional paper-and-ink look (paper surfaces, serif headings, dark red for removed, teal for added), light and dark.

Requirements: Obsidian 1.8 or later on macOS, Windows or Linux; `git` on your PATH (or set the path in settings).

## Safety and privacy

| What the plugin does | What it never does |
|---|---|
| Runs `git log`, `git show`, `git diff`, `git status` and similar read-only commands on your repository | Commit, push, pull, fetch, checkout, reset, revert, stage, or move HEAD |
| Writes to the working file only when you confirm a restore, after re-checking the file | Write anything to the repository on its own |
| Stores milestones, snapshots, undo history and settings in this vault's plugin data | Send anything over the network |
| Reads Obsidian's own File Recovery / Sync only through documented, read-only paths | Open their private databases |

Try it on a test vault first.

## Limits

- Desktop only (it spawns `git`).
- Large repositories: history reads are bounded (default 100 commits per note, configurable); long histories show a clear "more available" state rather than loading forever.
- Shallow or partial clones, LFS pointers and missing objects are reported as such; the plugin does not try to repair them.
- Renames are followed with `git log --follow`; copies and moves detected by Git are shown, heuristics are not invented.

## Development

```bash
npm install
npm run check          # type-check, tests, build
npm run package:release
```

TypeScript + esbuild, tested with Vitest (240 tests). See [RELEASING.md](RELEASING.md) for the release checklist and [CHANGELOG.md](CHANGELOG.md) for versions. Design notes live in [docs/](docs/).

## License

MIT

---

## 中文说明

**这是什么：** 一个 Obsidian 桌面插件。笔记放在 Git 仓库里（比如用 Obsidian Git 或每日备份脚本），它就能在侧栏显示这篇笔记的全部历史版本，任选两个版本比较，并把需要的内容取回来。

**为什么做：** 每天自动备份，旧版本都在；但要找回其中一段时，整篇恢复会冲掉后来写的内容。所以这个插件把“恢复”的单位从整篇改成一段、一个修改块，甚至从不同版本各取一块合并回来。

**安全：** 只读 Git，从不 commit、push、checkout、reset。写回前会再比对一次笔记，中途被改过就停下；每次恢复都能撤销。

**用法：** 把 `main.js`、`manifest.json`、`styles.css` 放进 `<库>/.obsidian/plugins/git-note-history/`，启用插件，打开一篇笔记，运行“打开当前笔记的 Git 历史”。

**实验功能：** 复查收件箱、工作事件、知识边界追踪、来源可信度镜头、版本批注、历史健康中心、知识图谱时间机、历史沙盒等，默认关闭，在设置里打开“显示实验功能”即可使用。完整功能清单见 [docs/FEATURES_zh.md](docs/FEATURES_zh.md)。
