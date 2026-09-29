import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const storePath = resolve(process.cwd(), 'data', 'store.json');
const raw = await readFile(storePath, 'utf8');
const store = JSON.parse(raw);

const mojibakePattern = /\u8f93\u5165\u7684\u5185\u5bb9\u663e\u793a\u4e3a\u4e71\u7801|\u60a8\u8f93\u5165\u7684\u5185\u5bb9\u663e\u793a\u4e3a\u4e71\u7801|\u95eb|\u59e3|\u7f01|\u701b|\u93ba|\u9539|\u953b|\u9286|\u00ef\u00bf\u00bd/;

function isEncodingInvalid(run) {
  return run.status === 'encoding_invalid' || mojibakePattern.test(String(run.rawAnswer ?? ''));
}

const originalRuns = Array.isArray(store.probeRuns) ? store.probeRuns : [];
const removedRuns = originalRuns.filter(isEncodingInvalid);
store.probeRuns = originalRuns.filter((run) => !isEncodingInvalid(run));
store.auditLogs = [
  ...(Array.isArray(store.auditLogs) ? store.auditLogs : []),
  {
    id: `audit_${Date.now()}`,
    action: 'probe_runs_removed',
    actor: 'system_maintenance',
    details: {
      reason: 'encoding_invalid_or_mojibake',
      removedRunIds: removedRuns.map((run) => run.id),
      removedCount: removedRuns.length,
    },
    createdAt: new Date().toISOString(),
  },
];

const temporaryPath = `${storePath}.cleanup-tmp`;
await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
JSON.parse(await readFile(temporaryPath, 'utf8'));
await rename(temporaryPath, storePath);

console.log(JSON.stringify({
  removedCount: removedRuns.length,
  removedRunIds: removedRuns.map((run) => run.id),
  remainingCount: store.probeRuns.length,
}));
