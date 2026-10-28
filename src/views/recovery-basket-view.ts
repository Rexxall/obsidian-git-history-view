import {
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import type GitNoteHistoryPlugin from "../main";
import { buildRecoveryBasketPlan } from "../recovery-basket/planner";
import type {
  RecoveryBasketIssue,
  RecoveryBasketPlan,
  RecoveryBasketState
} from "../recovery-basket/types";
import { RestorePreviewModal } from "../ui/restore-preview-modal";
import { ConfirmActionModal } from "../ui/confirm-modal";

export const GIT_RECOVERY_BASKET_VIEW_TYPE = "git-recovery-basket-view";

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function operationLabel(operation: "replace" | "insert" | "delete"): string {
  return {
    replace: "替换",
    insert: "插入",
    delete: "删除"
  }[operation];
}

function issueIcon(issue: RecoveryBasketIssue): string {
  if (issue.severity === "blocking") return "octagon-alert";
  if (issue.kind === "link-removal") return "unlink";
  if (issue.kind.startsWith("duplicate")) return "copy-check";
  return "info";
}

export class GitRecoveryBasketView extends ItemView {
  private filePath = "";
  private file: TFile | null = null;
  private basket: RecoveryBasketState | null = null;
  private plan: RecoveryBasketPlan | null = null;
  private loading = false;
  private error = "";
  private generation = 0;
  private actionInFlight = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: GitNoteHistoryPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return GIT_RECOVERY_BASKET_VIEW_TYPE;
  }

  getDisplayText(): string {
    const count = this.basket?.items.length ?? 0;
    return count > 0 ? `恢复篮子 · ${count}` : "恢复篮子";
  }

  getIcon(): string {
    return "shopping-basket";
  }

  async onOpen(): Promise<void> {
    this.render();
    if (this.filePath) await this.refresh();
  }

  async onClose(): Promise<void> {
    this.generation += 1;
  }

  async setFile(file: TFile): Promise<void> {
    this.filePath = file.path;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const file = this.app.vault.getFileByPath(this.filePath);
      if (!file || file.extension !== "md") {
        this.file = null;
        this.basket = this.plugin.getRecoveryBasket(this.filePath) ?? null;
        this.plan = null;
        this.error = `找不到恢复篮子的目标笔记：${this.filePath}`;
        return;
      }
      const currentContent = await this.app.vault.read(file);
      if (generation !== this.generation) return;
      const basket = this.plugin.getRecoveryBasket(file.path) ?? null;
      this.file = file;
      this.basket = basket;
      this.plan = basket
        ? buildRecoveryBasketPlan(basket, currentContent)
        : null;
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
    const container = this.contentEl;
    container.empty();
    container.addClass("ap", "git-recovery-basket-view");
    this.renderHeader(container);
    if (this.loading) {
      const state = container.createDiv({
        cls: "git-recovery-basket-state is-loading",
        attr: { role: "status", "aria-live": "polite" }
      });
      setIcon(state.createSpan(), "loader-circle");
      state.createDiv({ text: "正在核对冻结基线和篮子项目…" });
      return;
    }
    if (this.error) {
      const state = container.createDiv({
        cls: "git-recovery-basket-state is-error",
        attr: { role: "alert" }
      });
      setIcon(state.createSpan(), "triangle-alert");
      state.createDiv({ text: this.error });
      return;
    }
    if (!this.filePath) {
      this.renderEmpty(container, "请先打开一篇 Markdown 笔记，再打开恢复篮子。");
      return;
    }
    if (!this.basket || this.basket.items.length === 0 || !this.plan) {
      this.renderEmpty(
        container,
        "这篇笔记的恢复篮子还是空的。请从历史版本对比中的修改块或属性旁加入内容。"
      );
      return;
    }
    this.renderBaseline(container, this.basket, this.plan);
    this.renderItems(container, this.basket, this.plan);
    this.renderChecks(container, this.plan);
    this.renderFinalPreview(container, this.plan);
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv({ cls: "git-recovery-basket-header" });
    const identity = header.createDiv({ cls: "git-recovery-basket-identity" });
    const eyebrow = identity.createDiv({ cls: "git-recovery-basket-eyebrow" });
    setIcon(eyebrow.createSpan(), "shopping-basket");
    eyebrow.createSpan({ text: "恢复篮子" });
    eyebrow.createSpan({
      cls: "git-recovery-basket-transaction",
      text: "统一预演 · 一次写回"
    });
    identity.createEl("h2", {
      text: this.filePath ? this.filePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? "恢复篮子" : "恢复篮子"
    });
    if (this.filePath) {
      identity.createDiv({
        cls: "git-recovery-basket-file-path",
        text: this.filePath
      });
    }
    const actions = header.createDiv({ cls: "git-recovery-basket-header-actions" });
    if (this.file) {
      const collect = actions.createEl("button");
      setIcon(collect.createSpan(), "history");
      collect.createSpan({ text: "继续收集" });
      collect.addEventListener("click", () =>
        void this.plugin.activateHistoryInMain(this.file)
      );
    }
    const refresh = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "重新核对恢复篮子" }
    });
    setIcon(refresh, "refresh-cw");
    refresh.disabled = this.loading;
    refresh.addEventListener("click", () => void this.refresh());
  }

  private renderEmpty(container: HTMLElement, message: string): void {
    const empty = container.createDiv({ cls: "git-recovery-basket-state is-empty" });
    setIcon(empty.createSpan(), "shopping-basket");
    const copy = empty.createDiv();
    copy.createEl("h3", { text: "先收集，再恢复" });
    copy.createDiv({ text: message });
    if (this.file) {
      const open = copy.createEl("button", { text: "打开这篇笔记的 Git 历史" });
      open.addEventListener("click", () =>
        void this.plugin.activateHistoryInMain(this.file)
      );
    }
  }

  private renderBaseline(
    container: HTMLElement,
    basket: RecoveryBasketState,
    plan: RecoveryBasketPlan
  ): void {
    const baseline = container.createDiv({
      cls: `git-recovery-basket-baseline ${plan.stale ? "is-stale" : "is-current"}`
    });
    setIcon(baseline.createSpan(), plan.stale ? "triangle-alert" : "snowflake");
    const copy = baseline.createDiv({ cls: "git-recovery-basket-baseline-copy" });
    copy.createEl("strong", {
      text: plan.stale ? "笔记已偏离冻结基线" : "目标仍与冻结基线一致"
    });
    copy.createDiv({
      text: plan.stale
        ? "可以继续查看方案，但应用已停止；清空后从最新内容重新收集。"
        : `篮子创建于 ${formatTime(basket.createdAt)}；所有项目统一相对这份内容合并。`
    });
    const metrics = baseline.createDiv({ cls: "git-recovery-basket-baseline-metrics" });
    metrics.createSpan({ text: `${basket.items.length} 项` });
    metrics.createSpan({ text: `+${plan.addedLines}` });
    metrics.createSpan({ text: `−${plan.deletedLines}` });
  }

  private renderItems(
    container: HTMLElement,
    basket: RecoveryBasketState,
    plan: RecoveryBasketPlan
  ): void {
    const section = container.createEl("section", { cls: "git-recovery-basket-items" });
    const heading = section.createDiv({ cls: "git-recovery-basket-section-heading" });
    const title = heading.createDiv();
    title.createEl("h3", { text: "恢复项目" });
    title.createSpan({ text: "按冻结基线定位；上下顺序只影响审阅，不改变锚点。" });
    const clear = heading.createEl("button", { text: "清空篮子" });
    clear.disabled = this.actionInFlight;
    clear.addEventListener("click", () => this.confirmClear());

    const blockingIds = new Set(
      plan.issues
        .filter((issue) => issue.severity === "blocking")
        .flatMap((issue) => issue.itemIds ?? [])
    );
    const duplicateIds = new Set(plan.skippedDuplicateItemIds);
    const list = section.createDiv({ cls: "git-recovery-basket-list" });
    basket.items.forEach((item, index) => {
      const row = list.createDiv({
        cls: [
          "git-recovery-basket-item",
          blockingIds.has(item.id) ? "has-blocker" : "",
          duplicateIds.has(item.id) ? "is-duplicate" : ""
        ].filter(Boolean).join(" "),
        attr: { draggable: "true" }
      });
      row.dataset.itemId = item.id;
      row.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", item.id);
        event.dataTransfer?.setDragImage(row, 20, 20);
      });
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer?.getData("text/plain");
        if (!sourceId || sourceId === item.id) return;
        const sourceIndex = basket.items.findIndex((candidate) => candidate.id === sourceId);
        if (sourceIndex < 0) return;
        const direction: -1 | 1 = sourceIndex < index ? 1 : -1;
        void this.moveItem(sourceId, direction);
      });

      const handle = row.createDiv({
        cls: "git-recovery-basket-item-handle",
        attr: { title: "拖动调整审阅顺序" }
      });
      setIcon(handle, "grip-vertical");
      const body = row.createDiv({ cls: "git-recovery-basket-item-body" });
      const top = body.createDiv({ cls: "git-recovery-basket-item-top" });
      top.createSpan({
        cls: `git-recovery-basket-operation is-${item.operation}`,
        text: operationLabel(item.operation)
      });
      top.createEl("strong", { text: item.label });
      if (item.kind === "property") {
        top.createSpan({ cls: "git-recovery-basket-kind", text: "属性" });
      }
      if (duplicateIds.has(item.id)) {
        top.createSpan({ cls: "git-recovery-basket-kind is-warning", text: "重复项" });
      }
      body.createDiv({
        cls: "git-recovery-basket-source",
        text: `${item.source.label} · 加入于 ${formatTime(item.addedAt)}`
      });
      const preview = body.createEl("details", { cls: "git-recovery-basket-item-preview" });
      preview.createEl("summary", { text: "查看这一项的前后内容" });
      const values = preview.createDiv();
      values.createDiv({ cls: "is-before", text: item.previewBefore || "无" });
      values.createDiv({ cls: "is-after", text: item.previewAfter || "无" });

      const controls = row.createDiv({ cls: "git-recovery-basket-item-actions" });
      const up = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `上移：${item.label}` }
      });
      setIcon(up, "arrow-up");
      up.disabled = index === 0 || this.actionInFlight;
      up.addEventListener("click", () => void this.moveItem(item.id, -1));
      const down = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `下移：${item.label}` }
      });
      setIcon(down, "arrow-down");
      down.disabled = index === basket.items.length - 1 || this.actionInFlight;
      down.addEventListener("click", () => void this.moveItem(item.id, 1));
      const remove = controls.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": `移除：${item.label}` }
      });
      setIcon(remove, "x");
      remove.disabled = this.actionInFlight;
      remove.addEventListener("click", () => void this.removeItem(item.id));
    });
  }

  private renderChecks(container: HTMLElement, plan: RecoveryBasketPlan): void {
    const section = container.createEl("section", { cls: "git-recovery-basket-checks" });
    const heading = section.createDiv({ cls: "git-recovery-basket-section-heading" });
    const title = heading.createDiv();
    title.createEl("h3", { text: "写回前检查" });
    const blockers = plan.issues.filter((issue) => issue.severity === "blocking").length;
    const warnings = plan.issues.filter((issue) => issue.severity === "warning").length;
    title.createSpan({
      text: blockers > 0
        ? `${blockers} 个阻止项 · ${warnings} 个提醒`
        : warnings > 0
          ? `没有阻止项 · ${warnings} 个提醒`
          : "没有发现冲突、重复、断链或属性覆盖"
    });
    if (plan.issues.length === 0) {
      const clear = section.createDiv({ cls: "git-recovery-basket-check is-clear" });
      setIcon(clear.createSpan(), "circle-check");
      clear.createSpan({ text: "方案可以生成最终 Markdown。" });
      return;
    }
    for (const issue of plan.issues) {
      const row = section.createDiv({
        cls: `git-recovery-basket-check is-${issue.severity}`
      });
      setIcon(row.createSpan(), issueIcon(issue));
      row.createSpan({ text: issue.message });
    }
  }

  private renderFinalPreview(container: HTMLElement, plan: RecoveryBasketPlan): void {
    const section = container.createEl("section", { cls: "git-recovery-basket-final" });
    const heading = section.createDiv({ cls: "git-recovery-basket-section-heading" });
    const title = heading.createDiv();
    title.createEl("h3", { text: "最终 Markdown 预演" });
    title.createSpan({
      text: `最终结果 +${plan.addedLines} / −${plan.deletedLines}；确认后只写回一次。`
    });
    const actions = heading.createDiv({ cls: "git-recovery-basket-final-actions" });
    const copy = actions.createEl("button");
    setIcon(copy.createSpan(), "copy");
    copy.createSpan({ text: "复制预演" });
    copy.addEventListener("click", () => void (async () => {
      await navigator.clipboard.writeText(plan.targetContent);
      new Notice("已复制最终 Markdown 预演。");
    })());
    const apply = actions.createEl("button", {
      cls: "mod-warning"
    });
    setIcon(apply.createSpan(), "archive-restore");
    apply.createSpan({ text: "应用全部项目…" });
    apply.disabled = !plan.canApply || this.actionInFlight;
    apply.addEventListener("click", () => this.confirmApply(plan));

    const preview = section.createEl("details", {
      cls: "git-recovery-basket-final-preview"
    });
    preview.open = true;
    preview.createEl("summary", { text: "查看合并后的完整笔记" });
    const rendered = preview.createDiv({
      cls: "markdown-preview-view git-recovery-basket-markdown-preview"
    });
    void MarkdownRenderer.render(
      this.app,
      plan.targetContent,
      rendered,
      plan.filePath,
      this
    );
  }

  private async moveItem(itemId: string, direction: -1 | 1): Promise<void> {
    if (this.actionInFlight) return;
    await this.plugin.moveRecoveryBasketItem(this.filePath, itemId, direction);
    await this.refresh();
  }

  private async removeItem(itemId: string): Promise<void> {
    if (this.actionInFlight) return;
    await this.plugin.removeRecoveryBasketItem(this.filePath, itemId);
    await this.refresh();
  }

  private confirmClear(): void {
    if (!this.basket || this.actionInFlight) return;
    new ConfirmActionModal(
      this.app,
      "清空恢复篮子？",
      `将移除 ${this.basket.items.length} 个尚未应用的恢复项目，不会修改笔记。`,
      "清空篮子",
      async () => {
        await this.plugin.clearRecoveryBasket(this.filePath);
        await this.refresh();
      }
    ).open();
  }

  private confirmApply(plan: RecoveryBasketPlan): void {
    const file = this.file;
    const basket = this.basket;
    if (!file || !basket || !plan.canApply || this.actionInFlight) return;
    const sources = [...new Set(basket.items.map((item) => item.source.label))];
    new RestorePreviewModal(this.app, {
      file,
      title: `应用恢复篮子 · ${basket.items.length} 项`,
      currentContent: plan.baselineContent,
      targetContent: plan.targetContent,
      label: `应用恢复篮子（${basket.items.length} 项）`,
      sourceLabel: sources.length <= 2
        ? sources.join("；")
        : `${sources.slice(0, 2).join("；")} 等 ${sources.length} 个版本`,
      scope: "basket",
      confirmText: "确认一次写回",
      onConfirm: async () => {
        if (this.actionInFlight) return;
        this.actionInFlight = true;
        try {
          const latestBasket = this.plugin.getRecoveryBasket(file.path);
          const latestFile = this.app.vault.getFileByPath(file.path);
          if (!latestBasket || !(latestFile instanceof TFile)) {
            new Notice("恢复篮子或目标笔记已经不存在。", 8000);
            return;
          }
          const currentContent = await this.app.vault.read(latestFile);
          const latestPlan = buildRecoveryBasketPlan(latestBasket, currentContent);
          if (!latestPlan.canApply) {
            new Notice("方案在确认前已经失效，请重新检查恢复篮子。", 8000);
            await this.refresh();
            return;
          }
          const changed = await this.plugin.restoreService.restore(
            latestFile,
            latestPlan.targetContent,
            {
              label: `应用恢复篮子（${latestBasket.items.length} 项）`,
              sourceLabel: sources.join("；"),
              scope: "basket",
              expectedCurrentContent: currentContent
            }
          );
          if (!changed) return;
          try {
            await this.plugin.clearRecoveryBasket(file.path);
          } catch (error) {
            new Notice(
              `笔记已写回，但恢复篮子未能清空：${error instanceof Error ? error.message : String(error)}`,
              9000
            );
          }
          this.plugin.refreshOpenViews();
          await this.refresh();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 9000);
        } finally {
          this.actionInFlight = false;
          this.render();
        }
      }
    }).open();
  }
}
