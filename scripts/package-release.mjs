import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const archive = resolve(root, `git-note-history-${manifest.version}.zip`);
const files = ["main.js", "manifest.json", "styles.css"];

rmSync(archive, { force: true });
execFileSync("zip", ["-j", "-q", "-X", archive, ...files], {
  cwd: root,
  stdio: "inherit",
});

console.log(`Created ${archive}`);
