import { extractCompetitorCandidates, now, uid } from "./core.mjs";

export const DOUBAO_ACCOUNT_AB_TYPE = "doubao_account_ab";

export const ACCOUNT_AB_STATUS = Object.freeze({
  RUNNING_A: "running_a",
  WAITING_FOR_ACCOUNT_SWITCH: "waiting_for_account_switch",
  PREFLIGHT_B: "preflight_b",
  RUNNING_B: "running_b",
  COMPLETED: "completed",
  ABORTED: "aborted",
});

const TERMINAL = new Set([ACCOUNT_AB_STATUS.COMPLETED, ACCOUNT_AB_STATUS.ABORTED]);

export function createDoubaoAccountAbExperiment({
  experimentId = uid("doubao_ab"),
  companyId = null,
  platform = "doubao_web",
  questionSet = "dongguan_local",
  questionSetId = null,
  totalQuestions = 30,
  armA = "new_account",
  armB = "old_account",
} = {}) {
  const createdAt = now();
  return {
    id: experimentId,
    experimentId,
    experimentType: DOUBAO_ACCOUNT_AB_TYPE,
    status: ACCOUNT_AB_STATUS.RUNNING_A,
    companyId,
    platform,
    questionSet,
    questionSetId,
    totalQuestions: Number(totalQuestions) || 0,
    armA,
    armB,
    runAId: null,
    runBId: null,
    accountLabel: null,
    userConfirmedAccountLabel: null,
    createdAt,
    runACompletedAt: null,
    switchStartedAt: null,
    switchConfirmedAt: null,
    runBStartedAt: null,
    completedAt: null,
    timeGapMinutes: null,
    preflight: null,
    comparison: null,
  };
}

export function isAccountAbTerminal(experiment) {
  return TERMINAL.has(experiment?.status);
}

export function attachAccountAbRun(experiment, arm, runId, { accountLabel = null } = {}) {
  if (!experiment || !runId || !["A", "B"].includes(arm)) throw new Error("INVALID_ACCOUNT_AB_RUN");
  const field = arm === "A" ? "runAId" : "runBId";
  experiment[field] = runId;
  if (accountLabel) experiment.accountLabel = accountLabel;
  if (arm === "B") {
    experiment.status = ACCOUNT_AB_STATUS.RUNNING_B;
    experiment.runBStartedAt ||= now();
  }
  return experiment;
}

export function markAccountAbArmACompleted(experiment, completedAt = now()) {
  if (!experiment || experiment.status !== ACCOUNT_AB_STATUS.RUNNING_A) throw new Error("ACCOUNT_AB_NOT_RUNNING_A");
  experiment.status = ACCOUNT_AB_STATUS.WAITING_FOR_ACCOUNT_SWITCH;
  experiment.runACompletedAt = completedAt;
  experiment.accountLabel = experiment.armA;
  return experiment;
}

export function beginAccountAbSwitch(experiment, at = now()) {
  if (!experiment || experiment.status !== ACCOUNT_AB_STATUS.WAITING_FOR_ACCOUNT_SWITCH) throw new Error("ACCOUNT_AB_NOT_WAITING_FOR_SWITCH");
  experiment.switchStartedAt ||= at;
  experiment.status = ACCOUNT_AB_STATUS.PREFLIGHT_B;
  return experiment;
}

export function recordAccountAbPreflight(experiment, preflight = {}, { userConfirmedAccountLabel = null, at = now() } = {}) {
  if (!experiment || experiment.status !== ACCOUNT_AB_STATUS.PREFLIGHT_B) throw new Error("ACCOUNT_AB_NOT_IN_PREFLIGHT");
  experiment.preflight = { ...preflight, checkedAt: at };
  if (!preflight.ready) {
    experiment.status = ACCOUNT_AB_STATUS.WAITING_FOR_ACCOUNT_SWITCH;
    return experiment;
  }
  if (userConfirmedAccountLabel !== experiment.armB) throw new Error("ACCOUNT_AB_ACCOUNT_LABEL_CONFIRMATION_REQUIRED");
  experiment.userConfirmedAccountLabel = userConfirmedAccountLabel;
  experiment.switchConfirmedAt = at;
  return experiment;
}

export function markAccountAbCompleted(experiment, comparison = null, completedAt = now()) {
  if (!experiment || experiment.status !== ACCOUNT_AB_STATUS.RUNNING_B) throw new Error("ACCOUNT_AB_NOT_RUNNING_B");
  experiment.status = ACCOUNT_AB_STATUS.COMPLETED;
  experiment.completedAt = completedAt;
  experiment.comparison = comparison;
  const start = Date.parse(experiment.switchConfirmedAt || "");
  const end = Date.parse(experiment.runBStartedAt || "");
  experiment.timeGapMinutes = Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round(((end - start) / 60000) * 100) / 100
    : null;
  return experiment;
}

export function abortAccountAbExperiment(experiment, reason = "manual_abort", at = now()) {
  if (!experiment || isAccountAbTerminal(experiment)) return experiment;
  experiment.status = ACCOUNT_AB_STATUS.ABORTED;
  experiment.completedAt = at;
  experiment.abortReason = String(reason).slice(0, 300);
  return experiment;
}

function safeRate(value, denominator) {
  return denominator ? Math.round((value / denominator) * 10000) / 10000 : null;
}

function answerRows(run = {}) {
  return (run.questions || []).filter((question) => question.status === "success" && String(question.rawAnswer || "").trim());
}

function judgementCounts(run = {}) {
  const rows = answerRows(run);
  const mentioned = rows.filter((question) => question.mentionResult?.brandMentioned === true || question.brandMentioned === true).length;
  const priority = rows.filter((question) => ["first", "top3"].includes(question.recommendationResult?.recommendation || question.recommendation)).length;
  const citations = rows.map((question) => Array.isArray(question.browserCitations) && question.browserCitations.length ? question.browserCitations : (question.citations || []));
  const citationQuestions = citations.filter((items) => items.length > 0).length;
  const citationCount = citations.reduce((sum, items) => sum + items.length, 0);
  const domains = new Set(citations.flat().map((citation) => citation.domain || (() => { try { return new URL(citation.resolvedUrl || citation.url).hostname; } catch { return null; } })()).filter(Boolean));
  const answerLengths = rows.map((question) => String(question.rawAnswer || "").trim().length).filter((value) => value > 0);
  const candidateCounts = rows.map((question) => {
    const candidates = question.candidateCompanies || question.candidates || question.mentionedCompanies || question.competitorMentionsList;
    if (Array.isArray(candidates)) return candidates.length;
    if (Number.isFinite(Number(candidates))) return Number(candidates);
    if (Number.isFinite(Number(question.candidateCount))) return Number(question.candidateCount);
    return null;
  }).filter((value) => Number.isFinite(value));
  return {
    validAnswers: rows.length,
    mentioned,
    priority,
    mentionRate: safeRate(mentioned, rows.length),
    priorityRate: safeRate(priority, rows.length),
    citationQuestions,
    citationCoverageRate: safeRate(citationQuestions, rows.length),
    citationCount,
    uniqueDomains: domains.size,
    averageAnswerLength: answerLengths.length ? Math.round(answerLengths.reduce((sum, value) => sum + value, 0) / answerLengths.length) : null,
    averageCandidateCount: candidateCounts.length ? Math.round((candidateCounts.reduce((sum, value) => sum + value, 0) / candidateCounts.length) * 100) / 100 : null,
  };
}

function promptMap(run = {}) {
  return new Map((run.questions || []).map((question) => [question.promptId, question]));
}

function workerConsistency(run = {}) {
  const groups = new Map();
  for (const question of run.questions || []) {
    const workerId = question.workerId || question.job?.worker_id || "unassigned";
    const item = groups.get(workerId) || {
      workerId,
      completedQuestions: 0,
      failed: 0,
      retries: 0,
      mentions: 0,
      priority: 0,
      answerLengths: [],
      citationCount: 0,
    };
    item.retries += Math.max(0, Number(question.attemptCount || 0) - 1);
    if (question.status === "success" && String(question.rawAnswer || "").trim()) {
      item.completedQuestions += 1;
      if (question.mentionResult?.brandMentioned === true || question.brandMentioned === true) item.mentions += 1;
      if (["first", "top3"].includes(question.recommendationResult?.recommendation || question.recommendation)) item.priority += 1;
      item.answerLengths.push(String(question.rawAnswer || "").trim().length);
      const citations = Array.isArray(question.browserCitations) && question.browserCitations.length ? question.browserCitations : (question.citations || []);
      item.citationCount += citations.length;
    } else if (question.status === "failed") item.failed += 1;
    groups.set(workerId, item);
  }
  return [...groups.values()].map((item) => ({
    workerId: item.workerId,
    completedQuestions: item.completedQuestions,
    failed: item.failed,
    retries: item.retries,
    mentionRate: safeRate(item.mentions, item.completedQuestions),
    priorityRate: safeRate(item.priority, item.completedQuestions),
    averageAnswerLength: item.answerLengths.length ? Math.round(item.answerLengths.reduce((sum, value) => sum + value, 0) / item.answerLengths.length) : null,
    citationCount: item.citationCount,
  })).sort((left, right) => String(left.workerId).localeCompare(String(right.workerId)));
}

function citationChanges(runA = {}, runB = {}) {
  const sourceA = runA.sourceSummary || {};
  const sourceB = runB.sourceSummary || {};
  const values = (items, field) => new Set((Array.isArray(items) ? items : []).map((item) => String(item?.[field] || item || "").trim().toLowerCase()).filter(Boolean));
  const domainsA = values(sourceA.topDomains, "domain");
  const domainsB = values(sourceB.topDomains, "domain");
  const urlsA = values(sourceA.topUrls, "url");
  const urlsB = values(sourceB.topUrls, "url");
  const difference = (left, right) => [...right].filter((value) => !left.has(value));
  return {
    comparable: sourceA.citationObservationStatus === "observed" && sourceB.citationObservationStatus === "observed",
    domainsAdded: difference(domainsA, domainsB),
    domainsRemoved: difference(domainsB, domainsA),
    urlsAdded: difference(urlsA, urlsB),
    urlsRemoved: difference(urlsB, urlsA),
    brandRelatedCitationQuestionsDelta: (Number(sourceB.brandRelatedCitationQuestions) || 0) - (Number(sourceA.brandRelatedCitationQuestions) || 0),
    brandRelatedCitationCountDelta: (Number(sourceB.brandRelatedCitationCount) || 0) - (Number(sourceA.brandRelatedCitationCount) || 0),
  };
}

export function buildAccountAbComparison(runA, runB, { experimentId = null, brand = null } = {}) {
  if (!runA || !runB) throw new Error("ACCOUNT_AB_RUNS_REQUIRED");
  const a = judgementCounts(runA);
  const b = judgementCounts(runB);
  const aQuestions = promptMap(runA);
  const bQuestions = promptMap(runB);
  const promptIds = [...new Set([...aQuestions.keys(), ...bQuestions.keys()])];
  const promptComparison = promptIds.map((promptId) => {
    const left = aQuestions.get(promptId);
    const right = bQuestions.get(promptId);
    const leftVisible = Boolean(left?.mentionResult?.brandMentioned ?? left?.brandMentioned);
    const rightVisible = Boolean(right?.mentionResult?.brandMentioned ?? right?.brandMentioned);
    const leftPriority = ["first", "top3"].includes(left?.recommendationResult?.recommendation || left?.recommendation);
    const rightPriority = ["first", "top3"].includes(right?.recommendationResult?.recommendation || right?.recommendation);
    let classification = "both_invisible";
    if (leftVisible && rightVisible && leftPriority !== rightPriority) classification = "ranking_changed";
    else if (leftVisible && rightVisible) classification = "both_visible";
    else if (rightVisible) classification = "new_only";
    else if (leftVisible) classification = "old_only";
    return { promptId, classification, armAVisible: leftVisible, armBVisible: rightVisible, armAPriority: leftPriority, armBPriority: rightPriority };
  });
  const count = (classification) => promptComparison.filter((item) => item.classification === classification).length;
  const competitorNames = (run) => {
    const map = new Map();
    for (const question of run.questions || []) {
      const names = question.mentionedCompanies || question.competitorMentionsList || (brand ? extractCompetitorCandidates(question.rawAnswer || "", brand) : []);
      for (const company of names) map.set(company, (map.get(company) || 0) + 1);
    }
    return map;
  };
  const competitorsA = competitorNames(runA);
  const competitorsB = competitorNames(runB);
  const competitorNamesAll = new Set([...competitorsA.keys(), ...competitorsB.keys()]);
  const competitors = [...competitorNamesAll].map((company) => ({ company, armACount: competitorsA.get(company) || 0, armBCount: competitorsB.get(company) || 0, delta: (competitorsB.get(company) || 0) - (competitorsA.get(company) || 0) })).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const aCitations = runA.sourceSummary || {};
  const bCitations = runB.sourceSummary || {};
  const citationSimilarity = aCitations.citationObservationStatus !== "observed" || bCitations.citationObservationStatus !== "observed"
    ? null
    : (aCitations.uniqueDomains || bCitations.uniqueDomains ? Math.min(aCitations.uniqueDomains || 0, bCitations.uniqueDomains || 0) / Math.max(aCitations.uniqueDomains || 1, bCitations.uniqueDomains || 1) : 1);
  const competitorSimilarity = competitors.length ? competitors.filter((item) => item.armACount > 0 && item.armBCount > 0).length / competitors.length : 1;
  const mentionDelta = (b.mentionRate ?? 0) - (a.mentionRate ?? 0);
  const priorityDelta = (b.priorityRate ?? 0) - (a.priorityRate ?? 0);
  const oldOnlyQuestionCount = count("old_only");
  const effectMagnitude = Math.max(Math.abs(mentionDelta), Math.abs(priorityDelta));
  const effectStrength = effectMagnitude >= 0.30 && oldOnlyQuestionCount >= 3 ? "strong" : effectMagnitude >= 0.15 || oldOnlyQuestionCount >= 2 ? "moderate" : effectMagnitude >= 0.05 || oldOnlyQuestionCount > 0 ? "weak" : "inconclusive";
  const confidence = a.validAnswers === 30 && b.validAnswers === 30 && aQuestions.size === bQuestions.size ? "high" : a.validAnswers >= 25 && b.validAnswers >= 25 ? "medium" : "low";
  return {
    schemaVersion: 1,
    experimentId,
    armA: { label: "new_account", runId: runA.id, ...a },
    armB: { label: "old_account", runId: runB.id, ...b },
    deltas: { mentionRateDelta: mentionDelta, priorityRateDelta: priorityDelta },
    promptCounts: { oldOnlyQuestionCount, newOnlyQuestionCount: count("new_only"), bothVisibleQuestionCount: count("both_visible"), bothInvisibleQuestionCount: count("both_invisible"), rankingChangedQuestionCount: count("ranking_changed") },
    promptComparison,
    competitors,
    citationChanges: citationChanges(runA, runB),
    workerConsistency: { armA: workerConsistency(runA), armB: workerConsistency(runB) },
    citationSimilarity,
    competitorSimilarity,
    effectStrength,
    confidence,
    accountEffect: { strength: effectStrength, confidence, evidence: { oldOnlyQuestionCount, mentionRateDelta: mentionDelta, priorityRateDelta: priorityDelta } },
    conclusion: effectStrength === "strong" ? "账号环境对豆包 GEO 可见度存在较强影响的迹象" : effectStrength === "moderate" ? "账号环境可能解释部分 GEO 差异" : effectStrength === "weak" ? "观察到轻微账号差异，但证据有限" : "当前数据不足以确认账号因素造成明显差异",
  };
}
