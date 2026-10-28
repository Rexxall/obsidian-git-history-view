import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type { GitCommitVersion } from "../models";
import {
  findBestMatchingBlock,
  findBlockAtLines,
  insertAfterMarkdownBlock,
  replaceMarkdownBlock,
  type MarkdownBlock,
  type MarkdownBlockMatch
} from "../history/markdown-blocks";
import { RestorePreviewModal } from "./restore-preview-modal";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
}

interface ParagraphVersion {
  commit: GitCommitVersion;
  match: MarkdownBlockMatch | null;
}

export class LineHistoryModal extends Modal {
  private currentContent = "";
  private currentBlock: MarkdownBlock | null = null;

  constructor(
    app: App,
    private readonly plugin: GitNoteHistoryPlugin,
    private readonly file: TFile,
    private readonly startLine: number,
    private readonly endLine: number,
    private readonly selectedText: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("git-note-history-paragraph-modal");
    this.setTitle(`段落历史 · 第 ${this.startLine}–${this.endLine} 行`);
    if (this.selectedText) {
      const quote = this.contentEl.createEl("pre", { cls: "git-note-history-line-selection" });
      quote.setText(this.selectedText.length > 800 ? `${this.selectedText.slice(0, 800)}…` : this.selectedText);
    }
    const loading = this.contentEl.createDiv({
      cls: "git-note-history-loading",
      text: "正在追踪这个 Markdown 区块的历史内容…"
    });
    void this.load(loading);
  }

  private async load(loading: HTMLElement): Promise<void> {
    try {
      const [history, currentContent] = await Promise.all([
        this.plugin.gitClient.loadFileHistory(this.file),
        this.app.vault.read(this.file)
      ]);
      this.currentContent = currentContent;
      this.currentBlock = findBlockAtLines(currentContent, this.startLine - 1, this.endLine - 1);
      const source = this.currentBlock ?? {
        content: this.selectedText,
        headingPath: [],
        kind: "paragraph" as const
      };
      const candidates = history.commits.slice(0, 80);
      const rawVersions: ParagraphVersion[] = [];
      for (let index = 0; index < candidates.length; index += 8) {
        const batch = await Promise.all(candidates.slice(index, index + 8).map(async (commit): Promise<ParagraphVersion> => {
          try {
            const content = await this.plugin.gitClient.getFileContent(
              history.context.repositoryRoot,
              commit.hash,
              commit.historicalPath
            );
            return { commit, match: findBestMatchingBlock(source, content) };
          } catch {
            return { commit, match: null };
          }
        }));
        rawVersions.push(...batch);
      }
      let previousSignature = "\u0000current";
      const versions = rawVersions.filter((version) => {
        const signature = version.match?.block.content.trim() ?? "\u0000missing";
        if (signature === previousSignature) return false;
        previousSignature = signature;
        return true;
      });

      loading.remove();
      if (versions.length === 0) {
        this.contentEl.createDiv({ cls: "git-note-history-empty", text: "没有找到这段内容的 Git 历史。" });
        return;
      }
      const intro = this.contentEl.createDiv({ cls: "git-note-history-paragraph-intro" });
      intro.createSpan({ text: "插件会结合内容相似度与标题路径追踪移动过的段落。恢复只修改当前区块，并保留一次撤销。" });
      const list = this.contentEl.createDiv({ cls: "git-note-history-line-commits" });
      for (const version of versions) this.renderCommit(list, version, history.context.repositoryRoot);
    } catch (error) {
      loading.remove();
      this.contentEl.createEl("pre", {
        cls: "git-note-history-error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private renderCommit(
    container: HTMLElement,
    version: ParagraphVersion,
    repositoryRoot: string
  ): void {
    const { commit, match } = version;
    const row = container.createDiv({ cls: "git-note-history-line-commit" });
    const header = row.createDiv({ cls: "git-note-history-paragraph-version-header" });
    const icon = header.createSpan();
    setIcon(icon, "git-commit-horizontal");
    const body = header.createSpan({ cls: "git-note-history-paragraph-version-title" });
    body.createSpan({ cls: "git-note-history-commit-subject", text: commit.subject || commit.shortHash });
    body.createSpan({
      cls: "git-note-history-commit-meta",
      text: `${formatDate(commit.authoredAt)} · ${commit.authorName}`
    });
    const confidence = header.createSpan({
      cls: `git-note-history-match-score ${match && match.score >= 0.75 ? "is-strong" : ""}`,
      text: match ? `${Math.round(match.score * 100)}% 匹配` : "未匹配"
    });
    confidence.setAttribute("aria-label", "历史段落匹配置信度");

    if (match) {
      const path = match.block.headingPath.join(" › ");
      if (path) row.createDiv({ cls: "git-note-history-paragraph-path", text: path });
      const preview = row.createEl("pre", { cls: "git-note-history-paragraph-preview" });
      preview.setText(match.block.content.length > 1200
        ? `${match.block.content.slice(0, 1200)}…`
        : match.block.content);
    } else {
      row.createDiv({
        cls: "git-note-history-paragraph-missing",
        text: "这个版本中没有可靠匹配到该段落；仍可打开完整版本检查。"
      });
    }

    const actions = row.createDiv({ cls: "git-note-history-paragraph-actions" });
    const detail = actions.createEl("button", { text: "查看整版" });
    detail.addEventListener("click", () => {
      this.close();
      void this.plugin.openDetail({
        filePath: this.file.path,
        repositoryRoot,
        base: { kind: "commit", commit },
        target: { kind: "working", label: "当前工作区" },
        initialMode: "side-by-side"
      });
    });

    if (!match || !this.currentBlock) return;
    const copy = actions.createEl("button", { text: "复制段落" });
    copy.addEventListener("click", () => void (async () => {
      await navigator.clipboard.writeText(match.block.content);
      new Notice("已复制历史段落。");
    })());
    const insert = actions.createEl("button", { text: "插入到后面" });
    insert.addEventListener("click", () => void this.confirmParagraphChange(commit, match.block.content, "insert"));
    const replace = actions.createEl("button", { cls: "mod-warning", text: "替换当前段落" });
    replace.addEventListener("click", () => void this.confirmParagraphChange(commit, match.block.content, "replace"));
  }

  private async confirmParagraphChange(
    commit: GitCommitVersion,
    historicalBlock: string,
    action: "replace" | "insert"
  ): Promise<void> {
    if (!this.currentBlock) return;
    const targetContent = action === "replace"
      ? replaceMarkdownBlock(this.currentContent, this.currentBlock, historicalBlock)
      : insertAfterMarkdownBlock(this.currentContent, this.currentBlock, historicalBlock);
    const verb = action === "replace" ? "替换" : "插入";
    new RestorePreviewModal(this.app, {
      file: this.file,
      title: `安全${verb}历史段落`,
      currentContent: this.currentContent,
      targetContent,
      label: `${verb}历史段落`,
      sourceLabel: `${commit.shortHash} · ${commit.subject || "无提交说明"}`,
      scope: "paragraph",
      confirmText: `确认${verb}段落`,
      onConfirm: async () => {
        try {
          const changed = await this.plugin.restoreService.restore(
            this.file,
            targetContent,
            {
              label: `${verb}历史段落`,
              sourceLabel: `${commit.shortHash} · ${commit.subject || "无提交说明"}`,
              scope: "paragraph",
              expectedCurrentContent: this.currentContent
            }
          );
          if (changed) {
            this.close();
            this.plugin.refreshOpenViews();
          }
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        }
      }
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
