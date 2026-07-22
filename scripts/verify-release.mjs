import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const manifest = readJson("manifest.json");
const versions = readJson("versions.json");
const version = manifest.version;

const versionChecks = [
  ["package.json", packageJson.version],
  ["package-lock.json", packageLock.version],
  ["package-lock.json root package", packageLock.packages?.[""]?.version],
];

for (const [label, candidate] of versionChecks) {
  if (candidate !== version) {
    throw new Error(`${label} has version ${candidate}; expected ${version}`);
  }
}

if (versions[version] !== manifest.minAppVersion) {
  throw new Error(`versions.json must map ${version} to ${manifest.minAppVersion}`);
}

const archive = resolve(root, "dist", `git-note-history-${version}.zip`);
if (!existsSync(archive)) {
  throw new Error(`Missing release archive: ${archive}`);
}

const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const archiveListing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();

if (JSON.stringify(archiveListing) !== JSON.stringify([...releaseFiles].sort())) {
  throw new Error(`Archive contains unexpected files: ${archiveListing.join(", ")}`);
}

for (const file of releaseFiles) {
  const current = readFileSync(resolve(root, file));
  const archived = execFileSync("unzip", ["-p", archive, file]);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  if (digest(current) !== digest(archived)) {
    throw new Error(`${file} does not match the copy in ${archive}`);
  }
}

console.log(`Release ${version} is internally consistent.`);
