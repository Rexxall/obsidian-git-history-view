import { App, PluginSettingTab, Setting } from "obsidian";
import type GitNoteHistoryPlugin from "./main";
import type { GitNoteHistorySettings } from "./models";
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
  reviewExcludedPaths: ["backup", "backups", ".trash", ".obsidian", "node_modules"],
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
  paperStyle: false
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
    new Setting(containerEl).setName("基本").setHeading();

    new Setting(containerEl)
      .setName("Git 可执行文件")
      .setDesc("通常保持为 git；也可以填写 Git 可执行文件的绝对路径。")
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
      .setName("仓库根目录")
      .setDesc("留空时从 Vault 自动向上查找 Git 仓库。只有自动检测失败时才填写绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("自动检测")
          .setValue(this.plugin.settings.repositoryRoot)
          .onChange(async (value) => {
            this.plugin.settings.repositoryRoot = value.trim();
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName("最多显示的提交数")
      .setDesc("每篇笔记读取的 Git 提交上限，范围 10–1000。")
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
      .setName("默认跟随当前笔记")
      .setDesc("打开其他笔记时，侧栏自动切换；也可在侧栏临时固定。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followActiveNote).onChange(async (value) => {
          this.plugin.settings.followActiveNote = value;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName("默认对比模式")
      .setDesc("从时间线打开版本时默认使用的视图。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("side-by-side", "对比 · 双栏")
          .addOption("unified", "对比 · 单栏")
          .addOption("rendered", "阅读")
          .addOption("preview", "双预览")
          .addOption("semantic", "影响 · 结构")
          .addOption("impact", "影响 · 链接")
          .setValue(this.plugin.settings.defaultDetailMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultDetailMode = value as typeof this.plugin.settings.defaultDetailMode;
            await this.save();
          })
      );
  }

  private renderAppearance(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("显示").setHeading();

    new Setting(containerEl)
      .setName("纸与墨外观")
      .setDesc("Paper & ink style：纸色底、衬线标题、细墨线，暗红标记删掉与取回，青绿标记新增与保留。关闭时跟随 Obsidian 主题。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.paperStyle).onChange(async (value) => {
          this.plugin.settings.paperStyle = value;
          this.plugin.applyAppearance();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName("界面密度")
      .setDesc("紧凑模式适合窄侧栏，舒适模式更易阅读。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("comfortable", "舒适")
          .addOption("compact", "紧凑")
          .setValue(this.plugin.settings.density)
          .onChange(async (value) => {
            this.plugin.settings.density = value as typeof this.plugin.settings.density;
            await this.save(true);
          })
      );

    new Setting(containerEl)
      .setName("显示增删行统计")
      .setDesc("在工作区卡片和每个版本旁显示 +/− 行数。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCommitStats).onChange(async (value) => {
          this.plugin.settings.showCommitStats = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName("显示作者邮箱")
      .setDesc("在版本详情中显示 Git 作者邮箱。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAuthorEmail).onChange(async (value) => {
          this.plugin.settings.showAuthorEmail = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName("默认忽略空格变化")
      .setDesc("对比默认不突出仅由空格产生的变化，可在对比页临时切换。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreWhitespace).onChange(async (value) => {
          this.plugin.settings.ignoreWhitespace = value;
          await this.save(true);
        })
      );
  }

  private renderLab(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("实验功能").setHeading();

    new Setting(containerEl)
      .setName("显示实验功能")
      .setDesc("打开后，命令面板、右键菜单和侧栏“更多”里会多出复查收件箱、工作事件、知识边界追踪、来源镜头、版本批注、历史健康、知识图谱时间机和历史沙盒。关闭时只保留时间线、对比、恢复和冲突解决。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showLabTools).onChange(async (value) => {
          this.plugin.settings.showLabTools = value;
          await this.save(true);
        })
      );

    new Setting(containerEl)
      .setName("复查收件箱排除目录")
      .setDesc("每行一个 Vault 相对目录；backup、插件配置和回收站等内容不会进入收件箱。")
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
    new Setting(containerEl).setName("历史信噪比").setHeading();
    containerEl.createEl("p", {
      cls: "git-note-history-settings-group-note",
      text: "决定哪些 Git revision 算作噪音而被折叠。原始 Git 模式不隐藏任何版本。"
    });

    new Setting(containerEl)
      .setName("预设")
      .setDesc("平衡只隐藏确定的元数据、生成字段和格式噪音；严格还折叠纯空白重排。")
      .addDropdown((dropdown) => dropdown
        .addOption("balanced", "平衡")
        .addOption("strict", "严格")
        .addOption("raw", "原始 Git")
        .setValue(this.plugin.settings.historySignalProfile)
        .onChange(async (value) => {
          this.plugin.settings.historySignalProfile = value as GitNoteHistorySettings["historySignalProfile"];
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName("忽略的时间与维护属性")
      .setDesc("每行一个 Frontmatter 顶层属性。只有正文及其他属性完全一致时，相关 revision 才会归为噪音。")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyIgnoredProperties.join("\n"))
        .setPlaceholder("updated\nmodified")
        .onChange(async (value) => {
          this.plugin.settings.historyIgnoredProperties = splitList(value);
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName("自动生成属性")
      .setDesc("每行一个生成字段。健康中心会与普通维护属性分开解释。")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyGeneratedProperties.join("\n"))
        .setPlaceholder("checksum\ngenerated-at")
        .onChange(async (value) => {
          this.plugin.settings.historyGeneratedProperties = splitList(value);
          await this.save(true);
        }));

    new Setting(containerEl)
      .setName("参考 .git-blame-ignore-revs")
      .setDesc("把仓库明确列出的 revision 作为可解释噪音参考；原始 Git 模式仍会显示它们。")
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
