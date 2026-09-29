import { now, uid } from "./core.mjs";

export function createMonitorRun(prompts) {
  const startedAt = now();
  return {
    id: uid("monitor"),
    provider: "doubao",
    status: "running",
    total: prompts.length,
    completed: 0,
    success: 0,
    failed: 0,
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    questions: prompts.map((prompt) => ({
      promptId: prompt.id,
      questionText: prompt.text,
      status: "queued",
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      latencyMs: null,
      responseId: null,
      rawAnswer: null,
      citations: [],
      errorMessage: null,
    })),
  };
}

export function monitorRunSummary(run) {
  return {
    runId: run.id,
    status: run.status,
    total: run.total,
    completed: run.completed,
    success: run.success,
    failed: run.failed,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    questions: run.questions,
  };
}

export function normalizeMonitorConcurrency(value, defaultValue = 3) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return defaultValue;
  return Math.min(5, Math.max(1, Number(normalized)));
}

export function normalizeMonitorMaxRetries(value, defaultValue = 1) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) return defaultValue;
  return Math.min(1, Math.max(0, Number(normalized)));
}

export function parseRetryAfterMs(value, currentTimeMs = Date.now()) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Math.round(Number(normalized) * 1000);
  const retryAtMs = Date.parse(normalized);
  if (Number.isNaN(retryAtMs)) return null;
  return Math.max(0, retryAtMs - currentTimeMs);
}

export function retryDelayMs(retryAfterMs, random = Math.random) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.round(retryAfterMs);
  return 2000 + Math.floor(random() * 1001);
}

export function parseMonitorRunLimit(value, defaultValue = 30) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > 30) return null;
  return value;
}

export function findActiveDoubaoMonitorRun(runs = []) {
  return runs.find((run) => run.provider === "doubao" && ["queued", "running"].includes(run.status)) || null;
}

function updateRunCounts(run) {
  run.success = run.questions.filter((question) => question.status === "success").length;
  run.failed = run.questions.filter((question) => question.status === "failed").length;
  run.completed = run.success + run.failed;
}

async function executeMonitorQuestion(run, question, {
  brand,
  callDoubaoApi,
  persist,
  saveProbeRun,
  phase,
  maxRetries,
  isRetryableError,
  retryAfterByQuestion,
}) {
  const prompt = { id: question.promptId, text: question.questionText };
  const startedAt = Date.now();
  question.status = phase === "retry" ? "retrying" : "running";
  question.attemptCount += 1;
  question.startedAt ||= now();
  run.updatedAt = now();
  await persist();

  try {
    const probeRun = await callDoubaoApi(prompt, brand, { webSearch: true, maxAttempts: 1 });
    probeRun.monitorRunId = run.id;
    saveProbeRun(probeRun);
    question.status = "success";
    question.errorMessage = null;
    question.responseId = probeRun.responseId || null;
    question.rawAnswer = probeRun.rawAnswer || "";
    question.citations = probeRun.citations || [];
  } catch (error) {
    question.errorMessage = String(error?.message || "豆包监测请求失败").slice(0, 500);
    const shouldRetry = phase === "primary" && maxRetries > 0 && isRetryableError(error);
    if (shouldRetry) {
      retryAfterByQuestion.set(question.promptId, error?.retryAfterMs);
      question.status = "retry_pending";
    } else {
      question.status = "failed";
    }
  }

  if (phase === "retry") retryAfterByQuestion.delete(question.promptId);

  question.latencyMs = Date.now() - startedAt;
  question.completedAt = now();
  updateRunCounts(run);
  run.updatedAt = question.completedAt;
  await persist();
}

async function executeWorkerPool(questions, workerCount, executeQuestion) {
  let nextQuestionIndex = 0;
  const nextQuestion = () => {
    if (nextQuestionIndex >= questions.length) return null;
    const question = questions[nextQuestionIndex];
    nextQuestionIndex += 1;
    return question;
  };
  const worker = async () => {
    while (true) {
      const question = nextQuestion();
      if (!question) return;
      await executeQuestion(question);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
}

async function executeRetryWorkerPool(questions, workerCount, executeQuestion, retryAfterByQuestion, waitBeforeRetry, retryDelayForQuestion) {
  const pending = questions.map((question) => ({
    question,
    readyAt: Date.now() + retryDelayForQuestion(retryAfterByQuestion.get(question.promptId)),
  }));
  const nextReadyQuestion = () => {
    const currentTime = Date.now();
    const readyIndex = pending.findIndex((item) => item.readyAt <= currentTime);
    if (readyIndex >= 0) return pending.splice(readyIndex, 1)[0].question;
    return null;
  };
  const nextDelayMs = () => Math.max(0, Math.min(...pending.map((item) => item.readyAt)) - Date.now());
  const worker = async () => {
    while (pending.length) {
      const question = nextReadyQuestion();
      if (question) {
        await executeQuestion(question);
      } else {
        await waitBeforeRetry(nextDelayMs());
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
}

export async function executeMonitorRun(run, {
  brand,
  callDoubaoApi,
  persist,
  saveProbeRun,
  concurrency = 1,
  maxRetries = 1,
  isRetryableError = () => false,
  waitBeforeRetry = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryDelayForQuestion = retryDelayMs,
}) {
  const workerCount = Math.min(normalizeMonitorConcurrency(concurrency, 1), run.questions.length);
  const effectiveMaxRetries = normalizeMonitorMaxRetries(maxRetries);
  const retryAfterByQuestion = new Map();
  const executeQuestion = (question, phase) => executeMonitorQuestion(run, question, {
    brand,
    callDoubaoApi,
    persist,
    saveProbeRun,
    phase,
    maxRetries: effectiveMaxRetries,
    isRetryableError,
    retryAfterByQuestion,
  });

  await executeWorkerPool(run.questions, workerCount, (question) => executeQuestion(question, "primary"));

  const retryQuestions = run.questions.filter((question) => question.status === "retry_pending");
  if (retryQuestions.length) {
    await executeRetryWorkerPool(
      retryQuestions,
      Math.min(workerCount, retryQuestions.length),
      (question) => executeQuestion(question, "retry"),
      retryAfterByQuestion,
      waitBeforeRetry,
      retryDelayForQuestion,
    );
  }

  updateRunCounts(run);
  if (run.completed !== run.total) throw new Error("MonitorRun 存在未完成的问题");
  run.status = run.failed ? "completed_with_errors" : "completed";
  run.completedAt = now();
  run.updatedAt = run.completedAt;
  await persist();
  return run;
}
