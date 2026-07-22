import { App, PluginSettingTab, Setting } from "obsidian";
import type GitNoteHistoryPlugin from "./main";
import type { GitNoteHistorySettings } from "./models";

export const DEFAULT_SETTINGS: GitNoteHistorySettings = {
  gitExecutable: "git",
  repositoryRoot: "",
  maxCommits: 100,
  showAuthorEmail: false,
  followActiveNote: true,
  defaultDetailMode: "side-by-side",
  density: "comfortable",
  ignoreWhitespace: false,
  showCommitStats: true
};

export class GitNoteHistorySettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitNoteHistoryPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Git 可执行文件")
      .setDesc("通常保持为 git；也可以填写 Git 可执行文件的绝对路径。")
      .addText((text) =>
        text
          .setPlaceholder("git")
          .setValue(this.plugin.settings.gitExecutable)
          .onChange(async (value) => {
            this.plugin.settings.gitExecutable = value.trim() || "git";
            await this.plugin.savePluginData();
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
            await this.plugin.savePluginData();
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
            await this.plugin.savePluginData();
          })
      );

    new Setting(containerEl)
      .setName("显示作者邮箱")
      .setDesc("在提交详情中显示 Git 作者邮箱。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAuthorEmail).onChange(async (value) => {
          this.plugin.settings.showAuthorEmail = value;
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("默认对比模式")
      .setDesc("从时间线打开版本时默认使用的详情视图。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("side-by-side", "并排对比")
          .addOption("unified", "统一 Diff")
          .addOption("preview", "Markdown 预览")
          .addOption("semantic", "Markdown 语义摘要")
          .addOption("impact", "链接关系影响")
          .setValue(this.plugin.settings.defaultDetailMode)
          .onChange(async (value) => {
            this.plugin.settings.defaultDetailMode = value as typeof this.plugin.settings.defaultDetailMode;
            await this.plugin.savePluginData();
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
            await this.plugin.savePluginData();
            this.plugin.refreshOpenViews();
          })
      );

    new Setting(containerEl)
      .setName("显示增删行统计")
      .setDesc("在工作区卡片和每条提交旁显示 +/− 行数。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCommitStats).onChange(async (value) => {
          this.plugin.settings.showCommitStats = value;
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("默认忽略空格变化")
      .setDesc("Diff 默认不突出仅由空格产生的变化，可在详情页临时切换。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.ignoreWhitespace).onChange(async (value) => {
          this.plugin.settings.ignoreWhitespace = value;
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("默认跟随当前笔记")
      .setDesc("打开其他笔记时，Git 时间线自动切换；也可在侧栏临时固定。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.followActiveNote).onChange(async (value) => {
          this.plugin.settings.followActiveNote = value;
          await this.plugin.savePluginData();
        })
      );
  }
}
