# Changelog

## 0.11.0 — 2026-10-30

- **Why there is no history:** the sidebar tells apart a vault outside any Git repository, a repository without commits, a note Git does not track, a note excluded by an ignore rule (naming the rule), a staged but uncommitted note, a missing Git program and a note outside the detected repository. Each case offers one read-only next step; the plugin still never initialises a repository or commits.
- **Example:** new command *See an example (no repository needed)*, also in the sidebar menu and offered when there is no Git history: three pre-written versions of a note, compared side by side or unified and restored in memory, marked as a demo.
- **Stop and retry:** reading history and searching past content can be stopped; a stopped read offers *Read again*.
- **English interface:** the timeline, compare and restore views, conflict resolver, paragraph history, milestones, errors and empty states follow Obsidian's language. Lab views stay in Chinese for now.
- **Themes:** checked with Default, Minimal, Blue Topaz and AnuPpuccin in light and dark. Added and removed counts, status labels and date groups are now readable on light themes; the view title no longer takes the theme's heading colour and is hidden in a narrow sidebar instead of wrapping; the buttons at the bottom of the sidebar wrap instead of being cut off; the selected version in the example is highlighted inside dialogs.
- **README:** English and Chinese versions with new screenshots, a "Starting with Git" section, and what the plugin needs and costs up front.
- **Toggles:** the switch thumb sits 2px from every edge when off, on and pressed. Sizes now go through Obsidian's own toggle variables instead of overriding the thumb's position, and pressing stretches the thumb sideways inside the track instead of growing past it.

## 0.10.0 — 2026-10-29

- **Status bar:** shows how long ago the active note was last committed, with a dot when it has uncommitted edits and a warning when it has a merge conflict. Click it to open the timeline. Can be turned off in settings.
- **Compare with last commit:** new command that opens the current note against its last commit in one step.
- **Version links:** *Copy version link* in a version's menu copies a Markdown link (`obsidian://git-note-history?...`). Clicking it later opens that version against the current note.
- Commands, ribbon tooltips, file-menu items and the settings page follow Obsidian's language: Chinese, or English for every other language.
- Settings: general options sit at the top without a heading, as the Obsidian guidelines ask.
- Community directory readiness: the code passes the official `eslint-plugin-obsidianmd` rules (`npm run lint`, now part of `npm run check`); views are no longer detached on unload, so they keep their place after an update; the config folder comes from `Vault#configDir` instead of assuming `.obsidian`; SVG graphs use `createSvg`.
- README discloses network use (none) and when files outside the vault are read or written.
- **New look:** an Apple-style glass interface, shared with the author's other plugins. Content (timeline, cards, diffs, settings) is solid; the sidebar header, the compare toolbar and every dialog are glass with a light edge. Buttons are capsules, view switches are segmented controls, settings are grouped lists. Everything is derived from the theme's variables and accent colour; *Reduce transparency*, *Increase contrast* and *Reduce motion* are respected.
- **Quieter sidebar:** the header keeps only an *All | Milestones* switch and a "…" menu (follow note, refresh, review point, time machine, raw commits, recovery basket). The selected version is a solid accent row, and a glass bar at the bottom offers *Compare with current* and *Restore this version*. A pending review shows as one row above the list instead of a card.
- **Simpler compare toolbar:** one row with *Side by side | Unified*, *More* and *Restore*; reading, preview, structure and link views, filters, recovery basket and focus mode moved into *More*.
- The optional *Paper and ink* look and its setting are removed; the plugin follows Obsidian's light and dark mode.
- With *Increase contrast*, the faintest text (date groups, the search placeholder) is shown at secondary strength.
- `main.js` is no longer committed; it is the output of `npm run build` and is attached to each release.
- Settings use Obsidian's declarative settings (1.13), so every option shows up in settings search. Delete and clear buttons use `setDestructive`; other confirmations are plain primary buttons.
- Upgrading keeps everything from 0.7.x: settings, local snapshots and review states load unchanged; review states saved under another computer's vault path move to this vault once; the old bookmark copy of milestones (kept only for downgrades) is dropped, and v1 bookmarks still become milestones.
- Minimum Obsidian version is now 1.13.0.

## 0.9.0 — 2026-10-26

- Rewrote the stylesheet from scratch. The sidebar, compare view, restore modals and settings now take every colour, radius and spacing from Obsidian's theme variables, so the plugin follows the active theme in light and dark. The old hard-coded palette layer is gone.
- Optional **Paper & ink** look (settings → 显示 → 纸与墨外观): paper surfaces, serif headings, thin ink lines, dark red for what was removed or will be taken back, teal for what was added or kept. Off by default; works in dark mode.
- Timeline is a thin line with dots instead of cards; row actions appear on hover; the full-row button is an invisible overlay, so no `!important` is needed anywhere (17 → 0).
- Sidebar “more” menu is grouped (find changes / find sources / maintenance) and only shows lab tools when they are enabled; plugin settings moved into it. A footer states the three rules: read-only Git, preview before writing back, undo last.
- Settings page is grouped into 基本 / 显示 / 实验功能 / 历史信噪比; the jump-to select is gone.
- Styles are built from `styles/core.css`, `styles/paper.css` and `styles/lab.css` into `styles.css` (9,811 → 8,322 lines). Lab views keep their previous rules in `styles/lab.css` and migrate view by view.

## 0.8.0 — 2026-10-25

- Lab tools (review inbox, work events, knowledge tracing, provenance lens, annotations, history health, knowledge-graph playback, sandboxes, history sources) are now behind a single **Show lab tools** setting, off by default; command ids and hotkeys are unchanged.
- Git commands time out after 120 seconds with a clear message instead of spinning forever.
- An invalid "max commits" setting falls back to 100 instead of breaking the timeline.
- Added a regression test that documents selective restore: only the deleted paragraph comes back, text written later stays.
- README rewritten; the full Chinese feature list moved to `docs/FEATURES_zh.md`.

## 0.7.7 — 2026-09-19

- Add a direct plugin-settings toolbar entry and keyboard-accessible setting jump navigation.

- Group secondary history tools under a labeled menu while keeping follow, basket, refresh, and main-view actions visible.
- Preserve theme-compatible timeline cards and improve keyboard focus.
- Restore complete Git read-only and semantic-diff implementations from the committed baseline; all 235 regression tests pass.

## 0.7.6

- Fixed timeline cards becoming blank gray bars under themes that override the background of the full-row activation button.
- The invisible activation layer now explicitly resets native and theme button decoration, while timeline text and rail content render above it.
- Added a style-contract regression test for both transparency and stacking order.

## 0.7.5

- Added a central read-only history health center with command-palette, file-menu, and history-sidebar entry points.
- The signal view classifies exact duplicates, configured maintenance properties, generated properties, line-ending/trailing-space/property-order changes, strict whitespace-only formatting, `.git-blame-ignore-revs` references, substantive content, and unreadable versions with a reason for every decision.
- Balanced, strict, and raw-Git profiles are stored per Vault. Ignored and generated Frontmatter field lists are editable in settings; comments beside ignored fields remain significant and cannot be silently filtered.
- Raw Git revisions are always one click away. Filtering changes only the health view and never rewrites commits, blame, the normal timeline, or saved note content.
- Repository health reports shallow and partial clones, missing reachable objects for the note, LFS pointer content, bounded history windows, upstream absence, ahead/behind state, uncommitted work, plugin-local snapshots, object format, and ignore-revs availability.
- Every diagnostic distinguishes evidence from a scoped limitation and offers a read-only repair suggestion. The plugin does not fetch, pull LFS, stage, commit, push, change remotes, or configure upstreams.
- Signal inspection reads at most 120 revisions with a 2 MB content limit per version and preserves unreadable or truncated boundaries as unknown instead of treating them as noise.

## 0.7.4

- Added a central per-note annotation workbench and commands for annotating either the current working version or the Markdown block under the cursor/selection without changing the note or commit.
- Historical commit menus can now attach whole-version annotations. Every annotation records the repository, current and historical paths, exact version identity, original block context, status, and timestamps.
- Annotation status moves explicitly between pending, resolved, and no-action. Block annotations first relocate by exact content fingerprint, then by a conservative Markdown structure/content match; failed relocation keeps the original context visible.
- Added a readable Markdown review-package export to the clipboard for external review and handoff.
- Added optional, confirmed Git notes synchronization through the dedicated `refs/notes/git-note-history-review` ref. Managed data is bounded by markers, unrelated note text is preserved, existing annotations are merged by ID and timestamp, and the UI warns that ordinary `git push` does not normally transfer notes.
- Persisted data now uses schema v6, validates malformed annotations, enforces global and per-file limits, and migrates annotation paths on file or folder rename.

## 0.7.3

- Added a temporary block-level provenance lens with a direct history-sidebar shortcut, file-menu entry, command-palette entry, search, focused filters, and immediate `Esc` exit.
- Current Markdown blocks use frozen-content `git blame --line-porcelain` evidence and retain explicit working or unknown states instead of inventing authorship when blame is unavailable.
- Sources are classified as human, Agent, automation, script, working tree, or unknown. Existing `Agent`, `Authority`, `Send-Gate`, and `Workflow-Status` trailers remain visible as evidence and never become a correctness score.
- Existing local review checkpoints now identify Agent, automation, script, and working blocks not yet covered by human review; users may explicitly mark the current frozen content reviewed without changing the note or Git.
- When a matched block's prose changes while its existing link, embed, attachment, or footnote set remains identical, the lens raises a citation-sync review prompt rather than claiming the citation is wrong.
- Analysis is limited to 2 MB and 240 commits, validates the working content and Git state before and after blame, and opens source comparisons in frozen read-only mode.

## 0.7.2

- Added a central knowledge-graph time machine that analyzes up to 80 chronological note versions and keeps only boundaries where links, embeds, attachments, tags, or footnotes actually changed.
- Added playback, previous/next navigation, relationship-type filters, a focused local graph, a compact event rail, direct target opening, and frozen comparison of the selected relationship boundary.
- Attachment embeds and footnote references are now distinct relationship types; anchored links retain their heading or block subpath instead of being flattened.
- Restore previews now calculate a Vault-aware impact wave: restored relationships, unresolved historical targets, missing attachments, inbound links or embeds to removed headings and blocks, and references through aliases that the restored version removes.
- Relationship analysis remains bounded and read-only. Oversized, excessive, or unreadable historical versions stay visible as explicit gaps, and no change is inferred across them.

## 0.7.1

- Added a pluggable history-source bus with explicit capabilities, access mode, confidence, retention, and provider-boundary metadata.
- Added a central source view that keeps Git commits, the current workspace, plugin-local snapshots, File Recovery, and Obsidian Sync visibly distinct instead of flattening unlike histories into one false timeline.
- Directly readable Git and local-snapshot versions share one chronological comparison list; one failing source no longer hides the other available sources.
- Added manual plugin-local snapshots with content deduplication, fingerprint validation, rename migration, per-file and global capacity limits, comparison, recovery-basket collection, and confirmed deletion.
- File Recovery and Sync remain provider-managed handoffs. The plugin does not inspect their private stores or claim that unavailable version metadata was read.

## 0.7.0

- Added isolated historical Vault capsules backed by locked, detached Git worktrees; creating one never checks out or rewrites the current Vault.
- Historical capsules start with operating-system read-only note content, a persistent identity banner, and a rebuilt minimal `.obsidian` configuration that disables historical community plugins and loads only the current Git Note History bundle.
- Added a central sandbox manager for integrity checks, explicit editable upgrades, active and archived lifecycle states, missing or untrusted record handling, patch export, and guarded deletion.
- Added a safe first-open flow that respects Obsidian's registered-Vault limitation, plus direct URI opening after registration.
- Editable sandbox Markdown can be compared against the current note as a frozen experiment; selected hunks or YAML properties go through the existing recovery basket, while new notes require an explicit no-overwrite copy confirmation.
- Added schema v4 persistence, duplicate-creation coalescing, active and total sandbox limits, symlink and path-boundary checks, 2 MB Markdown read limits, and real-repository lifecycle regression tests.

## 0.6.3

- Added a central recovery basket that collects change hunks and individual YAML properties from multiple Git versions of the same note.
- Added frozen-baseline planning, overlap and property conflict detection, duplicate handling, relation-removal warnings, and a full final Markdown preview.
- Added one-write apply with confirm-time revalidation, restore receipts, concurrency protection, and undo support.
- Added basket shortcuts in the history sidebar and comparison toolbar, plus local schema v3 persistence with malformed-data isolation.

## 0.6.2

- 新增独立的中央“知识边界追踪”工作台，用明确声明回答一句话、属性、关系、Markdown 结构或规则从哪一版开始成立、失效或反复变化，不再只按关键词出现次数猜测。
- 支持文本包含、不包含与精确匹配；YAML 属性支持存在、缺失、等于和包含，并区分字符串、数字、布尔、空值、列表和对象。
- 支持 Wikilink、Markdown 链接、嵌入和标签关系，以及 ATX 标题、任务、围栏代码块、Callout、表格和公式；注释、行内代码与代码围栏中的示例不会被当成真实结构或关系。
- 提供 Frontmatter 有效、无冲突标记和正文非空三项内置规则；每个自动结果均保留可展开的判断依据或说明，不执行用户脚本。
- 所有版本统一使用成立、不成立和未知三态。缺失对象、Vault 边界、大文件、总读取上限、解析失败或并发变化均保持未知，不会被相邻版本填补。
- 自动追踪先按二分顺序定位候选，再逐版验证完整读取区间；界面分别显示二分探测次数与最终验证版本数。只有全程可判断且恰好一次转变时才称为已确认边界。
- 反复出现、删除后重现和多次规则破坏会显示每一次状态转变；稳定历史、全部未知、未知间隙和截断读取均使用独立结论，不把局部结果冒充完整历史。
- 新增人工逐版判断流程，一次突出一个冻结版本，可标记成立、不成立或未知并随时修正；人工结论始终称为人工候选，不会伪装成自动确认。
- 版本时间线按连续状态折叠，候选、已验证端点和每次转变保持独立；证据和说明按需展开，窄窗口自动重排，判断后焦点会移动到下一项。
- 当前工作区正文、HEAD、分支和状态在追踪开始时冻结并复核；之后的修改、重命名或删除只会把结果标记为过期，重新追踪前不会替换原采样。
- Git 历史按第一父链和 rename 连续路径从旧到新排列，不使用作者时间重排。已提交、暂存及内容完全一致的单一未暂存重命名均可延续旧路径；歧义或已修改的移动不会被猜测。
- 普通笔记只查询当前路径的 Git 状态；只有需要确认精确未暂存重命名时才在有上限的条件下检查删除候选，避免大型 backup 或未跟踪目录拖慢日常追踪。
- 边界卡可打开使用本次采样正文的冻结只读对比；即使原笔记随后重命名或删除，仍可检查当时的两端内容。只读页不提供恢复、另存或里程碑编辑。
- 所有 Git 调用禁用可选锁和 partial-clone 懒取；知识追踪不调用 `git bisect`、checkout、reset 或写入式命令，不移动 HEAD、修改索引或写入对象库。
- 自动化测试增加到 168 项，包含纯算法、界面租约和真实临时 Git 仓库回归，覆盖第一父链、提交与工作区重命名、SHA-1 / SHA-256、冻结并发、未知间隙、重复转变、读取上限、Vault 物理边界、卸载竞态和人工判断修正。
- 已在 两个测试库 的 Obsidian 1.12.7 中完成真实入口、确认边界、冻结只读对比、299 次历史的受限读取、窄栏和深浅主题验收；安装前后的 `data.json` 保持一致。

## 0.6.1

- 新增独立的中央“工作事件”页，以三种只读来源查看跨文件上下文：精确的单个 Git commit、明确标注为推测的连续自动备份会话，以及打开时采样的当前未提交工作。
- 从单篇笔记版本可进入同一 Git commit 涉及的全部 Vault 内笔记、Canvas、附件与配置文件，不再把一次工作拆成互不相干的单文件历史。
- 自动备份可按第一父链、同一作者和最多 45 分钟间隔推测为跨文件编辑会话；最多合并 12 个 commit，遇到手动提交、合并提交或当前笔记的命名里程碑即停止，并始终明确标注“推测”。
- 当前未提交工作使用打开时快照，不虚构开始时间；页面提供显式重新采样，普通全局刷新不会悄悄改变正在审阅的快照。
- 文件列表把当前笔记、需要留意、其他笔记、附件和配置分层显示；技术文件默认收起，超过 20 个文件才出现搜索，超大事件按 200 个文件渐进展示。
- 右侧只显示真正修改的 Markdown 内容，默认忽略空行，最多展示三组紧凑变化；相同内容不重复铺满页面，完整检查仍可进入现有双版本对比。
- 同一工作事件中的 Wikilink、Markdown 链接、嵌入和标签增删以文字列表显示，并区分当前 Vault 可解析目标与事件内文件；损坏的百分号编码链接不会再让整个影响视图失败。
- 已删除、纯新增、未跟踪、根提交和当前不存在的文件保持内联只读预览，不伪造缺失版本，也不开放不安全的完整对比或跨文件恢复。
- 仓库根目录位于 Vault 上方时，只读取和展示 Vault 内文件；Vault 外改动仅显示隐藏数量。关系分析限制为最多 60 篇 Markdown、单文件 256 KiB、总计 2 MiB，超限时明确报告部分分析。
- 支持普通、重命名、复制、删除、冲突、二进制、Unicode 和路径内制表符；Git `--name-status -z` 与 `--numstat -z` 均按 NUL 边界解析。
- 新增命令“查看当前未提交工作”，并在原始 commit、有效版本组、当前工作区卡片和详情页更多菜单提供语义明确的入口；没有增加新的 Ribbon 图标。
- 工作事件页及其完整对比不执行恢复、另存副本、修改里程碑、暂存、提交、checkout 或分支切换；需要恢复时须从正常单篇历史入口重新进入并独立确认。
- 自动化测试增加到 124 项；真实临时 Git 仓库进一步覆盖合并提交第一父、12 提交会话截断、会话内改后还原、超大 Markdown、空事件、unborn 仓库、跨 Vault copy-out、Vault 外符号链接、复合重命名状态和 SHA-256 根提交，并加入工作事件与详情页并发打开、详情内容代次、旧恢复弹窗失效，以及会话中途出现后还原的 Vault 外文件去重回归。
- 已通过 `npm run release:check`，并在 两个测试库 的 Obsidian 1.12.7 中完成入口、快照重新采样、跨文件分组、完整对比、窄屏、深浅主题、并发保护、只读边界和本地数据保留验收。

## 0.6.0

- 把单一 commit 标签升级为“命名里程碑”：同一版本可同时记录已发送、材料已提交、已确认、已导出、重要草稿或自定义事件，并分别保存名称、备注和实际发生时间。
- 时间线新增“只看里程碑”，版本徽章可直接编辑；工作区和版本菜单可快速比较上次发送、提交、确认、导出、重要草稿或自定义里程碑。
- 中央双版本工作台同步显示里程碑身份，版本选择器可搜索同一 commit 的全部事件、类型和备注；双预览标题与恢复回执沿用命名版本。
- 旧标签与复查点迁移到统一的 v2 本地数据模型；迁移可重复执行，重命名状态合并不会复制事件、覆盖目标状态或残留多个复查点。
- 笔记或文件夹连续重命名不再依赖历史侧栏是否打开；里程碑、撤销记录和恢复回执按真实执行顺序原子迁移，目标路径已有状态时安全合并。
- 保存失败会回滚本次内存修改；恢复写入失败不会挤掉旧撤销记录，旧版本检测到未来 schema 时停止加载，避免重复事件或静默覆盖新格式数据。
- 事件时间改为明确必填；清空或输入无效时间会禁用保存，不再让空白界面静默沿用旧时间。
- 重要版本即使超出常规历史读取数量仍保留可访问入口；旧标签缺少路径快照时可临时读取最多 1000 条历史，无法定位时会明确区分当前分支外或历史改写等不确定情况。
- 保存快照不会未经验证参与“上一个版本”判断；里程碑只写入插件本地数据，不修改笔记正文、Git commit、分支或 HEAD。
- 自动化测试增加到 77 项，覆盖多事件、旧数据迁移、未来 schema 保护、复查点统一、文件与文件夹重命名、并发恢复、恢复与撤销失败补偿、键盘打开版本、相同内容边界和历史窗口外里程碑。
- 已在真实 Obsidian 中验证同一 commit 多事件、事件备注检索、无效时间拦截、类型保留、测试数据清理、第二行键盘焦点与原生按钮激活路径，以及约 280 / 320 / 360px 侧栏布局。

## 0.5.5

- 笔记标题下新增默认收起的“路径轨迹”，按时间连接 Git 中确认过的重命名与复制事件，不再把改名前的笔记当成另一份孤立历史。
- 展开后可查看迁移时间、commit 和前后路径；点击任一事件会直接比较迁移前后的准确版本。
- 重命名与复制里程碑在有效版本时间线中显示紧凑路径提示；复制事件保持为独立版本边界，不会因内容相同被聚合隐藏。
- 历史路径加入现有搜索范围，可使用旧文件名或旧目录找到对应版本；详情页同时标明左右版本各自所属路径。
- 只有在已读取历史能够确认来源时才生成路径事件，不为历史窗口之外的来源补造推断结果。
- 测试增加到 58 项，并在真实 Obsidian 中使用实际重命名笔记验证折叠布局、事件展开、精确跳转和双版本路径身份。

## 0.5.4

- 历史内容搜索新增“内容轨迹”，按时间顺序标出关键词首次出现、最后存在、随后删除和当前工作区状态。
- 轨迹把未提交内容作为最新节点，可识别只存在于当前工作区的新内容，以及在工作区中尚未提交的删除。
- “查看首次加入”和“查看删除位置”会直接打开边界两侧的准确版本，不再需要手动猜测并选择 commit。
- 支持内容消失后重新出现；不可读版本保留为未知状态，不跨越缺失历史武断推断加入或删除。
- 输入搜索词后自动收起复查起点、工作区卡片和时光机，只保留版本视图、内容轨迹与命中结果；清空搜索即恢复日常概览。
- 测试增加到 55 项，并在真实 Obsidian 中完成属性轨迹、删除边界、窄侧栏专注布局和前后版本跳转回归。

## 0.5.3

- 侧栏搜索升级为历史内容搜索：同一个输入框同时匹配提交说明、作者、标签、正文和 YAML 属性。
- 输入至少两个字符后渐进检查当前笔记已读取的全部 Git 版本；新输入会让旧搜索结果失效，避免慢请求覆盖当前关键词。
- 命中的版本卡片直接显示三行以内的上下文并高亮关键词，同时用“正文 / 属性”标识说明命中位置。
- 搜索状态显示已检查版本数、命中数和不可读版本数；零结果继续使用现有可操作空状态，不把尚未完成的搜索误报为空。
- 修复 Git 将笔记识别为复制来源时的历史路径延续：复制与重命名都能正确读取更早版本，不再出现可恢复版本被误报为不可读。
- 测试增加到 51 项，覆盖正文片段、中文搜索、属性命中、正文优先级和复制路径追踪；并在真实 Obsidian 正文与属性搜索中完成回归。

## 0.5.2

- 原始双栏与单栏 Diff 默认智能折叠超长 YAML 属性，避免转录稿、OCR 原文或大段嵌入字段占满整个审阅页。
- 折叠结果保留属性名、修改方向、字符数、多行规模和原始文件行号；修改前后仍是一眼可辨的真实变化，而不是直接隐藏。
- 对比顶部明确列出本次折叠的属性；“过滤”菜单新增“折叠长属性”开关，需要检查原文时可随时展开。
- “影响 → 结构”和阅读视图中的结构概览只展示长属性的开头摘要与总字符数，不再把数万字符完整塞进卡片。
- 修正可折叠结构摘要的 HTML 语义，并在真实 Obsidian 长转录笔记中完成双栏、阅读和结构视图回归。
- 测试增加到 47 项，覆盖长属性折叠、修改前后标记、真实行号保留、正文不误折叠和结构摘要截断。

## 0.5.1

- 重做 Markdown 结构比较：属性、标题、段落、列表、任务、表格、Callout、代码、Mermaid、公式和 Wiki 链接使用各自的语义单位，不再只做字符串集合对照。
- YAML 属性支持多行值，能按字段区分新增、删除和值变化；“忽略属性”会同步作用于阅读视图中的结构概览。
- 标题改名、段落改写、列表重排与任务状态变化会分别显示为修改或移动，稳定内容不会在左右重复出现。
- 表格变化可展开到具体行与列，直接显示每个变化单元格的修改前后内容。
- Callout 类型与正文、带语言代码块、Mermaid 图和块级公式均提供独立、可定位的变化条目。
- 结构概览接入现有“阅读”视图并默认折叠；完整结果继续位于“影响 → 结构”，没有增加新的顶层模式按钮。
- 结构面板改为响应式卡片布局，使用轻量状态标签、行号和标题路径；窄窗口自动改为单栏。
- 测试增加到 44 项，覆盖多行属性、标题改名、列表移动、任务演化、表格单元格和特殊 Markdown 区块。

## 0.5.0

- 把“未提交笔记”升级为全库复查收件箱，同时汇总复查起点之后的已提交 Markdown 变化和当前工作区变化。
- 新增全库本地起点：第一次从当前 HEAD 开始追踪；单篇确认后只隐藏已经看过的内容，不修改笔记、提交或 Git 引用。
- 收件箱按“需要先处理、尚未提交、今天更新、最近更新、较早待复查”分组，并提供搜索及已提交 / 未提交 / 稍后筛选。
- 每篇可直接打开对比、标记已复查或推迟 24 小时；支持一次确认全部当前待复查内容。
- 默认排除 `backup`、`backups`、`.trash`、`.obsidian` 和 `node_modules`，设置中可按 Vault 相对目录自由调整。
- 起点因历史重写失效时提供明确的本地重设入口；冲突、删除和被排除路径继续保持安全边界。
- 统一 Vault 与 Git 仓库的物理路径，避免 macOS 路径别名或符号链接导致库内笔记被误判为库外文件。
- 测试增加到 39 项，并加入真实临时 Git Vault 验收，覆盖提交与工作区合并、路径排除、失效起点、冲突优先级和复查状态持久化。

## 0.4.7

- 把双栏对比重做为聚焦审阅面：打开新的版本比较时固定回到“只看改动”，不再因一个不明显的开关误入大段上下文。
- 相同开头与结尾完全隐藏，只在两个修改块之间显示极细的“⋯ N 行未变”分隔，删除旧式整宽灰色展开条。
- 工具栏把空行、空格和属性过滤合并为“过滤 · N”菜单；显示未修改上下文移入“更多”，主区域只保留查看与恢复任务。
- 压缩双版本工作台，弱化边框与红绿装饰；Diff 改用可换行的笔记字体、轻量侧边标记和柔和词级高亮。
- 上下文模式仍可按需开启，但展开控件改为中性细分隔，不再形成抢眼的大色块。
- 测试增加到 31 项，覆盖聚焦视图只保留修改行、隐藏首尾相同内容和压缩中间相同区间。

## 0.4.6

- 双栏对比默认启用“仅改动”：相同内容不再左右重复，只用一条轻量分隔提示隐藏的行数。
- 新增“忽略空行”开关并默认启用，空白行增删不再制造大面积无效红色块。
- 空行过滤保留原始文件行号，定位时不会把过滤后的序号误当成真实行号。
- 关闭“仅改动”后仍可恢复带上下文的完整双栏；单栏 Diff 同样支持忽略空行。
- 忽略空行时暂停可能错位的变化地图与局部恢复入口，保持恢复边界安全。
- 测试增加到 30 项，覆盖空行过滤、原始行号和缩进内容保留。

## 0.4.5

- 把隐藏在省略号菜单中的五种技术模式重组为「对比、阅读、双预览、影响」四个常驻入口。
- 并排 / 单栏、忽略空格 / 属性、结构 / 链接和同步滚动改为随当前任务出现的上下文选项，降低工具栏噪音。
- 新增阅读式 Markdown Diff：按排版后的区块展示稳定内容，并把修改前后、新增和删除内容用轻量语义色标注。
- 重做双 Markdown 预览：独立版本标题、提交信息、固定高度阅读窗与默认同步滚动，左右版本长文更容易对照。
- 忽略属性时不会提供可能错位的局部恢复入口；窄窗口会自动堆叠修改前后和双预览内容。
- 快捷键收束为 `1` 对比、`2` 阅读、`3` 双预览、`4` 影响；测试增加到 28 项。

## 0.4.4

- 把中央对比页的静态左右标签升级为双版本工作台：左右两侧都能独立选择任意提交或当前工作区。
- 每侧提供更早 / 更新版本按钮、可搜索版本选择器、版本位置、直接复制和“切到当前工作区”快捷入口。
- 新增交换左右版本与“自动选择右侧上一版本”，连续版本比较无需返回时间线重新选择。
- 左右两侧不会再选成同一个版本；箭头导航会跳过另一侧已经占用的版本，搜索列表也会排除它。
- 变化导航合并进主控制栏，“忽略空格”成为直接可见开关，恢复等高风险动作仍保持独立。
- 新增 `X` 交换左右版本、`Option + ← / →` 切换当前选中侧版本，并完成窄窗口纵向布局。
- 测试增加到 26 项，覆盖版本顺序、边界、双侧冲突规避和工作区目标。

## 0.4.3

- 重做“未提交笔记”面板：笔记名作为主信息，只显示最后两级目录，不再把完整长路径塞进一行。
- 按“已修改、新笔记、已准备提交、冲突”等用户可理解的状态分组，移除每行重复的 Git 术语。
- 修复中文路径与 Git `numstat` 输出不一致导致所有行错误显示 `+0 / −0` 的问题；零变化不再占位。
- 行卡片强制使用自适应高度、清晰间距和窄侧栏布局，解决主题样式下的卡片重叠。
- 少量改动时隐藏搜索框，刷新与加载状态统一；测试增加到 23 项。

## 0.4.2

- 长历史默认仅渲染最近 40 条，支持分批继续显示，避免高提交上限一次创建大量侧栏节点。
- 键盘向下浏览会自动扩展可见窗口，搜索和有效版本 / 原始提交切换会重置为清晰起点。
- Git 历史读取会多探测一条记录，明确提示当前结果是否达到设置中的提交上限。
- 重做加载、无历史、无搜索结果和 Git 错误状态，并为错误与空搜索提供直接恢复操作。
- 刷新期间禁用重复刷新并显示轻量进度状态；测试增加到 20 项。

## 0.4.1

- 重构侧栏视觉层级：干净工作区不再占用整张卡片，复查入口更紧凑，时光机改为按需展开。
- 时间线改为扁平列表，降低边框、阴影、作者与常驻操作按钮带来的视觉噪音。
- 中央对比页改为分段模式控制；空格过滤、复制基准、另存副本等低频动作收进“更多”菜单。
- 变化地图默认隐藏在导航按钮后；内容一致、单一变化或未主动展开时对比内容自动占满宽度。
- 缩短版本标题、路径与操作文案，保留恢复按钮作为唯一常驻高风险动作。

## 0.4.0

- 新增每篇笔记的复查 checkpoint 与“自上次确认后”收件箱卡片。
- 新增有效版本聚合：折叠连续自动备份、重复内容和仅空格变化，并保留原始 commit 展开与切换。
- 新增智能比较入口，可查看有效版本变化、与当前工作区或上次复查点比较。
- 新增 Markdown 标题变化地图、前后差异导航和 `[` / `]` 快捷键。
- 新增按需内容年龄镜头，估算区块首次出现与最近内容变化。
- 中央审阅页在窄宽度下自动使用统一 Diff，并把五个平级模式收束为任务入口与视图菜单。
- 新增恢复安全预演，展示最终 Markdown、增删行、结构变化和将移除的知识关系。
- 恢复服务升级为最多 12 步撤销栈，并记录文件、范围、来源、时间、内容指纹和撤销状态。
- 新增“查看 Git 恢复历史与撤销栈”命令；旧版单次撤销数据会自动迁移。
- 测试增加到 18 项，覆盖有效版本聚合、checkpoint 边界、内容指纹和标题变化地图。

## 0.3.3

- Kept the Git comparison tab active when leaving focus review instead of jumping back to the source note.

## 0.3.2

- Made focus review truly distraction-free by collapsing both Obsidian sidebars and restoring their exact previous state on exit.
- Added a prominent “在中央完整打开” action when the Git timeline is squeezed inside a split sidebar.
- Added a command-palette action for opening the current note's full Git timeline in the main workspace.

## 0.3.1

- Moved plugin backups outside Obsidian's live `plugins` scan tree so only one folder owns each plugin ID.
- Reworked the sidebar hierarchy with stronger contrast, compact time-machine controls, visible timeline cards, and larger metadata.
- Added full-window focus review with a toolbar button and `F`/`Esc` shortcuts.
- Made side-by-side diff readable at narrow widths, collapsed long unchanged runs, and replaced identical duplicate columns with a clear no-change state.
- Replaced the oversized relationship graph with a compact stable-state summary when links did not change.
- Tightened the detail toolbar and separated review modes from file actions.

## 0.3.0

- Added a draggable note time machine with automatic chronological playback and major-change marks.
- Rebuilt paragraph history around Markdown block matching so moved paragraphs remain discoverable.
- Added safe paragraph copy, insert, and replace actions with concurrent-edit protection and undo.
- Added a fifth detail mode for Wikilink, Markdown link, embed, tag, unresolved-target, backlink, and local-graph impact.
- Added a three-column Markdown conflict resolver backed by Git index stages 1/2/3.
- Added per-conflict ancestor/local/remote/both choices, merged-result preview, safe writeback, and explicit no-auto-stage boundaries.
- Added durable product planning in `ROADMAP.md`.

## 0.2.0

- Rebuilt the sidebar as a grouped visual Git timeline with working-tree statistics.
- Added a main-area review view with side-by-side, unified, preview, and semantic modes.
- Added word-level highlighting, line numbers, whitespace filtering, and collapsed context.
- Added arbitrary two-commit comparison.
- Added local version labels and per-file comparison baselines.
- Added safe single-hunk restore, block copying, and editor line location.
- Added paragraph/selection history using `git log -L`.
- Added a vault workspace review for changed Markdown files and deleted-note recovery.
- Added commit-trailer badges for Agent, Authority, Send-Gate, and Workflow-Status.
- Added search, hover previews, keyboard navigation, compact density, and reduced-motion support.
- Preserved local review metadata across note renames and undo metadata across restored-file renames.

## 0.1.0

- Initial per-note Git timeline, preview, unified diff, safe whole-file restore, undo, and copy-as-note.
