import { App, PluginSettingTab } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import type GitNoteHistoryPlugin from "./main";
import type { GitNoteHistorySettings } from "./models";
import { tr } from "./i18n";
import { normalizeReviewExcludedPaths } from "./review/review-inbox";

export const DEFAULT_SETTINGS: GitNoteHistorySettings = {
  gitExecutable: "git",
  repositoryRoot: "",
  maxCommits: 100,
  showAuthorEmail: false,
  followActiveNote: true,
  defaultDetailMode: "side-by-side",
  density: "comfortable",
  ignoreWhitespace: false,
  showCommitStats: true,
  reviewExcludedPaths: ["backup", "backups", ".trash", "node_modules"],
  sandboxStorageRoot: "",
  historySignalProfile: "balanced",
  historyIgnoredProperties: ["updated", "modified", "last-modified", "last_modified", "mtime"],
  historyGeneratedProperties: [
    "checksum",
    "content-hash",
    "content_hash",
    "generated",
    "generated-at",
    "generated_at"
  ],
  useBlameIgnoreRevs: true,
  showLabTools: false,
  showStatusBar: true
};

export class GitNoteHistorySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitNoteHistoryPlugin) {
    super(app, plugin);
    this.containerEl.addClass("ap", "ap-settings", "git-note-history-settings");
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      {
        type: "group",
        items: [
          {
            name: tr("Git 可执行文件", "Git executable"),
            desc: tr("通常保持为 git；也可以填写 Git 可执行文件的绝对路径。", "Usually just git. Enter an absolute path if Git is not on your PATH."),
            render: (setting) => void setting.addText((text) => text
              .setValue(settings.gitExecutable)
              .onChange(async (value) => {
                settings.gitExecutable = value.trim() || "git";
                await this.save();
                this.plugin.reloadHistoricalSandboxManager();
              }))
          },
          {
            name: tr("仓库根目录", "Repository root"),
            desc: tr("留空时从仓库所在位置自动向上查找 Git 仓库。只有自动检测失败时才填写绝对路径。", "Leave empty to find the Git repository above the vault. Enter an absolute path only if detection fails."),
            render: (setting) => void setting.addText((text) => text
              .setPlaceholder(tr("自动检测", "Detect automatically"))
              .setValue(settings.repositoryRoot)
              .onChange(async (value) => {
                settings.repositoryRoot = value.trim();
                await this.save();
              }))
          },
          {
            name: tr("最多显示的提交数", "Maximum commits"),
            desc: tr("每篇笔记读取的 Git 提交上限，范围 10–1000。", "How many commits to read for each note, from 10 to 1000."),
            render: (setting) => void setting.addText((text) => text
              .setPlaceholder("100")
              .setValue(String(settings.maxCommits))
              .onChange(async (value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed)) return;
                settings.maxCommits = Math.max(10, Math.min(1000, parsed));
                await this.save();
              }))
          },
          {
            name: tr("默认跟随当前笔记", "Follow the active note"),
            desc: tr("打开其他笔记时，侧栏自动切换；也可在侧栏临时固定。", "The sidebar switches when you open another note. You can pin it from the sidebar."),
            render: (setting) => void setting.addToggle((toggle) => toggle
              .setValue(settings.followActiveNote)
              .onChange(async (value) => {
                settings.followActiveNote = value;
                await this.save();
              }))
          },
          {
            name: tr("默认对比模式", "Default compare mode"),
            desc: tr("从时间线打开版本时默认使用的视图。", "The view used when you open a version from the timeline."),
            render: (setting) => void setting.addDropdown((dropdown) => dropdown
              .addOption("side-by-side", tr("对比 · 双栏", "Compare, side by side"))
              .addOption("unified", tr("对比 · 单栏", "Compare, unified"))
              .addOption("rendered", tr("阅读", "Rendered changes"))
              .addOption("preview", tr("双预览", "Two previews"))
              .addOption("semantic", tr("影响 · 结构", "Impact, structure"))
              .addOption("impact", tr("影响 · 链接", "Impact, links"))
              .setValue(settings.defaultDetailMode)
              .onChange(async (value) => {
                settings.defaultDetailMode = value as GitNoteHistorySettings["defaultDetailMode"];
                await this.save();
              }))
          }
        ]
      },
      {
        type: "group",
        heading: tr("显示", "Display"),
        items: [
          {
            name: tr("状态栏显示上次提交", "Show last commit in status bar"),
            desc: tr("在状态栏显示当前笔记上次提交是多久以前、有没有未提交的修改；点一下打开时间线。", "Show how long ago the active note was last committed and whether it has uncommitted edits. Click it to open the timeline."),
            render: (setting) => void setting.addToggle((toggle) => toggle
              .setValue(settings.showStatusBar)
              .onChange(async (value) => {
                settings.showStatusBar = value;
                await this.save();
                this.plugin.refreshNoteStatus();
              }))
          },
          {
            name: tr("界面密度", "Density"),
            desc: tr("紧凑模式适合窄侧栏，舒适模式更易阅读。", "Compact suits a narrow sidebar; comfortable is easier to read."),
            render: (setting) => void setting.addDropdown((dropdown) => dropdown
              .addOption("comfortable", tr("舒适", "Comfortable"))
              .addOption("compact", tr("紧凑", "Compact"))
              .setValue(settings.density)
              .onChange(async (value) => {
                settings.density = value as GitNoteHistorySettings["density"];
                await this.save(true);
              }))
          },
          this.toggle("showCommitStats", tr("显示增删行统计", "Show line counts"), tr("在工作区卡片和每个版本旁显示 +/− 行数。", "Show +/− line counts next to the working copy and each version.")),
          this.toggle("showAuthorEmail", tr("显示作者邮箱", "Show author email"), tr("在版本详情中显示 Git 作者邮箱。", "Show the Git author email in version details.")),
          this.toggle("ignoreWhitespace", tr("默认忽略空格变化", "Ignore whitespace by default"), tr("对比默认不突出仅由空格产生的变化，可在对比页临时切换。", "Do not highlight changes that are only whitespace. You can switch this in the compare view."))
        ]
      },
      {
        type: "group",
        heading: tr("实验功能", "Lab tools"),
        items: [
          this.toggle("showLabTools", tr("显示实验功能", "Show lab tools"), tr("打开后，命令面板、右键菜单和侧栏“更多”里会多出复查收件箱、工作事件、知识边界追踪、来源镜头、版本批注、历史健康、知识图谱时间机和历史沙盒。关闭时只保留时间线、对比、恢复和冲突解决。", "Adds the review inbox, work events, change tracing, provenance lens, version annotations, history health, knowledge graph playback and historical sandboxes to the command palette, file menu and sidebar. When off, only the timeline, compare, restore and conflict resolver are shown. Lab views are in Chinese.")),
          {
            name: tr("复查收件箱排除目录", "Folders excluded from the review inbox"),
            desc: tr("每行一个仓库内的相对目录；backup、插件配置和回收站等内容不会进入收件箱。", "One vault-relative folder per line. Backups, the config folder and the trash never enter the inbox."),
            render: (setting) => void setting.addTextArea((text) => text
              .setPlaceholder(tr("每行一个，例如 backup", "One per line, for example backup"))
              .setValue(settings.reviewExcludedPaths.join("\n"))
              .onChange(async (value) => {
                settings.reviewExcludedPaths = normalizeReviewExcludedPaths([value]);
                await this.save(true);
              }))
          }
        ]
      },
      {
        type: "group",
        heading: tr("历史信噪比", "History noise"),
        items: [
          {
            name: tr("预设", "Profile"),
            desc: tr("决定哪些版本算作噪音而被折叠。平衡只隐藏确定的元数据、生成字段和格式噪音；严格还折叠纯空白重排；原始 Git 不隐藏任何版本。", "Decide which revisions count as noise and are folded away. Balanced hides only certain metadata, generated fields and formatting noise; strict also folds whitespace-only reflows; raw Git hides nothing."),
            render: (setting) => void setting.addDropdown((dropdown) => dropdown
              .addOption("balanced", tr("平衡", "Balanced"))
              .addOption("strict", tr("严格", "Strict"))
              .addOption("raw", tr("原始 Git", "Raw Git"))
              .setValue(settings.historySignalProfile)
              .onChange(async (value) => {
                settings.historySignalProfile = value as GitNoteHistorySettings["historySignalProfile"];
                await this.save(true);
              }))
          },
          this.list("historyIgnoredProperties", tr("忽略的时间与维护属性", "Ignored maintenance properties"), tr("每行一个 Frontmatter 顶层属性。只有正文及其他属性完全一致时，相关版本才会归为噪音。", "One top-level property per line. A revision counts as noise only if the body and all other properties are identical."), tr("每行一个，例如 updated", "One per line, for example updated")),
          this.list("historyGeneratedProperties", tr("自动生成属性", "Generated properties"), tr("每行一个生成字段。健康中心会与普通维护属性分开解释。", "One generated field per line. History health explains them separately from maintenance properties."), tr("每行一个，例如 checksum", "One per line, for example checksum")),
          this.toggle("useBlameIgnoreRevs", tr("参考 .git-blame-ignore-revs", "Use .git-blame-ignore-revs"), tr("把仓库明确列出的版本作为可解释噪音参考；原始 Git 模式仍会显示它们。", "Treat revisions listed by the repository as explained noise. Raw Git still shows them."))
        ]
      }
    ];
  }

  private toggle(
    key: "showCommitStats" | "showAuthorEmail" | "ignoreWhitespace" | "showLabTools" | "useBlameIgnoreRevs",
    name: string,
    desc: string
  ): SettingDefinition {
    return {
      name,
      desc,
      render: (setting) => void setting.addToggle((toggle) => toggle
        .setValue(this.plugin.settings[key])
        .onChange(async (value) => {
          this.plugin.settings[key] = value;
          await this.save(true);
        }))
    };
  }

  private list(
    key: "historyIgnoredProperties" | "historyGeneratedProperties",
    name: string,
    desc: string,
    placeholder: string
  ): SettingDefinition {
    return {
      name,
      desc,
      render: (setting) => void setting.addTextArea((text) => text
        .setValue(this.plugin.settings[key].join("\n"))
        .setPlaceholder(placeholder)
        .onChange(async (value) => {
          this.plugin.settings[key] = splitList(value);
          await this.save(true);
        }))
    };
  }

  private async save(refresh = false): Promise<void> {
    await this.plugin.savePluginData();
    if (refresh) this.plugin.refreshOpenViews();
  }
}

function splitList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean)
    .slice(0, 64);
}
