// Prints the CHANGELOG.md section for a version, the body of its GitHub release.
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const section = changelog.split(/^## /m).find((part) => part.startsWith(`${tag} `));
if (!section) {
  console.error(`CHANGELOG.md has no section for ${tag}`);
  process.exit(1);
}
process.stdout.write(`${section.slice(section.indexOf("\n") + 1).trim()}\n`);
