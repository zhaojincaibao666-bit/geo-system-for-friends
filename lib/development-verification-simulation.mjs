import { DoubaoHumanActionRequiredError } from "./doubao-adapter.mjs";
import { executeDoubaoWebRun } from "./doubao-web-runner.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Development-only verification simulation. It has no Playwright imports,
 * never starts Chromium, and never writes a question result, GEO score, or
 * trend record. It exists solely to exercise the worker-pool state machine.
 */
export async function simulateVerification({ workerCount = 4, questionCount = 8, autoResolveMs = 20, environment = process.env.NODE_ENV || "development" } = {}) {
  if (environment === "production") throw new Error("simulate_verification is unavailable in production");
  const concurrency = Math.min(5, Math.max(1, Number(workerCount) || 4));
  const questions = Array.from({ length: Math.max(concurrency + 2, Number(questionCount) || 8) }, (_, index) => ({
    promptId: `sim-q${index + 1}`,
    questionText: `development simulation question ${index + 1}`,
  }));
  let releaseVerification;
  const verificationGate = new Promise((resolve) => { releaseVerification = resolve; });
  const assignments = [];
  const completed = [];
  const stages = [];
  const humanEvents = [];
  let challenged = false;
  let automaticRecoveryTimer = null;
  const worker = (pageIndex) => ({
    workerId: `doubao-worker-${pageIndex}`,
    pageIndex,
    initialize: async () => {},
    ensureLoggedIn: async () => {},
    ask: async (questionText) => {
      assignments.push({ workerId: `doubao-worker-${pageIndex}`, questionText });
      if (pageIndex === 3 && questionText === "development simulation question 3" && !challenged) {
        challenged = true;
        throw new DoubaoHumanActionRequiredError({ state: "image_verification", requiresHumanAction: true }, "simulate_verification");
      }
      await wait(3);
      return {
        answer: `complete simulated answer for ${questionText}`,
        citations: [],
        startedAt: "2026-08-14T01:00:00.000Z",
        firstTokenAt: "2026-08-14T01:00:01.000Z",
        completedAt: "2026-08-14T01:00:02.000Z",
        durationMs: 2_000,
      };
    },
    waitForBlockingStateClear: pageIndex === 3 ? async () => verificationGate.then(() => ({ inputReady: true })) : undefined,
  });
  const workers = Array.from({ length: concurrency }, (_, index) => worker(index + 1));
  try {
    const result = await executeDoubaoWebRun({
      run: { id: "DEV_SIMULATE_VERIFICATION" },
      browserManager: { ensureBrowser: async () => {}, prepareForRun: async () => workers },
      workerCount: concurrency,
      claimNextQuestion: async () => questions.shift() || null,
      onQuestionStarted: async () => {},
      onQuestionStage: async (question, stage, _conversation, workerInfo) => stages.push({ questionId: question.promptId, stage, workerId: workerInfo.workerId }),
      onQuestionCompleted: async (question) => completed.push(question.promptId),
      onQuestionException: async () => { throw new Error("The development verification simulation must not fail a question"); },
      onQuestionRetry: async () => { throw new Error("Verification must not use automatic page retry"); },
      onLoginRequired: async () => { throw new Error("Verification is not a login simulation"); },
      onHumanActionRequired: async (question, error, _artifact, workerInfo) => {
        humanEvents.push({ phase: "needs_verification", questionId: question.promptId, workerId: workerInfo.workerId, verificationType: error.humanActionType });
        automaticRecoveryTimer = setTimeout(releaseVerification, Math.max(0, Number(autoResolveMs) || 0));
      },
      onHumanActionResolved: async (question, _error, workerInfo) => humanEvents.push({ phase: "resolved", questionId: question.promptId, workerId: workerInfo.workerId }),
      retryRecoveryCooldownMs: 0,
    });
    return {
      status: result.status,
      assignments,
      completed,
      stages,
      humanEvents,
      writesToPersistentStore: false,
      startsChromium: false,
    };
  } finally {
    if (automaticRecoveryTimer) clearTimeout(automaticRecoveryTimer);
  }
}
