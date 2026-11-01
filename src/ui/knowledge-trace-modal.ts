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
import { tr } from "../i18n";

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
  { kind: "text", label: tr("文字", "Text"), icon: "text-cursor-input" },
  { kind: "property", label: tr("属性", "Property"), icon: "braces" },
  { kind: "relation", label: tr("关系", "Relation"), icon: "link-2" },
  { kind: "structure", label: tr("结构", "Structure"), icon: "blocks" },
  { kind: "rule", label: tr("规则", "Rule"), icon: "list-checks" },
  { kind: "manual", label: tr("人工", "Human"), icon: "user-round-check" }
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
  return typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
    ? value.toString()
    : "";
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
    this.modalEl.addClass("ap", "ap-modal", "git-knowledge-trace-setup-modal");
    this.setTitle(tr("追踪知识变化边界", "Trace when knowledge changed"));

    const intro = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-intro"
    });
    intro.createEl("strong", { text: tr("只读追踪", "Read-only trace") });
    intro.createSpan({
      text: tr("沿 Git 历史判断一项知识何时成立、失效或反复变化，不修改笔记和仓库。", "Follows Git history to find when a piece of knowledge started holding, stopped or changed back and forth. The note and repository are not changed.")
    });

    const file = this.contentEl.createDiv({
      cls: "git-knowledge-trace-setup-file"
    });
    file.createSpan({ cls: "git-knowledge-trace-setup-file-label", text: tr("当前笔记", "This note") });
    file.createSpan({
      cls: "git-knowledge-trace-setup-file-path",
      text: compactPath(this.options.filePath),
      attr: { title: this.options.filePath }
    });

    const kinds = this.contentEl.createDiv({
      cls: "git-knowledge-trace-assertion-kinds",
      attr: { role: "tablist", "aria-label": tr("选择判断类型", "Choose a kind of check") }
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
      .setName(tr("最多检查版本", "Most versions to check"))
      .setDesc(tr(`从最旧到最新保留顺序；允许 ${MIN_MAX_VERSIONS}–${MAX_MAX_VERSIONS} 个。`, `Kept in order from oldest to newest; ${MIN_MAX_VERSIONS}–${MAX_MAX_VERSIONS} allowed.`))
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
    const cancel = footer.createEl("button", { text: tr("取消", "Cancel") });
    cancel.addEventListener("click", () => this.close());
    this.submitButton = footer.createEl("button", {
      cls: "mod-cta",
      text: tr("开始只读追踪", "Start read-only trace")
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
      .setName(tr("判断方式", "Check"))
      .setDesc(tr("每个历史版本都会得到成立、不成立或未知三种结果。", "Each past version comes out as holds, does not hold or unknown."))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("contains", tr("包含这段文字", "Contains this text"))
          .addOption("not-contains", tr("不包含这段文字", "Does not contain this text"))
          .addOption("equals", tr("正文与这段文字完全一致", "Text is exactly this"))
          .setValue(this.textOperator)
          .onChange((value) => {
            this.textOperator = value as TextKnowledgeAssertion["operator"];
          });
      });
    this.addTextArea(
      container,
      tr("要判断的文字", "Text to check"),
      tr("精确匹配会保留换行；只有空白的条件不会开始追踪。", "Exact match keeps line breaks; a condition of only blank space does not start a trace."),
      this.textExpected,
      tr("例如：healthy aging", "For example: healthy aging"),
      (value) => {
        this.textExpected = value;
      }
    );
    new Setting(container)
      .setName(tr("区分大小写", "Match case"))
      .setDesc(tr("关闭时，只差大小写的词视为相同。", "When off, words that differ only in case count as the same."))
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
      .setName(tr("属性名", "Property name"))
      .setDesc(tr("读取 YAML frontmatter 的顶层属性。", "Reads top-level properties in the YAML frontmatter."))
      .addText((text) => text
        .setPlaceholder(tr("例如：status", "For example: status"))
        .setValue(this.propertyName)
        .onChange((value) => {
          this.propertyName = value.trim();
          this.updateSubmitState();
        }));
    new Setting(container)
      .setName(tr("判断方式", "Check"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.dataset.knowledgeTraceControl = "property-operator";
        dropdown
          .addOption("exists", tr("属性存在", "Property exists"))
          .addOption("missing", tr("属性缺失", "Property is missing"))
          .addOption("equals", tr("属性值等于", "Property equals"))
          .addOption("contains", tr("属性值包含", "Property contains"))
          .setValue(this.propertyOperator)
          .onChange((value) => {
            this.propertyOperator = value as PropertyKnowledgeAssertion["operator"];
            this.renderAssertionControls("property-operator");
          });
      });
    if (this.propertyOperator === "equals" || this.propertyOperator === "contains") {
      new Setting(container)
        .setName(tr("值类型", "Value type"))
        .setDesc(tr("避免把数字、布尔值和字符串混为一谈。", "Keeps numbers, booleans and strings apart."))
        .addDropdown((dropdown) => {
          dropdown.selectEl.dataset.knowledgeTraceControl = "property-value-type";
          dropdown
            .addOption("string", tr("字符串", "String"))
            .addOption("number", tr("数字", "Number"))
            .addOption("boolean", tr("布尔值", "Boolean"))
            .addOption("null", tr("空值", "Null"))
            .addOption("json", tr("列表 / 对象（JSON）", "List / object (JSON)"))
            .setValue(this.propertyValueType)
            .onChange((value) => {
              this.propertyValueType = value as PropertyValueType;
              this.renderAssertionControls("property-value-type");
            });
        });
      if (this.propertyValueType !== "null") {
        this.addTextArea(
          container,
          tr("期望值", "Expected value"),
          this.propertyValueType === "json"
            ? tr("输入有效 JSON，例如 [\"draft\", \"sent\"]。", "Enter valid JSON, for example [\"draft\", \"sent\"].")
            : tr("按所选类型解析，不自动把字符串改成数字。", "Parsed as the chosen type; strings are never turned into numbers."),
          this.propertyExpected,
          this.propertyValueType === "boolean" ? tr("true 或 false", "true or false") : tr("输入属性值", "Enter the property value"),
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
          .setName(tr("区分大小写", "Match case"))
          .setDesc(tr("仅影响字符串属性的包含判断。", "Affects only the contains check on string properties."))
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
      .setName(tr("关系类型", "Relation type"))
      .addDropdown((dropdown) => dropdown
        .addOption("wikilink", "Wikilink")
        .addOption("markdown-link", tr("Markdown 链接", "Markdown link"))
        .addOption("embed", tr("嵌入", "Embed"))
        .addOption("tag", tr("标签", "Tag"))
        .setValue(this.relationKind)
        .onChange((value) => {
          this.relationKind = value as RelationKnowledgeAssertion["relation"];
        }));
    new Setting(container)
      .setName(tr("判断方式", "Check"))
      .addDropdown((dropdown) => dropdown
        .addOption("exists", tr("关系存在", "Relation exists"))
        .addOption("missing", tr("关系不存在", "Relation does not exist"))
        .setValue(this.relationOperator)
        .onChange((value) => {
          this.relationOperator = value as RelationKnowledgeAssertion["operator"];
        }));
    new Setting(container)
      .setName(tr("目标", "Target"))
      .setDesc(tr("填写链接目标、嵌入目标或标签；标签可省略开头的 #。", "A link target, embed target or tag; the leading # of a tag can be left out."))
      .addText((text) => text
        .setPlaceholder(tr("例如：项目/健康老龄化", "For example: projects/healthy-aging"))
        .setValue(this.relationTarget)
        .onChange((value) => {
          this.relationTarget = value.trim();
          this.updateSubmitState();
        }));
  }

  private renderStructureControls(container: HTMLElement): void {
    new Setting(container)
      .setName(tr("Markdown 结构", "Markdown structure"))
      .setDesc(tr("标题仅检查 # ATX 形式；代码块仅检查 ``` / ~~~ 围栏形式，暂不包括 Setext 标题和缩进代码。", "Headings are checked only in # ATX form and code blocks only as ``` / ~~~ fences; Setext headings and indented code are not included yet."))
      .addDropdown((dropdown) => dropdown
        .addOption("heading", tr("井号标题（#）", "Heading (#)"))
        .addOption("task", tr("任务", "Task"))
        .addOption("code-block", tr("围栏代码块（``` / ~~~）", "Fenced code block (``` / ~~~)"))
        .addOption("callout", "Callout")
        .addOption("table", tr("表格", "Table"))
        .addOption("formula", tr("公式", "Math"))
        .setValue(this.structureKind)
        .onChange((value) => {
          this.structureKind = value as StructureKnowledgeAssertion["structure"];
        }));
    new Setting(container)
      .setName(tr("判断方式", "Check"))
      .addDropdown((dropdown) => dropdown
        .addOption("exists", tr("结构存在", "Structure exists"))
        .addOption("missing", tr("结构不存在", "Structure does not exist"))
        .setValue(this.structureOperator)
        .onChange((value) => {
          this.structureOperator = value as StructureKnowledgeAssertion["operator"];
        }));
    new Setting(container)
      .setName(tr("限定内容", "Limit to"))
      .setDesc(tr("可选；例如标题文字、代码语言、标注块类型或任务正文。", "Optional; for example heading text, code language, callout type or task text."))
      .addText((text) => text
        .setPlaceholder(tr("留空表示任意一个", "Empty means any one"))
        .setValue(this.structureValue)
        .onChange((value) => {
          this.structureValue = value.trim();
        }));
  }

  private renderRuleControls(container: HTMLElement): void {
    const intro = container.createDiv({
      cls: "git-knowledge-trace-control-note"
    });
    intro.createEl("strong", { text: tr("确定性规则", "Deterministic rule") });
    intro.createSpan({
      text: tr("规则只检查单个版本的内容；结果页会显示规则身份和失败证据。", "Rules look at one version at a time; the result page shows the rule and the evidence when it fails.")
    });
    new Setting(container)
      .setName(tr("规则 ID", "Rule ID"))
      .setDesc(tr("这些规则只读取单个版本，不执行命令。", "These rules only read one version and never run commands."))
      .addDropdown((dropdown) => {
        dropdown
          .addOption("no-conflict-markers", tr("没有 Git 冲突标记", "No Git conflict markers"))
          .addOption("valid-frontmatter", tr("Frontmatter 可解析", "Frontmatter can be parsed"))
          .addOption("nonempty-body", tr("正文不是空白", "Text is not blank"))
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
    note.createEl("strong", { text: tr("人工判断不会冒充自动规则", "A human judgement never passes as an automatic rule") });
    note.createSpan({
      text: tr("追踪后需要你对每个可读版本标记成立、不成立或未知；页面只会给出“人工候选”，不会显示“自动已确认”。", "After tracing, mark each readable version as holds, does not hold or unknown. The page only ever shows a human candidate, never confirmed automatically.")
    });
    this.addTextArea(
      container,
      tr("判断问题", "Question to judge"),
      tr("写成每个版本都能独立回答的是 / 否问题。", "Write a yes or no question each version can answer on its own."),
      this.manualPrompt,
      tr("例如：这一版是否已经明确表达研究问题？", "For example: does this version state the research question clearly?"),
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
        if (!Number.isFinite(value)) throw new Error(tr("属性期望值不是有效数字。", "The expected property value is not a valid number."));
        return value;
      }
      case "boolean":
        if (this.propertyExpected === "true") return true;
        if (this.propertyExpected === "false") return false;
        throw new Error(tr("布尔值只能填写 true 或 false。", "A boolean can only be true or false."));
      case "null":
        return null;
      case "json": {
        const value: unknown = JSON.parse(this.propertyExpected);
        if (value === null || typeof value !== "object") {
          throw new Error(tr("JSON 值必须是列表或对象。", "A JSON value must be a list or an object."));
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
      return tr(`最多检查版本必须是 ${MIN_MAX_VERSIONS}–${MAX_MAX_VERSIONS} 之间的整数。`, `Most versions to check must be a whole number from ${MIN_MAX_VERSIONS} to ${MAX_MAX_VERSIONS}.`);
    }
    try {
      switch (this.assertionKind) {
        case "text":
          if (!this.textExpected.trim()) return tr("请填写要判断的文字。", "Enter the text to check.");
          break;
        case "property":
          if (!this.propertyName) return tr("请填写 YAML 属性名。", "Enter a YAML property name.");
          if (this.propertyOperator === "equals" || this.propertyOperator === "contains") {
            if (
              this.propertyValueType !== "null"
              && this.propertyValueType !== "string"
              && !this.propertyExpected.trim()
            ) {
              return tr("请填写属性期望值。", "Enter the expected property value.");
            }
            if (
              this.propertyOperator === "contains"
              && this.propertyValueType === "string"
              && this.propertyExpected.length === 0
            ) {
              return tr("字符串包含判断不能使用空值。", "A string contains check cannot use an empty value.");
            }
            this.parsePropertyExpected();
          }
          break;
        case "relation":
          if (!this.relationTarget) return tr("请填写关系目标。", "Enter the relation target.");
          break;
        case "structure":
          break;
        case "rule":
          break;
        case "manual":
          if (!this.manualPrompt.trim()) return tr("请填写人工判断问题。", "Enter the question to judge.");
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
    this.errorEl?.setText(tr("正在打开只读追踪…", "Opening the read-only trace…"));
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
