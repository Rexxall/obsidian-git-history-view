import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(root, ".local-install-targets.json");
const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (!existsSync(configPath)) {
  throw new Error(
    `Missing ${configPath}. Copy .local-install-targets.example.json and add local vault plugin directories.`,
  );
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!Array.isArray(config.targets) || config.targets.length === 0) {
  throw new Error("Local install config must contain at least one target.");
}

const sourceHashes = Object.fromEntries(
  releaseFiles.map((file) => [file, digest(resolve(root, file))]),
);
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

for (const target of config.targets) {
  if (!target?.name || !target?.pluginDir || !isAbsolute(target.pluginDir)) {
    throw new Error("Every target needs a name and an absolute pluginDir.");
  }

  const pluginDir = resolve(target.pluginDir);
  const isCurrent = releaseFiles.every((file) => {
    const installed = resolve(pluginDir, file);
    return existsSync(installed) && digest(installed) === sourceHashes[file];
  });

  if (isCurrent) {
    console.log(`${target.name}: already at ${manifest.version}`);
    continue;
  }

  if (existsSync(pluginDir)) {
    let previousVersion = "unknown";
    const previousManifest = resolve(pluginDir, "manifest.json");
    if (existsSync(previousManifest)) {
      previousVersion = JSON.parse(readFileSync(previousManifest, "utf8")).version ?? "unknown";
    }

    const configDir = dirname(dirname(pluginDir));
    const backupDir = resolve(
      configDir,
      "plugin-backups",
      manifest.id,
      `${manifest.id}.backup-${previousVersion}-${timestamp}`,
    );
    mkdirSync(dirname(backupDir), { recursive: true });
    cpSync(pluginDir, backupDir, { recursive: true, errorOnExist: true });
    console.log(`${target.name}: backed up ${previousVersion} to ${backupDir}`);
  }

  mkdirSync(pluginDir, { recursive: true });
  for (const file of releaseFiles) {
    copyFileSync(resolve(root, file), resolve(pluginDir, file));
  }

  for (const file of releaseFiles) {
    const installed = resolve(pluginDir, file);
    if (digest(installed) !== sourceHashes[file]) {
      throw new Error(`${target.name}: verification failed for ${file}`);
    }
  }

  console.log(`${target.name}: installed ${manifest.version}`);
}
