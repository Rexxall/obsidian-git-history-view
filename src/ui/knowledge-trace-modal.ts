import {
  App,
  Modal,
  Setting,
  TextAreaComponent,
  setIcon
} from "obsidian";
import type {
  KnowledgeAssertion,
  PropertyKnowledgeAssertion,
  RelationKnowledgeAssertion,
  StructureKnowledgeAssertion,
  TextKnowledgeAssertion
} from "../knowledge-trace/types";

export interface KnowledgeTraceSetupValue {
  filePath: string;
  assertion: KnowledgeAssertion;
  maxVersions: number;
}

export interface KnowledgeTraceSetupModalOptions {
  filePath: string;
  initialValue?: Partial<Omit<KnowledgeTraceSetupValue, "filePath">>;
  onSubmit: (value: KnowledgeTraceSetupValue) => void | Promise<void>;
}

type AssertionKind = KnowledgeAssertion["kind"];
type PropertyValueType = "string" | "number" | "boolean" | "null" | "json";
type AssertionControlFocus = "property-operator" | "property-value-type";

const DEFAULT_MAX_VERSIONS = 80;
const MIN_MAX_VERSIONS = 2;
const MAX_MAX_VERSIONS = 500;
let setupModalInstance = 0;
const BUILT_IN_RULE_IDS = [
  "no-conflict-markers",
  "valid-frontmatter",
  "nonempty-body"
] as const;

const ASSERTION_KINDS: ReadonlyArray<{
  kind: AssertionKind;
  label: string;
  icon: string;
}> = [
  { kind: "text", label: "文字", icon: "text-cursor-input" },
  { kind: "property", label: "属性", icon: "braces" },
  { kind: "relation", label: "关系", icon: "link-2" },
  { kind: "structure", label: "结构", icon: "blocks" },
  { kind: "rule", label: "规则", icon: "list-checks" },
  { kind: "manual", label: "人工", icon: "user-round-check" }
];

function compactPath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function inferredPropertyValueType(value: unknown): PropertyValueType {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "object") return "json";
  return "string";
}

function propertyValueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export class KnowledgeTraceSetupModal extends Modal {
  private assertionKind: AssertionKind;
  private textOperator: TextKnowledgeAssertion["operator"] = "contains";
  private textExpected = "";
  private textCaseSensitive = false;
  private propertyName = "";
  private propertyOperator: PropertyKnowledgeAssertion["operator"] = "exists";
  private propertyExpected = "";
  private propertyValueType: PropertyValueType = "string";
  private propertyCaseSensitive = false;
  private relationKind: RelationKnowledgeAssertion["relation"] = "wikilink";
  private relationOperator: RelationKnowledgeAssertion["operator"] = "exists";
  private relationTarget = "";
  private structureKind: StructureKnowledgeAssertion["structure"] = "heading";
  private structureOperator: StructureKnowledgeAssertion["operator"] = "exists";
  private structureValue = "";
  private ruleId: (typeof BUILT_IN_RULE_IDS)[number] = BUILT_IN_RULE_IDS[0];
  private manualPrompt = "";
  private maxVersions: number;
  private controlsEl?: HTMLElement;
  private maxVersionsInput?: HTMLInputElement;
  private submitButton?: HTMLButtonElement;
  private errorEl?: HTMLElement;
  private submitting = false;
  private readonly kindButtons = new Map<AssertionKind, HTMLButtonElement>();
  private readonly errorId = `git-knowledge-trace-setup-error-${++setupModalInstance}`;

  constructor(
    app: App,
    private readonly options: KnowledgeTraceSetupModalOptions
  ) {
    super(app);
    const assertion = options.initialValue?.assertion ?? {
      kind: "text",
      operator: "contains",
      expected: "",
      normalizeLineEndings: true
    };
    this.assertionKind = assertion.kind;
    this.maxVersions = options.initialValue?.maxVersions ?? DEFAULT_MAX_VERSIONS;
    this.hydrateAssertion(assertion);
  }

  onOpen(): void {
    this.modalEl.addClass("git-knowledge-trace-setup-modal");
    this.setTitle("追踪知识变化边界");

    const intro = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-intro"
    });
    intro.createEl("strong", { text: "只读追踪" });
    intro.createSpan({
      text: "沿 Git 历史判断一项知识何时成立、失效或反复变化，不修改笔记和仓库。"
    });

    const file = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-file"
    });
    file.createSpan({ cls: "git-knowledge-trace-setup-file-label", text: "当前笔记" });
    file.createSpan({
      cls: "git-knowledge-trace-setup-file-path",
      text: compactPath(this.options.filePath),
      attr: { title: this.options.filePath }
    });

    const kinds = this.contentEl.createDiv({
      cls: "git-knowledge-trace-assertion-kinds",
      attr: { role: "tablist", "aria-label": "选择判断类型" }
    });
    for (const item of ASSERTION_KINDS) {
      const button = kinds.createEl("button", {
        cls: `git-knowledge-trace-assertion-kind is-${item.kind}`,
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": String(item.kind === this.assertionKind)
        }
      });
      setIcon(
        button.createSpan({ cls: "git-knowledge-trace-assertion-kind-icon" }),
        item.icon
      );
      button.createSpan({
        cls: "git-knowledge-trace-assertion-kind-label",
        text: item.label
      });
      button.dataset.kind = item.kind;
      this.kindButtons.set(item.kind, button);
      button.addEventListener("click", () => {
        this.assertionKind = item.kind;
        this.updateKindSelection();
        this.renderAssertionControls();
      });
    }
    kinds.addEventListener("keydown", (event) => {
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End"
        ].includes(event.key)
      ) return;
      const current = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(
            ".git-knowledge-trace-assertion-kind"
          )
        : null;
      if (!current) return;
      const buttons = ASSERTION_KINDS
        .map((item) => this.kindButtons.get(item.kind))
        .filter((button): button is HTMLButtonElement => Boolean(button));
      const currentIndex = buttons.indexOf(current);
      if (currentIndex < 0) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (
              currentIndex
              + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1)
              + buttons.length
            ) % buttons.length;
      const next = buttons[nextIndex];
      next?.click();
      next?.focus();
    });

    this.controlsEl = this.contentEl.createDiv({
      cls: "git-knowledge-trace-assertion-controls",
      attr: { role: "tabpanel" }
    });
    this.renderAssertionControls();

    new Setting(this.contentEl)
      .setName("最多检查版本")
      .setDesc(`从最旧到最新保留顺序；允许 ${MIN_MAX_VERSIONS}–${MAX_MAX_VERSIONS} 个。`)
      .addText((text) => {
        const input = text.inputEl;
        this.maxVersionsInput = input;
        input.type = "number";
        input.min = String(MIN_MAX_VERSIONS);
        input.max = String(MAX_MAX_VERSIONS);
        input.step = "1";
        input.setAttribute("aria-errormessage", this.errorId);
        text
          .setValue(String(this.maxVersions))
          .onChange((value) => {
            this.maxVersions = Number(value);
            this.updateSubmitState();
          });
      });

    this.errorEl = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-error",
      attr: {
        id: this.errorId,
        role: "alert",
        "aria-live": "polite"
      }
    });

    const footer = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-actions"
    });
    const cancel = footer.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    this.submitButton = footer.createEl("button", {
      cls: "mod-cta",
      text: "开始只读追踪"
    });
    this.submitButton.addEventListener("click", () => void this.submit());
    this.updateKindSelection();
    this.updateSubmitState();
  }

  private hydrateAssertion(assertion: KnowledgeAssertion): void {
    switch (assertion.kind) {
      case "text":
        this.textOperator = assertion.operator;
        this.textExpected = assertion.expected;
        this.textCaseSensitive = assertion.caseSensitive ?? false;
        break;
      case "property":
        this.propertyName = assertion.property;
        this.propertyOperator = assertion.operator;
        this.propertyExpected = propertyValueText(assertion.expected);
        this.propertyValueType = inferredPropertyValueType(assertion.expected);
        this.propertyCaseSensitive = assertion.caseSensitive ?? false;
        break;
      case "relation":
        this.relationKind = assertion.relation;
        this.relationOperator = assertion.operator;
        this.relationTarget = assertion.target;
        break;
      case "structure":
        this.structureKind = assertion.structure;
        this.structureOperator = assertion.operator;
        this.structureValue = assertion.value ?? "";
        break;
      case "rule":
        this.ruleId = BUILT_IN_RULE_IDS.includes(
          assertion.ruleId as (typeof BUILT_IN_RULE_IDS)[number]
        )
          ? assertion.ruleId as (typeof BUILT_IN_RULE_IDS)[number]
          : BUILT_IN_RULE_IDS[0];
        break;
      case "manual":
        this.manualPrompt = assertion.prompt;
        break;
    }
  }

  private updateKindSelection(): void {
    for (const [kind, button] of this.kindButtons) {
      const selected = kind === this.assertionKind;
      button.toggleClass("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
  }

  private renderAssertionControls(
    focusControl?: AssertionControlFocus
  ): void {
    const container = this.controlsEl;
    if (!container) return;
    container.empty();
    switch (this.assertionKind) {
      case "text":
        this.renderTextControls(container);
        break;
      case "property":
        this.renderPropertyControls(container);
        break;
      case "relation":
        this.renderRelationControls(container);
        break;
      case "structure":
        this.renderStructureControls(container);
        break;
      case "rule":
        this.renderRuleControls(container);
        break;
      case "manual":
        this.renderManualControls(container);
        break;
    }
    this.updateSubmitState();
    if (focusControl) {
      const nextControl = container.querySelector<HTMLElement>(
        `[data-knowledge-trace-control="${focusControl}"]`
      );
      window.requestAnimationFrame(() => {
        if (
          this.controlsEl === container
          && nextControl?.isConnected
        ) nextControl.focus({ preventScroll: true });
      });
    }
  }

  private renderTextControls(container: HTMLElement): void {
    new Setting(container)
      .setName("判断方式")
      .setDesc("每个历史版本都会得到成立、不成立或未知三种结果。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("contains", "包含这段文字")
          .addOption("not-contains", "不包含这段文字")
          .addOption("equals", "正文与这段文字完全一致")
          .setValue(this.textOperator)
          .onChange((value) => {
            this.textOperator = value as TextKnowledgeAssertion["operator"];
          });
      });
    this.addTextArea(
      container,
      "要判断的文字",
      "精确匹配会保留换行；只有空白的条件不会开始追踪。",
      this.textExpected,
      "例如：healthy aging",
      (value) => {
        this.textExpected = value;
      }
    );
    new Setting(container)
      .setName("区分大小写")
      .setDesc("关闭时，Healthy 与 healthy 视为相同。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.textCaseSensitive)
          .onChange((value) => {
            this.textCaseSensitive = value;
          });
      });
  }

  private renderPropertyControls(container: HTMLElement): void {
    new Setting(container)
      .setName("属性名")
      .setDesc("读取 YAML frontmatter 的顶层属性。")
      .addText((text) => text
        .setPlaceholder("例如：status")
        .setValue(this.propertyName)
        .onChange((value) => {
          this.propertyName = value.trim();
          this.updateSubmitState();
        }));
    new Setting(container)
      .setName("判断方式")
      .addDropdown((dropdown) => {
        dropdown.selectEl.dataset.knowledgeTraceControl = "property-operator";
        dropdown
          .addOption("exists", "属性存在")
          .addOption("missing", "属性缺失")
          .addOption("equals", "属性值等于")
          .addOption("contains", "属性值包含")
          .setValue(this.propertyOperator)
          .onChange((value) => {
            this.propertyOperator = value as PropertyKnowledgeAssertion["operator"];
            this.renderAssertionControls("property-operator");
          });
      });
    if (this.propertyOperator === "equals" || this.propertyOperator === "contains") {
      new Setting(container)
        .setName("值类型")
        .setDesc("避免把数字、布尔值和字符串混为一谈。")
        .addDropdown((dropdown) => {
          dropdown.selectEl.dataset.knowledgeTraceControl = "property-value-type";
          dropdown
            .addOption("string", "字符串")
            .addOption("number", "数字")
            .addOption("boolean", "布尔值")
            .addOption("null", "空值")
            .addOption("json", "列表 / 对象（JSON）")
            .setValue(this.propertyValueType)
            .onChange((value) => {
              this.propertyValueType = value as PropertyValueType;
              this.renderAssertionControls("property-value-type");
            });
        });
      if (this.propertyValueType !== "null") {
        this.addTextArea(
          container,
          "期望值",
          this.propertyValueType === "json"
            ? "输入有效 JSON，例如 [\"draft\", \"sent\"]。"
            : "按所选类型解析，不自动把字符串改成数字。",
          this.propertyExpected,
          this.propertyValueType === "boolean" ? "true 或 false" : "输入属性值",
          (value) => {
            this.propertyExpected = value;
          },
          this.propertyValueType === "json" ? 4 : 2
        );
      }
      if (
        this.propertyOperator === "contains"
        && this.propertyValueType === "string"
      ) {
        new Setting(container)
          .setName("区分大小写")
          .setDesc("仅影响字符串属性的包含判断。")
          .addToggle((toggle) => toggle
            .setValue(this.propertyCaseSensitive)
            .onChange((value) => {
              this.propertyCaseSensitive = value;
            }));
      }
    }
  }

  private renderRelationControls(container: HTMLElement): void {
    new Setting(container)
      .setName("关系类型")
      .addDropdown((dropdown) => dropdown
        .addOption("wikilink", "Wikilink")
        .addOption("markdown-link", "Markdown 链接")
        .addOption("embed", "嵌入")
        .addOption("tag", "标签")
        .setValue(this.relationKind)
        .onChange((value) => {
          this.relationKind = value as RelationKnowledgeAssertion["relation"];
        }));
    new Setting(container)
      .setName("判断方式")
      .addDropdown((dropdown) => dropdown
        .addOption("exists", "关系存在")
        .addOption("missing", "关系不存在")
        .setValue(this.relationOperator)
        .onChange((value) => {
          this.relationOperator = value as RelationKnowledgeAssertion["operator"];
        }));
    new Setting(container)
      .setName("目标")
      .setDesc("填写链接目标、嵌入目标或标签；标签可省略开头的 #。")
      .addText((text) => text
        .setPlaceholder("例如：MOC/Healthy aging")
        .setValue(this.relationTarget)
        .onChange((value) => {
          this.relationTarget = value.trim();
          this.updateSubmitState();
        }));
  }

  private renderStructureControls(container: HTMLElement): void {
    new Setting(container)
      .setName("Markdown 结构")
      .setDesc("标题仅检查 # ATX 形式；代码块仅检查 ``` / ~~~ 围栏形式，暂不包括 Setext 标题和缩进代码。")
      .addDropdown((dropdown) => dropdown
        .addOption("heading", "ATX 标题（#）")
        .addOption("task", "任务")
        .addOption("code-block", "围栏代码块（``` / ~~~）")
        .addOption("callout", "Callout")
        .addOption("table", "表格")
        .addOption("formula", "公式")
        .setValue(this.structureKind)
        .onChange((value) => {
          this.structureKind = value as StructureKnowledgeAssertion["structure"];
        }));
    new Setting(container)
      .setName("判断方式")
      .addDropdown((dropdown) => dropdown
        .addOption("exists", "结构存在")
        .addOption("missing", "结构不存在")
        .setValue(this.structureOperator)
        .onChange((value) => {
          this.structureOperator = value as StructureKnowledgeAssertion["operator"];
        }));
    new Setting(container)
      .setName("限定内容")
      .setDesc("可选；例如标题文字、代码语言、Callout 类型或任务正文。")
      .addText((text) => text
        .setPlaceholder("留空表示任意一个")
        .setValue(this.structureValue)
        .onChange((value) => {
          this.structureValue = value.trim();
        }));
  }

  private renderRuleControls(container: HTMLElement): void {
    const intro = container.createDiv({
      cls: "git-knowledge-trace-control-note"
    });
    intro.createEl("strong", { text: "确定性规则" });
    intro.createSpan({
      text: "规则只检查单个版本的内容；结果页会显示规则身份和失败证据。"
    });
    new Setting(container)
      .setName("规则 ID")
      .setDesc("这些规则只读取单个版本，不执行命令。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("no-conflict-markers", "没有 Git 冲突标记")
          .addOption("valid-frontmatter", "Frontmatter 可解析")
          .addOption("nonempty-body", "正文不是空白")
          .setValue(this.ruleId)
          .onChange((value) => {
            this.ruleId = value as (typeof BUILT_IN_RULE_IDS)[number];
            this.updateSubmitState();
          });
      });
  }

  private renderManualControls(container: HTMLElement): void {
    const note = container.createDiv({
      cls: "git-knowledge-trace-manual-note"
    });
    note.createEl("strong", { text: "人工判断不会冒充自动规则" });
    note.createSpan({
      text: "追踪后需要你对每个可读版本标记成立、不成立或未知；页面只会给出“人工候选”，不会显示“自动已确认”。"
    });
    this.addTextArea(
      container,
      "判断问题",
      "写成每个版本都能独立回答的是 / 否问题。",
      this.manualPrompt,
      "例如：这一版是否已经明确表达研究问题？",
      (value) => {
        this.manualPrompt = value;
      },
      4
    );
  }

  private addTextArea(
    container: HTMLElement,
    name: string,
    description: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
    rows = 3
  ): TextAreaComponent {
    let component: TextAreaComponent | undefined;
    new Setting(container)
      .setName(name)
      .setDesc(description)
      .addTextArea((text) => {
        component = text;
        text
          .setPlaceholder(placeholder)
          .setValue(value)
          .onChange((next) => {
            onChange(next);
            this.updateSubmitState();
          });
        text.inputEl.rows = rows;
      });
    return component!;
  }

  private parsePropertyExpected(): unknown {
    switch (this.propertyValueType) {
      case "string":
        return this.propertyExpected;
      case "number": {
        const value = Number(this.propertyExpected);
        if (!Number.isFinite(value)) throw new Error("属性期望值不是有效数字。");
        return value;
      }
      case "boolean":
        if (this.propertyExpected === "true") return true;
        if (this.propertyExpected === "false") return false;
        throw new Error("布尔值只能填写 true 或 false。");
      case "null":
        return null;
      case "json": {
        const value: unknown = JSON.parse(this.propertyExpected);
        if (value === null || typeof value !== "object") {
          throw new Error("JSON 值必须是列表或对象。");
        }
        return value;
      }
    }
  }

  private buildAssertion(): KnowledgeAssertion {
    switch (this.assertionKind) {
      case "text":
        return {
          kind: "text",
          operator: this.textOperator,
          expected: this.textExpected,
          caseSensitive: this.textCaseSensitive,
          normalizeLineEndings: true
        };
      case "property":
        return {
          kind: "property",
          property: this.propertyName,
          operator: this.propertyOperator,
          ...(
            this.propertyOperator === "equals" || this.propertyOperator === "contains"
              ? { expected: this.parsePropertyExpected() }
              : {}
          ),
          ...(this.propertyOperator === "contains"
            ? { caseSensitive: this.propertyCaseSensitive }
            : {})
        };
      case "relation":
        return {
          kind: "relation",
          relation: this.relationKind,
          operator: this.relationOperator,
          target: this.relationTarget
        };
      case "structure":
        return {
          kind: "structure",
          structure: this.structureKind,
          operator: this.structureOperator,
          ...(this.structureValue ? { value: this.structureValue } : {})
        };
      case "rule":
        return {
          kind: "rule",
          ruleId: this.ruleId
        };
      case "manual":
        return {
          kind: "manual",
          prompt: this.manualPrompt
        };
    }
  }

  private validationError(): string {
    if (this.maxVersionsInvalid()) {
      return `最多检查版本必须是 ${MIN_MAX_VERSIONS}–${MAX_MAX_VERSIONS} 之间的整数。`;
    }
    try {
      switch (this.assertionKind) {
        case "text":
          if (!this.textExpected.trim()) return "请填写要判断的文字。";
          break;
        case "property":
          if (!this.propertyName) return "请填写 YAML 属性名。";
          if (this.propertyOperator === "equals" || this.propertyOperator === "contains") {
            if (
              this.propertyValueType !== "null"
              && this.propertyValueType !== "string"
              && !this.propertyExpected.trim()
            ) {
              return "请填写属性期望值。";
            }
            if (
              this.propertyOperator === "contains"
              && this.propertyValueType === "string"
              && this.propertyExpected.length === 0
            ) {
              return "字符串包含判断不能使用空值。";
            }
            this.parsePropertyExpected();
          }
          break;
        case "relation":
          if (!this.relationTarget) return "请填写关系目标。";
          break;
        case "structure":
          break;
        case "rule":
          break;
        case "manual":
          if (!this.manualPrompt.trim()) return "请填写人工判断问题。";
          break;
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  }

  private maxVersionsInvalid(): boolean {
    return !Number.isInteger(this.maxVersions)
      || this.maxVersions < MIN_MAX_VERSIONS
      || this.maxVersions > MAX_MAX_VERSIONS;
  }

  private updateSubmitState(): void {
    const error = this.validationError();
    if (this.submitButton) {
      this.submitButton.disabled = this.submitting || Boolean(error);
    }
    const invalidMaxVersions = this.maxVersionsInvalid();
    this.maxVersionsInput?.toggleClass("is-invalid", invalidMaxVersions);
    this.maxVersionsInput?.setAttribute(
      "aria-invalid",
      String(invalidMaxVersions)
    );
    if (invalidMaxVersions) {
      this.maxVersionsInput?.setAttribute("aria-describedby", this.errorId);
    } else {
      this.maxVersionsInput?.removeAttribute("aria-describedby");
    }
    if (!this.submitting) this.errorEl?.setText(error);
  }

  private async submit(): Promise<void> {
    if (this.submitting) return;
    const error = this.validationError();
    if (error) {
      this.errorEl?.setText(error);
      return;
    }
    let assertion: KnowledgeAssertion;
    try {
      assertion = this.buildAssertion();
    } catch (buildError) {
      this.errorEl?.setText(
        buildError instanceof Error ? buildError.message : String(buildError)
      );
      return;
    }
    this.submitting = true;
    this.updateSubmitState();
    this.errorEl?.setText("正在打开只读追踪…");
    try {
      await this.options.onSubmit({
        filePath: this.options.filePath,
        assertion,
        maxVersions: this.maxVersions
      });
      this.close();
    } catch (submitError) {
      this.submitting = false;
      this.errorEl?.setText(
        submitError instanceof Error ? submitError.message : String(submitError)
      );
      this.updateSubmitState();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
