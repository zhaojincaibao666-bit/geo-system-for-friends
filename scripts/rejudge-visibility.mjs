import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rejudgeStoredVisibility } from "../lib/visibility-rejudge.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storePath = join(root, "data", "store.json");
const dryRun = process.argv.includes("--dry-run");
const normalizeOutput = process.argv.includes("--normalize");
const store = JSON.parse(await readFile(storePath, "utf8"));
const result = rejudgeStoredVisibility(store, {
  diagnosticConfig: { baselineRuns: 5, absoluteThreshold: 0.10, relativeThreshold: 0.25 },
});

if (!dryRun && (result.changed || normalizeOutput)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(root, "data", "backups", `store-before-visibility-rejudge-${stamp}.json`);
  await copyFile(storePath, backupPath);
  const temporaryPath = `${storePath}.visibility-rejudge.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await rename(temporaryPath, storePath);
  result.backupPath = backupPath;
}

console.log(JSON.stringify({ dryRun, ...result }, null, 2));
