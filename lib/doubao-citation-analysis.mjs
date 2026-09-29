import { extractCompetitorCandidates, findMatchedBrandAliases, normalizeOwnedDomain } from "./core.mjs";
import { calculateSourceAgeHours } from "./doubao-citation-extractor.mjs";

const CAPTURE_FAILURES = new Set(["failed", "partial"]);
const STRUCTURED_CAPTURE_STATUSES = new Set(["success", "empty", "partial", "failed", "not_available"]);
const V2_CAPTURE_STATUSES = new Set(["CAPTURED", "NO_CITATION_CONFIRMED", "CAPTURED_PARTIAL", "CITATION_REGION_NOT_LOADED", "CAPTURE_FAILED"]);
const V2_TO_LEGACY_STATUS = Object.freeze({
  CAPTURED: "success",
  NO_CITATION_CONFIRMED: "empty",
  CAPTURED_PARTIAL: "partial",
  CITATION_REGION_NOT_LOADED: "not_available",
  CAPTURE_FAILED: "failed",
});

export function citationCaptureStatus(question = {}) {
  if (question.citationCaptureVersion === "v2") {
    return question.citationLegacyStatus || question.citationCaptureV2?.legacyStatus
      || V2_TO_LEGACY_STATUS[question.citationCaptureStatus] || "not_available";
  }
  if (Object.hasOwn(question, "citationCaptureStatus")) return question.citationCaptureStatus || "not_available";
  if (Object.hasOwn(question.job || {}, "citation_capture_status")) return question.job.citation_capture_status || "not_available";
  return "not_observed";
}

export function citationObservationState(run = {}) {
  const questions = Array.isArray(run.questions) ? run.questions : [];
  const statuses = questions.map(citationCaptureStatus);
  if (statuses.some((status) => status === "not_observed")) return "not_observed";
  if (statuses.length && statuses.every((status) => STRUCTURED_CAPTURE_STATUSES.has(status))) return "observed";
  return "not_observed";
}

/**
 * Mark only records that predate structured citation capture. No citation is
 * inferred and no empty-source claim is made. New live runs always carry an
 * explicit status and are left unchanged.
 */
export function normalizeHistoricalCitationObservation(run = {}) {
  const questions = Array.isArray(run.questions) ? run.questions : [];
  if (!questions.length) return false;
  const hasExplicitStatus = questions.some((question) => Object.hasOwn(question, "citationCaptureStatus") || Object.hasOwn(question.job || {}, "citation_capture_status"));
  if (hasExplicitStatus) return false;
  let changed = false;
  for (const question of questions) {
    if (question.citationCaptureStatus !== "not_observed") { question.citationCaptureStatus = "not_observed"; changed = true; }
    question.job ||= {};
    if (question.job.citation_capture_status !== "not_observed") { question.job.citation_capture_status = "not_observed"; changed = true; }
  }
  if (run.citationObservationStatus !== "not_observed") { run.citationObservationStatus = "not_observed"; changed = true; }
  return changed;
}

function textOf(citation = {}) {
  return [citation.title, citation.visibleText, citation.url, citation.domain].filter(Boolean).join(" ").trim();
}

function ownedDomain(domain, brand) {
  const normalized = normalizeOwnedDomain(domain || "");
  return normalized && (brand?.domains || []).map(normalizeOwnedDomain).includes(normalized);
}

/**
 * Classify a citation conservatively. A title/domain alone cannot prove a
 * brand relationship; the result is deliberately separate from GEO scoring.
 */
export function analyzeCitationBrandRelation(citation = {}, brand = null) {
  const titleText = [citation.title, citation.visibleText].filter(Boolean).join(" ").trim();
  const allText = textOf(citation);
  const aliases = findMatchedBrandAliases(titleText, brand);
  const domainOwned = ownedDomain(citation.domain, brand) || ownedDomain(citation.url, brand);
  const hasSignal = Boolean(titleText || citation.url || citation.domain);
  if (aliases.length && domainOwned) {
    return { brandRelatedCitation: "confirmed", brandRelationReason: `来源标题/可见文本命中品牌实体，且域名属于已配置品牌域名（${aliases.join("、")}）` };
  }
  if (aliases.length) {
    return { brandRelatedCitation: "probable", brandRelationReason: `来源标题或可见文本命中品牌别名（${aliases.join("、")}），但域名未被配置为品牌官方域名` };
  }
  if (domainOwned) {
    return { brandRelatedCitation: "unknown", brandRelationReason: "来源域名属于品牌已配置域名，但仅凭域名不足以确认该来源内容与品牌实体相关" };
  }
  if (!hasSignal) return { brandRelatedCitation: "unknown", brandRelationReason: "来源缺少标题、可见文本和可解析 URL，无法判断品牌关系" };
  const competitorCandidates = brand ? extractCompetitorCandidates(allText, brand) : [];
  if (competitorCandidates.length) return { brandRelatedCitation: "none", brandRelationReason: `来源文本未命中当前品牌实体；仅识别到其他企业实体（${competitorCandidates.join("、")}）` };
  return { brandRelatedCitation: "none", brandRelationReason: "来源标题、可见文本和域名未命中当前品牌实体" };
}

export function enrichCitationBrandRelation(citation = {}, brand = null) {
  const relation = analyzeCitationBrandRelation(citation, brand);
  const mentionedCompanies = brand ? extractCompetitorCandidates(textOf(citation), brand) : [];
  return { ...citation, ...relation, mentionedCompanies };
}

function citationsForQuestion(question = {}) {
  if (Array.isArray(question.browserCitations)) return question.browserCitations;
  if (Array.isArray(question.citations)) return question.citations;
  if (Array.isArray(question.job?.citations)) return question.job.citations;
  return [];
}

function share(count, denominator) {
  return denominator ? Math.round((count / denominator) * 10_000) / 10_000 : 0;
}

function domainFromCitation(citation = {}) {
  if (citation.domain) return String(citation.domain);
  try { return new URL(citation.resolvedUrl || citation.url).hostname; } catch { return ""; }
}

function rankedCitationItems(map, total) {
  return [...map.values()]
    .map((item) => ({ ...item, questionCount: item.questionIds.size, share: share(item.citationCount, total) }))
    .sort((a, b) => b.citationCount - a.citationCount || String(a.domain || a.url).localeCompare(String(b.domain || b.url)))
    .map((item) => {
      delete item.questionIds;
      return item;
    });
}

/**
 * Citation V2 analytics deliberately ignores every historical answer without
 * `citationCaptureVersion: "v2"`. It is additive and never alters GEO
 * visibility/ranking summaries or legacy citation observations.
 */
export function buildCitationV2Analytics(run = {}) {
  const questions = (Array.isArray(run.questions) ? run.questions : [])
    .filter((question) => question.citationCaptureVersion === "v2");
  const citations = questions.flatMap((question) => citationsForQuestion(question).map((citation) => ({ citation, question })));
  const urlMap = new Map();
  const domainMap = new Map();
  for (const { citation, question } of citations) {
    const url = citation.normalizedUrl || citation.resolvedUrl || citation.url || null;
    const domain = domainFromCitation(citation).trim().toLowerCase().replace(/^www\./, "");
    const questionId = question.promptId || question.questionId || question.job?.question_id || "unknown";
    if (url) {
      const item = urlMap.get(url) || { url, citationCount: 0, questionIds: new Set() };
      item.citationCount += 1; item.questionIds.add(questionId); urlMap.set(url, item);
    }
    if (domain) {
      const item = domainMap.get(domain) || { domain, citationCount: 0, questionIds: new Set() };
      item.citationCount += 1; item.questionIds.add(questionId); domainMap.set(domain, item);
    }
  }
  const statusCount = (status) => questions.filter((question) => question.citationCaptureStatus === status).length;
  return {
    captureVersion: "v2",
    answersTotal: questions.length,
    answersWithCitations: questions.filter((question) => citationsForQuestion(question).length > 0).length,
    answersWithoutCitationConfirmed: statusCount("NO_CITATION_CONFIRMED"),
    answersCitationPartial: statusCount("CAPTURED_PARTIAL"),
    answersCitationRegionNotLoaded: statusCount("CITATION_REGION_NOT_LOADED"),
    answersCitationFailed: statusCount("CAPTURE_FAILED"),
    citationsTotal: citations.length,
    uniqueCitationUrls: urlMap.size,
    uniqueCitationDomains: domainMap.size,
    topCitationDomains: rankedCitationItems(domainMap, citations.length),
    topCitationUrls: rankedCitationItems(urlMap, citations.length),
  };
}

export function buildCitationFreshnessSummary(run = {}) {
  const citations = (Array.isArray(run.questions) ? run.questions : []).flatMap((question) => citationsForQuestion(question));
  const ages = citations.map((citation) => Number.isFinite(Number(citation.sourceAgeHours))
    ? Number(citation.sourceAgeHours)
    : calculateSourceAgeHours(citation.publishedAt, citation.capturedAt)).filter(Number.isFinite);
  const within = (hours) => ages.filter((age) => age >= 0 && age <= hours).length;
  return {
    citationsWithPublishedAt: ages.length,
    citationsWithoutPublishedAt: Math.max(0, citations.length - ages.length),
    citationsWithin24h: within(24),
    citationsWithin3d: within(72),
    citationsWithin7d: within(168),
    citationsWithin30d: within(720),
    sourceAgeHoursAvailable: ages.length,
    sourceAgeHoursMin: ages.length ? Math.min(...ages) : null,
    sourceAgeHoursMax: ages.length ? Math.max(...ages) : null,
  };
}

/** Build a durable run-level source summary without changing GEO judgement. */
export function buildCitationSourceSummary(run = {}, brand = null) {
  const questions = Array.isArray(run.questions) ? run.questions : [];
  const allCitations = questions.flatMap((question) => citationsForQuestion(question).map((citation) => ({ citation, question })));
  const domainMap = new Map();
  const urlMap = new Map();
  const brandQuestionIds = new Set();
  let brandRelatedCitationCount = 0;
  for (const { citation, question } of allCitations) {
    const enriched = citation.brandRelatedCitation ? citation : enrichCitationBrandRelation(citation, brand);
    const domain = domainFromCitation(enriched).trim().toLowerCase().replace(/^www\./, "");
    const url = enriched.normalizedUrl || enriched.resolvedUrl || enriched.url || null;
    if (domain) {
      const item = domainMap.get(domain) || { domain, citationCount: 0, questionIds: new Set() };
      item.citationCount += 1;
      item.questionIds.add(question.promptId || question.questionId || question.job?.question_id || "unknown");
      domainMap.set(domain, item);
    }
    if (url) {
      const item = urlMap.get(url) || { url, citationCount: 0, questionIds: new Set() };
      item.citationCount += 1;
      item.questionIds.add(question.promptId || question.questionId || question.job?.question_id || "unknown");
      urlMap.set(url, item);
    }
    if (["confirmed", "probable"].includes(enriched.brandRelatedCitation)) {
      brandRelatedCitationCount += 1;
      brandQuestionIds.add(question.promptId || question.questionId || question.job?.question_id || "unknown");
    }
  }
  const toRanked = (map) => [...map.values()]
    .map((item) => ({ domain: item.domain, url: item.url, citationCount: item.citationCount, questionCount: item.questionIds.size, share: share(item.citationCount, allCitations.length) }))
    .sort((a, b) => b.citationCount - a.citationCount || String(a.domain || a.url).localeCompare(String(b.domain || b.url)))
    .map((item) => {
      if (item.domain) delete item.url;
      else delete item.domain;
      return item;
    });
  const questionsWithCitations = questions.filter((question) => citationsForQuestion(question).length > 0).length;
  const statuses = questions.map(citationCaptureStatus);
  const citationCaptureFailures = questions.filter((question) => CAPTURE_FAILURES.has(citationCaptureStatus(question))).length;
  const citationCaptureNotObserved = statuses.filter((status) => status === "not_observed").length;
  const citationVisibilityMismatches = questions.filter((question) => question.citationVisibilityMismatch === true || question.job?.citation_visibility_mismatch === true).length;
  const totalQuestions = Number(run.total || questions.length || 0);
  const summary = {
    totalCitations: allCitations.length,
    uniqueUrls: urlMap.size,
    uniqueDomains: domainMap.size,
    topDomains: toRanked(domainMap),
    topUrls: toRanked(urlMap),
    questionsWithCitations,
    questionsWithoutCitations: citationCaptureNotObserved ? null : Math.max(0, totalQuestions - questionsWithCitations),
    questionsWithoutObservedCitations: citationCaptureNotObserved ? null : Math.max(0, totalQuestions - questionsWithCitations),
    citationCaptureFailures,
    ...(citationVisibilityMismatches ? { citationVisibilityMismatches } : {}),
    citationCaptureNotObserved,
    citationObservationStatus: citationCaptureNotObserved ? "not_observed" : "observed",
    citationComparisonAvailable: citationCaptureNotObserved === 0,
    brandRelatedCitationCount,
    brandRelatedCitationQuestions: brandQuestionIds.size,
    ...buildCitationFreshnessSummary(run),
  };
  // Do not introduce a V2 coverage denominator into frozen historical runs.
  // New runs receive this additive analytics block as soon as one V2 answer is
  // saved, while all old GEO visibility aggregates remain untouched.
  if (questions.some((question) => question.citationCaptureVersion === "v2")) {
    summary.citationV2Analytics = buildCitationV2Analytics(run);
  }
  return summary;
}
