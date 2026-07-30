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
  useBlameIgnoreRevs: true
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
            await this.plugin.savePluginData();
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
            await this.plugin.savePluginData();
            this.plugin.refreshOpenViews();
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
      .setName("历史信噪比预设")
      .setDesc("平衡模式只隐藏确定的元数据、生成字段和格式噪音；严格模式还折叠纯空白重排；原始模式不隐藏任何 Git revision。")
      .addDropdown((dropdown) => dropdown
        .addOption("balanced", "平衡")
        .addOption("strict", "严格")
        .addOption("raw", "原始 Git")
        .setValue(this.plugin.settings.historySignalProfile)
        .onChange(async (value) => {
          this.plugin.settings.historySignalProfile = value as GitNoteHistorySettings["historySignalProfile"];
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        }));

    new Setting(containerEl)
      .setName("忽略的时间与维护属性")
      .setDesc("每行一个 Frontmatter 顶层属性。只有正文及其他属性完全一致时，相关 revision 才会归为噪音。")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyIgnoredProperties.join("\n"))
        .setPlaceholder("updated\nmodified")
        .onChange(async (value) => {
          this.plugin.settings.historyIgnoredProperties = value
            .split(/\r?\n/)
            .map((item) => item.trim().toLocaleLowerCase())
            .filter(Boolean)
            .slice(0, 64);
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        }));

    new Setting(containerEl)
      .setName("自动生成属性")
      .setDesc("每行一个生成字段。健康中心会与普通维护属性分开解释。")
      .addTextArea((text) => text
        .setValue(this.plugin.settings.historyGeneratedProperties.join("\n"))
        .setPlaceholder("checksum\ngenerated-at")
        .onChange(async (value) => {
          this.plugin.settings.historyGeneratedProperties = value
            .split(/\r?\n/)
            .map((item) => item.trim().toLocaleLowerCase())
            .filter(Boolean)
            .slice(0, 64);
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        }));

    new Setting(containerEl)
      .setName("参考 .git-blame-ignore-revs")
      .setDesc("把仓库明确列出的 revision 作为可解释噪音参考；原始 Git 模式仍会显示它们。")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.useBlameIgnoreRevs)
        .onChange(async (value) => {
          this.plugin.settings.useBlameIgnoreRevs = value;
          await this.plugin.savePluginData();
          this.plugin.refreshOpenViews();
        }));

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
          .addOption("rendered", "阅读式改动")
          .addOption("preview", "Markdown 双预览")
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
