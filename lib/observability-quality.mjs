const CITATION_CAPTURED = new Set(["success", "empty"]);
const CITATION_FAILURES = new Set(["failed", "partial"]);
const V2_TO_LEGACY_STATUS = Object.freeze({
  CAPTURED: "success", NO_CITATION_CONFIRMED: "empty", CAPTURED_PARTIAL: "partial",
  CITATION_REGION_NOT_LOADED: "not_available", CAPTURE_FAILED: "failed",
});

const text = (value) => String(value ?? "").trim();

/**
 * Explain whether a completed Run has enough audit evidence for root-cause
 * analysis. This is intentionally separate from GEO scoring and visibility.
 */
export function buildObservabilityQuality(run = {}) {
  const questions = Array.isArray(run.questions) ? run.questions : [];
  const total = Number(run.total || questions.length || 0);
  const answersCaptured = questions.filter((question) => question.status === "success" && text(question.rawAnswer)).length;
  const citationStatuses = questions.map((question) => question.citationCaptureVersion === "v2"
    ? question.citationLegacyStatus || question.citationCaptureV2?.legacyStatus || V2_TO_LEGACY_STATUS[question.citationCaptureStatus] || "not_available"
    : question.citationCaptureStatus || question.job?.citation_capture_status || "not_available");
  const citationsCapturedQuestions = citationStatuses.filter((status) => CITATION_CAPTURED.has(status)).length;
  const citationCaptureFailures = citationStatuses.filter((status) => CITATION_FAILURES.has(status)).length;
  const citationVisibilityMismatches = questions.filter((question) => question.citationVisibilityMismatch === true || question.job?.citation_visibility_mismatch === true).length;
  const citationCaptureUnavailable = citationStatuses.filter((status) => status === "not_available").length;
  const citationCaptureNotObserved = citationStatuses.filter((status) => status === "not_observed").length;
  const conversationAudited = questions.filter((question) => text(question.conversationId || question.sessionUuid)).length;
  const workerAudited = questions.filter((question) => text(question.workerId || question.job?.worker_id) && (text(question.pageId || question.job?.page_id) || Number(question.pageIndex) > 0)).length;
  const ratio = (value) => total ? Math.round((value / total) * 10_000) / 100 : 0;
  const answerCoverage = ratio(answersCaptured);
  const citationCoverage = ratio(citationsCapturedQuestions);
  const conversationAuditCoveragePercent = ratio(conversationAudited);
  const workerAuditCoveragePercent = ratio(workerAudited);
  let diagnosticReadiness = "low";
  if (total > 0 && answersCaptured === total && citationCoverage >= 90 && conversationAudited === total && workerAudited === total && citationCaptureFailures === 0) diagnosticReadiness = "high";
  else if (total > 0 && answersCaptured === total && citationCoverage >= 50 && conversationAuditCoveragePercent >= 80 && workerAuditCoveragePercent >= 80) diagnosticReadiness = "medium";
  const geoResultTrustworthy = total > 0 && answersCaptured === total;
  return {
    schemaVersion: 1,
    totalQuestions: total,
    answersCaptured,
    answerCoveragePercent: answerCoverage,
    citationsCapturedQuestions,
    citationCaptureFailures,
    citationVisibilityMismatches,
    citationCaptureUnavailable,
    citationCaptureNotObserved,
    citationCoveragePercent: citationCoverage,
    conversationAudited,
    conversationAuditCoverage: conversationAudited,
    conversationAuditCoveragePercent,
    workerAudited,
    workerAuditCoverage: workerAudited,
    workerAuditCoveragePercent,
    geoResultTrustworthy,
    geoResultReliability: geoResultTrustworthy ? "high" : "low",
    diagnosticReadiness,
    readinessReason: diagnosticReadiness === "high"
      ? "回答、Citation采集和会话/Worker审计信息完整，可进行较充分根因诊断。"
      : diagnosticReadiness === "medium"
        ? "GEO回答数据基本完整，但部分来源或审计证据缺失，根因诊断需要保留不确定性。"
        : "回答或Citation/审计证据缺失较多；GEO数值可单独查看，但根因诊断证据不足。",
  };
}
