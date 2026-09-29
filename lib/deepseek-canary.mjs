import { now, uid } from "./core.mjs";

export const DEEPSEEK_CANARY_EXECUTION_POLICY = Object.freeze({
  kind: "canary",
  version: "deepseek_single_question_v1",
  reportable: false,
  maxEffectiveQuestions: 1,
  maxAttempts: 3,
});

export function isReportableObservation(observation = {}) {
  return observation.reportable !== false;
}

export function createDeepSeekCanaryRun(prompt, { platformMode, runId = uid("deepseek_canary") } = {}) {
  if (!prompt?.id || !String(prompt.text || "").trim()) throw new Error("DEEPSEEK_CANARY_PROMPT_REQUIRED");
  if (!["chat", "web_search"].includes(platformMode)) throw new Error("INVALID_PLATFORM_MODE");
  const createdAt = now();
  const question = {
    questionId: `canary_question_${prompt.id}`,
    promptId: prompt.id,
    questionText: prompt.text,
    promptVersion: Number(prompt.monitoringVersion || prompt.promptVersion || 1),
    questionSet: prompt.questionSet || null,
    questionSetId: prompt.questionSetId || null,
    platform: "deepseek_web",
    platformMode,
    reportable: false,
    status: "queued",
    attemptCount: 0,
    workerId: null,
    pageId: null,
    modeVerified: false,
    webSearchEnabled: null,
    promptSubmitted: false,
    answerStarted: false,
    answerCompleted: false,
    rawAnswer: null,
    citations: [],
    citationCaptureStatus: "not_available",
    citationCapture: null,
    errorCode: null,
    errorMessage: null,
    createdAt,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    executionLog: [{ stage: "QUEUED", at: createdAt }],
  };
  return {
    id: runId,
    runId,
    type: "canary",
    reportable: false,
    provider: "deepseek_web",
    platform: "deepseek_web",
    platformMode,
    executionPolicy: { ...DEEPSEEK_CANARY_EXECUTION_POLICY },
    status: "queued",
    total: 1,
    completed: 0,
    success: 0,
    failed: 0,
    createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
    questions: [question],
  };
}

// A pre-submit failure may be retried under the same Canary identity. This
// avoids turning one intended mode check into additional effective questions.
export function prepareDeepSeekCanaryRetry(run) {
  const question = run?.questions?.[0];
  if (!run || !question || run.status !== "failed" || question.promptSubmitted || Number(question.attemptCount) >= DEEPSEEK_CANARY_EXECUTION_POLICY.maxAttempts) {
    const error = new Error("DEEPSEEK_CANARY_NOT_RETRYABLE");
    error.code = "DEEPSEEK_CANARY_NOT_RETRYABLE";
    throw error;
  }
  Object.assign(run, { status: "queued", completed: 0, success: 0, failed: 0, startedAt: null, completedAt: null, updatedAt: now() });
  Object.assign(question, {
    status: "queued", workerId: null, pageId: null, modeVerified: false,
    webSearchEnabled: null, promptSubmitted: false, answerStarted: false,
    answerCompleted: false, rawAnswer: null, citations: [],
    citationCaptureStatus: "not_available", citationCapture: null,
    errorCode: null, errorMessage: null, startedAt: null, completedAt: null,
    durationMs: null,
  });
  question.executionLog.push({ stage: "RETRY_QUEUED", at: now() });
  return run;
}

function stage(question, name, fields = {}) {
  const at = now();
  Object.assign(question, fields);
  question.executionLog.push({ stage: name, at });
  return at;
}

export async function executeDeepSeekCanary({ run, worker, classify, persist = async () => {}, storeProbe = async () => {} } = {}) {
  const question = run?.questions?.[0];
  if (!run || !question || !worker) throw new Error("DEEPSEEK_CANARY_EXECUTION_INVALID");
  const expectedWebSearch = run.platformMode === "web_search";
  run.status = "running";
  run.startedAt ||= now();
  run.updatedAt = run.startedAt;
  question.status = "running";
  question.startedAt = run.startedAt;
  question.attemptCount += 1;
  question.workerId = worker.workerId;
  question.pageId = worker.pageId;
  stage(question, "CLAIMED");
  await persist();

  try {
    stage(question, "NEW_CONVERSATION_REQUESTED");
    const previous = await worker.startNewConversation();
    const conversation = await worker.confirmNewConversation(previous);
    stage(question, "NEW_CONVERSATION_CONFIRMED");
    await worker.prepareMode(run.platformMode);
    const mode = await worker.verifyMode(run.platformMode);
    if (!mode?.ready || mode.webSearchEnabled !== expectedWebSearch) {
      const error = new Error(`PLATFORM_MODE_NOT_READY: expected ${run.platformMode}`);
      error.code = "PLATFORM_MODE_NOT_READY";
      throw error;
    }
    stage(question, "MODE_VERIFIED", { modeVerified: true, webSearchEnabled: mode.webSearchEnabled });
    await persist();

    // This is the final hard guard immediately before a real message can be
    // submitted. Any mismatch exits before submitPrompt is reached.
    if (question.webSearchEnabled !== expectedWebSearch) {
      const error = new Error(`PLATFORM_MODE_NOT_READY: expected ${run.platformMode}`);
      error.code = "PLATFORM_MODE_NOT_READY";
      throw error;
    }
    const submission = await worker.submitPrompt(question.questionText, { platformMode: run.platformMode });
    stage(question, "PROMPT_SUBMITTED", { promptSubmitted: true, promptSubmittedAt: submission.submittedAt || now() });
    await persist();

    const started = await worker.waitForAnswerStart({ baselineAnswerTexts: submission.baselineAnswerTexts || [] });
    stage(question, "ANSWER_STARTED", { answerStarted: true, answerStartedAt: started.startedAt || now() });
    const completed = await worker.waitForAnswerComplete();
    stage(question, "ANSWER_COMPLETED", { answerCompleted: true, answerCompletedAt: completed.completedAt || now() });
    const rawAnswer = await worker.getAnswer();
    const citationResult = await worker.getCitations();
    const judgement = classify(rawAnswer);
    const completedAt = now();
    const probeRunId = uid("probe");
    const probeRun = {
      id: probeRunId,
      createdAt: completedAt,
      source: "browser_observed",
      executionPolicy: "canary",
      type: "canary",
      reportable: false,
      deepseekCanaryRunId: run.id,
      browserMonitorRunId: null,
      platform: "deepseek_web",
      platformMode: run.platformMode,
      provider: "deepseek_web",
      surface: "DeepSeek",
      promptId: question.promptId,
      questionId: question.questionId,
      question: question.questionText,
      promptVersion: question.promptVersion,
      questionSet: question.questionSet,
      questionSetId: question.questionSetId,
      rawAnswer,
      citations: citationResult.citations || [],
      browserCitations: citationResult.citations || [],
      citationCaptureStatus: citationResult.citationCaptureStatus || "not_available",
      citationCapture: citationResult.citationCapture || null,
      citationCaptureError: citationResult.citationCaptureError || null,
      workerId: question.workerId,
      pageId: question.pageId,
      status: "success",
      completedAt,
      browserConversation: { workerId: question.workerId, pageId: question.pageId, conversation, url: worker.page?.url?.() || null },
      ...judgement,
      mentionResult: { brandMentioned: Boolean(judgement.brandMentioned), matchedBrandAliases: judgement.matchedBrandAliases || [] },
      recommendationResult: { recommendation: judgement.recommendation || "none", position: judgement.position ?? null, recommendationEvidence: judgement.recommendationEvidence || null },
    };
    await storeProbe(probeRun);
    Object.assign(question, {
      status: "success", rawAnswer, citations: probeRun.citations,
      citationCaptureStatus: probeRun.citationCaptureStatus, citationCapture: probeRun.citationCapture,
      probeRunId, completedAt, durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(question.startedAt)),
      mentionResult: probeRun.mentionResult, recommendationResult: probeRun.recommendationResult,
    });
    stage(question, "SAVED");
    Object.assign(run, { status: "completed", completed: 1, success: 1, failed: 0, completedAt, updatedAt: completedAt });
    await persist();
    return { run, question, probeRun };
  } catch (error) {
    const completedAt = now();
    Object.assign(question, {
      status: "failed", errorCode: error?.code || "DEEPSEEK_CANARY_FAILED",
      errorMessage: String(error?.message || error).slice(0, 500), completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(question.startedAt)),
    });
    stage(question, "FAILED");
    Object.assign(run, { status: "failed", completed: 1, success: 0, failed: 1, completedAt, updatedAt: completedAt });
    await persist();
    throw error;
  }
}
