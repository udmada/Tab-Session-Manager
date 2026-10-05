// Usage: node scripts/bump-version.mjs [patch|minor|major] [rootDir]
// Bumps "version" in both manifests (src/manifest-ff.json is the source of truth) and prints it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const kind = process.argv[2] || "patch";
const root = process.argv[3] || ".";
const files = ["src/manifest-ff.json", "src/manifest.json"].map(file => join(root, file));
const versionPattern = /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/;

const current = versionPattern.exec(readFileSync(files[0], "utf8"));
if (!current) throw new Error(`No semver "version" found in ${files[0]}`);
let [major, minor, patch] = current.slice(2, 5).map(Number);

if (kind === "major") [major, minor, patch] = [major + 1, 0, 0];
else if (kind === "minor") [minor, patch] = [minor + 1, 0];
else if (kind === "patch") patch += 1;
else throw new Error(`Unknown bump "${kind}", expected patch, minor or major`);

const next = `${major}.${minor}.${patch}`;
// Replace only the version string so the files keep their formatting and line endings.
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!versionPattern.test(text)) throw new Error(`No semver "version" found in ${file}`);
  writeFileSync(file, text.replace(versionPattern, `$1${next}$5`));
}
console.log(next);
