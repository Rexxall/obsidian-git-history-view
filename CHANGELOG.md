# Changelog

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
