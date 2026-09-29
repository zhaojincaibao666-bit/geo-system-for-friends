import { classifyBrowserVisibilityAnswer, extractCompetitorCandidates } from "./core.mjs";
import { buildCitationSourceSummary, citationObservationState } from "./doubao-citation-analysis.mjs";
import { buildPromptStageDiagnostics } from "./geo-stage-diagnostics.mjs";
import { buildObservabilityQuality } from "./observability-quality.mjs";
import { effectivePlatform } from "./platform.mjs";

// This module is deliberately pure. It reads completed run records and never
// changes the GEO scoring rules or creates new probe/question records.
export const DEFAULT_GEO_DIAGNOSTIC_CONFIG = Object.freeze({
  baselineRuns: 5,
  absoluteThreshold: 0.10,
  relativeThreshold: 0.25,
});

const asText = (value) => String(value ?? "").trim();
const asRate = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clampRate = (value) => value === null ? null : Math.min(1, Math.max(0, value));
const round = (value, places = 4) => Number.isFinite(value) ? Number(value.toFixed(places)) : null;
const normalize = (value) => asText(value).toLowerCase().replace(/\s+/g, " ");

function runPlatform(run) {
  return asText(effectivePlatform(run)).toLowerCase();
}

function promptSetFromQuestions(run, promptMap = new Map()) {
  const values = (run?.questions || []).map((question) => {
    const prompt = promptMap.get(question.promptId);
    return question.questionSet || prompt?.questionSet || question.questionSetId || prompt?.questionSetId || null;
  }).filter(Boolean).map(normalize);
  return values.length && values.every((value) => value === values[0]) ? values[0] : null;
}

export function runQuestionSet(run, promptMap = new Map()) {
  return normalize(run?.questionSet || run?.questionSetId || run?.executionPolicy?.questionSetId || promptSetFromQuestions(run, promptMap));
}

export function runCompany(run, brand = null) {
  return normalize(run?.companyId || run?.brandId || run?.company || run?.brand?.id || brand?.id || brand?.legalName || brand?.name);
}

export function isComparableCompletedRun(run, { companyId = null, platform = null, questionSet = null, totalQuestions = null, brand = null, promptMap = new Map() } = {}) {
  const questions = Array.isArray(run?.questions) ? run.questions : [];
  const expectedTotal = Number(totalQuestions);
  const complete = run?.status === "completed"
    && Number(run.completed) === Number(run.total)
    && Number(run.total) > 0
    && questions.length === Number(run.total)
    && questions.every((question) => question.status === "success" && asText(question.rawAnswer));
  if (!complete) return false;
  if (Number.isFinite(expectedTotal) && Number(run.total) !== expectedTotal) return false;
  if (platform && runPlatform(run) !== normalize(platform)) return false;
  if (questionSet && runQuestionSet(run, promptMap) !== normalize(questionSet)) return false;
  if (companyId && runCompany(run, brand) !== normalize(companyId)) return false;
  return true;
}

function questionPromptId(question) {
  return asText(question?.promptId || question?.question_id || question?.id);
}

function questionJudgement(question, brand) {
  if (!question || question.status !== "success" || !asText(question.rawAnswer)) return null;
  const stored = question.mentionResult || question.recommendationResult;
  const judged = classifyBrowserVisibilityAnswer(question.rawAnswer, brand);
  return {
    brandMentioned: stored?.brandMentioned !== undefined ? Boolean(stored.brandMentioned) : Boolean(judged.brandMentioned),
    recommendation: stored?.recommendation || judged.recommendation || "none",
    valid: judged.hasValidCompanyAnswer !== false,
  };
}

function questionMap(run, brand) {
  return new Map((run?.questions || []).map((question) => [questionPromptId(question), { question, judgement: questionJudgement(question, brand) }]));
}

function metricForRun(run, brand, key) {
  const summary = run?.visibilitySummary;
  if (summary && Number.isFinite(Number(summary[key]))) return Number(summary[key]);
  const values = [...questionMap(run, brand).values()].map(({ judgement }) => judgement).filter((item) => item?.valid);
  if (!values.length) return null;
  if (key === "mentionRate") return values.filter((item) => item.brandMentioned).length / values.length;
  return values.filter((item) => ["first", "top3"].includes(item.recommendation)).length / values.length;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function compareMetric(current, baseline, absoluteThreshold, relativeThreshold) {
  const absoluteDelta = current === null || baseline === null ? null : current - baseline;
  const relativeDelta = absoluteDelta === null || baseline === 0 ? null : absoluteDelta / baseline;
  const absoluteDrop = absoluteDelta !== null && absoluteDelta <= -absoluteThreshold;
  const relativeDrop = relativeDelta !== null && relativeDelta <= -relativeThreshold;
  return {
    current: round(current), baseline: round(baseline), absoluteDelta: round(absoluteDelta), relativeDelta: round(relativeDelta),
    absoluteDrop, relativeDrop, dropTriggered: absoluteDrop || relativeDrop,
  };
}

function answerRows(run, brand) {
  return (run?.questions || []).map((question) => ({
    question,
    promptId: questionPromptId(question),
    judgement: questionJudgement(question, brand),
  })).filter((row) => row.judgement?.valid);
}

function promptDetails(promptId, prompts) {
  const prompt = prompts.get(promptId);
  return { promptId, questionText: prompt?.text || prompt?.questionText || null, intent: prompt?.intent || null, region: prompt?.region || null };
}

function buildPromptMatrix(currentRun, baselineRuns, { brand, prompts = new Map() }) {
  const current = questionMap(currentRun, brand);
  const baselineMaps = baselineRuns.map((run) => questionMap(run, brand));
  const ids = new Set([...current.keys(), ...baselineMaps.flatMap((map) => [...map.keys()])]);
  const matrix = [...ids].filter(Boolean).map((promptId) => {
    const historical = baselineMaps.map((map) => map.get(promptId)?.judgement).filter(Boolean);
    const previousVisible = historical.filter((item) => item.valid && item.brandMentioned).length;
    const previousValid = historical.filter((item) => item.valid).length;
    const currentJudgement = current.get(promptId)?.judgement || null;
    const baselineRate = previousValid ? previousVisible / previousValid : null;
    const currentRate = currentJudgement?.valid ? (currentJudgement.brandMentioned ? 1 : 0) : null;
    let classification = "volatile";
    if (baselineRate !== null && currentRate !== null) {
      if (baselineRate >= 0.8 && currentRate < 0.5) classification = "lost_visibility";
      else if (baselineRate < 0.5 && currentRate >= 0.8) classification = "new_visibility";
      else if (baselineRate >= 0.8 && currentRate >= 0.8) classification = "stable_visible";
      else if (baselineRate < 0.5 && currentRate < 0.5) classification = "stable_invisible";
    }
    return { ...promptDetails(promptId, prompts), baselineRate: round(baselineRate), currentRate: round(currentRate), delta: round(currentRate === null || baselineRate === null ? null : currentRate - baselineRate), classification, baselineVisibleRuns: previousVisible, baselineSampleSize: previousValid, currentVisibleRuns: currentJudgement?.valid && currentJudgement.brandMentioned ? 1 : 0, currentSampleSize: currentJudgement?.valid ? 1 : 0 };
  }).sort((a, b) => (b.baselineRate || 0) - (a.baselineRate || 0));
  return {
    items: matrix,
    counts: Object.fromEntries(["stable_visible", "lost_visibility", "new_visibility", "stable_invisible", "volatile"].map((key) => [key, matrix.filter((item) => item.classification === key).length])),
    lostVisibilityPrompts: matrix.filter((item) => item.classification === "lost_visibility"),
  };
}

function sceneClusters(matrix) {
  const clusters = new Map();
  for (const item of matrix.items) {
    const key = item.intent || item.region || "未分类";
    const bucket = clusters.get(key) || { scene: key, promptCount: 0, baselineVisible: 0, currentVisible: 0, lostVisibilityCount: 0, stableVisibleCount: 0 };
    bucket.promptCount += 1;
    if (item.baselineRate !== null) bucket.baselineVisible += item.baselineRate;
    if (item.currentRate !== null) bucket.currentVisible += item.currentRate;
    if (item.classification === "lost_visibility") bucket.lostVisibilityCount += 1;
    if (item.classification === "stable_visible") bucket.stableVisibleCount += 1;
    clusters.set(key, bucket);
  }
  return [...clusters.values()].map((bucket) => ({
    ...bucket,
    baselineMentionRate: round(bucket.promptCount ? bucket.baselineVisible / bucket.promptCount : null),
    currentMentionRate: round(bucket.promptCount ? bucket.currentVisible / bucket.promptCount : null),
    delta: round(bucket.promptCount ? (bucket.currentVisible - bucket.baselineVisible) / bucket.promptCount : null),
  })).sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0));
}

function citationRows(run, brand) {
  return (run?.questions || []).flatMap((question) => {
    const citations = Array.isArray(question.browserCitations) && question.browserCitations.length
      ? question.browserCitations
      : (Array.isArray(question.citations) ? question.citations : []);
    return citations.map((citation) => ({ ...citation, questionId: questionPromptId(question), domain: normalize(citation.domain || "") || null, normalizedUrl: citation.normalizedUrl || citation.resolvedUrl || citation.url || null }));
  });
}

function citationComparison(currentRun, baselineRuns, brand) {
  const currentRows = citationRows(currentRun, brand);
  const baselineRows = baselineRuns.flatMap((run) => citationRows(run, brand));
  const currentSummary = currentRun.sourceSummary || buildCitationSourceSummary(currentRun, brand);
  const baselineSummaries = baselineRuns.map((run) => run.sourceSummary || buildCitationSourceSummary(run, brand));
  const notObservedRuns = [currentRun, ...baselineRuns].filter((run) => citationObservationState(run) === "not_observed");
  if (notObservedRuns.length) {
    return {
      available: false,
      status: "not_observed",
      reason: "历史批次未采集结构化引用来源，无法进行信源变化比较。没有历史 Citation 数据不代表历史豆包没有 Citation。",
      current: currentSummary,
      baseline: { sampleSize: baselineSummaries.length, notObservedRunIds: baselineRuns.filter((run) => citationObservationState(run) === "not_observed").map((run) => run.id) },
      brandRelatedSourceCoverage: { current: null, baseline: null },
      competitorRelatedSourceCoverage: { current: null, baseline: null },
      sourceAdded: [],
      sourceRemoved: [],
      sourceShareChanged: [],
      brandSourceLost: [],
      competitorSourceGained: [],
    };
  }
  const baselineDomains = new Set(baselineRows.map((row) => row.domain).filter(Boolean));
  const currentDomains = new Set(currentRows.map((row) => row.domain).filter(Boolean));
  const domainStats = (rows) => {
    const total = rows.length || 1; const map = new Map();
    for (const row of rows) { const key = row.domain || "未记录域名"; const item = map.get(key) || { domain: key, citationCount: 0, questionIds: new Set(), brandRelated: 0, competitors: new Set() }; item.citationCount += 1; item.questionIds.add(row.questionId); if (["confirmed", "probable"].includes(row.brandRelatedCitation)) item.brandRelated += 1; for (const company of row.mentionedCompanies || []) item.competitors.add(company); map.set(key, item); }
    return new Map([...map].map(([domain, item]) => [domain, { domain, citationCount: item.citationCount, questionCount: item.questionIds.size, share: item.citationCount / total, brandRelated: item.brandRelated, competitors: [...item.competitors] }]));
  };
  const currentStats = domainStats(currentRows); const baselineStats = domainStats(baselineRows);
  const sourceShareChanged = [...new Set([...currentStats.keys(), ...baselineStats.keys()])].map((domain) => ({ domain, currentShare: round(currentStats.get(domain)?.share || 0), baselineShare: round(baselineStats.get(domain)?.share || 0), delta: round((currentStats.get(domain)?.share || 0) - (baselineStats.get(domain)?.share || 0)) })).filter((item) => Math.abs(item.delta || 0) >= 0.10).sort((a, b) => Math.abs(b.delta || 0) - Math.abs(a.delta || 0));
  const brandDomainsBefore = new Set(baselineRows.filter((row) => ["confirmed", "probable"].includes(row.brandRelatedCitation)).map((row) => row.domain).filter(Boolean));
  const brandDomainsNow = new Set(currentRows.filter((row) => ["confirmed", "probable"].includes(row.brandRelatedCitation)).map((row) => row.domain).filter(Boolean));
  const competitorDomainsBefore = new Set(baselineRows.filter((row) => (row.mentionedCompanies || []).length).map((row) => row.domain).filter(Boolean));
  const competitorDomainsNow = new Set(currentRows.filter((row) => (row.mentionedCompanies || []).length).map((row) => row.domain).filter(Boolean));
  const competitorQuestions = (rows) => new Set(rows.filter((row) => (row.mentionedCompanies || []).length).map((row) => row.questionId)).size;
  return {
    current: currentSummary,
    baseline: { sampleSize: baselineSummaries.length, averageBrandRelatedCitationCoverage: round(average(baselineSummaries.map((summary) => Number(summary.totalQuestions) ? Number(summary.brandRelatedCitationQuestions || 0) / Number(summary.totalQuestions) : null))), topDomains: [...new Set(baselineSummaries.flatMap((summary) => (summary.topDomains || []).map((item) => item.domain)))].slice(0, 20), topUrls: [...new Set(baselineSummaries.flatMap((summary) => (summary.topUrls || []).map((item) => item.url)))].slice(0, 20) },
    brandRelatedSourceCoverage: { current: currentSummary.totalQuestions ? round((currentSummary.brandRelatedCitationQuestions || 0) / currentSummary.totalQuestions) : null, baseline: round(average(baselineSummaries.map((summary) => summary.totalQuestions ? (summary.brandRelatedCitationQuestions || 0) / summary.totalQuestions : null))) },
    competitorRelatedSourceCoverage: { current: currentRun?.total ? round(competitorQuestions(currentRows) / Number(currentRun.total)) : null, baseline: round(average(baselineRuns.map((run) => run.total ? competitorQuestions(citationRows(run, brand)) / Number(run.total) : null))) },
    sourceAdded: [...currentDomains].filter((domain) => !baselineDomains.has(domain)),
    sourceRemoved: [...baselineDomains].filter((domain) => !currentDomains.has(domain)),
    sourceShareChanged,
    brandSourceLost: [...brandDomainsBefore].filter((domain) => !brandDomainsNow.has(domain)),
    competitorSourceGained: [...competitorDomainsNow].filter((domain) => !competitorDomainsBefore.has(domain)),
  };
}

function competitorStats(runs, brand) {
  const map = new Map();
  for (const run of runs) for (const row of answerRows(run, brand)) {
    const names = extractCompetitorCandidates(row.question.rawAnswer, brand) || [];
    const recommended = ["first", "top3"].includes(row.judgement.recommendation);
    for (const name of names) {
      const key = normalize(name); const item = map.get(key) || { company: name, mentionCount: 0, promptIds: new Set(), priorityCount: 0 };
      item.mentionCount += 1; item.promptIds.add(row.promptId); if (recommended) item.priorityCount += 1; map.set(key, item);
    }
  }
  return new Map([...map].map(([key, item]) => [key, { company: item.company, mentionCount: item.mentionCount, promptCount: item.promptIds.size, promptIds: [...item.promptIds], priorityCount: item.priorityCount }]));
}

function competitorComparison(currentRun, baselineRuns, brand) {
  const current = competitorStats([currentRun], brand); const baseline = competitorStats(baselineRuns, brand);
  const changes = [...new Set([...current.keys(), ...baseline.keys()])].map((key) => ({ company: current.get(key)?.company || baseline.get(key)?.company || key, current: current.get(key) || { mentionCount: 0, promptCount: 0, promptIds: [], priorityCount: 0 }, baseline: baseline.get(key) || { mentionCount: 0, promptCount: 0, promptIds: [], priorityCount: 0 }, mentionDelta: (current.get(key)?.mentionCount || 0) - (baseline.get(key)?.mentionCount || 0), promptDelta: (current.get(key)?.promptCount || 0) - (baseline.get(key)?.promptCount || 0), priorityDelta: (current.get(key)?.priorityCount || 0) - (baseline.get(key)?.priorityCount || 0) })).sort((a, b) => b.mentionDelta - a.mentionDelta);
  return { changes, replacingCompetitors: changes.filter((item) => item.mentionDelta > 0 || item.priorityDelta > 0).slice(0, 10) };
}

function workerConsistency(run, brand) {
  const groups = new Map();
  for (const question of run.questions || []) {
    const worker = asText(question.workerId || question.job?.worker_id || "unknown"); const item = groups.get(worker) || { workerId: worker, completedQuestions: 0, failed: 0, retries: 0, mentions: 0, answerLengths: [], citationCount: 0 };
    if (question.status === "success") { item.completedQuestions += 1; const judgement = questionJudgement(question, brand); if (judgement?.brandMentioned) item.mentions += 1; if (asText(question.rawAnswer)) item.answerLengths.push(asText(question.rawAnswer).length); const citations = Array.isArray(question.browserCitations) && question.browserCitations.length ? question.browserCitations : (question.citations || []); item.citationCount += citations.length; }
    if (question.status === "failed") item.failed += 1; if (Number(question.attemptCount || 0) > 1) item.retries += Number(question.attemptCount || 0) - 1; groups.set(worker, item);
  }
  return [...groups.values()].map((item) => ({ ...item, mentionRate: item.completedQuestions ? round(item.mentions / item.completedQuestions) : null, averageAnswerLength: item.answerLengths.length ? Math.round(item.answerLengths.reduce((sum, value) => sum + value, 0) / item.answerLengths.length) : null }));
}

function dataQuality(run) {
  const questions = run.questions || []; const answers = questions.filter((question) => question.status === "success").map((question) => normalize(question.rawAnswer)).filter(Boolean); const answerCounts = new Map(); for (const answer of answers) answerCounts.set(answer, (answerCounts.get(answer) || 0) + 1);
  const promptIds = questions.map(questionPromptId).filter(Boolean); const uniquePromptIds = new Set(promptIds);
  const conversations = questions.map((question) => asText(question.conversationId || question.sessionUuid)).filter(Boolean); const duplicateConversationIds = conversations.filter((id, index) => conversations.indexOf(id) !== index);
  const citationCapture = {}; for (const question of questions) { const status = question.citationCaptureStatus || "not_available"; citationCapture[status] = (citationCapture[status] || 0) + 1; }
  return {
    completeAnswers: questions.filter((question) => question.status === "success" && asText(question.rawAnswer)).length,
    emptyAnswers: questions.filter((question) => question.status === "success" && !asText(question.rawAnswer)).length,
    duplicateAnswers: [...answerCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    promptConsistency: { totalQuestions: questions.length, uniquePromptIds: uniquePromptIds.size, duplicatePromptIds: promptIds.filter((id, index) => promptIds.indexOf(id) !== index), consistent: promptIds.length === questions.length && uniquePromptIds.size === questions.length },
    conversationIsolation: { totalQuestions: questions.length, missingConversationId: questions.filter((question) => !asText(question.conversationId || question.sessionUuid)).length, duplicateConversationIds: [...new Set(duplicateConversationIds)], isolated: conversations.length === questions.length && duplicateConversationIds.length === 0 },
    citationCapture,
  };
}

function promptOpportunityList(currentRun, matrix, stageDiagnostics, prompts, brand) {
  const currentQuestions = new Map((currentRun?.questions || []).map((question) => [questionPromptId(question), question]));
  const stageByPrompt = new Map((stageDiagnostics.items || []).map((item) => [item.questionId, item]));
  return matrix.items
    .filter((item) => ["lost_visibility", "volatile", "stable_invisible"].includes(item.classification))
    .map((item) => {
      const prompt = prompts.get(item.promptId) || {};
      const question = currentQuestions.get(item.promptId);
      const competitors = question ? extractCompetitorCandidates(question.rawAnswer, brand) : [];
      const citations = question ? citationRows({ questions: [question] }, brand).map((citation) => citation.domain || citation.title || citation.url).filter(Boolean) : [];
      const commercial = /购买转化|品类推荐|对比决策/.test(`${item.intent || ""} ${item.questionText || ""}`) || Number(prompt.weight) >= 4;
      const priority = item.classification === "lost_visibility" && commercial ? "P0" : item.classification === "lost_visibility" || item.classification === "volatile" ? "P1" : "P2";
      const stage = stageByPrompt.get(item.promptId) || { diagnosisType: "unknown", confidence: "low", summary: "证据不足，无法确认阶段" };
      const suggestedAction = stage.diagnosisType === "likely_retrieval_or_candidate_loss"
        ? "补强该问题对应的品牌实体、可抓取信源和第三方证据，并复测。"
        : stage.diagnosisType === "ranking_competitiveness"
          ? "补充可比较的能力、案例和适用场景证据，提升进入推荐前列的竞争力。"
          : stage.diagnosisType === "generation_selection_loss"
            ? "检查品牌信源内容是否清晰、可引用，并增加与该 Prompt 直接匹配的事实段落。"
            : "继续观察并补充该场景的可核实公开信息。";
      return {
        priority,
        promptId: item.promptId,
        prompt: item.questionText,
        intent: item.intent,
        historicalPerformance: `${item.baselineVisibleRuns}/${item.baselineSampleSize} 次出现`,
        currentPerformance: `${item.currentVisibleRuns}/${item.currentSampleSize} 次出现`,
        currentCompetitors: competitors,
        currentSources: [...new Set(citations)].slice(0, 5),
        diagnosisType: stage.diagnosisType,
        confidence: stage.confidence,
        suggestedAction,
      };
    })
    .sort((a, b) => ({ P0: 0, P1: 1, P2: 2 }[a.priority] - { P0: 0, P1: 1, P2: 2 }[b.priority]) || String(a.prompt || a.promptId).localeCompare(String(b.prompt || b.promptId)));
}

function buildDiagnosticConclusion({ mention, priority, matrix, citation, stageDiagnostics, quality }) {
  const counts = stageDiagnostics.counts || {};
  const candidates = [
    ["likely_retrieval_or_candidate_loss", counts.likely_retrieval_or_candidate_loss || 0, "高概率为品牌候选/信源召回下降"],
    ["generation_selection_loss", counts.generation_selection_loss || 0, "倾向为生成阶段没有选用已出现的品牌信源"],
    ["ranking_competitiveness", counts.ranking_competitiveness || 0, "倾向为品牌进入回答但排名竞争力下降"],
  ].sort((a, b) => b[1] - a[1]);
  const top = candidates[0];
  const confidence = top[1] ? (stageDiagnostics.items.filter((item) => item.diagnosisType === top[0]).some((item) => item.confidence === "high") ? "high" : stageDiagnostics.items.filter((item) => item.diagnosisType === top[0]).some((item) => item.confidence === "medium") ? "medium" : "low") : "low";
  const evidence = [
    `${quality.completeAnswers}/${quality.promptConsistency.totalQuestions} 个问题保存了非空完整回答`,
    `品牌提及率 ${(Number(mention.current || 0) * 100).toFixed(1)}%（基准 ${(Number(mention.baseline || 0) * 100).toFixed(1)}%）`,
    `${matrix.lostVisibilityPrompts.length} 个历史高频 Prompt 被标记为可见度丢失`,
    `品牌相关来源覆盖 ${(Number(citation.brandRelatedSourceCoverage.current || 0) * 100).toFixed(1)}%（基准 ${(Number(citation.brandRelatedSourceCoverage.baseline || 0) * 100).toFixed(1)}%）`,
  ];
  return { diagnosisType: top[1] ? top[0] : "unknown", confidence, summary: top[1] ? top[2] : "当前数据不足以确认主要下降阶段", evidence };
}

export function buildGeoDropDiagnostics({ currentRun, historicalRuns = [], prompts = [], brand = null, config = {} } = {}) {
  const options = { ...DEFAULT_GEO_DIAGNOSTIC_CONFIG, ...config };
  const promptMap = prompts instanceof Map ? prompts : new Map((prompts || []).map((prompt) => [prompt.id, prompt]));
  const currentCompany = runCompany(currentRun, brand);
  const currentQuestionSet = runQuestionSet(currentRun, promptMap);
  const currentComparable = currentCompany && currentQuestionSet && isComparableCompletedRun(currentRun, { companyId: currentCompany, platform: runPlatform(currentRun), questionSet: currentQuestionSet, totalQuestions: currentRun?.total, brand, promptMap });
  if (!currentComparable) {
    return {
      schemaVersion: 1,
      eligible: false,
      triggered: false,
      triggerReasons: [],
      reason: "current_run_not_comparable_completed",
      thresholds: { absolute: Number(options.absoluteThreshold), relative: Number(options.relativeThreshold) },
      currentRunId: currentRun?.id || null,
      baselineRunIds: [],
      baselineSampleSize: 0,
      baselineRequested: Math.max(1, Math.trunc(options.baselineRuns)),
      comparison: { mentionRate: compareMetric(null, null, Number(options.absoluteThreshold), Number(options.relativeThreshold)), priorityRate: compareMetric(null, null, Number(options.absoluteThreshold), Number(options.relativeThreshold)) },
      observability: buildObservabilityQuality(currentRun),
      promptMatrix: { items: [], counts: {}, lostVisibilityPrompts: [] },
      sceneClusters: [], citationChanges: null, competitorChanges: { changes: [], replacingCompetitors: [] }, workerConsistency: [], dataQuality: dataQuality(currentRun), stageDiagnostics: { items: [], counts: {}, confidenceCounts: {}, inferenceCount: 0, factCount: 0, unknownCount: 0 }, conclusion: { diagnosisType: "unknown", confidence: "low", summary: "当前 Run 未达到完整可比条件", evidence: [] }, opportunities: [], generatedAt: new Date().toISOString(),
    };
  }
  const comparable = currentCompany && currentQuestionSet
    ? historicalRuns.filter((run) => run?.id !== currentRun?.id && isComparableCompletedRun(run, { companyId: currentCompany, platform: runPlatform(currentRun), questionSet: currentQuestionSet, totalQuestions: currentRun?.total, brand, promptMap })).sort((a, b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0)).slice(0, Math.max(1, Math.trunc(options.baselineRuns)))
    : [];
  const currentMention = metricForRun(currentRun, brand, "mentionRate"); const currentPriority = metricForRun(currentRun, brand, "priorityRate");
  const mention = compareMetric(currentMention, average(comparable.map((run) => metricForRun(run, brand, "mentionRate"))), Number(options.absoluteThreshold), Number(options.relativeThreshold));
  const priority = compareMetric(currentPriority, average(comparable.map((run) => metricForRun(run, brand, "priorityRate"))), Number(options.absoluteThreshold), Number(options.relativeThreshold));
  const matrix = buildPromptMatrix(currentRun, comparable, { brand, prompts: promptMap });
  const citation = citationComparison(currentRun, comparable, brand);
  const stageDiagnostics = buildPromptStageDiagnostics(currentRun, { brand });
  const quality = dataQuality(currentRun);
  const reasons = []; if (mention.dropTriggered) reasons.push(`品牌提及率下降：${round(mention.absoluteDelta * 100, 1)} 个百分点`); if (priority.dropTriggered) reasons.push(`优先推荐率下降：${round(priority.absoluteDelta * 100, 1)} 个百分点`); if (matrix.lostVisibilityPrompts.length) reasons.push(`${matrix.lostVisibilityPrompts.length} 个高频提及问题出现可见度丢失`); if (citation.brandSourceLost.length) reasons.push(`品牌相关来源域名减少 ${citation.brandSourceLost.length} 个`);
  return {
    schemaVersion: 1,
    triggered: reasons.length > 0,
    triggerReasons: reasons,
    thresholds: { absolute: Number(options.absoluteThreshold), relative: Number(options.relativeThreshold) },
    currentRunId: currentRun?.id || null,
    baselineRunIds: comparable.map((run) => run.id),
    baselineSampleSize: comparable.length,
    baselineRequested: Math.max(1, Math.trunc(options.baselineRuns)),
    comparison: { mentionRate: mention, priorityRate: priority },
    promptMatrix: matrix,
    sceneClusters: sceneClusters(matrix),
    citationChanges: citation,
    competitorChanges: competitorComparison(currentRun, comparable, brand),
    workerConsistency: workerConsistency(currentRun, brand),
    dataQuality: quality,
    observability: buildObservabilityQuality(currentRun),
    stageDiagnostics,
    conclusion: buildDiagnosticConclusion({ mention, priority, matrix, citation, stageDiagnostics, quality }),
    opportunities: promptOpportunityList(currentRun, matrix, stageDiagnostics, promptMap, brand),
    generatedAt: new Date().toISOString(),
  };
}
