import { App, Modal, TFile, setIcon } from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import {
  extractMarkdownBlocks,
  findBestMatchingBlock,
  type MarkdownBlock
} from "../history/markdown-blocks";
import type { GitCommitVersion } from "../models";
import { tr } from "../i18n";

interface AgedBlock {
  block: MarkdownBlock;
  firstSeen?: GitCommitVersion;
  lastChanged?: GitCommitVersion;
  uncommitted: boolean;
}

function formatDate(value?: string): string {
  if (!value) return tr("未知", "Unknown");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function signature(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export class BlockAgeModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: GitNoteHistoryPlugin,
    private readonly file: TFile
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ap", "ap-modal", "git-note-history-block-age-modal");
    this.setTitle(tr(`内容年龄镜头 · ${this.file.basename}`, `Content age lens · ${this.file.basename}`));
    const intro = this.contentEl.createDiv({ cls: "git-note-history-block-age-intro" });
    setIcon(intro.createSpan(), "scan-eye");
    intro.createSpan({ text: tr("按标题和段落估算首次出现与最近内容变化；关闭弹窗后不会在编辑器留下装饰。", "Estimates first appearance and last change per heading and paragraph; nothing stays in the editor after closing.") });
    const loading = this.contentEl.createDiv({
      cls: "git-note-history-loading",
      text: tr("正在沿 Git 历史追踪 Markdown 区块…", "Tracing Markdown blocks through Git history…")
    });
    void this.load(loading);
  }

  private async load(loading: HTMLElement): Promise<void> {
    try {
      const [history, currentContent] = await Promise.all([
        this.plugin.gitClient.loadFileHistory(this.file),
        this.app.vault.read(this.file)
      ]);
      const commits = history.commits.slice(0, 48);
      const contents = new Map<string, string>();
      for (let index = 0; index < commits.length; index += 8) {
        const batch = commits.slice(index, index + 8);
        const loaded = await Promise.all(batch.map(async (commit) => {
          try {
            return await this.plugin.gitClient.getFileContent(
              history.context.repositoryRoot,
              commit.hash,
              commit.historicalPath
            );
          } catch {
            return null;
          }
        }));
        batch.forEach((commit, offset) => {
          const content = loaded[offset];
          if (content !== null && content !== undefined) contents.set(commit.hash, content);
        });
      }

      const blocks = extractMarkdownBlocks(currentContent)
        .filter((block) => block.kind !== "frontmatter")
        .slice(0, 36);
      const aged = blocks.map((block): AgedBlock => {
        const versions = commits.map((commit) => {
          const content = contents.get(commit.hash);
          const match = content ? findBestMatchingBlock(block, content) : null;
          return { commit, match: match && match.score >= 0.58 ? match : null };
        });
        const matching = versions.filter((version) => version.match);
        const firstSeen = matching.at(-1)?.commit;
        let lastChanged: GitCommitVersion | undefined;
        let previous = "";
        for (const version of [...matching].reverse()) {
          const next = signature(version.match!.block.content);
          if (previous && next !== previous) lastChanged = version.commit;
          previous = next;
        }
        const newest = matching[0]?.match?.block.content;
        return {
          block,
          uncommitted: newest === undefined || signature(newest) !== signature(block.content),
          ...(firstSeen ? { firstSeen } : {}),
          ...(lastChanged ?? matching[0]?.commit
            ? { lastChanged: lastChanged ?? matching[0]!.commit }
            : {})
        };
      });

      loading.remove();
      if (aged.length === 0) {
        this.contentEl.createDiv({ cls: "git-note-history-empty", text: tr("没有可追踪的 Markdown 内容区块。", "No Markdown blocks to trace.") });
        return;
      }
      const list = this.contentEl.createDiv({ cls: "git-note-history-block-age-list" });
      for (const item of aged) this.renderBlock(list, item);
      if (extractMarkdownBlocks(currentContent).length > aged.length) {
        this.contentEl.createDiv({
          cls: "git-note-history-block-age-limit",
          text: tr(`为保持响应速度，本次显示前 ${aged.length} 个内容区块。`, `To stay responsive, the first ${aged.length} blocks are shown.`)
        });
      }
    } catch (error) {
      loading.remove();
      this.contentEl.createEl("pre", {
        cls: "git-note-history-error",
        text: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private renderBlock(container: HTMLElement, item: AgedBlock): void {
    const row = container.createEl("button", { cls: "git-note-history-block-age-row" });
    const icon = row.createSpan({ cls: "git-note-history-block-age-icon" });
    setIcon(icon, item.block.kind === "heading" ? "heading" : item.block.kind === "list" ? "list" : "pilcrow");
    const body = row.createSpan({ cls: "git-note-history-block-age-body" });
    const title = item.block.kind === "heading"
      ? item.block.content.replace(/^#{1,6}\s+/, "")
      : item.block.content.replace(/\s+/g, " ").slice(0, 110);
    body.createSpan({ cls: "git-note-history-block-age-title", text: title || tr("（空区块）", "(empty block)") });
    const path = item.block.headingPath.join(" › ");
    if (path && item.block.kind !== "heading") body.createSpan({ cls: "git-note-history-block-age-path", text: path });
    const meta = body.createSpan({ cls: "git-note-history-block-age-meta" });
    meta.createSpan({ text: tr(`首次出现 ${formatDate(item.firstSeen?.authoredAt)}`, `First seen ${formatDate(item.firstSeen?.authoredAt)}`) });
    meta.createSpan({ text: item.uncommitted ? tr("当前工作区有新修改", "New edits in the working copy") : tr(`最近变化 ${formatDate(item.lastChanged?.authoredAt)}`, `Last changed ${formatDate(item.lastChanged?.authoredAt)}`) });
    row.addEventListener("click", () => void (async () => {
      this.close();
      await this.plugin.openFileAtLine(this.file, item.block.startLine);
    })());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
