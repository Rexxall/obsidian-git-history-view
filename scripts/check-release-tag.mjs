// Release workflow guard: the pushed tag must match every version field, and versions.json must map it to minAppVersion.
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const manifest = read("manifest.json");
const lock = read("package-lock.json");
const versions = read("versions.json");
const found = {
  "manifest.json": manifest.version,
  "package.json": read("package.json").version,
  "package-lock.json": lock.version,
  "package-lock.json root": lock.packages?.[""]?.version
};
const problems = Object.entries(found)
  .filter(([, version]) => version !== tag)
  .map(([file, version]) => `${file} is ${version}`);
if (versions[tag] !== manifest.minAppVersion) {
  problems.push(`versions.json maps ${tag} to ${versions[tag]}, manifest.json needs ${manifest.minAppVersion}`);
}
if (problems.length) {
  console.error(`Tag ${tag} does not match: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`Tag ${tag} matches the version files.`);
