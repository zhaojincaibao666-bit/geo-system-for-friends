const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const workerMetadata = (worker, index, platform, platformMode) => ({
  workerId: worker.workerId || `${platform}-worker-${index + 1}`,
  pageIndex: Number(worker.pageIndex || index + 1),
  pageId: worker.pageId || null,
  platform,
  platformMode,
});

const defaultErrorPolicy = Object.freeze({
  isLoginRequired: (error) => error?.code === "PLATFORM_LOGIN_REQUIRED",
  isHumanActionRequired: (error) => error?.code === "VERIFICATION_REQUIRED",
  isRateLimited: (error) => error?.code === "PLATFORM_SEND_RATE_LIMIT",
  isAnswerStartFailure: (error) => error?.code === "ANSWER_NOT_STARTED",
  isNonRetryable: (error) => error?.sentPromptMayExist === true,
  createConversationCollisionError: (conversationId, details) => Object.assign(
    new Error(`Conversation id collision: ${conversationId}`),
    { code: "BROWSER_CONVERSATION_ID_COLLISION", conversationId, details },
  ),
});

/**
 * Platform-neutral queue, retry, verification and worker-pool execution.
 * Site DOM work remains behind the runtime's worker adapters. The runner only
 * invokes the stable worker contract: ask, recoverPage, recreatePage,
 * waitForBlockingStateClear and captureDebugArtifact.
 */
export async function executeWebPlatformRun({
  platform,
  platformMode = "chat",
  run,
  runtime,
  claimNextQuestion,
  onQuestionStarted,
  onQuestionCompleted,
  onQuestionException,
  onQuestionCancelled = async () => {},
  onQuestionRetry = async () => {},
  onQuestionStage = async () => {},
  onWorkersReady = async () => {},
  onLoginRequired = async () => {},
  onHumanActionRequired = async () => {},
  onHumanActionResolved = async () => {},
  onRateLimited = async () => {},
  onPlatformUnavailable = async () => {},
  workerCount = 1,
  maxQuestionRetries = 2,
  retryRecoveryCooldownMs = 5_000,
  platformUnavailableThreshold = 3,
  errorPolicy = defaultErrorPolicy,
  signal = null,
  logger = console,
}) {
  if (!platform) throw new Error("PLATFORM_REQUIRED");
  const policy = { ...defaultErrorPolicy, ...errorPolicy };
  const normalizedWorkerCount = Math.min(5, Math.max(1, Math.trunc(Number(workerCount) || 1)));
  const threshold = Math.min(10, Math.max(2, Math.trunc(Number(platformUnavailableThreshold) || 3)));
  let paused = null;
  let consecutiveAnswerStartFailures = 0;
  const savedConversationIds = new Map();
  const isStopped = () => Boolean(signal?.aborted || run?.status === "aborted");
  const stoppedResult = () => ({ status: "aborted", platform, platformMode });

  const captureWorkerArtifact = async (worker, question, error, fallbackStage) => {
    if (!worker || typeof worker.captureDebugArtifact !== "function") return null;
    try { return await worker.captureDebugArtifact({ stage: error?.stage || fallbackStage, questionId: question?.promptId || null, attempt: question?.attemptCount || null, error }); }
    catch (captureError) { logger.warn?.("Unable to capture platform debug artifact", captureError); return null; }
  };
  const pauseForLogin = async (question, error, worker = null) => {
    if (!paused) {
      paused = { status: "paused", reason: error.message, platform, platformMode };
      await onLoginRequired(question, error, await captureWorkerArtifact(worker, question, error, "login_check"));
    }
    return paused;
  };
  const waitForHumanAction = async (question, error, worker, info = null) => {
    const artifact = await captureWorkerArtifact(worker, question, error, error.stage || "needs_human_action");
    await onHumanActionRequired(question, error, artifact, info);
    if (typeof worker?.waitForBlockingStateClear !== "function") {
      paused = { status: "needs_human_action", reason: error.message, platform, platformMode };
      return false;
    }
    await worker.waitForBlockingStateClear();
    await onHumanActionResolved(question, error, info);
    return true;
  };
  const pauseForRateLimit = async (question, error, worker) => {
    if (paused) return paused;
    const artifact = await captureWorkerArtifact(worker, question, error, "send_rate_limit");
    paused = { status: "paused", reason: error.message, platform, platformMode };
    await onRateLimited(question, error, artifact);
    return paused;
  };

  let readyWorkers;
  try {
    if (isStopped()) return stoppedResult();
    if (typeof runtime?.prepareForRun !== "function" || typeof runtime?.ensureBrowser !== "function") {
      throw Object.assign(new Error("BROWSER_RUNTIME_INTERFACE_ERROR: missing ensureBrowser or prepareForRun"), { code: "BROWSER_RUNTIME_INTERFACE_ERROR" });
    }
    readyWorkers = await runtime.prepareForRun(normalizedWorkerCount);
  } catch (error) {
    if (policy.isHumanActionRequired(error)) {
      const recovered = await waitForHumanAction(null, error, runtime, null);
      if (!recovered) return paused;
      return executeWebPlatformRun({ platform, platformMode, run, runtime, claimNextQuestion, onQuestionStarted, onQuestionCompleted, onQuestionException, onQuestionCancelled, onQuestionRetry, onQuestionStage, onWorkersReady, onLoginRequired, onHumanActionRequired, onHumanActionResolved, onRateLimited, onPlatformUnavailable, workerCount, maxQuestionRetries, retryRecoveryCooldownMs, platformUnavailableThreshold, errorPolicy: policy, signal, logger });
    }
    if (policy.isLoginRequired(error)) return pauseForLogin(null, error);
    throw error;
  }
  if (!Array.isArray(readyWorkers) || !readyWorkers.length) throw new Error("BROWSER_WORKER_PAGE_UNAVAILABLE");
  if (isStopped()) return stoppedResult();
  await onWorkersReady(readyWorkers.map((worker, index) => workerMetadata(worker, index, platform, platformMode)));
  if (isStopped()) return stoppedResult();

  const executeQuestion = async (question, worker, index) => {
    const info = workerMetadata(worker, index, platform, platformMode);
    if (isStopped()) { await onQuestionCancelled(question, info); return; }
    await onQuestionStarted(question, info);
    for (let retry = 0; ; retry += 1) {
      try {
        if (isStopped()) { await onQuestionCancelled(question, info); return; }
        if (typeof worker.prepareMode === "function") await worker.prepareMode(platformMode);
        if (isStopped()) { await onQuestionCancelled(question, info); return; }
        if (typeof worker.verifyMode === "function") await worker.verifyMode(platformMode);
        if (isStopped()) { await onQuestionCancelled(question, info); return; }
        const result = await worker.ask(question.questionText, {
          questionId: question.promptId, runId: run.id, workerId: info.workerId,
          signal,
          onStage: (stage, conversation) => onQuestionStage(question, stage, conversation, info),
        });
        if (isStopped()) { await onQuestionCancelled(question, info); return; }
        const conversationId = String(result?.conversation?.conversationId || "").trim();
        if (conversationId) {
          const existingPromptId = savedConversationIds.get(conversationId);
          if (existingPromptId && existingPromptId !== question.promptId) {
            const collision = policy.createConversationCollisionError(conversationId, { existingPromptId, currentPromptId: question.promptId, worker: info });
            collision.conversation = result.conversation || null;
            throw collision;
          }
          savedConversationIds.set(conversationId, question.promptId);
        }
        await onQuestionCompleted(question, { ...result, worker: info, platform, platformMode });
        consecutiveAnswerStartFailures = 0;
        return;
      } catch (error) {
        if (isStopped() || error?.code === "RUN_ABORTED") {
          await onQuestionCancelled(question, info);
          return;
        }
        if (policy.isHumanActionRequired(error)) {
          await onQuestionStage(question, "INTERRUPTED_BY_VERIFICATION", error.conversation || null, info);
          if (!await waitForHumanAction(question, error, worker, info)) return;
          await onQuestionStage(question, "HUMAN_ACTION_RESOLVED", error.conversation || null, info);
          continue;
        }
        if (policy.isLoginRequired(error)) { await pauseForLogin(question, error, worker); return; }
        if (policy.isRateLimited(error)) { await pauseForRateLimit(question, error, worker); return; }
        if (!policy.isNonRetryable(error) && retry < maxQuestionRetries) {
          const debugArtifact = await captureWorkerArtifact(worker, question, error, "question_retry");
          await onQuestionRetry(question, error, { retry: retry + 1, maxQuestionRetries, conversation: error.conversation || null, worker: info, debugArtifact });
          await onQuestionStage(question, "PAGE_RECOVERY_STARTED", error.conversation || null, info);
          let recovered = false;
          if (typeof worker.recoverPage === "function") {
            try { await worker.recoverPage(); recovered = true; await onQuestionStage(question, "PAGE_RECOVERED", null, info); }
            catch (recoveryError) { if (policy.isLoginRequired(recoveryError)) { await pauseForLogin(question, recoveryError, worker); return; } }
          }
          if (!recovered && typeof worker.recreatePage === "function") {
            try { await worker.recreatePage(); recovered = true; await onQuestionStage(question, "PAGE_RECREATED", null, info); }
            catch (recoveryError) { if (policy.isLoginRequired(recoveryError)) { await pauseForLogin(question, recoveryError, worker); return; } }
          }
          if (retryRecoveryCooldownMs > 0) await delay(retryRecoveryCooldownMs);
          await onQuestionStage(question, "RETRY_NEW_CONVERSATION_REQUIRED", null, info);
          continue;
        }
        const isAnswerStartFailure = policy.isAnswerStartFailure(error);
        consecutiveAnswerStartFailures = isAnswerStartFailure ? consecutiveAnswerStartFailures + 1 : 0;
        let artifact = await captureWorkerArtifact(worker, question, error, "question_exception");
        try {
          if (!artifact && typeof worker.takeDebugScreenshot === "function") {
            artifact = { screenshotPath: await worker.takeDebugScreenshot(`question-${question.promptId}`) };
          }
        } catch (captureError) {
          logger.warn?.("Unable to capture platform debug screenshot", captureError);
        }
        if (isAnswerStartFailure && consecutiveAnswerStartFailures >= threshold) {
          paused = { status: "paused", reason: `Platform did not start ${consecutiveAnswerStartFailures} consecutive answers`, platform, platformMode };
          await onPlatformUnavailable(question, error, artifact, { consecutiveAnswerStartFailures, threshold, worker: info });
          return;
        }
        await onQuestionException(question, error, artifact?.screenshotPath || null, artifact, error.conversation || null, info);
        return;
      }
    }
  };

  await Promise.all(readyWorkers.map(async (worker, index) => {
    while (!paused && !isStopped()) {
      const info = workerMetadata(worker, index, platform, platformMode);
      const question = await claimNextQuestion(info);
      if (!question) return;
      if (paused || isStopped()) { await onQuestionCancelled(question, info); return; }
      await executeQuestion(question, worker, index);
    }
  }));
  return paused || (isStopped() ? stoppedResult() : { status: "completed", platform, platformMode });
}
