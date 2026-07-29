import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const dist = resolve(root, "dist");
const archive = resolve(dist, `git-note-history-${manifest.version}.zip`);
const archivedReleases = resolve(dist, "archive");
const files = ["main.js", "manifest.json", "styles.css"];

mkdirSync(dist, { recursive: true });
mkdirSync(archivedReleases, { recursive: true });
for (const entry of readdirSync(dist)) {
  if (
    /^git-note-history-\d+\.\d+\.\d+\.zip$/.test(entry)
    && entry !== `git-note-history-${manifest.version}.zip`
  ) {
    renameSync(resolve(dist, entry), resolve(archivedReleases, entry));
  }
}
rmSync(archive, { force: true });
execFileSync("zip", ["-j", "-q", "-X", archive, ...files], {
  cwd: root,
  stdio: "inherit",
});

console.log(`Created ${archive}`);
