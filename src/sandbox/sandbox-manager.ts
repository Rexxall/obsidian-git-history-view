import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  HistoricalSandboxBundleSource,
  HistoricalSandboxCreateInput,
  HistoricalSandboxInspection,
  HistoricalSandboxPatchExport,
  HistoricalSandboxRecord
} from "./types";

const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_SANDBOX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const SANDBOX_MARKER_FILE = ".git-note-history-sandbox.json";
const SAFE_CONFIG_DIRECTORY = ".obsidian";
const SANDBOX_SNIPPET_NAME = "git-note-history-sandbox";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface HistoricalSandboxManagerOptions {
  gitExecutable: string;
  storageRoot?: string;
  bundleSource?: HistoricalSandboxBundleSource;
  now?: () => string;
  createId?: () => string;
  runCommand?: (
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ) => Promise<CommandResult>;
}

function defaultStorageRoot(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Git Note History",
      "sandboxes"
    );
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? os.homedir(),
      "Git Note History",
      "sandboxes"
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "git-note-history",
    "sandboxes"
  );
}

function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: 120_000,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ""}`
          ));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function safeName(value: string): string {
  const compact = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return compact.slice(0, 80) || "历史沙盒";
}

function isCommitHash(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value);
}

function assertInside(parent: string, child: string, allowEqual = false): void {
  const relative = path.relative(parent, child);
  if (
    (!allowEqual && relative === "")
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("沙盒路径越过了受管目录边界。");
  }
}

function sandboxCss(record: HistoricalSandboxRecord): string {
  const mode = record.mode === "capsule" ? "只读时间胶囊" : "可编辑历史沙盒";
  const label = `${mode} · ${record.source.shortHash}`.replace(/["\\]/gu, "\\$&");
  return [
    "body::before {",
    `  content: "${label}";`,
    "  position: fixed;",
    "  top: 8px;",
    "  right: 12px;",
    "  z-index: 999999;",
    "  padding: 5px 10px;",
    "  border: 1px solid var(--color-orange);",
    "  border-radius: 999px;",
    "  background: var(--background-primary);",
    "  color: var(--text-normal);",
    "  box-shadow: var(--shadow-s);",
    "  font-size: 12px;",
    "  font-weight: 600;",
    "  pointer-events: none;",
    "}"
  ].join("\n");
}

function parsePorcelainPaths(raw: string): {
  changedPaths: string[];
  untrackedPaths: string[];
} {
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const records = raw.split("\u0000").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (status === "??") {
      untrackedPaths.push(filePath);
      continue;
    }
    changedPaths.push(filePath);
    if (status[0] === "R" || status[0] === "C") {
      const target = records[index + 1];
      if (target) {
        changedPaths.push(target);
        index += 1;
      }
    }
  }
  return {
    changedPaths: [...new Set(changedPaths)].sort(),
    untrackedPaths: [...new Set(untrackedPaths)].sort()
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export class HistoricalSandboxManager {
  readonly storageRoot: string;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly command: NonNullable<HistoricalSandboxManagerOptions["runCommand"]>;

  constructor(private readonly options: HistoricalSandboxManagerOptions) {
    this.storageRoot = path.resolve(options.storageRoot ?? defaultStorageRoot());
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
    this.command = options.runCommand ?? runCommand;
  }

  async createCapsule(
    input: HistoricalSandboxCreateInput
  ): Promise<HistoricalSandboxRecord> {
    if (!isCommitHash(input.commitHash)) {
      throw new Error("历史沙盒只接受已经解析出的完整 Git commit hash。");
    }
    const repositoryRoot = await realpath(path.resolve(input.repositoryRoot));
    const vaultRoot = await realpath(path.resolve(input.vaultRoot));
    assertInside(repositoryRoot, vaultRoot, true);
    const verified = (
      await this.git(repositoryRoot, [
        "rev-parse",
        "--verify",
        `${input.commitHash}^{commit}`
      ])
    ).stdout.trim();
    if (!isCommitHash(verified)) throw new Error("无法验证历史沙盒的源 commit。");

    await mkdir(this.storageRoot, { recursive: true });
    const managedRoot = await realpath(this.storageRoot);
    const rawId = this.createId();
    const id = createHash("sha256")
      .update(`${repositoryRoot}\u0000${verified}\u0000${rawId}`)
      .digest("hex")
      .slice(0, 20);
    const rootPath = path.join(managedRoot, id);
    assertInside(managedRoot, rootPath);
    if (await exists(rootPath)) throw new Error("沙盒目录已经存在，请重试。");

    const vaultRelativePath = path.relative(repositoryRoot, vaultRoot);
    const vaultPath = path.join(rootPath, vaultRelativePath);
    const now = this.now();
    const record: HistoricalSandboxRecord = {
      schemaVersion: 1,
      id,
      name: safeName(
        input.name
        ?? `${input.commitSubject || "历史版本"} · ${(input.shortHash || verified).slice(0, 7)}`
      ),
      rootPath,
      vaultPath,
      vaultRelativePath,
      mode: "capsule",
      lifecycle: "active",
      source: {
        repositoryRoot,
        vaultRoot,
        commitHash: verified,
        shortHash: (input.shortHash || verified).slice(0, 12),
        commitSubject: input.commitSubject ?? "",
        commitAuthoredAt: input.commitAuthoredAt ?? "",
        ...(input.anchorRepositoryPath
          ? { anchorRepositoryPath: input.anchorRepositoryPath }
          : {})
      },
      createdAt: now,
      updatedAt: now
    };

    let worktreeAdded = false;
    try {
      await this.git(repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        "--lock",
        "--reason",
        `Git Note History capsule ${id}`,
        rootPath,
        verified
      ]);
      worktreeAdded = true;
      if (!(await exists(vaultPath))) {
        throw new Error("源 commit 中不存在对应的 Vault 目录。");
      }
      const historicalVaultInfo = await lstat(vaultPath);
      if (
        historicalVaultInfo.isSymbolicLink()
        || !historicalVaultInfo.isDirectory()
      ) {
        throw new Error("源 commit 中的 Vault 根目录不是安全的普通目录。");
      }
      const actualWorktreeRoot = await realpath(rootPath);
      const actualVaultPath = await realpath(vaultPath);
      assertInside(actualWorktreeRoot, actualVaultPath, true);
      await this.prepareSafeVault(record);
      await this.setContentWritable(record, false);
      return record;
    } catch (error) {
      if (worktreeAdded) {
        await this.git(repositoryRoot, ["worktree", "unlock", rootPath]).catch(() => undefined);
        await this.git(repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          rootPath
        ]).catch(() => undefined);
      } else {
        await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async upgradeToEditable(
    record: HistoricalSandboxRecord
  ): Promise<HistoricalSandboxRecord> {
    await this.assertManagedRecord(record);
    if (record.mode === "editable") return record;
    await this.setContentWritable(record, true);
    const next: HistoricalSandboxRecord = {
      ...record,
      mode: "editable",
      updatedAt: this.now()
    };
    await this.writeMarker(next);
    await this.writeIdentitySnippet(next);
    return next;
  }

  async downgradeToCapsule(
    record: HistoricalSandboxRecord
  ): Promise<HistoricalSandboxRecord> {
    await this.assertManagedRecord(record);
    if (record.mode === "capsule") return record;
    const next: HistoricalSandboxRecord = {
      ...record,
      mode: "capsule",
      updatedAt: this.now()
    };
    await this.writeMarker(next);
    await this.writeIdentitySnippet(next);
    await this.setContentWritable(next, false);
    return next;
  }

  async setArchived(
    record: HistoricalSandboxRecord,
    archived: boolean
  ): Promise<HistoricalSandboxRecord> {
    await this.assertManagedRecord(record);
    const next: HistoricalSandboxRecord = {
      ...record,
      lifecycle: archived ? "archived" : "active",
      updatedAt: this.now()
    };
    await this.writeMarker(next);
    return next;
  }

  async markOpened(
    record: HistoricalSandboxRecord
  ): Promise<HistoricalSandboxRecord> {
    await this.assertManagedRecord(record);
    const now = this.now();
    const next = { ...record, lastOpenedAt: now, updatedAt: now };
    await this.writeMarker(next);
    return next;
  }

  async inspect(
    record: HistoricalSandboxRecord
  ): Promise<HistoricalSandboxInspection> {
    try {
      await this.assertManagedRecord(record);
    } catch {
      const rootStillExists = await exists(record.rootPath);
      return {
        availability: rootStillExists ? "untrusted" : "missing",
        record,
        changedPaths: [],
        untrackedPaths: [],
        hasChanges: false
      };
    }
    const head = (
      await this.git(record.rootPath, ["rev-parse", "HEAD"]).catch(() => ({
        stdout: "",
        stderr: ""
      }))
    ).stdout.trim();
    if (!head) {
      return {
        availability: "detached",
        record,
        changedPaths: [],
        untrackedPaths: [],
        hasChanges: false
      };
    }
    const status = await this.git(record.rootPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
      ...this.excludedConfigPathspecs(record)
    ]);
    const parsed = parsePorcelainPaths(status.stdout);
    return {
      availability: head === record.source.commitHash ? "ready" : "wrong-commit",
      record,
      headHash: head,
      ...parsed,
      hasChanges: parsed.changedPaths.length > 0 || parsed.untrackedPaths.length > 0
    };
  }

  async exportPatch(
    record: HistoricalSandboxRecord
  ): Promise<HistoricalSandboxPatchExport> {
    await this.assertManagedRecord(record);
    const inspection = await this.inspect(record);
    if (inspection.availability !== "ready") {
      throw new Error("沙盒已丢失或不再位于创建时的 commit，不能导出补丁。");
    }
    const patch = (
      await this.git(record.rootPath, [
        "diff",
        "--binary",
        "--no-ext-diff",
        record.source.commitHash,
        "--",
        ".",
        ...this.excludedConfigPathspecs(record)
      ])
    ).stdout;
    const exportRoot = path.join(this.storageRoot, "exports");
    await mkdir(exportRoot, { recursive: true });
    const managedExportRoot = await realpath(exportRoot);
    const stamp = this.now().replace(/[:.]/gu, "-");
    const baseName = `${record.id}-${stamp}`;
    const patchPath = path.join(managedExportRoot, `${baseName}.patch`);
    const manifestPath = path.join(managedExportRoot, `${baseName}.json`);
    assertInside(managedExportRoot, patchPath);
    assertInside(managedExportRoot, manifestPath);
    await writeFile(patchPath, patch, "utf8");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      sandbox: record,
      exportedAt: this.now(),
      changedPaths: inspection.changedPaths,
      untrackedPaths: inspection.untrackedPaths,
      warning: inspection.untrackedPaths.length > 0
        ? "Untracked files are listed but are not embedded in the Git patch."
        : undefined
    }, null, 2), "utf8");
    return {
      patchPath,
      manifestPath,
      changedPaths: inspection.changedPaths,
      untrackedPaths: inspection.untrackedPaths,
      patchBytes: Buffer.byteLength(patch)
    };
  }

  async readMarkdownFile(
    record: HistoricalSandboxRecord,
    repositoryPath: string
  ): Promise<{ content: string; sizeBytes: number }> {
    await this.assertManagedRecord(record);
    if (
      !repositoryPath
      || repositoryPath.includes("\u0000")
      || path.isAbsolute(repositoryPath)
    ) {
      throw new Error("沙盒文件路径无效。");
    }
    const candidate = path.resolve(
      record.rootPath,
      ...repositoryPath.split("/")
    );
    assertInside(record.rootPath, candidate);
    const candidateInfo = await lstat(candidate);
    if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
      throw new Error("只允许读取沙盒中的普通 Markdown 文件。");
    }
    const actual = await realpath(candidate);
    const actualRoot = await realpath(record.rootPath);
    assertInside(actualRoot, actual);
    const sizeBytes = candidateInfo.size;
    if (sizeBytes > MAX_SANDBOX_MARKDOWN_BYTES) {
      throw new Error("沙盒笔记超过 2 MB 安全读取上限。");
    }
    return {
      content: await readFile(actual, "utf8"),
      sizeBytes
    };
  }

  async remove(record: HistoricalSandboxRecord): Promise<void> {
    await this.assertManagedRecord(record);
    await this.setContentWritable(record, true);
    await this.git(record.source.repositoryRoot, [
      "worktree",
      "unlock",
      record.rootPath
    ]).catch(() => undefined);
    await this.git(record.source.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      record.rootPath
    ]);
  }

  private async prepareSafeVault(record: HistoricalSandboxRecord): Promise<void> {
    const configRoot = path.join(record.vaultPath, SAFE_CONFIG_DIRECTORY);
    const snippetRoot = path.join(configRoot, "snippets");
    // Historical config can contain executable community plugins or symlinks.
    // Rebuild it from a minimal known-safe set; the source commit remains intact.
    await rm(configRoot, { recursive: true, force: true });
    await mkdir(snippetRoot, { recursive: true });

    const appearance: Record<string, unknown> = {
      enabledCssSnippets: [SANDBOX_SNIPPET_NAME]
    };
    await writeFile(
      path.join(configRoot, "appearance.json"),
      JSON.stringify(appearance, null, 2),
      "utf8"
    );

    const bundle = this.options.bundleSource;
    if (bundle) {
      const pluginRoot = path.join(configRoot, "plugins", bundle.pluginId);
      await mkdir(pluginRoot, { recursive: true });
      for (const fileName of ["main.js", "manifest.json", "styles.css"]) {
        await copyFile(
          path.join(bundle.directory, fileName),
          path.join(pluginRoot, fileName)
        );
      }
      await writeFile(
        path.join(configRoot, "community-plugins.json"),
        JSON.stringify([bundle.pluginId], null, 2),
        "utf8"
      );
    } else {
      await writeFile(
        path.join(configRoot, "community-plugins.json"),
        "[]\n",
        "utf8"
      );
    }
    await this.writeMarker(record);
    await this.writeIdentitySnippet(record);
  }

  private async writeMarker(record: HistoricalSandboxRecord): Promise<void> {
    await writeFile(
      path.join(record.vaultPath, SAFE_CONFIG_DIRECTORY, SANDBOX_MARKER_FILE),
      JSON.stringify(record, null, 2),
      "utf8"
    );
  }

  private async writeIdentitySnippet(record: HistoricalSandboxRecord): Promise<void> {
    await writeFile(
      path.join(
        record.vaultPath,
        SAFE_CONFIG_DIRECTORY,
        "snippets",
        `${SANDBOX_SNIPPET_NAME}.css`
      ),
      `${sandboxCss(record)}\n`,
      "utf8"
    );
  }

  private excludedConfigPathspecs(record: HistoricalSandboxRecord): string[] {
    const prefix = record.vaultRelativePath
      ? `${record.vaultRelativePath.split(path.sep).join("/")}/`
      : "";
    return [
      `:(exclude)${prefix}${SAFE_CONFIG_DIRECTORY}/**`
    ];
  }

  private async setContentWritable(
    record: HistoricalSandboxRecord,
    writable: boolean
  ): Promise<void> {
    const configRoot = path.join(record.vaultPath, SAFE_CONFIG_DIRECTORY);
    const visit = async (candidate: string): Promise<void> => {
      if (candidate === configRoot) return;
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        const entries = await readdir(candidate);
        for (const entry of entries) {
          await visit(path.join(candidate, entry));
        }
      }
      const nextMode = writable
        ? info.mode | (info.isDirectory() ? 0o700 : 0o200)
        : info.mode & ~0o222;
      await chmod(candidate, nextMode);
    };
    await visit(record.rootPath);
  }

  private async assertManagedRecord(
    record: HistoricalSandboxRecord
  ): Promise<void> {
    const rootPath = path.resolve(record.rootPath);
    let managedRoot: string;
    try {
      managedRoot = await realpath(this.storageRoot);
    } catch {
      assertInside(this.storageRoot, rootPath);
      throw new Error("沙盒受管目录不存在。");
    }
    assertInside(managedRoot, rootPath);
    const actualRoot = await realpath(rootPath);
    assertInside(managedRoot, actualRoot);
    if (actualRoot !== rootPath) {
      throw new Error("沙盒目录经过了符号链接重定向，已停止操作。");
    }
    const markerPath = path.join(
      record.vaultPath,
      SAFE_CONFIG_DIRECTORY,
      SANDBOX_MARKER_FILE
    );
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as
      Partial<HistoricalSandboxRecord>;
    if (marker.id !== record.id || marker.rootPath !== record.rootPath) {
      throw new Error("沙盒身份标记不匹配，已停止操作。");
    }
  }

  private git(cwd: string, args: string[]): Promise<CommandResult> {
    return this.command(this.options.gitExecutable, args, {
      cwd,
      env: {
        ...process.env,
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0"
      }
    });
  }
}
