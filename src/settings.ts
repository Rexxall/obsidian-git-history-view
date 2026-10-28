import { App, PluginSettingTab, Setting } from "obsidian";
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
  paperStyle: false,
  showStatusBar: true
};

export class GitNoteHistorySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitNoteHistoryPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("git-note-history-settings");
    this.renderBasics(containerEl);
    this.renderAppearance(containerEl);
    this.renderLab(containerEl);
    this.renderSignal(containerEl);
  }

  private async save(refresh = false): Promise<void> {
    await this.plugin.savePluginData();
    if (refresh) this.plugin.refreshOpenViews();
  }

  private renderBasics(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(tr("Git 可执行文件", "Git executable"))
      .setDesc(tr("通常保持为 git；也可以填写 Git 可执行文件的绝对路径。", "Usually just git. Enter an absolute path if Git is not on your PATH."))
      .addText((text) =>
        text
          .setPlaceholder("git")
          .setValue(this.plugin.settings.gitExecutable)
          .onChange(async (value) => {
            this.plugin.settings.gitExecutable = value.trim() || "git";
            await this.save();
            this.plugin.reloadHistoricalSandboxManager();
          })
      );

    new Setting(containerEl)
      .setName(tr("仓库根目录", "Repository root"))
      .setDesc(tr("留空时从 Vault 自动向上查找 Git 仓库。只有自动检测失败时才填写绝对路径。", "Leave empty to find the Git repository above the vault. Enter an absolute path only if detection fails."))
      .addText((text) =>
        text
          .setPlaceholder(tr("自动检测", "Detect automatically"))
          .setValue(this.plugin.settings.repositoryRoot)
          .onChange(async (value) => {
            this.plugin.settings.repositoryRoot = value.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName(tr("最多显示的提交数", "Maximum commits"))
      .setDesc(tr("每篇笔记读取的 Git 提交上限，范围 10–1000。", "How many commits to read for each note, from 10 to 1000."))
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.maxCommits))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            this.plugin.settings.maxCommits = Math.max(10, Math.min(1000, parsed));
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName(tr("默认跟随当前笔记", "Follow the active note"))
      .setDesc(tr("打开其他笔记时，侧栏自动切换；也可在侧栏临时固定。", "The sidebar switches when you open another note. You can pin it from the sidebar."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followActiveNote).onChange(async (value) => {
          this.plugin.settings.followActiveNote = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName(tr("默认对比模式", "Default compare mode"))
      .setDesc(tr("从时间线打开版本时默认使用的视图。", "The view used when you open a version from the timeline."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("side-by-side", tr("对比 · 双栏", "Compare, side by side"))
          .addOption("unified", tr("对比 · 单栏", "Compare, unified"))
          .addOption("rendered", tr("阅读", "Rendered changes"))
          .addOption("preview", tr("双预览", "Two previews"))
          .addOption("semantic", tr("影响 · 结构", "Impact, structure"))
          .addOption("impact", tr("影响 · 链接", "Impact, links"))
          .setValue(this.plugin.settings.defaultDetailMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultDetailMode = value as typeof this.plugin.settings.defaultDetailMode;
            await this.save();
          })
      );
  }

  private renderAppearance(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(tr("显示", "Display")).setHeading();

    new Setting(containerEl)
      .setName(tr("纸与墨外观", "Paper and ink style"))
      .setDesc(tr("Paper & ink style：纸色底、衬线标题、细墨线，暗红标记删掉与取回，青绿标记新增与保留。关闭时跟随 Obsidian 主题。", "Paper surfaces, serif headings and thin ink lines; dark red marks what was removed or will be taken back, teal marks what was added or kept. When off, the plugin follows your theme."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.paperStyle).onChange(async (value) => {
          this.plugin.settings.paperStyle = value;
          this.plugin.applyAppearance();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName(tr("状态栏显示上次提交", "Show last commit in status bar"))
      .setDesc(tr("在状态栏显示当前笔记上次提交是多久以前、有没有未提交的修改；点一下打开时间线。", "Show how long ago the active note was last committed and whether it has uncommitted edits. Click it to open the timeline."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showStatusBar).onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.save();
          this.plugin.refreshNoteStatus();
        })
      );

    new Setting(containerEl)
      .setName(tr("界面密度", "Density"))
      .setDesc(tr("紧凑模式适合窄侧栏，舒适模式更易阅读。", "Compact suits a narrow sidebar; comfortable is easier to read."))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("comfortable", tr("舒适", "Comfortable"))
          .addOption("compact", tr("紧凑", "Compact"))
          .setValue(this.plugin.settings.density)
          .onChange(async (value) => {
            this.plugin.settings.density = value as typeof this.plugin.settings.density;
            await this.save(true);
          })
      );

    new Setting(containerEl)
      .setName(tr("显示增删行统计", "Show line counts"))
      .setDesc(tr("在工作区卡片和每个版本旁显示 +/− 行数。", "Show +/− line counts next to the working copy and each version."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCommitStats).onChange(async (value) => {
          this.plugin.settings.showCommitStats = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName(tr("显示作者邮箱", "Show author email"))
      .setDesc(tr("在版本详情中显示 Git 作者邮箱。", "Show the Git author email in version details."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAuthorEmail).onChange(async (value) => {
          this.plugin.settings.showAuthorEmail = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName(tr("默认忽略空格变化", "Ignore whitespace by default"))
      .setDesc(tr("对比默认不突出仅由空格产生的变化，可在对比页临时切换。", "Do not highlight changes that are only whitespace. You can switch this in the compare view."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreWhitespace).onChange(async (value) => {
          this.plugin.settings.ignoreWhitespace = value;
          await this.save(true);
        })
      );
  }

  private renderLab(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(tr("实验功能", "Lab tools")).setHeading();

    new Setting(containerEl)
      .setName(tr("显示实验功能", "Show lab tools"))
      .setDesc(tr("打开后，命令面板、右键菜单和侧栏“更多”里会多出复查收件箱、工作事件、知识边界追踪、来源镜头、版本批注、历史健康、知识图谱时间机和历史沙盒。关闭时只保留时间线、对比、恢复和冲突解决。", "Adds the review inbox, work events, change tracing, provenance lens, version annotations, history health, knowledge graph playback and historical sandboxes to the command palette, file menu and sidebar. When off, only the timeline, compare, restore and conflict resolver are shown. Lab views are in Chinese."))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showLabTools).onChange(async (value) => {
          this.plugin.settings.showLabTools = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName(tr("复查收件箱排除目录", "Folders excluded from the review inbox"))
      .setDesc(tr("每行一个 Vault 相对目录；backup、插件配置和回收站等内容不会进入收件箱。", "One vault-relative folder per line. Backups, the config folder and the trash never enter the inbox."))
      .addTextArea((text) =>
        text
          .setPlaceholder("backup\n.trash")
          .setValue(this.plugin.settings.reviewExcludedPaths.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.reviewExcludedPaths = normalizeReviewExcludedPaths([value]);
            await this.save(true);
          })
      );
  }

  private renderSignal(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(tr("历史信噪比", "History noise")).setHeading();
    containerEl.createEl("p", {
      cls: "git-note-history-settings-group-note",
      text: tr("决定哪些 Git revision 算作噪音而被折叠。原始 Git 模式不隐藏任何版本。", "Decide which revisions count as noise and are folded away. Raw Git hides nothing.")
    });

    new Setting(containerEl)
      .setName(tr("预设", "Profile"))
      .setDesc(tr("平衡只隐藏确定的元数据、生成字段和格式噪音；严格还折叠纯空白重排。", "Balanced hides only certain metadata, generated fields and formatting noise; strict also folds whitespace-only reflows."))
      .addDropdown((dropdown) => dropdown
        .addOption("balanced", tr("平衡", "Balanced"))
        .addOption("strict", tr("严格", "Strict"))
        .addOption("raw", tr("原始 Git", "Raw Git"))
        .setValue(this.plugin.settings.historySignalProfile)
        .onChange(async (value) => {
          this.plugin.settings.historySignalProfile = value as GitNoteHistorySettings["historySignalProfile"];
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName(tr("忽略的时间与维护属性", "Ignored maintenance properties"))
      .setDesc(tr("每行一个 Frontmatter 顶层属性。只有正文及其他属性完全一致时，相关 revision 才会归为噪音。", "One top-level property per line. A revision counts as noise only if the body and all other properties are identical."))
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyIgnoredProperties.join("\n"))
        .setPlaceholder("updated\nmodified")
        .onChange(async (value) => {
          this.plugin.settings.historyIgnoredProperties = splitList(value);
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName(tr("自动生成属性", "Generated properties"))
      .setDesc(tr("每行一个生成字段。健康中心会与普通维护属性分开解释。", "One generated field per line. History health explains them separately from maintenance properties."))
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyGeneratedProperties.join("\n"))
        .setPlaceholder("checksum\ngenerated-at")
        .onChange(async (value) => {
          this.plugin.settings.historyGeneratedProperties = splitList(value);
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName(tr("参考 .git-blame-ignore-revs", "Use .git-blame-ignore-revs"))
      .setDesc(tr("把仓库明确列出的 revision 作为可解释噪音参考；原始 Git 模式仍会显示它们。", "Treat revisions listed by the repository as explained noise. Raw Git still shows them."))
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useBlameIgnoreRevs)
        .onChange(async (value) => {
          this.plugin.settings.useBlameIgnoreRevs = value;
          await this.save(true);
        }));
  }
}

function splitList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean)
    .slice(0, 64);
}
