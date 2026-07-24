# Git Note History

在 Obsidian 内用笔记时光机审阅 Markdown 的 Git 历史、段落演变、知识关系和冲突，并安全恢复整篇、单个修改块或单个段落。

## 功能

- 右侧栏显示按日期分组的 Git 时间线，主编辑区显示版本详情。
- 拖动时间滑杆连续浏览任意历史时刻，或从旧到新自动播放笔记演变。
- 当前工作区卡片显示未暂存、已暂存、冲突和 `+/-` 行数。
- 五种查看模式：并排词级 Diff、统一 Diff、双 Markdown 预览、Markdown 语义摘要、链接关系影响。
- 任意选择两个 commit 比较，不限于“历史版本 vs 当前内容”。
- 使用 `git log --follow` 延续笔记重命名前的历史。
- 为 commit 设置本地标签和固定比较基线，不修改 Git。
- 支持整篇恢复、单个变更块恢复、复制当前/历史修改块和定位当前行。
- 按 Markdown 区块追踪当前段落的历史，即使段落移动过位置；可复制、插入或安全替换旧段落。
- 比较 Wikilink、Markdown 链接、嵌入和标签，显示未解析目标、反链数和局部关系图。
- 三栏显示 Git 共同祖先、本地和远端 Markdown，逐冲突选择结果并预览后安全写回。
- 全库未提交笔记按状态分组审阅，以笔记名和短目录为主，并支持恢复被删除的 Markdown。
- 解析 commit trailer：`Agent`、`Authority`、`Send-Gate`、`Workflow-Status`。
- 搜索提交、作者、日期、标签和 trailer，悬停快速预览历史内容。
- 键盘浏览时间线，并记住每篇笔记最后使用的详情模式。
- 主对比页支持真正的专注审阅：会临时收起左右侧栏，退出时恢复进入前的布局；按 `F` 进入，按 `Esc` 退出。
- 当时间线被挤在分割侧栏中时，可点击“在中央完整打开”切到主工作区查看。
- 每篇笔记可建立本地复查点，侧栏直接汇总“自上次确认后”的有效版本和当前工作区变化。
- 默认把密集自动备份聚合成有效版本，并识别重复内容；可随时展开或切回原始 commit。
- 中央审阅页提供标题级变化地图、前后差异导航、内容年龄镜头和窄屏响应式 Diff。
- 恢复前预演最终内容、结构与链接影响；保存最多 12 步撤销内容，并记录可查看的恢复回执。
- 若恢复后笔记又被修改，会停止自动撤销，避免覆盖新内容，同时保留恢复记录。
- 长历史按 40 条渐进显示，并明确提示是否达到 Git 提交读取上限。

## 要求

- Obsidian 桌面版 1.8.0 或更高版本。
- 系统已安装 Git，并可通过 `git` 命令调用。
- Vault 位于 Git 仓库内，或者在插件设置中指定仓库根目录。
- 当前版本仅支持 `.md` 文件。

## 安装

### 本地构建

```bash
npm install
npm run check
```

把下列文件复制到：

```text
<Vault>/.obsidian/plugins/git-note-history/
├── main.js
├── manifest.json
└── styles.css
```

然后在 Obsidian 的“第三方插件”中启用 **Git Note History**。

## 使用

主要入口：

1. 点击左侧 Ribbon 的历史图标。
2. 打开命令面板，运行“Git Note History: 打开当前笔记的 Git 历史”。
3. 在文件列表中右键 Markdown 笔记，选择“查看 Git 历史”。
4. 点击未提交笔记图标，或运行“打开未提交笔记面板”。
5. 在编辑器中运行“查看当前段落或选中文本的 Git 历史”。
6. 冲突笔记可从当前工作区卡片点击“解决冲突”，或运行“三栏 Git 冲突解决器”。

时间线操作：

- 首次使用时点击“以当前为起点”建立复查点；以后从“待复查”卡片直接审阅并标记完成。
- 默认显示“有效版本”；点击“查看原始提交”可检查每一个真实 commit。
- 点击 commit：与当前工作区比较。
- 拖动“笔记时光机”滑杆：在主区域预览所选历史时刻；播放按钮会按时间自动前进。
- `Cmd/Ctrl` 点击，或使用叠层图标：选择两个 commit 比较。
- `J/K` 或方向键：移动键盘选择；`Enter`/`D`：打开对比；`P`：打开预览。
- `···`：设为比较基线、设置标签、复制 commit hash。
- 详情页按 `1/2/3/4/5`：切换并排、统一、预览、语义和关系影响模式。
- 详情页按 `[` / `]`：移动到上一个 / 下一个变化；左侧变化地图可按 Markdown 标题直接跳转。
- 详情页按 `F` 或点击右上角扩展按钮进入专注审阅，按 `Esc` 退出；左右侧栏会按进入前状态自动恢复。
- 在详情页“视图”菜单或命令面板中打开“内容年龄镜头”，查看区块首次出现和最近变化时间。
- 运行“查看 Git 恢复历史与撤销栈”可检查恢复来源、内容指纹和撤销状态。

如果团队或本地工具在 commit message 尾部写入：

```text
Agent: local-tool
Authority: working_master
Send-Gate: user_review_not_sent
Workflow-Status: review
```

时间线会把这些字段渲染成可搜索徽章。

恢复只会把目标 commit 中的文本写入当前笔记。它不会自动 commit，也不会执行 `git checkout`、`git reset` 或 `git revert`。

## 安全边界

- 整篇和局部恢复只修改工作区文件，不移动 HEAD、分支或暂存区。
- 若笔记在恢复读取与写入之间发生变化，恢复会停止。
- 恢复后可连续运行“撤销上次 Git 恢复”，最多保留 12 步。如果恢复后又编辑了笔记，自动撤销会停止，防止覆盖这些新编辑。
- Git 历史只包含已提交版本。插件不会自动提交或推送。
- 冲突解决器只写回工作区文件，不会自动 `git add`；写回后必须自行检查并暂存。

建议先在测试 Vault 中验证恢复行为，再用于重要笔记库。

## 开发

```bash
npm run dev
npm run build
npm test
npm run check
```

项目文档：

- [产品路线图](ROADMAP.md)
- [交互研究与头脑风暴](docs/UX_RESEARCH_BRAINSTORM_2026-07-21.md)
- [发布流程](RELEASING.md)

仓库结构：

```text
src/        插件源码
tests/      自动化测试
scripts/    构建与发布校验工具
docs/       研究与设计文档
dist/       本地安装包输出，不提交到 Git
```

### 同步到本地 Vault

复制 `.local-install-targets.example.json` 为 `.local-install-targets.json`，填写需要同步的 Obsidian 插件目录。真实路径文件已被 Git 忽略。

```bash
npm run release:local
```

该命令会完成构建、测试、安装包校验，并把 `main.js`、`manifest.json`、`styles.css` 同步到所有配置目标。覆盖前会备份旧插件目录，已有的 `data.json` 不会被删除。

核心代码：

```text
src/
├── diff/         Markdown 语义差异
├── analysis/     Wikilink、标签和知识关系影响
├── conflict/     Git 冲突标记解析与安全合并结果
├── git/          Git 调用、log/status 解析
├── history/      Markdown 区块识别与跨版本匹配
├── restore/      安全恢复和撤销
├── ui/           Diff、标签、段落历史和确认框
├── views/        时间线、详情页和工作区审阅
├── main.ts       插件入口、命令和文件菜单
└── settings.ts   插件设置
```

## License

MIT
