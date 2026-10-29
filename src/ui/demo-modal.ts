import { App, Modal, Notice, Setting } from "obsidian";
import { tr } from "../i18n";
import { renderSideBySideDiff, renderUnifiedDiff } from "./diff-renderer";

interface DemoVersion {
  label: string;
  when: string;
  text: string;
}

function demoVersions(): DemoVersion[] {
  if (tr("zh", "en") === "zh") {
    return [
      { label: "初稿", when: "10 月 1 日", text: "# 研究计划\n\n## 背景\n\n手术机器人越来越常见，但年轻医生学得很慢。\n\n## 方法\n\n先做问卷，再做小实验。\n\n## 时间表\n\n一年。\n" },
      { label: "补上动机", when: "10 月 12 日", text: "# 研究计划\n\n## 背景\n\n手术机器人越来越常见，但年轻医生学得很慢。我在实习时看到，同一台手术，新手要多花一倍时间。\n\n## 方法\n\n先做问卷，再做小实验。\n\n## 时间表\n\n前半年做问卷，后半年做实验。\n" },
      { label: "现在", when: "今天", text: "# 研究计划\n\n## 背景\n\n手术机器人越来越常见，但年轻医生学得很慢。\n\n## 方法\n\n用模拟器记录 20 名新手的操作数据，对比两种训练方式。\n\n## 时间表\n\n前半年做问卷，后半年做实验。\n" }
    ];
  }
  return [
    { label: "First draft", when: "1 Oct", text: "# Research plan\n\n## Background\n\nSurgical robots are common, but new doctors learn them slowly.\n\n## Method\n\nA survey first, then a small experiment.\n\n## Timeline\n\nOne year.\n" },
    { label: "Added motivation", when: "12 Oct", text: "# Research plan\n\n## Background\n\nSurgical robots are common, but new doctors learn them slowly. During my internship, beginners took twice as long on the same operation.\n\n## Method\n\nA survey first, then a small experiment.\n\n## Timeline\n\nSurvey in the first half year, experiment in the second.\n" },
    { label: "Now", when: "Today", text: "# Research plan\n\n## Background\n\nSurgical robots are common, but new doctors learn them slowly.\n\n## Method\n\nRecord 20 beginners on a simulator and compare two ways of training.\n\n## Timeline\n\nSurvey in the first half year, experiment in the second.\n" }
  ];
}

/**
 * A worked example that needs no repository: three pre-written versions of one note,
 * compared the same way as real history, with paragraph restore applied only in memory.
 */
export class HistoryDemoModal extends Modal {
  private readonly versions = demoVersions();
  private current = this.versions[this.versions.length - 1]!.text;
  private selected = 1;
  private mode: "side-by-side" | "unified" = "unified";

  constructor(app: App, private readonly guideUrl: string) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ap", "ap-modal", "git-note-history-demo");
    this.setTitle(tr("示例：一篇笔记的三个版本", "Example: three versions of one note"));
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const banner = contentEl.createDiv({ cls: "git-note-history-demo-banner" });
    banner.createSpan({ cls: "git-note-history-demo-badge", text: tr("演示", "Demo") });
    banner.createSpan({ text: tr("版本是预先写好的，不读你的仓库，也不写任何文件。", "The versions are pre-written. Your repository is not read and no file is written.") });

    const list = contentEl.createDiv({ cls: "git-note-history-demo-versions", attr: { role: "listbox", "aria-label": tr("示例版本", "Example versions") } });
    this.versions.slice(0, -1).forEach((version, index) => {
      const row = list.createEl("button", {
        cls: index === this.selected ? "git-note-history-demo-version is-selected" : "git-note-history-demo-version",
        attr: { role: "option", "aria-selected": String(index === this.selected) }
      });
      row.createSpan({ text: version.label, cls: "git-note-history-demo-label" });
      row.createSpan({ text: version.when, cls: "git-note-history-demo-when" });
      row.addEventListener("click", () => {
        this.selected = index;
        this.render();
      });
    });

    const caption = contentEl.createDiv({ cls: "git-note-history-demo-caption" });
    caption.createSpan({ text: tr(`“${this.versions[this.selected]!.label}”和现在相比`, `"${this.versions[this.selected]!.label}" compared with now`) });
    const segment = caption.createDiv({ cls: "ap-seg", attr: { role: "group", "aria-label": tr("显示方式", "Layout") } });
    for (const [mode, label] of [["unified", tr("合并", "Unified")], ["side-by-side", tr("并排", "Side by side")]] as const) {
      const button = segment.createEl("button", { text: label, attr: { "aria-pressed": String(this.mode === mode) } });
      button.addEventListener("click", () => {
        this.mode = mode;
        this.render();
      });
    }

    const body = contentEl.createDiv({ cls: `git-note-history-review-body mode-${this.mode}` });
    const historical = this.versions[this.selected]!.text;
    if (this.mode === "side-by-side") {
      renderSideBySideDiff(body, historical, this.current, { ignoreWhitespace: false, ignoreBlankLines: false, changesOnly: false });
    } else {
      renderUnifiedDiff(body, historical, this.current, {
        ignoreWhitespace: false,
        onRestoreHunk: (target) => {
          this.current = target;
          new Notice(tr("演示：这一段已换回旧版，别的段落不动。真实使用时会先预览，再写回笔记，并且可以撤销。", "Demo: that paragraph is back to the old version and nothing else moved. In real use you preview first, then it is written to the note and can be undone."), 6000);
          this.render();
        }
      });
    }

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(tr("关闭", "Close")).onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText(tr("怎样开始用 Git", "How to start with Git")).onClick(() => {
        window.open(this.guideUrl);
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
