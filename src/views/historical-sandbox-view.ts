import {
  ItemView,
  Notice,
  setIcon,
  WorkspaceLeaf
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import type {
  HistoricalSandboxInspection,
  HistoricalSandboxRecord
} from "../sandbox/types";
import { ConfirmActionModal } from "../ui/confirm-modal";
import { tr } from "../i18n";

export const GIT_HISTORICAL_SANDBOX_VIEW_TYPE =
  "git-historical-sandbox-view";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function availabilityLabel(
  inspection: HistoricalSandboxInspection
): string {
  return {
    ready: inspection.hasChanges ? tr("有实验改动", "Has experimental edits") : tr("目录完整", "Folder intact"),
    missing: tr("目录已丢失", "Folder missing"),
    untrusted: tr("身份标记异常", "Identity marker mismatch"),
    detached: tr("Git 连接异常", "Git link broken"),
    "wrong-commit": tr("基点已改变", "Base commit changed")
  }[inspection.availability];
}

export class GitHistoricalSandboxView extends ItemView {
  private loading = false;
  private error = "";
  private inspections: HistoricalSandboxInspection[] = [];
  private generation = 0;
  private showArchived = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_HISTORICAL_SANDBOX_VIEW_TYPE;
  }

  getDisplayText(): string {
    const active = this.inspections.filter(
      (item) => item.record.lifecycle === "active"
    ).length;
    return active > 0 ? tr(`历史沙盒 · ${active}`, `Historical sandbox · ${active}`) : tr("历史沙盒", "Historical sandboxes");
  }

  getIcon(): string {
    return "boxes";
  }

  async onOpen(): Promise<void> {
    this.render();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.generation += 1;
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const inspections = await this.plugin.inspectHistoricalSandboxes();
      if (generation !== this.generation) return;
      this.inspections = inspections;
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("ap", "git-note-history-root", "git-note-history-sandbox-root");

    const header = container.createDiv({ cls: "git-note-history-sandbox-header" });
    const heading = header.createDiv({ cls: "git-note-history-sandbox-heading" });
    setIcon(heading.createSpan(), "boxes");
    const labels = heading.createDiv();
    labels.createEl("h2", { text: tr("历史沙盒", "Historical sandboxes") });
    labels.createDiv({
      cls: "git-note-history-sandbox-subtitle",
      text: tr("走进整套旧 Vault；当前工作区不会被切换、checkout 或覆盖。", "Step into a whole old vault. Your current vault is not switched, checked out or overwritten.")
    });
    const refresh = header.createEl("button", {
      cls: this.loading ? "clickable-icon is-loading" : "clickable-icon",
      attr: {
        "aria-label": this.loading ? tr("正在核对沙盒", "Checking sandboxes") : tr("重新核对沙盒", "Check sandboxes again")
      }
    });
    refresh.disabled = this.loading;
    setIcon(refresh, this.loading ? "loader-circle" : "refresh-cw");
    refresh.addEventListener("click", () => void this.refresh());

    const safety = container.createDiv({ cls: "git-note-history-sandbox-safety" });
    setIcon(safety.createSpan(), "shield-check");
    safety.createDiv({
      text: tr("新建时默认只读，并禁用历史中的社区插件。需要试改时，必须明确升级为可编辑沙盒。", "New sandboxes are read-only and turn off the community plugins from that time. To try edits, upgrade one to an editable sandbox.")
    });

    if (this.error) {
      const error = container.createDiv({
        cls: "git-note-history-error",
        attr: { role: "alert" }
      });
      setIcon(error.createSpan(), "triangle-alert");
      error.createSpan({ text: this.error });
      return;
    }

    const active = this.inspections.filter(
      (item) => item.record.lifecycle === "active"
    );
    const archived = this.inspections.filter(
      (item) => item.record.lifecycle === "archived"
    );
    if (!this.loading && active.length === 0 && archived.length === 0) {
      const empty = container.createDiv({ cls: "git-note-history-sandbox-empty" });
      setIcon(empty.createSpan(), "archive-restore");
      empty.createEl("h3", { text: tr("还没有历史沙盒", "No historical sandboxes yet") });
      empty.createEl("p", {
        text: tr("在任意历史版本的“更多”菜单中选择“创建只读时间胶囊”。", "In any version's More menu, choose Create read-only time capsule.")
      });
      return;
    }

    const list = container.createDiv({ cls: "git-note-history-sandbox-list" });
    for (const inspection of active) this.renderCard(list, inspection);

    if (archived.length > 0) {
      const archivedToggle = container.createEl("button", {
        cls: "git-note-history-sandbox-archive-toggle",
        attr: { "aria-expanded": String(this.showArchived) }
      });
      setIcon(archivedToggle.createSpan(), "archive");
      archivedToggle.createSpan({ text: tr(`已归档 ${archived.length}`, `${archived.length} archived`) });
      setIcon(
        archivedToggle.createSpan(),
        this.showArchived ? "chevron-up" : "chevron-down"
      );
      archivedToggle.addEventListener("click", () => {
        this.showArchived = !this.showArchived;
        this.render();
      });
      if (this.showArchived) {
        const archiveList = container.createDiv({
          cls: "git-note-history-sandbox-list is-archived"
        });
        for (const inspection of archived) {
          this.renderCard(archiveList, inspection);
        }
      }
    }
  }

  private renderCard(
    container: HTMLElement,
    inspection: HistoricalSandboxInspection
  ): void {
    const { record } = inspection;
    const card = container.createDiv({
      cls: `git-note-history-sandbox-card is-${record.mode} is-${inspection.availability}`
    });
    const top = card.createDiv({ cls: "git-note-history-sandbox-card-top" });
    const identity = top.createDiv({ cls: "git-note-history-sandbox-card-identity" });
    const icon = identity.createSpan();
    setIcon(icon, record.mode === "capsule" ? "lock-keyhole" : "flask-conical");
    const text = identity.createDiv();
    text.createEl("h3", { text: record.name });
    const badges = text.createDiv({ cls: "git-note-history-sandbox-badges" });
    badges.createSpan({
      cls: `git-note-history-sandbox-badge is-${record.mode}`,
      text: record.mode === "capsule" ? tr("只读时间胶囊", "Read-only time capsule") : tr("可编辑沙盒", "Editable sandbox")
    });
    badges.createSpan({
      cls: `git-note-history-sandbox-badge is-${inspection.availability}`,
      text: availabilityLabel(inspection)
    });
    if (record.lifecycle === "archived") {
      badges.createSpan({
        cls: "git-note-history-sandbox-badge",
        text: tr("已归档", "Archived")
      });
    }
    top.createDiv({
      cls: "git-note-history-sandbox-created",
      text: formatDate(record.createdAt)
    });

    const source = card.createDiv({ cls: "git-note-history-sandbox-source" });
    source.createSpan({
      cls: "git-note-history-sandbox-hash",
      text: record.source.shortHash
    });
    source.createSpan({
      text: record.source.commitSubject || tr("无提交说明", "No commit message")
    });
    if (record.source.commitAuthoredAt) {
      source.createSpan({ text: formatDate(record.source.commitAuthoredAt) });
    }

    const path = card.createDiv({
      cls: "git-note-history-sandbox-path",
      attr: { title: record.vaultPath }
    });
    setIcon(path.createSpan(), "folder");
    path.createSpan({ text: record.vaultPath });

    if (inspection.hasChanges) {
      const changes = card.createDiv({ cls: "git-note-history-sandbox-changes" });
      setIcon(changes.createSpan(), "file-diff");
      changes.createSpan({
        text: tr(`${inspection.changedPaths.length} 个已跟踪文件改变`, `${inspection.changedPaths.length} tracked files changed`)
      });
      if (inspection.untrackedPaths.length > 0) {
        changes.createSpan({
          text: tr(`${inspection.untrackedPaths.length} 个新文件`, `${inspection.untrackedPaths.length} new files`)
        });
      }
      this.renderChangedMarkdown(card, inspection);
    }

    const actions = card.createDiv({ cls: "git-note-history-sandbox-actions" });
    if (inspection.availability === "ready") {
      const firstOpen = actions.createEl("button", { text: tr("首次打开引导", "First-open guide") });
      setIcon(firstOpen.createSpan(), "folder-open");
      firstOpen.addEventListener("click", () => {
        void this.plugin.guideFirstSandboxOpen(record);
      });
      const open = actions.createEl("button", {
        cls: "mod-cta",
        text: tr("在 Obsidian 打开", "Open in Obsidian")
      });
      setIcon(open.createSpan(), "external-link");
      open.addEventListener("click", () => {
        void this.plugin.openRegisteredSandbox(record);
      });
      if (record.mode === "capsule") {
        const edit = actions.createEl("button", { text: tr("升级为可编辑", "Make editable") });
        setIcon(edit.createSpan(), "flask-conical");
        edit.addEventListener("click", () => this.confirmUpgrade(record));
      } else if (inspection.hasChanges) {
        const exportPatch = actions.createEl("button", { text: tr("导出补丁", "Export patch") });
        setIcon(exportPatch.createSpan(), "file-output");
        exportPatch.addEventListener("click", () => {
          void this.plugin.exportHistoricalSandboxPatch(record.id)
            .then(async (result) => {
              await navigator.clipboard.writeText(result.patchPath);
              new Notice(
                result.untrackedPaths.length > 0
                  ? tr("补丁已导出并复制路径；新文件已列入清单，但不在 Git patch 内。", "Patch exported and its path copied. New files are listed but not in the Git patch.")
                  : tr("补丁已导出，路径已复制。", "Patch exported and its path copied.")
              );
              void this.refresh();
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : String(error), 9000);
            });
        });
      }
    }

    const archive = actions.createEl("button", {
      text: record.lifecycle === "archived" ? tr("移回使用中", "Move back to active") : tr("归档", "Archive")
    });
    setIcon(archive.createSpan(), record.lifecycle === "archived" ? "archive-restore" : "archive");
    archive.addEventListener("click", () => {
      void this.plugin.setHistoricalSandboxArchived(
        record.id,
        record.lifecycle !== "archived"
      ).then(() => this.refresh());
    });
    const remove = actions.createEl("button", {
      cls: "mod-warning",
      text: inspection.availability === "missing"
        || inspection.availability === "untrusted"
        ? tr("移除失效记录", "Remove stale record")
        : tr("删除沙盒", "Delete sandbox")
    });
    setIcon(remove.createSpan(), "trash-2");
    remove.addEventListener("click", () => this.confirmRemove(record, inspection));
  }

  private renderChangedMarkdown(
    card: HTMLElement,
    inspection: HistoricalSandboxInspection
  ): void {
    const tracked = inspection.changedPaths.filter((filePath) =>
      filePath.toLocaleLowerCase().endsWith(".md")
    );
    const untracked = inspection.untrackedPaths.filter((filePath) =>
      filePath.toLocaleLowerCase().endsWith(".md")
    );
    if (tracked.length === 0 && untracked.length === 0) return;
    const files = card.createDiv({ cls: "git-note-history-sandbox-files" });
    for (const filePath of tracked.slice(0, 8)) {
      const row = files.createDiv({ cls: "git-note-history-sandbox-file" });
      setIcon(row.createSpan(), "file-pen-line");
      row.createSpan({ text: filePath, attr: { title: filePath } });
      const compare = row.createEl("button", { text: tr("选择带回", "Choose what to bring back") });
      compare.addEventListener("click", () => {
        void this.plugin.openHistoricalSandboxFileComparison(
          inspection.record.id,
          filePath
        ).catch((error: unknown) => {
          new Notice(error instanceof Error ? error.message : String(error), 9000);
        });
      });
    }
    for (const filePath of untracked.slice(0, Math.max(0, 8 - tracked.length))) {
      const row = files.createDiv({
        cls: "git-note-history-sandbox-file is-new"
      });
      setIcon(row.createSpan(), "file-plus-2");
      row.createSpan({ text: filePath, attr: { title: filePath } });
      const copy = row.createEl("button", { text: tr("复制到当前仓库", "Copy into the current repository") });
      copy.addEventListener("click", () => {
        this.confirmCopyNewNote(inspection.record, filePath);
      });
    }
    const remaining = tracked.length + untracked.length - 8;
    if (remaining > 0) {
      files.createDiv({
        cls: "git-note-history-sandbox-files-more",
        text: tr(`还有 ${remaining} 个 Markdown 文件；可导出补丁查看完整清单。`, `${remaining} more Markdown files; export the patch to see the full list.`)
      });
    }
  }

  private confirmUpgrade(record: HistoricalSandboxRecord): void {
    new ConfirmActionModal(
      this.app,
      tr("升级为可编辑历史沙盒？", "Make this historical sandbox editable?"),
      tr("升级后可以在隔离目录里修改文件，但仍不会改变当前 Vault。修改会作为沙盒实验保留，直到你导出或删除。", "You can then edit files in the isolated folder; your current vault still does not change. Edits stay as a sandbox experiment until you export or delete them."),
      tr("升级为可编辑", "Make editable"),
      async () => {
        try {
          await this.plugin.upgradeHistoricalSandbox(record.id);
          new Notice(tr("已升级为可编辑历史沙盒。", "The historical sandbox is now editable."));
          await this.refresh();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 9000);
        }
      }
    ).open();
  }

  private confirmRemove(
    record: HistoricalSandboxRecord,
    inspection: HistoricalSandboxInspection
  ): void {
    const changeWarning = inspection.hasChanges
      ? tr(`其中有 ${inspection.changedPaths.length + inspection.untrackedPaths.length} 个未导出的文件变化。`, `It has ${inspection.changedPaths.length + inspection.untrackedPaths.length} file changes that were not exported.`)
      : tr("其中没有检测到实验改动。", "No experimental edits were found in it.");
    const forgetOnly = inspection.availability === "missing"
      || inspection.availability === "untrusted";
    new ConfirmActionModal(
      this.app,
      forgetOnly ? tr("移除这条失效记录？", "Remove this stale record?") : tr("永久删除这个历史沙盒？", "Delete this historical sandbox for good?"),
      forgetOnly
        ? tr("插件不会触碰无法验证身份的目录，只会移除本地管理记录。若目录仍在，请随后手动检查。", "The plugin does not touch folders whose identity it cannot verify; only the local record is removed. If the folder is still there, check it yourself.")
        : tr(`${changeWarning} 删除只作用于受管沙盒目录，不会删除当前 Vault，但操作无法撤销。`, `${changeWarning} Deleting affects only the managed sandbox folder, never your current vault, and cannot be undone.`),
      forgetOnly ? tr("移除记录", "Remove record") : tr("永久删除", "Delete for good"),
      async () => {
        try {
          if (forgetOnly) {
            await this.plugin.forgetHistoricalSandboxRecord(record.id);
            new Notice(tr("失效的历史沙盒记录已移除，未触碰目录。", "Stale historical sandbox record removed; the folder was not touched."));
          } else {
            await this.plugin.removeHistoricalSandbox(record.id);
            new Notice(tr("历史沙盒已删除。", "Historical sandbox deleted."));
          }
          await this.refresh();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 9000);
        }
      },
      !forgetOnly
    ).open();
  }

  private confirmCopyNewNote(
    record: HistoricalSandboxRecord,
    repositoryPath: string
  ): void {
    new ConfirmActionModal(
      this.app,
      tr("把沙盒新笔记复制到当前 Vault？", "Copy the sandbox's new note into your current vault?"),
      tr(`将创建 ${repositoryPath} 对应的 Markdown 笔记；若当前 Vault 已有同路径文件，将停止而不会覆盖。`, `A Markdown note will be created at ${repositoryPath}. If your vault already has a file there, nothing is overwritten and this stops.`),
      tr("创建笔记", "Create note"),
      async () => {
        try {
          const file = await this.plugin.copyHistoricalSandboxNewNote(
            record.id,
            repositoryPath
          );
          new Notice(tr(`已创建 ${file.path}。`, `Created ${file.path}.`));
          await this.refresh();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 9000);
        }
      }
    ).open();
  }
}
