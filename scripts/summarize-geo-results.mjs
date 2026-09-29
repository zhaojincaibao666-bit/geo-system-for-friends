import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.join(root, 'data');
const outDir = path.join(root, 'reports', 'geo-test-summary-2026-09-19');

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function dateOf(run) {
  return new Date(run.completedAt || run.updatedAt || run.createdAt || 0);
}

function isTerminal(run) {
  return ['completed', 'completed_with_errors', 'failed', 'stopped'].includes(run.status);
}

function answerCount(run) {
  return Number(run?.visibilitySummary?.validAnswers ?? run?.summary?.validAnswerCount ?? run?.visibility?.validAnswerCount ?? run?.visibility?.validAnswers ?? run?.validAnswerCount ?? run?.questions?.filter((q) => q.rawAnswer || q.answer)?.length ?? 0);
}

function mentioned(run) {
  return Number(run?.visibilitySummary?.mentionedCount ?? run?.visibility?.mentionedCount ?? run?.summary?.mentionedCount ?? run?.mentionedCount ?? run?.questions?.filter((q) => q?.mentionResult?.brandMentioned || q?.brandMentioned)?.length ?? 0);
}

function priority(run) {
  return Number(run?.visibilitySummary?.priorityCount ?? run?.visibility?.priorityCount ?? run?.summary?.priorityCount ?? run?.priorityCount ?? run?.questions?.filter((q) => ['priority', 'first'].includes(q?.recommendationResult?.recommendation))?.length ?? 0);
}

function full30(run) {
  return Number(run?.totalQuestions ?? run?.summary?.totalQuestions ?? run?.questions?.length ?? 0) === 30 && answerCount(run) >= 25;
}

function pct(n, d) { return d ? `${(n / d * 100).toFixed(1)}%` : '—'; }
function average(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function beijing(date) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date).replaceAll('/', '-');
}

function citationsOf(run) {
  return (run.questions || []).flatMap((q) => q.citations || q.citationResult?.citations || []);
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

async function main() {
  const stores = [await readJson(path.join(dataDir, 'store.json'))];
  const archiveRoot = path.join(dataDir, 'archives');
  for (const entry of await fs.readdir(archiveRoot, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(archiveRoot, entry.name, 'monitor-history.json');
    try { stores.push(await readJson(file)); } catch { /* ignore incomplete archives */ }
  }
  const all = new Map();
  for (const store of stores) for (const run of store.browserMonitorRuns || []) all.set(run.id, run);
  const runs = [...all.values()].filter(isTerminal).sort((a, b) => dateOf(a) - dateOf(b));
  const original = runs.filter((r) => r.questionSet === 'dongguan_local' && full30(r));
  const newBusiness = runs.filter((r) => r.questionSet === 'new_business_expansion' && full30(r));

  function stats(list) {
    const total = list.length;
    const answers = list.map(answerCount);
    const mentions = list.map(mentioned);
    const priorities = list.map(priority);
    return {
      total,
      avgAnswers: average(answers), avgMentions: average(mentions), avgPriorities: average(priorities),
      mentionRate: average(mentions) / 30, priorityRate: average(priorities) / 30,
      minMentions: Math.min(...mentions), maxMentions: Math.max(...mentions),
    };
  }
  function serialiseStats(s) {
    return { ...s, avgAnswers: Number(s.avgAnswers.toFixed(2)), avgMentions: Number(s.avgMentions.toFixed(2)), avgPriorities: Number(s.avgPriorities.toFixed(2)), mentionRate: Number((s.mentionRate * 100).toFixed(2)), priorityRate: Number((s.priorityRate * 100).toFixed(2)) };
  }

  const recentOriginal = original.slice(-10);
  const recentNewBusiness = newBusiness.slice(-10);
  const latest = (list) => list.at(-1) || null;
  const sourceRuns = original.slice(-5);
  const domains = {};
  for (const run of sourceRuns) for (const c of citationsOf(run)) {
    const name = host(c.url || c.href || c.link || '');
    if (name) domains[name] = (domains[name] || 0) + 1;
  }
  const questionMap = new Map();
  for (const run of recentOriginal) for (const q of run.questions || []) {
    const key = q.promptId || q.questionId || q.prompt || q.text;
    if (!key) continue;
    const e = questionMap.get(key) || { text: q.prompt || q.question || q.text || key, tested: 0, mentions: 0, priorities: 0 };
    e.tested += 1;
    e.mentions += q?.mentionResult?.brandMentioned || q?.brandMentioned ? 1 : 0;
    e.priorities += ['priority', 'first'].includes(q?.recommendationResult?.recommendation) ? 1 : 0;
    questionMap.set(key, e);
  }
  const questionStats = [...questionMap.values()].sort((a, b) => b.mentions - a.mentions || b.priorities - a.priorities);
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceFiles: ['data/store.json', ...stores.slice(1).map((s) => s.archiveRegistry ? 'data/archives/monitor-history.json' : 'archive')],
    allTerminalRuns: runs.length,
    original: { overall: serialiseStats(stats(original)), latest10: serialiseStats(stats(recentOriginal)), first5: serialiseStats(stats(original.slice(0, 5))), last5: serialiseStats(stats(original.slice(-5))), latest: latest(original) && { id: latest(original).id, date: beijing(dateOf(latest(original))), validAnswers: answerCount(latest(original)), mentions: mentioned(latest(original)), priorities: priority(latest(original)), mentionRate: Number((mentioned(latest(original)) / 30 * 100).toFixed(2)), priorityRate: Number((priority(latest(original)) / 30 * 100).toFixed(2)) }, recentRuns: recentOriginal.map((r) => ({ id: r.id, date: beijing(dateOf(r)), validAnswers: answerCount(r), mentions: mentioned(r), priorities: priority(r), mentionRate: Number((mentioned(r) / 30 * 100).toFixed(2)), priorityRate: Number((priority(r) / 30 * 100).toFixed(2)) })), recentQuestionStats: questionStats },
    newBusiness: { overall: newBusiness.length ? serialiseStats(stats(newBusiness)) : null, latest10: newBusiness.length ? serialiseStats(stats(recentNewBusiness)) : null, latest: latest(newBusiness) && { id: latest(newBusiness).id, date: beijing(dateOf(latest(newBusiness))), validAnswers: answerCount(latest(newBusiness)), mentions: mentioned(latest(newBusiness)), priorities: priority(latest(newBusiness)), mentionRate: Number((mentioned(latest(newBusiness)) / 30 * 100).toFixed(2)), priorityRate: Number((priority(latest(newBusiness)) / 30 * 100).toFixed(2)) }, recentRuns: recentNewBusiness.map((r) => ({ id: r.id, date: beijing(dateOf(r)), validAnswers: answerCount(r), mentions: mentioned(r), priorities: priority(r), mentionRate: Number((mentioned(r) / 30 * 100).toFixed(2)), priorityRate: Number((priority(r) / 30 * 100).toFixed(2)) })) },
    sourceDomainsLast5Original: Object.entries(domains).sort((a, b) => b[1] - a[1]).map(([domain, citations]) => ({ domain, citations })),
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'data-summary.json'), JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
