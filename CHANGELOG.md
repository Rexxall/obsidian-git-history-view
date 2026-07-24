# Changelog

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
