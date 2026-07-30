import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoricalSandboxManager } from "../src/sandbox/sandbox-manager";
import type { HistoricalSandboxRecord } from "../src/sandbox/types";
import {
  CURRENT_DATA_SCHEMA_VERSION,
  migratePluginData
} from "../src/persistence/plugin-data";

const temporaryRoots: string[] = [];

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function fixture(): Promise<{
  repositoryRoot: string;
  vaultRoot: string;
  storageRoot: string;
  bundleRoot: string;
  commitHash: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-note-history-sandbox-"));
  temporaryRoots.push(root);
  const repositoryRoot = path.join(root, "repo");
  const vaultRoot = path.join(repositoryRoot, "Vault");
  const storageRoot = path.join(root, "managed");
  const bundleRoot = path.join(root, "bundle");
  await mkdir(path.join(vaultRoot, ".obsidian", "plugins", "unsafe-old-plugin"), {
    recursive: true
  });
  await mkdir(path.join(vaultRoot, "Notes"), { recursive: true });
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(path.join(vaultRoot, "Notes", "alpha.md"), "# Alpha\n\nOld\n");
  await writeFile(
    path.join(vaultRoot, ".obsidian", "community-plugins.json"),
    JSON.stringify(["unsafe-old-plugin"])
  );
  await writeFile(
    path.join(vaultRoot, ".obsidian", "plugins", "unsafe-old-plugin", "main.js"),
    "throw new Error('must stay disabled');\n"
  );
  await writeFile(path.join(bundleRoot, "main.js"), "module.exports = {};\n");
  await writeFile(
    path.join(bundleRoot, "manifest.json"),
    JSON.stringify({ id: "git-note-history", version: "0.7.0" })
  );
  await writeFile(path.join(bundleRoot, "styles.css"), ".plugin {}\n");
  await run(repositoryRoot, ["init"]);
  await run(repositoryRoot, ["config", "user.name", "Sandbox Test"]);
  await run(repositoryRoot, ["config", "user.email", "sandbox@example.invalid"]);
  await run(repositoryRoot, ["add", "."]);
  await run(repositoryRoot, ["commit", "-m", "historical baseline"]);
  const commitHash = (await run(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  return { repositoryRoot, vaultRoot, storageRoot, bundleRoot, commitHash };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("HistoricalSandboxManager", () => {
  it("creates a locked, detached, visibly identified capsule without enabling old plugins", async () => {
    const env = await fixture();
    const manager = new HistoricalSandboxManager({
      gitExecutable: "git",
      storageRoot: env.storageRoot,
      bundleSource: {
        pluginId: "git-note-history",
        pluginVersion: "0.7.0",
        directory: env.bundleRoot
      },
      createId: () => "stable-id",
      now: () => "2026-07-30T01:02:03.000Z"
    });

    const record = await manager.createCapsule({
      repositoryRoot: env.repositoryRoot,
      vaultRoot: env.vaultRoot,
      commitHash: env.commitHash,
      shortHash: env.commitHash.slice(0, 7),
      commitSubject: "historical baseline",
      anchorRepositoryPath: "Vault/Notes/alpha.md"
    });

    expect(record.mode).toBe("capsule");
    expect(record.source.commitHash).toBe(env.commitHash);
    expect(record.vaultRelativePath).toBe("Vault");
    expect(
      JSON.parse(
        await readFile(
          path.join(record.vaultPath, ".obsidian", "community-plugins.json"),
          "utf8"
        )
      )
    ).toEqual(["git-note-history"]);
    await expect(access(
      path.join(
        record.vaultPath,
        ".obsidian",
        "plugins",
        "unsafe-old-plugin",
        "main.js"
      )
    )).rejects.toThrow();
    expect(
      await readFile(
        path.join(
          record.vaultPath,
          ".obsidian",
          "snippets",
          "git-note-history-sandbox.css"
        ),
        "utf8"
      )
    ).toContain("只读时间胶囊");
    const noteMode = (await stat(
      path.join(record.vaultPath, "Notes", "alpha.md")
    )).mode;
    expect(noteMode & 0o222).toBe(0);
    const worktreeList = await run(env.repositoryRoot, [
      "worktree",
      "list",
      "--porcelain"
    ]);
    expect(worktreeList).toContain(record.rootPath);
    expect(worktreeList).toContain("locked");
    expect(await run(env.repositoryRoot, ["status", "--porcelain"])).toBe("");

    const inspection = await manager.inspect(record);
    expect(inspection).toMatchObject({
      availability: "ready",
      changedPaths: [],
      untrackedPaths: [],
      hasChanges: false
    });

    await manager.remove(record);
    await expect(access(record.rootPath)).rejects.toThrow();
    expect(await run(env.repositoryRoot, ["status", "--porcelain"])).toBe("");
  });

  it("upgrades explicitly, reports real edits, exports a patch, and archives without deleting", async () => {
    const env = await fixture();
    let clock = 0;
    const manager = new HistoricalSandboxManager({
      gitExecutable: "git",
      storageRoot: env.storageRoot,
      now: () => `2026-07-30T01:02:0${clock++}.000Z`,
      createId: () => "editable-id"
    });
    let record: HistoricalSandboxRecord = await manager.createCapsule({
      repositoryRoot: env.repositoryRoot,
      vaultRoot: env.vaultRoot,
      commitHash: env.commitHash,
      commitSubject: "historical baseline"
    });
    record = await manager.upgradeToEditable(record);
    expect(record.mode).toBe("editable");
    const notePath = path.join(record.vaultPath, "Notes", "alpha.md");
    expect((await stat(notePath)).mode & 0o200).toBeGreaterThan(0);
    await writeFile(notePath, "# Alpha\n\nExperiment\n");
    await writeFile(path.join(record.vaultPath, "Notes", "new.md"), "# New\n");
    const externalNote = path.join(path.dirname(record.rootPath), "external.md");
    await writeFile(externalNote, "# External\n");
    await symlink(
      externalNote,
      path.join(record.vaultPath, "Notes", "external-link.md")
    );

    const inspection = await manager.inspect(record);
    expect(inspection.availability).toBe("ready");
    expect(inspection.changedPaths).toEqual(["Vault/Notes/alpha.md"]);
    expect(inspection.untrackedPaths).toEqual([
      "Vault/Notes/external-link.md",
      "Vault/Notes/new.md"
    ]);
    expect(
      await manager.readMarkdownFile(record, "Vault/Notes/alpha.md")
    ).toMatchObject({ content: "# Alpha\n\nExperiment\n" });
    await expect(
      manager.readMarkdownFile(record, "Vault/Notes/external-link.md")
    ).rejects.toThrow("普通 Markdown 文件");

    const exported = await manager.exportPatch(record);
    expect(await readFile(exported.patchPath, "utf8")).toContain("+Experiment");
    const manifest = JSON.parse(await readFile(exported.manifestPath, "utf8")) as {
      untrackedPaths: string[];
      warning: string;
    };
    expect(manifest.untrackedPaths).toEqual([
      "Vault/Notes/external-link.md",
      "Vault/Notes/new.md"
    ]);
    expect(manifest.warning).toContain("not embedded");

    record = await manager.setArchived(record, true);
    expect(record.lifecycle).toBe("archived");
    expect(await access(record.rootPath)).toBeUndefined();
    await manager.remove(record);
  });

  it("rejects forged records and non-hash revisions before destructive lifecycle actions", async () => {
    const env = await fixture();
    const manager = new HistoricalSandboxManager({
      gitExecutable: "git",
      storageRoot: env.storageRoot
    });
    await expect(manager.createCapsule({
      repositoryRoot: env.repositoryRoot,
      vaultRoot: env.vaultRoot,
      commitHash: "HEAD"
    })).rejects.toThrow("完整 Git commit hash");

    const forged: HistoricalSandboxRecord = {
      schemaVersion: 1,
      id: "forged",
      name: "forged",
      rootPath: env.repositoryRoot,
      vaultPath: env.vaultRoot,
      vaultRelativePath: "Vault",
      mode: "editable",
      lifecycle: "active",
      source: {
        repositoryRoot: env.repositoryRoot,
        vaultRoot: env.vaultRoot,
        commitHash: env.commitHash,
        shortHash: env.commitHash.slice(0, 7),
        commitSubject: "",
        commitAuthoredAt: ""
      },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    };
    await expect(manager.remove(forged)).rejects.toThrow("受管目录边界");
    expect(await run(env.repositoryRoot, ["rev-parse", "HEAD"])).toContain(
      env.commitHash
    );
  });

  it("reports an existing directory with a mismatched marker as untrusted and does not delete it", async () => {
    const env = await fixture();
    const manager = new HistoricalSandboxManager({
      gitExecutable: "git",
      storageRoot: env.storageRoot
    });
    const record = await manager.createCapsule({
      repositoryRoot: env.repositoryRoot,
      vaultRoot: env.vaultRoot,
      commitHash: env.commitHash
    });
    const markerPath = path.join(
      record.vaultPath,
      ".obsidian",
      ".git-note-history-sandbox.json"
    );
    await writeFile(markerPath, JSON.stringify({ ...record, id: "tampered" }));
    expect((await manager.inspect(record)).availability).toBe("untrusted");
    await expect(manager.remove(record)).rejects.toThrow("身份标记不匹配");
    expect(await access(record.rootPath)).toBeUndefined();
    await writeFile(markerPath, JSON.stringify(record));
    await manager.remove(record);
  });

  it("migrates only internally consistent sandbox records into schema v4", () => {
    const valid: HistoricalSandboxRecord = {
      schemaVersion: 1,
      id: "valid",
      name: "Valid capsule",
      rootPath: "/tmp/managed/valid",
      vaultPath: "/tmp/managed/valid/Vault",
      vaultRelativePath: "Vault",
      mode: "capsule",
      lifecycle: "active",
      source: {
        repositoryRoot: "/tmp/repository",
        vaultRoot: "/tmp/repository/Vault",
        commitHash: "a".repeat(40),
        shortHash: "aaaaaaa",
        commitSubject: "Baseline",
        commitAuthoredAt: "2026-07-30T00:00:00.000Z"
      },
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z"
    };
    const migrated = migratePluginData({
      schemaVersion: 3,
      historicalSandboxes: {
        valid,
        forged: {
          ...valid,
          id: "forged",
          rootPath: "/tmp/managed/forged",
          vaultPath: "/tmp/outside",
          vaultRelativePath: "../outside"
        }
      }
    });
    expect(migrated.schemaVersion).toBe(CURRENT_DATA_SCHEMA_VERSION);
    expect(migrated.historicalSandboxes).toEqual({ valid });
    expect(migratePluginData(migrated)).toEqual(migrated);
  });
});
