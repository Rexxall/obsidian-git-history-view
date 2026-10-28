import { App, Component, MarkdownRenderer, Modal, Setting, TFile, setIcon } from "obsidian";
import { diffLines } from "diff";
import { buildLinkImpact } from "../analysis/link-impact";
import {
  buildRecoveryImpactWave,
  extractFrontmatterAliases,
  type IncomingKnowledgeReference
} from "../analysis/recovery-impact";
import { buildSemanticDiff } from "../diff/semantic-diff";
import type { RestoreScope } from "../models";

export interface RestorePreviewOptions {
  file: TFile;
  title: string;
  currentContent: string;
  targetContent: string;
  label: string;
  sourceLabel?: string;
  scope: RestoreScope;
  confirmText: string;
  onConfirm: () => Promise<void>;
  onSaveCopy?: () => Promise<void>;
}

function lineStats(before: string, after: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const part of diffLines(before, after)) {
    const count = Math.max(0, part.count ?? part.value.split(/\r?\n/).length - 1);
    if (part.added) added += count;
    if (part.removed) deleted += count;
  }
  return { added, deleted };
}

export class RestorePreviewModal extends Modal {
  private readonly renderer = new Component();

  constructor(app: App, private readonly options: RestorePreviewOptions) {
    super(app);
  }

  onOpen(): void {
    this.renderer.load();
    this.modalEl.addClass("ap", "ap-modal", "git-note-history-restore-preview-modal");
    this.setTitle(this.options.title);
    const intro = this.contentEl.createDiv({ cls: "git-note-history-restore-preflight" });
    const title = intro.createDiv({ cls: "git-note-history-restore-preflight-title" });
    setIcon(title.createSpan(), "shield-check");
    const text = title.createDiv();
    text.createEl("strong", { text: this.options.label });
    text.createDiv({
      text: `${this.options.file.path}${this.options.sourceLabel ? ` · 来源 ${this.options.sourceLabel}` : ""}`
    });

    const stats = lineStats(this.options.currentContent, this.options.targetContent);
    const semantic = buildSemanticDiff(this.options.currentContent, this.options.targetContent);
    const impact = buildLinkImpact(this.options.currentContent, this.options.targetContent);
    const incomingReferences = this.collectIncomingReferences(
      extractFrontmatterAliases(this.options.currentContent)
    );
    const wave = buildRecoveryImpactWave(
      this.options.currentContent,
      this.options.targetContent,
      {
        incomingReferences,
        resolvesTarget: (relation) => Boolean(
          this.app.metadataCache.getFirstLinkpathDest(
            relation.target,
            this.options.file.path
          )
        )
      }
    );
    const metrics = intro.createDiv({ cls: "git-note-history-restore-metrics" });
    metrics.createSpan({ cls: "is-added", text: `+${stats.added} 行` });
    metrics.createSpan({ cls: "is-removed", text: `−${stats.deleted} 行` });
    metrics.createSpan({ text: `${semantic.length} 个结构变化` });
    metrics.createSpan({
      cls: wave.severity === "danger"
        ? "is-danger"
        : wave.severity === "review"
          ? "is-warning"
          : "is-safe",
      text: wave.summary
    });

    if (semantic.length > 0 || impact.removed.length > 0) {
      const checks = this.contentEl.createDiv({ cls: "git-note-history-restore-checks" });
      checks.createEl("h5", { text: "写回前检查" });
      for (const change of semantic.slice(0, 8)) {
        checks.createDiv({
          cls: `git-note-history-restore-check is-${change.kind}`,
          text: `${change.kind === "added" ? "+" : change.kind === "removed" ? "−" : "↔"} ${change.group} · ${change.label}`
        });
      }
      if (semantic.length > 8) checks.createDiv({ text: `另有 ${semantic.length - 8} 项结构变化` });
      for (const relation of impact.removed.slice(0, 6)) {
        checks.createDiv({
          cls: "git-note-history-restore-check is-warning",
          text: `− 将移除 ${relation.kind === "tag" ? "标签" : "关系"}：${relation.label}`
        });
      }
    }

    const wavePanel = this.contentEl.createEl("details", {
      cls: `git-note-history-restore-wave is-${wave.severity}`
    });
    const waveSummary = wavePanel.createEl("summary");
    const waveIcon = waveSummary.createSpan();
    setIcon(
      waveIcon,
      wave.severity === "danger"
        ? "circle-alert"
        : wave.severity === "review"
          ? "waves"
          : "shield-check"
    );
    const waveHeading = waveSummary.createDiv();
    waveHeading.createEl("strong", { text: "恢复冲击波" });
    waveHeading.createSpan({ text: wave.summary });
    const waveMetrics = wavePanel.createDiv({
      cls: "git-note-history-restore-wave-metrics"
    });
    waveMetrics.createDiv({
      text: `${wave.restoredRelations.length}`,
      attr: { "data-label": "恢复旧关系" }
    });
    waveMetrics.createDiv({
      text: `${wave.missingTargets.length}`,
      attr: { "data-label": "恢复后断链" }
    });
    waveMetrics.createDiv({
      text: `${wave.brokenIncomingReferences.length}`,
      attr: { "data-label": "受影响反链" }
    });
    waveMetrics.createDiv({
      text: `${wave.missingAttachments.length}`,
      attr: { "data-label": "缺失附件" }
    });
    if (wave.findings.length === 0) {
      const safe = wavePanel.createDiv({
        cls: "git-note-history-restore-wave-safe"
      });
      setIcon(safe.createSpan(), "circle-check-big");
      safe.createSpan({
        text: "当前 Vault 中未发现会因这次恢复新增的断链、缺失附件或失效入站锚点。"
      });
    } else {
      const findings = wavePanel.createDiv({
        cls: "git-note-history-restore-wave-findings"
      });
      for (const finding of wave.findings.slice(0, 16)) {
        const row = findings.createDiv({
          cls: `is-${finding.severity}`
        });
        setIcon(
          row.createSpan(),
          finding.severity === "danger"
            ? "circle-alert"
            : finding.severity === "warning"
              ? "triangle-alert"
              : "minus"
        );
        const copy = row.createDiv();
        copy.createEl("strong", { text: finding.title });
        copy.createDiv({ text: finding.detail });
      }
      if (wave.findings.length > 16) {
        findings.createDiv({
          text: `另有 ${wave.findings.length - 16} 项影响未展开`
        });
      }
    }

    const result = this.contentEl.createEl("details", { cls: "git-note-history-restore-result" });
    result.createEl("summary", { text: "查看恢复后的完整内容" });
    const preview = result.createDiv({ cls: "markdown-preview-view git-note-history-restore-markdown-preview" });
    void MarkdownRenderer.render(
      this.app,
      this.options.targetContent,
      preview,
      this.options.file.path,
      this.renderer
    );

    const safety = this.contentEl.createDiv({ cls: "git-note-history-restore-safety-note" });
    setIcon(safety.createSpan(), "history");
    safety.createSpan({
      text: "确认后会先保存恢复前内容并生成回执；插件不会修改 HEAD、分支或 Git 暂存区。"
    });

    let cancelButton: HTMLButtonElement | null = null;
    let saveButton: HTMLButtonElement | null = null;
    let confirmButton: HTMLButtonElement | null = null;
    let actionInFlight = false;
    const beginAction = (): boolean => {
      if (actionInFlight) return false;
      actionInFlight = true;
      if (cancelButton) cancelButton.disabled = true;
      if (saveButton) saveButton.disabled = true;
      if (confirmButton) confirmButton.disabled = true;
      return true;
    };
    new Setting(this.contentEl)
      .addButton((button) => {
        cancelButton = button.buttonEl;
        button.setButtonText("取消").onClick(() => this.close());
      })
      .addButton((button) => {
        saveButton = button.buttonEl;
        if (!this.options.onSaveCopy) {
          button.buttonEl.hide();
          return;
        }
        button.setButtonText("另存副本").onClick(async () => {
          if (!beginAction()) return;
          try {
            await this.options.onSaveCopy?.();
          } finally {
            this.close();
          }
        });
      })
      .addButton((button) => {
        confirmButton = button.buttonEl;
        button
          .setButtonText(this.options.confirmText)
          .setWarning()
          .onClick(async () => {
            if (!beginAction()) return;
            try {
              await this.options.onConfirm();
            } finally {
              this.close();
            }
          });
      });

    window.setTimeout(() => cancelButton?.focus(), 0);
  }

  onClose(): void {
    this.renderer.unload();
    this.contentEl.empty();
  }

  private collectIncomingReferences(
    aliases: string[]
  ): IncomingKnowledgeReference[] {
    const references: IncomingKnowledgeReference[] = [];
    const aliasesByLower = new Map(
      aliases.map((alias) => [alias.toLocaleLowerCase(), alias])
    );
    for (const source of this.app.vault.getMarkdownFiles()) {
      if (source.path === this.options.file.path) continue;
      const cache = this.app.metadataCache.getFileCache(source);
      const groups = [
        { kind: "link" as const, items: cache?.links ?? [] },
        { kind: "embed" as const, items: cache?.embeds ?? [] }
      ];
      for (const group of groups) {
        for (const item of group.items) {
          const raw = item.link.trim();
          const subpathIndex = [raw.indexOf("#"), raw.indexOf("^")]
            .filter((index) => index >= 0)
            .sort((a, b) => a - b)[0];
          const linkpath = (
            subpathIndex === undefined ? raw : raw.slice(0, subpathIndex)
          ).trim();
          const destination = this.app.metadataCache.getFirstLinkpathDest(
            linkpath,
            source.path
          );
          if (destination?.path !== this.options.file.path) continue;
          const subpath = subpathIndex === undefined
            ? undefined
            : raw.slice(subpathIndex);
          const viaAlias = aliasesByLower.get(linkpath.toLocaleLowerCase());
          references.push({
            sourcePath: source.path,
            sourceLabel: source.basename,
            kind: group.kind,
            ...(subpath ? { subpath } : {}),
            ...(viaAlias ? { viaAlias } : {})
          });
        }
      }
    }
    return references;
  }
}
