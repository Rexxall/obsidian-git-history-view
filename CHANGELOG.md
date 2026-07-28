# Changelog

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
