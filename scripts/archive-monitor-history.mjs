import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA_PATH = join(ROOT, "data", "store.json");
const ARCHIVE_ROOT = join(ROOT, "data", "archives");
const RETAIN_COMPLETED_FULL_RUNS_PER_BANK = 15;
const APPLY = process.argv.includes("--apply");
const TERMINAL = new Set(["completed", "completed_with_errors", "failed", "aborted"]);

function timestampForPath(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function completedAt(run) {
  return Date.parse(run.completedAt || run.updatedAt || run.startedAt || run.createdAt || 0) || 0;
}

function retentionGroup(run) {
  return [
    run.platform || "doubao_web",
    // Early Doubao records were saved before platformMode existed. The UI
    // treats those as ordinary chat records, so retain them in the same
    // chronological window rather than keeping an extra legacy history.
    run.platformMode || ((run.platform || "doubao_web") === "doubao_web" ? "chat" : "legacy"),
    run.questionSet || "legacy",
    run.questionSetId || "legacy",
  ].join("|");
}

function isArchivableFullRun(run) {
  return TERMINAL.has(run.status)
    && run.mode === "full_daily"
    && Number(run.total) === 30
    && run.reportable !== false;
}

function planArchive(source) {
  const runs = Array.isArray(source.browserMonitorRuns) ? source.browserMonitorRuns : [];
  const keepIds = new Set();
  const groups = new Map();

  for (const run of runs) {
    if (!isArchivableFullRun(run)) {
      keepIds.add(run.id);
      continue;
    }
    const group = retentionGroup(run);
    const list = groups.get(group) || [];
    list.push(run);
    groups.set(group, list);
  }

  for (const list of groups.values()) {
    list.sort((left, right) => completedAt(right) - completedAt(left));
    for (const run of list.slice(0, RETAIN_COMPLETED_FULL_RUNS_PER_BANK)) keepIds.add(run.id);
  }

  const archivedRuns = runs.filter((run) => !keepIds.has(run.id));
  const archivedRunIds = new Set(archivedRuns.map((run) => run.id));
  const allProbes = Array.isArray(source.probeRuns) ? source.probeRuns : [];
  const archivedProbes = allProbes.filter((probe) => archivedRunIds.has(probe.browserMonitorRunId));

  return {
    retainedRuns: runs.filter((run) => !archivedRunIds.has(run.id)),
    archivedRuns,
    retainedProbes: allProbes.filter((probe) => !archivedRunIds.has(probe.browserMonitorRunId)),
    archivedProbes,
    groupCounts: Object.fromEntries([...groups.entries()].map(([group, list]) => [group, {
      totalCompletedFullRuns: list.length,
      retainedCompletedFullRuns: Math.min(list.length, RETAIN_COMPLETED_FULL_RUNS_PER_BANK),
      archivedCompletedFullRuns: Math.max(0, list.length - RETAIN_COMPLETED_FULL_RUNS_PER_BANK),
    }])),
  };
}

const raw = await readFile(DATA_PATH);
const store = JSON.parse(raw.toString("utf8"));
const plan = planArchive(store);
const summary = {
  mode: APPLY ? "apply" : "dry_run",
  retention: { completedFullRunsPerBank: RETAIN_COMPLETED_FULL_RUNS_PER_BANK },
  before: { browserMonitorRuns: store.browserMonitorRuns?.length || 0, probeRuns: store.probeRuns?.length || 0, storeBytes: raw.length },
  after: { browserMonitorRuns: plan.retainedRuns.length, probeRuns: plan.retainedProbes.length },
  archive: { browserMonitorRuns: plan.archivedRuns.length, probeRuns: plan.archivedProbes.length },
  groupCounts: plan.groupCounts,
};

if (!APPLY) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (!plan.archivedRuns.length) {
  console.log(JSON.stringify({ ...summary, message: "没有符合归档条件的完整测试。" }, null, 2));
  process.exit(0);
}

const createdAt = new Date().toISOString();
const archiveDir = join(ARCHIVE_ROOT, `monitor-history-${timestampForPath(new Date())}`);
await mkdir(archiveDir, { recursive: true });
const archivePayload = {
  formatVersion: 1,
  createdAt,
  purpose: "历史完整30题测试归档，保留最近15次同平台同题库完整测试在主系统。",
  sourceStoreSha256: createHash("sha256").update(raw).digest("hex"),
  retention: summary.retention,
  browserMonitorRuns: plan.archivedRuns,
  probeRuns: plan.archivedProbes,
};
const archivePath = join(archiveDir, "monitor-history.json");
await writeFile(archivePath, JSON.stringify(archivePayload));
await access(archivePath, constants.F_OK);

const compactedStore = {
  ...store,
  browserMonitorRuns: plan.retainedRuns,
  probeRuns: plan.retainedProbes,
  archiveRegistry: [
    ...(Array.isArray(store.archiveRegistry) ? store.archiveRegistry : []),
    {
      formatVersion: 1,
      createdAt,
      path: archivePath,
      browserMonitorRuns: plan.archivedRuns.length,
      probeRuns: plan.archivedProbes.length,
      sourceStoreSha256: archivePayload.sourceStoreSha256,
      retention: summary.retention,
    },
  ],
};
const compacted = JSON.stringify(compactedStore);
const stagingPath = `${DATA_PATH}.history-archive-staging`;
await writeFile(stagingPath, compacted);
const verify = JSON.parse(await readFile(stagingPath, "utf8"));
if (verify.browserMonitorRuns.length !== plan.retainedRuns.length || verify.probeRuns.length !== plan.retainedProbes.length) {
  throw new Error("归档校验失败：暂存文件记录数量不一致，未覆盖主数据。");
}
await writeFile(DATA_PATH, compacted);
await writeFile(join(archiveDir, "manifest.json"), JSON.stringify({
  ...summary,
  createdAt,
  archivePath,
  archiveBytes: Buffer.byteLength(JSON.stringify(archivePayload)),
  compactedStoreBytes: Buffer.byteLength(compacted),
}, null, 2));

console.log(JSON.stringify({
  ...summary,
  archivePath,
  compactedStoreBytes: Buffer.byteLength(compacted),
}, null, 2));
