import { classifyBrowserVisibilityAnswer, now, uid } from "./core.mjs";
import { buildCitationSourceSummary } from "./doubao-citation-analysis.mjs";
import { buildObservabilityQuality } from "./observability-quality.mjs";
import { effectivePlatform, effectivePlatformMode } from "./platform.mjs";

export const DEFAULT_FAILED_QUESTION_RETRY_ROUNDS = 2;

export function createBrowserMonitorRun(prompts, options = {}) {
  const createdAt = now();
  const runId = options.runId || uid("browser_monitor");
  return {
    id: runId,
    provider: options.provider || options.platform || "doubao_web",
    platform: options.platform || "doubao_web",
    platformMode: options.platformMode || "chat",
    companyId: options.companyId || null,
    questionSet: options.questionSet || null,
    questionSetId: options.questionSetId || null,
    questionSetName: options.questionSetName || null,
    mode: options.mode || "replace_invalid_answer",
    sourceDate: options.sourceDate || null,
    retrySourceRunId: options.retrySourceRunId || null,
    executionPolicy: options.executionPolicy || null,
    reportable: options.reportable !== false,
    adapterVersion: options.adapterVersion || null,
    profileKey: options.profileKey || null,
    status: "queued",
    total: prompts.length,
    completed: 0,
    success: 0,
    failed: 0,
    invalid: 0,
    failedQuestionRetryRounds: 0,
    maxFailedQuestionRetryRounds: Number.isInteger(options.maxFailedQuestionRetryRounds)
      ? Math.max(0, Math.min(5, options.maxFailedQuestionRetryRounds))
      : DEFAULT_FAILED_QUESTION_RETRY_ROUNDS,
    createdAt,
    startedAt: null,
    updatedAt: createdAt,
    completedAt: null,
    sourceSummary: null,
    observability: null,
    geoDropDiagnostics: null,
    pausedReason: null,
    humanAction: null,
    humanActions: [],
    verificationLog: [],
    questions: prompts.map((prompt) => ({
      promptId: prompt.id,
      platform: options.platform || "doubao_web",
      platformMode: options.platformMode || "chat",
      questionText: prompt.text,
      questionSet: prompt.questionSet || options.questionSet || null,
      questionSetId: prompt.questionSetId || options.questionSetId || null,
      question: prompt.text,
      // Stable job contract for browser workers. Legacy fields remain so the
      // existing dashboard and GEO calculation do not change.
      job: {
        run_id: runId,
        question_id: prompt.id,
        platform: options.platform || "doubao_web",
        platform_mode: options.platformMode || "chat",
        question_set: prompt.questionSet || options.questionSet || null,
        question_set_id: prompt.questionSetId || options.questionSetId || null,
        worker_id: null,
        page_id: null,
        attempt: 0,
        status: "queued",
        question: prompt.text,
        raw_answer: null,
        citations: [],
        citation_capture_status: "not_available",
        citation_capture_error: null,
        citation_capture: null,
        citation_visibility_mismatch: null,
        started_at: null,
        completed_at: null,
        duration_ms: null,
        error_code: null,
        error_message: null,
        lock_id: null,
        locked_at: null,
      },
      // A replacement starts a new monitoring version. This lets the
      // consecutive-invalid rule count only tests made against the same
      // wording, while every earlier answer remains available for audit.
      promptVersion: Number(prompt.monitoringVersion || 1),
      replaceRunId: options.replaceRunIds?.[prompt.id] || null,
      status: "queued",
      attemptCount: 0,
      queuedAt: createdAt,
      activeAttemptQueuedAt: createdAt,
      startedAt: null,
      pageReadyAt: null,
      newChatStartedAt: null,
      newChatReadyAt: null,
      promptSubmittedAt: null,
      answerStartedAt: null,
      generationEndedAt: null,
      answerCompletedAt: null,
      savedAt: null,
      completedAt: null,
      latencyMs: null,
      stageDurationsMs: null,
      executionLog: [{ stage: "QUEUED", at: createdAt }],
      attemptHistory: [],
      browserStage: "queued",
      firstTokenAt: null,
      answerDurationMs: null,
      debugScreenshot: null,
      debugArtifact: null,
      debugArtifacts: [],
      conversationId: null,
      sessionUuid: null,
      workerId: null,
      pageIndex: null,
      pageId: null,
      conversationHistory: [],
      rawAnswer: null,
      mentionResult: null,
      recommendationResult: null,
      citations: [],
      browserCitations: [],
      citationCaptureStatus: "not_available",
      citationCaptureVersion: null,
      citationLegacyStatus: null,
      citationCount: 0,
      citationCheckedChannels: [],
      // V2 is deliberately additive. Historical runs retain their old
      // observation status; only future browser answers populate these.
      citationStatus: null,
      citationCaptureError: null,
      citationCapture: null,
      citationCaptureV2: null,
      citationVisibilityMismatch: null,
      errorMessage: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      outcome: null,
      exceptionType: null,
    })),
  };
}

export function findActiveBrowserMonitorRun(runs = [], selection = {}) {
  return runs.find((run) => ["queued", "preparing_browser", "waiting_for_login", "running", "paused", "needs_human_action"].includes(run.status)
    && (!selection.platform || effectivePlatform(run) === selection.platform)
    && (!selection.platformMode || effectivePlatformMode(run) === selection.platformMode)) || null;
}

export function updateBrowserMonitorRun(run) {
  run.success = run.questions.filter((question) => question.status === "success").length;
  run.failed = run.questions.filter((question) => question.status === "failed").length;
  run.invalid = run.questions.filter((question) => question.status === "invalid").length;
  const allQuestionsSettled = run.questions.every((question) => ["success", "failed", "invalid"].includes(question.status));
  if (allQuestionsSettled && run.failed > 0 && !["paused", "aborted"].includes(run.status)) {
    const retryRounds = Number(run.failedQuestionRetryRounds || 0);
    const maxRetryRounds = Number.isInteger(run.maxFailedQuestionRetryRounds)
      ? Math.max(0, Math.min(5, run.maxFailedQuestionRetryRounds))
      : DEFAULT_FAILED_QUESTION_RETRY_ROUNDS;
    if (retryRounds < maxRetryRounds) {
      const queuedAt = now();
      run.failedQuestionRetryRounds = retryRounds + 1;
      for (const question of run.questions.filter((item) => item.status === "failed")) {
        question.status = "queued";
        question.browserStage = "retry_queued";
        question.queuedAt = queuedAt;
        question.activeAttemptQueuedAt = queuedAt;
        question.completedAt = null;
        question.job ||= {};
        Object.assign(question.job, { status: "queued", completed_at: null, lock_id: null, locked_at: null });
        question.executionLog ||= [];
        question.executionLog.push({ stage: "FAILED_QUESTION_RETRY_QUEUED", at: queuedAt, round: run.failedQuestionRetryRounds });
      }
      run.status = "running";
      run.completedAt = null;
      run.failed = 0;
    } else {
      const invalidAt = now();
      for (const question of run.questions.filter((item) => item.status === "failed")) {
        question.status = "invalid";
        question.outcome = "invalid_test_result";
        question.browserStage = "invalid_after_retries";
        question.invalidReason = question.errorMessage || question.lastErrorMessage || question.exceptionType || "Repeated browser test attempts did not produce a verifiable answer.";
        question.job ||= {};
        Object.assign(question.job, { status: "invalid", error_code: question.exceptionType || question.lastErrorCode || "TEST_RESULT_INVALID", error_message: question.invalidReason, lock_id: null, locked_at: null });
        question.executionLog ||= [];
        question.executionLog.push({ stage: "INVALID_AFTER_RETRIES", at: invalidAt, retryRounds });
      }
      run.failed = 0;
      run.invalid = run.questions.filter((question) => question.status === "invalid").length;
    }
  }
  run.completed = run.success + run.failed + run.invalid;
  run.updatedAt = now();
  if (run.completed === run.total && !["paused", "aborted"].includes(run.status)) {
    run.status = run.failed ? "completed_with_errors" : "completed";
    run.completedAt = run.updatedAt;
  }
  return run;
}

// A completed browser-monitor run is the durable unit used by visibility
// trends.  The original question records remain the audit source; this is a
// compact, reproducible projection using the same classifier as GEO scoring.
export function browserMonitorVisibilitySummary(run, brand) {
  const successfulAnswers = (run.questions || [])
    .filter((question) => question.status === "success" && String(question.rawAnswer || "").trim());
  const validAnswers = successfulAnswers
    .map((question) => classifyBrowserVisibilityAnswer(question.rawAnswer, brand))
    .filter((judgement) => judgement.hasValidCompanyAnswer !== false);
  const mentionedCount = validAnswers.filter((judgement) => judgement.brandMentioned).length;
  const priorityCount = validAnswers.filter((judgement) => ["first", "top3"].includes(judgement.recommendation)).length;
  const rate = (count) => validAnswers.length ? count / validAnswers.length : null;
  const questionSetMetadata = run.questionSet ? {
    questionSet: run.questionSet,
    questionSetId: run.questionSetId || null,
    questionSetName: run.questionSetName || null,
  } : {};
  return {
    schemaVersion: 1,
    runId: run.id,
    platform: effectivePlatform(run),
    platformMode: effectivePlatformMode(run),
    ...questionSetMetadata,
    startedAt: run.startedAt || run.createdAt || null,
    completedAt: run.completedAt || null,
    totalQuestions: Number(run.total || 0),
    successfulAnswers: successfulAnswers.length,
    validAnswers: validAnswers.length,
    mentionedCount,
    priorityCount,
    mentionRate: rate(mentionedCount),
    priorityRate: rate(priorityCount),
    sourceSummary: run.sourceSummary || buildCitationSourceSummary(run, brand),
  };
}

export function browserMonitorRunSummary(run) {
  return {
    runId: run.id,
    provider: run.provider,
    platform: effectivePlatform(run),
    platformMode: effectivePlatformMode(run),
    companyId: run.companyId || null,
    questionSet: run.questionSet || null,
    questionSetId: run.questionSetId || null,
    questionSetName: run.questionSetName || null,
    mode: run.mode || "replace_invalid_answer",
    experimentType: run.experimentType || null,
    experimentId: run.experimentId || null,
    experimentArm: run.experimentArm || null,
    accountLabel: run.accountLabel || null,
    userConfirmedAccountLabel: run.userConfirmedAccountLabel || null,
    accountSwitchRequired: Boolean(run.accountSwitchRequired),
    accountSwitchExperimentId: run.accountSwitchExperimentId || null,
    benchmark: run.benchmark || null,
    sourceDate: run.sourceDate || null,
    retrySourceRunId: run.retrySourceRunId || null,
    executionPolicy: run.executionPolicy || null,
    status: run.status,
    total: run.total,
    completed: run.completed,
    success: run.success,
    failed: run.failed,
    invalid: run.invalid || 0,
    failedQuestionRetryRounds: run.failedQuestionRetryRounds || 0,
    maxFailedQuestionRetryRounds: run.maxFailedQuestionRetryRounds ?? DEFAULT_FAILED_QUESTION_RETRY_ROUNDS,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    pausedReason: run.pausedReason || null,
    humanAction: run.humanAction || null,
    humanActions: run.humanActions || [],
    verificationEvents: browserMonitorVerificationEvents(run),
    performance: browserMonitorRunPerformance(run),
    diagnostics: browserMonitorRunDiagnostics(run),
    sourceSummary: run.sourceSummary || run.visibilitySummary?.sourceSummary || null,
    observability: run.observability || null,
    geoDropDiagnostics: run.geoDropDiagnostics || null,
    questions: run.questions,
  };
}

export function browserMonitorVerificationEvents(run) {
  const hasActiveVerification = (run.humanActions || []).some((action) => action?.active);
  const endAt = run.completedAt || (hasActiveVerification ? now() : run.updatedAt || now());
  const stored = Array.isArray(run.verificationLog) ? run.verificationLog : [];
  if (stored.length) return stored.map((event) => ({ ...event, verification_duration_ms: Number.isFinite(event.verification_duration_ms) ? event.verification_duration_ms : elapsed(event.detected_at, event.resolved_at || endAt) }));
  // Backward-compatible projection for runs created before verificationLog.
  return (run.humanActions || []).map((action) => ({
    verification_event_id: action.verificationEventId || null,
    run_id: action.runId || run.id,
    worker_id: action.workerId || null,
    question_id: action.questionId || null,
    verification_type: action.verificationType || action.type || null,
    detected_at: action.detectedAt || action.requestedAt || null,
    resolved_at: action.resolvedAt || null,
    verification_duration_ms: Number.isFinite(action.verificationDurationMs) ? action.verificationDurationMs : elapsed(action.detectedAt || action.requestedAt, action.resolvedAt || endAt),
  }));
}

const elapsed = (from, to) => {
  const value = Date.parse(to || "") - Date.parse(from || "");
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const mergedIntervalDuration = (intervals) => {
  const ordered = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let active = null;
  for (const interval of ordered) {
    if (!active || interval.start > active.end) {
      if (active) total += active.end - active.start;
      active = { ...interval };
    } else active.end = Math.max(active.end, interval.end);
  }
  return total + (active ? active.end - active.start : 0);
};

const verificationTiming = (run) => {
  const hasActiveVerification = (run.humanActions || []).some((action) => action?.active);
  const endAt = run.completedAt || (hasActiveVerification ? now() : run.updatedAt || now());
  const events = browserMonitorVerificationEvents(run);
  const intervals = events.map((event) => ({ start: Date.parse(event.detected_at || ""), end: Date.parse(event.resolved_at || endAt) }));
  const workerWaitMs = events.reduce((sum, event) => sum + Math.max(0, Number(event.verification_duration_ms) || 0), 0);
  return { events, verificationWaitMs: mergedIntervalDuration(intervals), verificationWorkerWaitMs: workerWaitMs };
};

const automaticRetryCount = (question) => Math.max(0,
  Number(question.attemptCount || 0) - 1 - (question.attemptHistory || []).filter((attempt) => attempt.outcome === "interrupted_by_verification").length,
);

const percentile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
};

export function browserMonitorRunPerformance(run) {
  const questions = run.questions || [];
  const finished = questions.filter((item) => ["success", "failed", "invalid"].includes(item.status));
  const totalDurations = finished.map((item) => item.stageDurationsMs?.totalMs ?? item.latencyMs).filter(Number.isFinite);
  // Keep the original aggregate fields for existing reports, then expose a
  // non-overlapping breakdown that separates model generation from our final
  // completion-confirmation window.
  const stageKeys = ["newChatMs", "submitMs", "ttftMs", "answerGenerationMs", "saveMs"];
  const stageTotals = Object.fromEntries(stageKeys.map((key) => [key, finished.reduce((sum, item) => sum + (Number(item.stageDurationsMs?.[key]) || 0), 0)]));
  const detailedStageKeys = ["queueMs", "pageLoadMs", "newChatMs", "submitMs", "ttftMs", "modelGenerationMs", "completionVerificationMs", "saveMs"];
  const detailedStageTotals = Object.fromEntries(detailedStageKeys.map((key) => [key, finished.reduce((sum, item) => sum + (Number(item.stageDurationsMs?.[key]) || 0), 0)]));
  const measuredStageTotal = Object.values(stageTotals).reduce((sum, value) => sum + value, 0);
  const detailedMeasuredStageTotal = Object.values(detailedStageTotals).reduce((sum, value) => sum + value, 0);
  const failureReasons = {};
  for (const question of questions.filter((item) => ["failed", "invalid"].includes(item.status))) {
    const reason = question.exceptionType || question.lastErrorCode || question.errorMessage || "unknown_failure";
    failureReasons[reason] = (failureReasons[reason] || 0) + 1;
  }
  const slowest5 = finished
    .map((item) => ({
      promptId: item.promptId,
      questionText: item.questionText,
      status: item.status,
      totalMs: item.stageDurationsMs?.totalMs ?? item.latencyMs ?? null,
      stageDurationsMs: item.stageDurationsMs || null,
      attemptCount: item.attemptCount,
    }))
    .sort((a, b) => (b.totalMs || -1) - (a.totalMs || -1))
    .slice(0, 5);
  const totalWallClockMs = elapsed(run.startedAt, run.completedAt || run.updatedAt);
  const verification = verificationTiming(run);
  const actualExecutionMs = totalWallClockMs === null ? null : Math.max(0, totalWallClockMs - verification.verificationWaitMs);
  return {
    totalQuestions: questions.length,
    successfulQuestions: questions.filter((item) => item.status === "success").length,
    failedQuestions: questions.filter((item) => item.status === "failed").length,
    invalidQuestions: questions.filter((item) => item.status === "invalid").length,
    retries: questions.reduce((sum, item) => sum + automaticRetryCount(item), 0),
    // Keep totalElapsedMs for older reports, but label the new fields
    // explicitly so manual verification delay cannot be read as model speed.
    totalElapsedMs: totalWallClockMs,
    totalWallClockMs,
    actualExecutionMs,
    verificationWaitMs: verification.verificationWaitMs,
    verificationWorkerWaitMs: verification.verificationWorkerWaitMs,
    verificationEvents: verification.events,
    averageQuestionMs: totalDurations.length ? Math.round(totalDurations.reduce((sum, value) => sum + value, 0) / totalDurations.length) : null,
    p50QuestionMs: percentile(totalDurations, 0.5),
    p90QuestionMs: percentile(totalDurations, 0.9),
    slowest5,
    failureReasons,
    stageDurationsMs: stageTotals,
    stageSharePercent: Object.fromEntries(stageKeys.map((key) => [key, measuredStageTotal ? Math.round((stageTotals[key] / measuredStageTotal) * 10_000) / 100 : 0])),
    detailedStageDurationsMs: detailedStageTotals,
    detailedStageSharePercent: Object.fromEntries(detailedStageKeys.map((key) => [key, detailedMeasuredStageTotal ? Math.round((detailedStageTotals[key] / detailedMeasuredStageTotal) * 10_000) / 100 : 0])),
  };
}

export function browserMonitorRunDiagnostics(run) {
  const questions = run.questions || [];
  const finished = questions.filter((item) => ["success", "failed", "invalid"].includes(item.status));
  const success = questions.filter((item) => item.status === "success").length;
  const failed = questions.filter((item) => item.status === "failed").length;
  const invalid = questions.filter((item) => item.status === "invalid").length;
  const attemptErrors = questions.flatMap((item) => [
    ...(item.attemptHistory || []).map((attempt) => attempt.errorCode),
    item.status === "failed" ? (item.exceptionType || item.lastErrorCode) : null,
  ]).filter(Boolean);
  const runErrors = [
    ...(run.runErrors || []).map((item) => item.code || item.message),
    run.status === "paused" && run.pausedReason ? run.pausedReason : null,
  ].filter(Boolean);
  const countErrors = (pattern) => [...attemptErrors, ...runErrors].filter((code) => pattern.test(String(code))).length;
  const ttft = finished.map((item) => item.stageDurationsMs?.ttftMs).filter(Number.isFinite);
  const generation = finished.map((item) => item.stageDurationsMs?.answerGenerationMs).filter(Number.isFinite);
  const answers = questions.filter((item) => item.status === "success")
    .map((item) => String(item.rawAnswer || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const answerCounts = new Map();
  for (const answer of answers) answerCounts.set(answer, (answerCounts.get(answer) || 0) + 1);
  const duplicateAnswers = [...answerCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const totalElapsedMs = elapsed(run.startedAt, run.completedAt || run.updatedAt);
  const verification = verificationTiming(run);
  const actualExecutionMs = totalElapsedMs === null ? null : Math.max(0, totalElapsedMs - verification.verificationWaitMs);
  return {
    totalQuestions: questions.length,
    successfulQuestions: success,
    failedQuestions: failed,
    invalidQuestions: invalid,
    incompleteQuestions: questions.length - success - failed - invalid,
    completedQuestionRatePercent: questions.length ? Math.round(((success + failed + invalid) / questions.length) * 10_000) / 100 : 0,
    successRatePercent: questions.length ? Math.round((success / questions.length) * 10_000) / 100 : 0,
    failureRatePercent: questions.length ? Math.round((failed / questions.length) * 10_000) / 100 : 0,
    retryRatePercent: questions.length ? Math.round((questions.filter((item) => item.attemptCount > 1).length / questions.length) * 10_000) / 100 : 0,
    retries: questions.reduce((sum, item) => sum + automaticRetryCount(item), 0),
    pageLoadExceptions: countErrors(/(?:DOUBAO_)?(?:SYSTEM_EXCEPTION|NETWORK_ERROR|RESPONSE_ERROR|PAGE_NOT_READY)/i),
    answerTimeouts: countErrors(/DOUBAO_(?:ANSWER_TIMEOUT|ANSWER_NOT_STARTED)/),
    newConversationFailures: countErrors(/DOUBAO_NEW_CONVERSATION|DOUBAO_COMPOSER_NOT_EMPTY/),
    emptyAnswers: countErrors(/DOUBAO_EMPTY_ANSWER|unclassified_browser_error/),
    duplicateAnswers,
    loginExceptions: countErrors(/DOUBAO_LOGIN_REQUIRED/),
    rateLimitEvents: countErrors(/DOUBAO_SEND_RATE_LIMIT/),
    averageTTFTMs: ttft.length ? Math.round(ttft.reduce((sum, value) => sum + value, 0) / ttft.length) : null,
    p90TTFTMs: percentile(ttft, 0.9),
    averageGenerationMs: generation.length ? Math.round(generation.reduce((sum, value) => sum + value, 0) / generation.length) : null,
    p90GenerationMs: percentile(generation, 0.9),
    totalElapsedMs,
    totalWallClockMs: totalElapsedMs,
    actualExecutionMs,
    verificationWaitMs: verification.verificationWaitMs,
    verificationWorkerWaitMs: verification.verificationWorkerWaitMs,
    verificationEvents: verification.events,
    effectiveCompleteAnswersPerMinute: actualExecutionMs ? Math.round((success / (actualExecutionMs / 60_000)) * 100) / 100 : null,
  };
}

export function claimNextBrowserQuestion(run, worker = null) {
  if (["paused", "preparing_browser", "waiting_for_login", "completed", "completed_with_errors", "failed", "aborted"].includes(run.status)) return null;
  return claimBrowserQuestion(run, run.questions.find((item) => item.status === "queued"), worker);
}

export function claimBrowserQuestionById(run, promptId, worker = null) {
  if (["paused", "preparing_browser", "waiting_for_login", "completed", "completed_with_errors", "failed", "aborted"].includes(run.status)) return null;
  return claimBrowserQuestion(run, run.questions.find((item) => item.promptId === promptId && item.status === "queued"), worker);
}

function claimBrowserQuestion(run, question, worker = null) {
  if (!question) return null;
  const startedAt = now();
  if (!run.humanAction?.active) run.status = "running";
  run.startedAt ||= startedAt;
  run.updatedAt = startedAt;
  question.status = "running";
  question.browserStage = "starting";
  question.attemptCount += 1;
  question.startedAt = startedAt;
  // Only the final, saved attempt contributes to the per-question timing
  // report. Keep prior attempts in executionLog/conversationHistory, but do
  // not let a failed or paused attempt inflate TTFT or generation duration.
  question.pageReadyAt = null;
  question.newChatStartedAt = null;
  question.newChatReadyAt = null;
  question.promptSubmittedAt = null;
  question.answerStartedAt = null;
  question.generationEndedAt = null;
  question.answerCompletedAt = null;
  question.savedAt = null;
  question.completedAt = null;
  question.latencyMs = null;
  question.stageDurationsMs = null;
  question.question = question.questionText;
  question.rawAnswer = null;
  question.citations = [];
  question.browserCitations = [];
  question.mentionResult = null;
  question.recommendationResult = null;
  question.citationCaptureStatus = "not_available";
  question.citationCaptureVersion = null;
  question.citationLegacyStatus = null;
  question.citationCount = 0;
  question.citationCheckedChannels = [];
  question.citationStatus = null;
  question.citationCaptureError = null;
  question.citationCapture = null;
  question.citationCaptureV2 = null;
  question.citationVisibilityMismatch = null;
  question.conversationId = null;
  question.sessionUuid = null;
  question.executionLog ||= [];
  question.workerId = worker?.workerId || question.workerId || null;
  question.pageIndex = Number(worker?.pageIndex || question.pageIndex || 0) || null;
  question.pageId = worker?.pageId || question.pageId || null;
  question.job ||= {};
  Object.assign(question.job, {
    run_id: run.id,
    question_id: question.promptId,
    worker_id: question.workerId,
    page_id: question.pageId,
    attempt: question.attemptCount,
    status: "running",
    question: question.questionText,
    raw_answer: null,
    citations: [],
    citation_capture_status: "not_available",
    citation_capture_version: null,
    citation_legacy_status: null,
    citation_count: 0,
    citation_checked_channels: [],
    citation_capture_error: null,
    citation_capture: null,
    citation_visibility_mismatch: null,
    started_at: startedAt,
    completed_at: null,
    duration_ms: null,
    error_code: null,
    error_message: null,
    lock_id: uid("browser_lock"),
    locked_at: startedAt,
  });
  question.executionLog.push({ stage: "STARTED", at: startedAt, worker: question.workerId ? { workerId: question.workerId, pageIndex: question.pageIndex } : null, lockId: question.job.lock_id });
  return question;
}
