import { createServer } from "node:http";
import { createPublishService } from "./lib/publish-service.mjs";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize as normalizePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLATFORMS,
  LOCAL_QUESTION_BANKS,
  SURFACES,
  approvedFacts,
  calculateScore,
  calculateEvidenceMetrics,
  calculateLocalVisibilityScore,
  classifyBrowserVisibilityAnswer,
  classifyCitations,
  configFingerprintForRun,
  createPlatformRule,
  createFixedLocalQuestionBank,
  createLocalPromptSet,
  deterministicProbe,
  extractCompetitorCandidates,
  findMatchedBrandAliases,
  groupStability,
  hasEncodingCorruption,
  now,
  policyModeration,
  renderArticle,
  recommendationEvidence,
  seedStore,
  uid,
  validateArticle,
} from "./lib/core.mjs";
import { createMonitorRun, executeMonitorRun, findActiveDoubaoMonitorRun, monitorRunSummary, normalizeMonitorConcurrency, normalizeMonitorMaxRetries, parseMonitorRunLimit, parseRetryAfterMs } from "./lib/monitor-run.mjs";
import { browserMonitorRunSummary, browserMonitorVisibilitySummary, claimBrowserQuestionById, claimNextBrowserQuestion, createBrowserMonitorRun, findActiveBrowserMonitorRun, updateBrowserMonitorRun } from "./lib/browser-monitor-run.mjs";
import { createPersistQueue } from "./lib/persist-queue.mjs";
import { createCompetitorService } from "./lib/competitor-service.mjs";
import { DoubaoLoginRequiredError } from "./lib/doubao-adapter.mjs";
import { DoubaoBrowserManager } from "./lib/doubao-browser-manager.mjs";
import { DeepSeekBrowserManager } from "./lib/deepseek-browser-manager.mjs";
import { executeDoubaoWebRun } from "./lib/doubao-web-runner.mjs";
import { executeWebPlatformRun } from "./lib/web-platform-runner.mjs";
import { readDoubaoWebConfig } from "./lib/doubao-config.mjs";
import { readDeepSeekWebConfig } from "./lib/deepseek-config.mjs";
import { createDeepSeekCanaryRun, executeDeepSeekCanary, prepareDeepSeekCanaryRetry } from "./lib/deepseek-canary.mjs";
import { activeVerificationEvents, invalidateVerificationEvent, reconcileVerificationEvents, validateVerificationEvent } from "./lib/verification-events.mjs";
import { normalizeCitation } from "./lib/doubao-citation-extractor.mjs";
import { buildCitationSourceSummary, enrichCitationBrandRelation, normalizeHistoricalCitationObservation } from "./lib/doubao-citation-analysis.mjs";
import { normalizePublishedContent, validatePublishedContent } from "./lib/published-content.mjs";
import { buildGeoDropDiagnostics } from "./lib/geo-drop-diagnostics.mjs";
import { buildObservabilityQuality } from "./lib/observability-quality.mjs";
import { VISIBILITY_CLASSIFICATION_VERSION } from "./lib/visibility-rejudge.mjs";
import { browserMonitorPlatformFields, effectivePlatform, effectivePlatformMode, isPlatformId, isPlatformMode } from "./lib/platform.mjs";
import { evidenceMatchesPlatformSelection, listPlatformCapabilities, platformNotImplementedPayload, resolvePlatformSelection, runMatchesPlatformSelection } from "./lib/platform-api.mjs";
import { ActivePlatformRunRegistry } from "./lib/active-platform-run-registry.mjs";
import { createDoubaoPlatformDefinition, createDeepSeekPlatformDefinition, PlatformRegistry } from "./lib/platform-registry.mjs";
import { PlatformRuntimeRegistry } from "./lib/platform-runtime-registry.mjs";
import {
  ACCOUNT_AB_STATUS,
  DOUBAO_ACCOUNT_AB_TYPE,
  attachAccountAbRun,
  beginAccountAbSwitch,
  buildAccountAbComparison,
  createDoubaoAccountAbExperiment,
  markAccountAbArmACompleted,
  markAccountAbCompleted,
  recordAccountAbPreflight,
} from "./lib/doubao-account-ab.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_PATH = join(ROOT, "data", "store.json");
const PUBLIC_PATH = join(ROOT, "public");
const DOUBAO_CONFIG = readDoubaoWebConfig({ root: ROOT });
const DEEPSEEK_CONFIG = readDeepSeekWebConfig({ root: ROOT });
const DOUBAO_PROFILE_PATH = DOUBAO_CONFIG.profileDir;
const DOUBAO_DEBUG_PATH = DOUBAO_CONFIG.debugDir;
const SECRET_PATH = join(ROOT, "data", "secrets", "doubao-ark-api-key.bin");
const SECRET_HELPER = join(ROOT, "scripts", "secret-store.ps1");
const DOUBAO_HELPER = join(ROOT, "scripts", "doubao-request.ps1");
const PORT = Number(process.env.PORT || 4318);
const HOST = process.env.HOST || "127.0.0.1";
const SERVER_INSTANCE_ID = `geo-${randomUUID()}`;
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_INTERACTIVE_LAUNCH = process.env.GEO_INTERACTIVE_LAUNCH === "1";
const SERVER_STARTUP_SOURCE = String(process.env.GEO_STARTUP_SOURCE || "unknown").trim() || "unknown";
const DEVELOPMENT_RUNTIME = process.env.NODE_ENV !== "production";
const AGENT_TOKEN = process.env.AGENT_TOKEN || "local-workbuddy-token";
const DOUBAO_MODEL = "doubao-seed-2-0-lite-260215";
const DOUBAO_RESPONSES_URL = "https://ark.cn-beijing.volces.com/api/v3/responses";
const DOUBAO_TRANSPORT = (process.env.DOUBAO_TRANSPORT || "node").toLowerCase();
const DOUBAO_STREAM = String(process.env.DOUBAO_STREAM ?? "true").toLowerCase() !== "false";
const DOUBAO_API_ACCESS_DISABLED = true;
const GEO_DOUABO_CONCURRENCY = normalizeMonitorConcurrency(process.env.GEO_DOUABO_CONCURRENCY);
const GEO_DOUABO_MAX_RETRIES = normalizeMonitorMaxRetries(process.env.GEO_DOUABO_MAX_RETRIES);
const DOUBAO_MAX_PROMPTS_PER_RUN = 5;
const DOUBAO_MIN_INTERVAL_MS = 2000;
const DOUBAO_REQUEST_TIMEOUT_MS = 100_000;
const ANSWER_START_TIMEOUT = DOUBAO_CONFIG.answerStartTimeoutMs;
const ANSWER_COMPLETE_TIMEOUT = DOUBAO_CONFIG.answerCompleteTimeoutMs;
const ANSWER_STABLE_WINDOW = DOUBAO_CONFIG.textStableMs;
const MAX_QUESTION_RETRIES = DOUBAO_CONFIG.maxRetries;
const DOUBAO_TYPING_DELAY = DOUBAO_CONFIG.typingDelayMs;
const DOUBAO_RETRY_RECOVERY_COOLDOWN = DOUBAO_CONFIG.retryRecoveryCooldownMs;
const DOUBAO_WORKER_CONCURRENCY = DOUBAO_CONFIG.concurrency;
const DEEPSEEK_WORKER_CONCURRENCY = DEEPSEEK_CONFIG.concurrency;
const DOUBAO_PLATFORM_UNAVAILABLE_THRESHOLD = DOUBAO_CONFIG.platformUnavailableThreshold;
const GEO_DIAGNOSTIC_BASELINE_RUNS = DOUBAO_CONFIG.diagnosticBaselineRuns;
const GEO_DROP_ABSOLUTE_THRESHOLD = DOUBAO_CONFIG.geoDropAbsoluteThreshold;
const GEO_DROP_RELATIVE_THRESHOLD = DOUBAO_CONFIG.geoDropRelativeThreshold;
const DOUBAO_DEBUG_MODE = DOUBAO_CONFIG.debugMode;
const DOUBAO_DEBUG_TRACE = DOUBAO_CONFIG.debugTrace;
const ACCOUNT_AB_REPORT_PATH = join(ROOT, "reports", "doubao-account-ab-analysis.md");
let store;
// Older monitor evidence is deliberately kept outside the working store so
// normal dashboard startup stays fast.  Load these files only after the user
// explicitly opens the historical-records panel.
let archivedMonitorStoresPromise = null;
let doubaoRunInProgress = false;
const browserMonitorLoginWatchers = new Set();
const browserMonitorProgressClients = new Set();
const enqueuePersist = createPersistQueue(async (snapshot) => {
  await mkdir(dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, snapshot);
});
const platformRegistry = new PlatformRegistry([
  createDoubaoPlatformDefinition({
    runtimeFactory: () => new DoubaoBrowserManager({
      profileDir: DOUBAO_PROFILE_PATH,
      debugDir: DOUBAO_DEBUG_PATH,
      doubaoUrl: DOUBAO_CONFIG.url,
      logger: console,
      headless: false,
      answerStartTimeoutMs: ANSWER_START_TIMEOUT,
      answerCompleteTimeoutMs: ANSWER_COMPLETE_TIMEOUT,
      answerStableMs: ANSWER_STABLE_WINDOW,
      typingDelayMs: DOUBAO_TYPING_DELAY,
      debugMode: DOUBAO_DEBUG_MODE,
      debugTrace: DOUBAO_DEBUG_TRACE,
      workerCount: DOUBAO_WORKER_CONCURRENCY,
      serverInstanceId: SERVER_INSTANCE_ID,
    }),
  }),
  createDeepSeekPlatformDefinition({
    runtimeFactory: () => new DeepSeekBrowserManager({
      profileDir: DEEPSEEK_CONFIG.profileDir,
      webUrl: DEEPSEEK_CONFIG.webUrl,
      navigationTimeoutMs: DEEPSEEK_CONFIG.navigationTimeoutMs,
      workerCount: DEEPSEEK_WORKER_CONCURRENCY,
    }),
  }),
]);
const platformRuntimeRegistry = new PlatformRuntimeRegistry(platformRegistry);
const activePlatformRuns = new ActivePlatformRunRegistry();
// Stopping a monitor run must not close its Persistent Context or change its
// profile. This signal only cancels the runner's pending browser work.
const browserMonitorAbortControllers = new Map();
const getPlatformRuntime = (platform) => platformRuntimeRegistry.getPlatformRuntime(platform);
const getDoubaoBrowserRuntime = () => getPlatformRuntime("doubao_web");
// Compatibility reference for existing verification helpers. New controller
// paths resolve their runtime through getPlatformRuntime instead.
const doubaoBrowserManager = getDoubaoBrowserRuntime();

async function loadStore() {
  try {
    await access(DATA_PATH, constants.F_OK);
    store = JSON.parse(await readFile(DATA_PATH, "utf8"));
    let migrated = false;
    store.brands ||= [{ id: "brand_primary", name: "", legalName: "", aliases: [], domain: "", industry: "", location: "", competitors: [] }];
    store.brands[0].aliases ||= [];
    if (!store.citationPolicy) { store.citationPolicy = { ownedDomains: [] }; migrated = true; }
    if (!store.monitorRuns) { store.monitorRuns = []; migrated = true; }
    if (!store.browserMonitorRuns) { store.browserMonitorRuns = []; migrated = true; }
    if (!store.deepseekCanaryRuns) { store.deepseekCanaryRuns = []; migrated = true; }
    if (!store.doubaoAccountExperiments) { store.doubaoAccountExperiments = []; migrated = true; }
    if (!store.publishedContents) { store.publishedContents = []; migrated = true; }
    // Remove the single synthetic answer created while verifying the browser
    // task bridge. It was never a real Doubao webpage result and must not
    // participate in the user's monitoring history.
    const syntheticBrowserRunIds = new Set(["browser_monitor_5ae2cace"]);
    // This queued three-question task was created before a partial day was
    // excluded from the replacement baseline. It has never been claimed and
    // does not represent a user-requested test, so remove only this task.
    const obsoleteBrowserTaskIds = new Set(["browser_monitor_81d80bc6"]);
    for (const syntheticRun of (store.probeRuns || [])
      .filter((run) => run.source === "browser_observed" && run.rawAnswer === "东莞市测试玩具有限公司是一家示例公司。")
      .map((run) => run.browserMonitorRunId)
      .filter(Boolean)) syntheticBrowserRunIds.add(syntheticRun);
    if (syntheticBrowserRunIds.size) {
      const retainedProbeRuns = store.probeRuns.filter((run) => !syntheticBrowserRunIds.has(run.browserMonitorRunId));
      const retainedBrowserRuns = store.browserMonitorRuns.filter((run) => !syntheticBrowserRunIds.has(run.id));
      if (retainedProbeRuns.length !== store.probeRuns.length || retainedBrowserRuns.length !== store.browserMonitorRuns.length) {
        store.probeRuns = retainedProbeRuns;
        store.browserMonitorRuns = retainedBrowserRuns;
        migrated = true;
      }
    }
    if (store.browserMonitorRuns.some((run) => obsoleteBrowserTaskIds.has(run.id))) {
      store.browserMonitorRuns = store.browserMonitorRuns.filter((run) => !obsoleteBrowserTaskIds.has(run.id));
      migrated = true;
    }
    store.rules ||= [];
    for (const platform of PLATFORMS) {
      if (!store.rules.some((rule) => rule.platform === platform)) {
        store.rules.push(createPlatformRule(platform));
        migrated = true;
      }
    }
    if (!store.localMonitoringConfig) {
      store.localMonitoringConfig = {
        allowedRegions: ["chashan", "dongguan", "national"],
        selectedRegions: ["national"],
        formalQuestionSet: "dongguan_local",
        scoreWeights: { directRecommendation: 0.5, thirdPartyBrandSource: 0.3, businessMention: 0.2 },
        officialCitationInScore: false,
      };
      migrated = true;
    }
    if (!LOCAL_QUESTION_BANKS.some((bank) => bank.id === store.localMonitoringConfig.selectedQuestionSet)) {
      store.localMonitoringConfig.selectedQuestionSet = "dongguan_local";
      migrated = true;
    }
    if (JSON.stringify(store.localMonitoringConfig.browserExecutionPolicy) !== JSON.stringify(BROWSER_MONITOR_EXECUTION_POLICY)) {
      store.localMonitoringConfig.browserExecutionPolicy = BROWSER_MONITOR_EXECUTION_POLICY;
      migrated = true;
    }
    // Keep an in-flight user-requested monitor aligned with the currently
    // approved execution policy. Results already captured remain unchanged;
    // only the scheduling metadata is upgraded for the remaining questions.
    for (const browserRun of store.browserMonitorRuns) {
      const platform = effectivePlatform(browserRun);
      const workerConcurrency = platform === "deepseek_web"
        ? DEEPSEEK_WORKER_CONCURRENCY
        : normalizeDoubaoWorkerConcurrency(browserRun.executionPolicy?.workerConcurrency ?? browserRun.executionPolicy?.browserPages);
      const expectedPolicy = createBrowserMonitorExecutionPolicy(workerConcurrency, platform);
      if (["queued", "preparing_browser", "waiting_for_login", "running", "paused"].includes(browserRun.status)
        && JSON.stringify(browserRun.executionPolicy) !== JSON.stringify(expectedPolicy)) {
        browserRun.executionPolicy = expectedPolicy;
        migrated = true;
      }
      // Older one-click stops only marked the in-flight question as aborted,
      // leaving the rest of the stopped queue looking like it was still
      // waiting. Preserve every question record but make the audit state
      // explicit: stopped work is never pending work.
      if (browserRun.status === "aborted") {
        const stoppedAt = browserRun.abortedAt || browserRun.updatedAt || now();
        for (const question of browserRun.questions || []) {
          if (["success", "failed", "invalid", "aborted"].includes(question.status)) continue;
          question.status = "aborted";
          question.browserStage = "aborted_before_submission";
          question.completedAt ||= stoppedAt;
          question.savedAt ||= stoppedAt;
          question.job ||= {};
          Object.assign(question.job, {
            status: "aborted", completed_at: question.job.completed_at || stoppedAt,
            error_code: "RUN_ABORTED", error_message: browserRun.pausedReason || "operator_one_click_stop",
            lock_id: null, locked_at: null,
          });
          question.executionLog ||= [];
          question.executionLog.push({ stage: "ABORTED_BEFORE_SUBMISSION", at: stoppedAt, reason: browserRun.pausedReason || "operator_one_click_stop" });
          migrated = true;
        }
      }
    }
    if (!(store.prompts || []).some((prompt) => prompt.questionSet === "dongguan_local")) {
      for (const prompt of store.prompts || []) {
        if (!prompt.questionSet) {
          prompt.questionSet = "historical_broad";
          prompt.reportable = false;
          prompt.active = false;
        }
      }
      const generated = createLocalPromptSet(store.brands[0].id, store.localMonitoringConfig.selectedRegions);
      store.prompts.push(...generated.prompts);
      store.localMonitoringConfig.questionSetId = generated.id;
      migrated = true;
    }
    for (const prompt of store.prompts || []) {
      if (!prompt.monitoringVersion) {
        prompt.monitoringVersion = 1;
        migrated = true;
      }
      if (!Array.isArray(prompt.replacementHistory)) {
        prompt.replacementHistory = [];
        migrated = true;
      }
    }
    for (const run of store.probeRuns || []) {
      // Canary observations are isolated, immutable audit data. They are not
      // legacy records to be normalised during a later service restart.
      if (run.reportable === false) continue;
      const source = run.source || "browser_observed";
      const defaults = source === "doubao_api"
        ? { webSearch: false, invocationMode: "api", temperature: "default", modelId: run.model || DOUBAO_MODEL }
        : source === "simulated_probe"
          ? { webSearch: false, invocationMode: "simulated", temperature: "default", modelId: run.modelId || `${run.surface}-simulated` }
          : { webSearch: "unknown", invocationMode: "browser_manual", temperature: "default", modelId: run.modelId || run.model || `${run.surface}-web` };
      for (const [key, value] of Object.entries(defaults)) {
        if (run[key] === undefined) { run[key] = value; migrated = true; }
      }
      if (!run.citationMode) {
        run.citationMode = "legacy_unverified";
        run.legacyBrandCitation = run.brandCitation === true;
        run.citations = run.citations || [];
        run.ownedDomainCitations = [];
        run.thirdPartyCitations = [];
        run.thirdPartyBrandCitations = [];
        // These fields were derived from the old, invalid `brandCitation`
        // shortcut. Do not let them be read as verified source evidence.
        run.officialCitation = false;
        run.thirdPartyCitation = false;
        migrated = true;
      }
      // The first Web Search tool probe was collected before the system began
      // requiring a search instruction. Keep it for diagnostics, but do not
      // blend it into the formal connected-search report.
      if (run.source === "doubao_api" && run.webSearch === true && !run.searchStrategy) {
        run.searchStrategy = "tool_auto_probe";
        run.status = "configuration_check";
        migrated = true;
      }
      if (run.source === "doubao_api" && run.citationMode !== "legacy_unverified" && !run.requestEncoding) {
        run.requestEncoding = "legacy_console_input";
        run.status = "encoding_invalid";
        migrated = true;
      }
      if (run.source === "doubao_api" && String(run.rawAnswer || "").includes("输入的内容显示为乱码")) {
        run.status = "encoding_invalid";
        migrated = true;
      }
      const fingerprint = configFingerprintForRun(run);
      if (run.configFingerprint !== fingerprint) { run.configFingerprint = fingerprint; migrated = true; }
      if (run.source === "browser_observed" && run.visibilityClassificationVersion !== VISIBILITY_CLASSIFICATION_VERSION) {
        if (!run.promptVersion) {
          run.promptVersion = 1;
          migrated = true;
        }
        const judgement = classifyBrowserVisibilityAnswer(run.rawAnswer, store.brands[0]);
        const fields = { ...judgement };
        for (const [key, value] of Object.entries(fields)) {
          if (JSON.stringify(run[key]) !== JSON.stringify(value)) { run[key] = value; migrated = true; }
        }
      }
    }
    // Recover safely from a process restart: the in-flight real-page action
    // is never treated as a saved answer.  It is requeued and requires an
    // explicit resume, so its next attempt starts in a fresh conversation.
    for (const browserRun of store.browserMonitorRuns || []) {
      const terminalBrowserRun = browserMonitorRunIsComplete(browserRun);
      const historicalCitationChanged = normalizeHistoricalCitationObservation(browserRun);
      if (historicalCitationChanged) {
        migrated = true;
        // Rebuild cached diagnostics so legacy empty arrays can never be
        // mistaken for an observed zero-source result.
        if (browserRun.geoDropDiagnostics) { browserRun.geoDropDiagnostics = null; migrated = true; }
      }
      // Completed formal runs are immutable audit history. Only a nonterminal
      // run may receive recovered worker/job metadata after a service restart.
      if (!terminalBrowserRun) {
        for (const question of browserRun.questions || []) {
          if (normalizeBrowserQuestionJob(browserRun, question)) migrated = true;
          if (question.attemptCount > 1 && ["success", "failed", "invalid"].includes(question.status)) {
            normalizeBrowserQuestionTimingFromLatestAttempt(question);
            migrated = true;
          }
        }
        if (reconcileVerificationEvents(browserRun, { serverInstanceId: SERVER_INSTANCE_ID, afterRestart: true }).changed) migrated = true;
      }
      if (browserMonitorRunIsComplete(browserRun) && (!browserRun.visibilitySummary || !browserRun.sourceSummary || browserRun.sourceSummary.citationsWithin24h === undefined || browserRun.sourceSummary.citationObservationStatus === undefined)) {
        browserRun.sourceSummary = buildCitationSourceSummary(browserRun, store.brands[0]);
        browserRun.visibilitySummary = browserMonitorVisibilitySummary(browserRun, store.brands[0]);
        migrated = true;
      }
      if (browserMonitorRunIsComplete(browserRun) && !browserRun.observability) {
        browserRun.observability = buildObservabilityQuality(browserRun);
        migrated = true;
      }
      if (browserMonitorRunIsComplete(browserRun) && browserRun.geoDropDiagnostics && !browserRun.geoDropDiagnostics.observability) {
        browserRun.geoDropDiagnostics.observability = browserRun.observability || buildObservabilityQuality(browserRun);
        migrated = true;
      }
      if (browserMonitorRunIsComplete(browserRun) && !browserRun.geoDropDiagnostics) {
        browserRun.geoDropDiagnostics = buildGeoDropDiagnostics({
          currentRun: browserRun,
          historicalRuns: store.browserMonitorRuns || [],
          prompts: store.prompts || [],
          brand: store.brands[0],
          config: { baselineRuns: GEO_DIAGNOSTIC_BASELINE_RUNS, absoluteThreshold: GEO_DROP_ABSOLUTE_THRESHOLD, relativeThreshold: GEO_DROP_RELATIVE_THRESHOLD },
        });
        migrated = true;
      }
      if (browserRun.status === "running") {
        const interruptedAt = now();
        for (const question of browserRun.questions || []) {
          if (question.status !== "running") continue;
          if (Number(question.attemptCount || 0) >= MAX_QUESTION_RETRIES + 1) {
            question.status = "failed";
            question.browserStage = "failed_after_restart_retry_limit";
            question.completedAt = interruptedAt;
            question.savedAt = interruptedAt;
            question.outcome = "test_exception";
            question.exceptionType = "INTERRUPTED_AFTER_MAX_RETRIES";
            question.errorMessage = "服务重启时该题已达到首轮加两次 Retry 上限；为避免重复发送 Prompt，按真实中断记录为失败。";
            question.job ||= {};
            Object.assign(question.job, { status: "failed", completed_at: interruptedAt, duration_ms: durationBetween(question.startedAt, interruptedAt), error_code: question.exceptionType, error_message: question.errorMessage, lock_id: null, locked_at: null });
            question.executionLog ||= [];
            question.executionLog.push({ stage: "INTERRUPTED_AFTER_MAX_RETRIES", at: interruptedAt });
            continue;
          }
          question.status = "queued";
          question.browserStage = "paused_interrupted";
          question.executionLog ||= [];
          question.executionLog.push({ stage: "INTERRUPTED_REQUEUED", at: interruptedAt });
        }
        browserRun.status = "preparing_browser";
        browserRun.pausedReason = `服务重启：当前题目已重新排队，正在恢复专用${effectivePlatform(browserRun) === "deepseek_web" ? "DeepSeek" : "豆包"}浏览器。`;
        browserRun.updatedAt = interruptedAt;
        migrated = true;
        updateBrowserMonitorRunWithVisibilitySummary(browserRun);
      }
      if (browserRun.status === "needs_human_action") {
        const interruptedAt = now();
        for (const question of browserRun.questions || []) {
          if (question.status !== "needs_verification") continue;
          question.status = "queued";
          question.browserStage = "paused_human_action_after_restart";
          question.job ||= {};
          Object.assign(question.job, { status: "queued", lock_id: null, locked_at: null });
          question.executionLog ||= [];
          question.executionLog.push({ stage: "HUMAN_ACTION_REQUEUED_AFTER_RESTART", at: interruptedAt });
        }
        browserRun.status = "paused";
        browserRun.pausedReason = `服务重启：请确认${effectivePlatform(browserRun) === "deepseek_web" ? "DeepSeek" : "豆包"}人工验证已完成后继续；重试将从独立新对话开始。`;
        browserRun.humanAction = null;
        browserRun.humanActions = (browserRun.humanActions || []).map((action) => action.active ? { ...action, active: false, interruptedAt } : action);
        browserRun.updatedAt = interruptedAt;
        migrated = true;
      }
    }
    // Recover an A/B experiment if the process stopped after an arm finished
    // but before the finalization callback wrote the experiment checkpoint.
    for (const experiment of store.doubaoAccountExperiments || []) {
      const terminalRun = [experiment.runAId, experiment.runBId]
        .map((runId) => store.browserMonitorRuns.find((run) => run.id === runId))
        .find((run) => run && browserMonitorRunIsComplete(run));
      if (terminalRun && ![ACCOUNT_AB_STATUS.COMPLETED, ACCOUNT_AB_STATUS.ABORTED].includes(experiment.status)) {
        await finalizeDoubaoAccountAbRun(terminalRun);
        migrated = true;
      }
    }
    if (migrated) await persist();
  } catch {
    store = seedStore();
    store.monitorRuns = [];
    store.doubaoAccountExperiments = [];
    await persist();
  }
}

async function persist() {
  // The monitor store can contain thousands of saved answers and citations.
  // Whitespace makes every checkpoint substantially larger without adding
  // information, so keep the on-disk snapshot compact. JSON parsing remains
  // fully backward compatible with the older pretty-printed snapshots.
  const snapshot = JSON.stringify(store);
  await enqueuePersist(snapshot);
}

function nextBrowserMonitorRunId() {
  const highest = (store.browserMonitorRuns || []).reduce((max, run) => {
    const match = String(run.id || "").match(/^GEO_RUN_(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `GEO_RUN_${String(highest + 1).padStart(3, "0")}`;
}

function localQuestionBankDefinition(questionSet) {
  return LOCAL_QUESTION_BANKS.find((bank) => bank.id === questionSet) || null;
}

function selectedLocalQuestionSet() {
  const selected = store.localMonitoringConfig?.selectedQuestionSet;
  return localQuestionBankDefinition(selected) ? selected : "dongguan_local";
}

function localQuestionBankPrompts(questionSet = selectedLocalQuestionSet(), questionSetId = null) {
  const bank = localQuestionBankDefinition(questionSet);
  const isFixedBank = bank?.kind === "fixed";
  const currentSetId = isFixedBank ? (bank.currentSetId || `${questionSet}_v2`) : null;
  const requestedSetId = questionSetId || currentSetId;
  const persisted = (store.prompts || []).filter((item) => item.questionSet === questionSet
    && (!requestedSetId || item.questionSetId === requestedSetId)
    && (questionSetId ? item.reportable !== false : item.active && item.reportable !== false));
  if (persisted.length || !isFixedBank || (questionSetId && questionSetId !== currentSetId)) return persisted;
  // Fixed-bank prompts ship in the question-bank file. Use those rows when a
  // current set has not yet been persisted locally.
  return createFixedLocalQuestionBank(store.brands[0].id, questionSet, currentSetId).prompts;
}

function localQuestionBankCatalog() {
  return LOCAL_QUESTION_BANKS.map((bank) => {
    const prompts = localQuestionBankPrompts(bank.id);
    return {
      ...bank,
      promptCount: prompts.length,
      questionSetId: prompts[0]?.questionSetId || null,
    };
  });
}

function localQuestionBankName(questionSet) {
  return localQuestionBankDefinition(questionSet)?.name || questionSet || "未记录题库";
}

function browserMonitorRunMetadata(prompts, platform = "doubao_web") {
  const first = (prompts || [])[0] || {};
  return {
    platform,
    companyId: store.brands?.[0]?.id || store.brands?.[0]?.legalName || store.brands?.[0]?.name || null,
    questionSet: first.questionSet || null,
    questionSetId: first.questionSetId || store.localMonitoringConfig?.questionSetId || null,
    questionSetName: localQuestionBankName(first.questionSet),
  };
}

function accountAbExperimentSummary(experiment) {
  if (!experiment) return null;
  const runA = experiment.runAId ? store.browserMonitorRuns.find((run) => run.id === experiment.runAId) : null;
  const runB = experiment.runBId ? store.browserMonitorRuns.find((run) => run.id === experiment.runBId) : null;
  const compactRun = (run) => {
    if (!run) return null;
    const summary = browserMonitorRunSummary(run);
    delete summary.questions;
    return summary;
  };
  return {
    ...experiment,
    runA: compactRun(runA),
    runB: compactRun(runB),
  };
}

function activeDoubaoAccountAbExperiment() {
  return (store.doubaoAccountExperiments || []).find((experiment) => ![ACCOUNT_AB_STATUS.COMPLETED, ACCOUNT_AB_STATUS.ABORTED].includes(experiment.status)) || null;
}

function accountAbPromptsFromRun(run) {
  return (run?.questions || []).map((question) => ({
    id: question.promptId,
    text: question.questionText || question.question,
    questionSet: run.questionSet,
    questionSetId: run.questionSetId,
    monitoringVersion: question.promptVersion || 1,
    active: true,
    reportable: true,
  }));
}

function accountAbQuestionSetUnchanged(run) {
  const current = localQuestionBankPrompts(run?.questionSet || selectedLocalQuestionSet(), run?.questionSetId || null);
  const snapshot = accountAbPromptsFromRun(run);
  return current.length === snapshot.length && current.every((prompt, index) => prompt.id === snapshot[index]?.id && prompt.text === snapshot[index]?.text);
}

function accountAbRunIsFullSuccess(run) {
  return Boolean(run && run.status === "completed" && Number(run.total) === 30 && Number(run.success) === 30 && Number(run.completed) === 30 && (run.questions || []).length === 30 && run.questions.every((question) => question.status === "success" && String(question.rawAnswer || "").trim()));
}

function browserMonitorCompletionEvent(run) {
  // Arm A must not be exposed to the UI as a terminal experiment result: the
  // serial flow still requires a manual account switch and a separate B run.
  return run?.experimentType === DOUBAO_ACCOUNT_AB_TYPE && run?.experimentArm === "A"
    ? "progress"
    : (run.status === "completed" || run.status === "completed_with_errors" ? "completed" : "progress");
}

async function writeAccountAbReport(experiment, comparison) {
  const pct = (value) => value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
  const a = comparison.armA;
  const b = comparison.armB;
  const lines = [
    "# 豆包账号 A/B 对照分析",
    "",
    `- experimentId: ${experiment.experimentId}`,
    `- experimentType: ${experiment.experimentType}`,
    `- 题库: ${experiment.questionSet || "未记录"}`,
    `- A（新账号）Run: ${experiment.runAId}`,
    `- B（旧账号）Run: ${experiment.runBId}`,
    `- A 完成时间: ${experiment.runACompletedAt || "未记录"}`,
    `- 切换确认时间: ${experiment.switchConfirmedAt || "未记录"}`,
    `- B 开始时间: ${experiment.runBStartedAt || "未记录"}`,
    `- 两轮间隔（分钟）: ${experiment.timeGapMinutes ?? "未记录"}`,
    "",
    "## 总体 GEO 对比",
    "",
    "| 指标 | 新账号 A | 旧账号 B | 旧账号 - 新账号 |",
    "|---|---:|---:|---:|",
    `| 有效回答 | ${a.validAnswers} | ${b.validAnswers} | ${b.validAnswers - a.validAnswers} |`,
    `| 品牌提及率 | ${pct(a.mentionRate)} | ${pct(b.mentionRate)} | ${pct(comparison.deltas.mentionRateDelta)} |`,
    `| 优先推荐率 | ${pct(a.priorityRate)} | ${pct(b.priorityRate)} | ${pct(comparison.deltas.priorityRateDelta)} |`,
    `| Citation 覆盖题数 | ${a.citationQuestions} | ${b.citationQuestions} | ${b.citationQuestions - a.citationQuestions} |`,
    `| Citation 总数 | ${a.citationCount} | ${b.citationCount} | ${b.citationCount - a.citationCount} |`,
    `| Unique Domains | ${a.uniqueDomains} | ${b.uniqueDomains} | ${b.uniqueDomains - a.uniqueDomains} |`,
    `| 平均回答长度 | ${a.averageAnswerLength ?? "未记录"} | ${b.averageAnswerLength ?? "未记录"} | ${a.averageAnswerLength != null && b.averageAnswerLength != null ? b.averageAnswerLength - a.averageAnswerLength : "未记录"} |`,
    `| 平均候选企业数 | ${a.averageCandidateCount ?? "未记录"} | ${b.averageCandidateCount ?? "未记录"} | ${a.averageCandidateCount != null && b.averageCandidateCount != null ? b.averageCandidateCount - a.averageCandidateCount : "未记录"} |`,
    "",
    "## 逐题差异",
    "",
    `- old_only（A 未提及、B 提及）: ${comparison.promptCounts.oldOnlyQuestionCount}`,
    `- new_only（A 提及、B 未提及）: ${comparison.promptCounts.newOnlyQuestionCount}`,
    `- both_visible: ${comparison.promptCounts.bothVisibleQuestionCount}`,
    `- both_invisible: ${comparison.promptCounts.bothInvisibleQuestionCount}`,
    `- ranking_changed: ${comparison.promptCounts.rankingChangedQuestionCount}`,
    "",
    "## Account Effect",
    "",
    `- effectStrength: ${comparison.effectStrength}`,
    `- confidence: ${comparison.confidence}`,
    `- competitorSimilarity: ${comparison.competitorSimilarity}`,
    `- citationSimilarity: ${comparison.citationSimilarity ?? "无法比较"}`,
    `- citationChangesComparable: ${comparison.citationChanges?.comparable ? "yes" : "no"}`,
    `- citationDomainsAdded: ${(comparison.citationChanges?.domainsAdded || []).join(", ") || "none"}`,
    `- citationDomainsRemoved: ${(comparison.citationChanges?.domainsRemoved || []).join(", ") || "none"}`,
    `- workerConsistency: ${JSON.stringify(comparison.workerConsistency || {})}`,
    `- 结论: ${comparison.conclusion}`,
    "",
    "> 账号切换是相关性实验，不等于证明 100% 因果。题库、执行器、时间间隔、平台状态和 Citation 可观测性仍需一起复核。",
  ];
  await mkdir(dirname(ACCOUNT_AB_REPORT_PATH), { recursive: true });
  await writeFile(ACCOUNT_AB_REPORT_PATH, lines.join("\n"));
}

async function finalizeDoubaoAccountAbRun(run) {
  const experiment = (store.doubaoAccountExperiments || []).find((item) => item.runAId === run.id || item.runBId === run.id);
  if (!experiment || experiment.status === ACCOUNT_AB_STATUS.COMPLETED || experiment.status === ACCOUNT_AB_STATUS.ABORTED) return;
  if (experiment.runAId === run.id) {
    if (!accountAbRunIsFullSuccess(run)) {
      experiment.status = ACCOUNT_AB_STATUS.ABORTED;
      experiment.abortReason = "A 轮未达到 30/30 完整有效回答，禁止进入账号切换和 B 轮。";
      experiment.completedAt = now();
      await persist();
      return;
    }
    markAccountAbArmACompleted(experiment, run.completedAt || now());
    run.accountSwitchRequired = true;
    run.accountSwitchExperimentId = experiment.experimentId;
    run.accountSwitchMessage = "新账号测试已完成。请人工切换到豆包旧账号后确认。";
    await persist();
    publishBrowserMonitorProgress(run, "account_switch_required");
    return;
  }
  if (experiment.runBId === run.id) {
    if (!accountAbRunIsFullSuccess(run)) {
      experiment.status = ACCOUNT_AB_STATUS.ABORTED;
      experiment.abortReason = "B 轮未达到 30/30 完整有效回答，禁止生成正式账号差异结论。";
      experiment.completedAt = now();
      await persist();
      return;
    }
    const runA = store.browserMonitorRuns.find((item) => item.id === experiment.runAId);
    const comparison = buildAccountAbComparison(runA, run, { experimentId: experiment.experimentId, brand: store.brands?.[0] || null });
    markAccountAbCompleted(experiment, comparison, run.completedAt || now());
    run.accountAbExperimentCompleted = true;
    await writeAccountAbReport(experiment, comparison);
    await persist();
    publishBrowserMonitorProgress(run, "completed");
  }
}

function browserMonitorQuestionCounts(run) {
  return (run.questions || []).reduce((counts, question) => {
    const status = question.status === "retrying" ? "retrying" : question.status;
    if (Object.hasOwn(counts, status)) counts[status] += 1;
    return counts;
  }, { queued: 0, running: 0, retrying: 0, needs_verification: 0, success: 0, failed: 0, invalid: 0, aborted: 0 });
}

function browserMonitorRunIsComplete(run) {
  const questions = run.questions || [];
  // A durable trend point is allowed only when every job is terminal. This
  // deliberately rejects a stale/corrupt completed count if even one Worker
  // is still awaiting verification, running, queued, or retrying.
  return ["completed", "completed_with_errors"].includes(run.status)
    && run.completed === run.total
    && questions.length === run.total
    && questions.every((question) => ["success", "failed", "invalid"].includes(question.status));
}

function updateBrowserMonitorRunWithVisibilitySummary(run) {
  updateBrowserMonitorRun(run);
  if (browserMonitorRunIsComplete(run)) {
    run.sourceSummary = buildCitationSourceSummary(run, store.brands[0]);
    run.visibilitySummary = browserMonitorVisibilitySummary(run, store.brands[0]);
    run.observability = buildObservabilityQuality(run);
    run.geoDropDiagnostics = buildGeoDropDiagnostics({
      currentRun: run,
      historicalRuns: store.browserMonitorRuns || [],
      prompts: store.prompts || [],
      brand: store.brands[0],
      config: { baselineRuns: GEO_DIAGNOSTIC_BASELINE_RUNS, absoluteThreshold: GEO_DROP_ABSOLUTE_THRESHOLD, relativeThreshold: GEO_DROP_RELATIVE_THRESHOLD },
    });
  }
  return run;
}

function browserMonitorTrendHistory(selection = {}, questionSet = null, questionSetId = null) {
  const activeQuestionSetId = questionSetId || (questionSet ? localQuestionBankPrompts(questionSet)[0]?.questionSetId : null);
  return (store.browserMonitorRuns || [])
    .filter((run) => run.reportable !== false && browserMonitorRunIsComplete(run) && Number(run.total) === 30 && runMatchesPlatformSelection(run, selection)
      && (!questionSet || run.questionSet === questionSet)
      && (!activeQuestionSetId || run.questionSetId === activeQuestionSetId))
    .map((run) => {
      const geoDropDiagnostics = run.geoDropDiagnostics || buildGeoDropDiagnostics({ currentRun: run, historicalRuns: store.browserMonitorRuns || [], prompts: store.prompts || [], brand: store.brands[0], config: { baselineRuns: GEO_DIAGNOSTIC_BASELINE_RUNS, absoluteThreshold: GEO_DROP_ABSOLUTE_THRESHOLD, relativeThreshold: GEO_DROP_RELATIVE_THRESHOLD } });
      return { ...(run.visibilitySummary || browserMonitorVisibilitySummary(run, store.brands[0])), platform: effectivePlatform(run), platformMode: effectivePlatformMode(run), experimentType: run.experimentType || null, experimentId: run.experimentId || null, experimentArm: run.experimentArm || null, accountLabel: run.accountLabel || null, observability: run.observability || buildObservabilityQuality(run), geoDropDiagnostics: { schemaVersion: geoDropDiagnostics.schemaVersion, triggered: geoDropDiagnostics.triggered, triggerReasons: geoDropDiagnostics.triggerReasons, baselineSampleSize: geoDropDiagnostics.baselineSampleSize, baselineRequested: geoDropDiagnostics.baselineRequested, thresholds: geoDropDiagnostics.thresholds, comparison: geoDropDiagnostics.comparison, observability: geoDropDiagnostics.observability || run.observability || buildObservabilityQuality(run) } };
    })
    .sort((a, b) => Date.parse(a.completedAt || a.startedAt || 0) - Date.parse(b.completedAt || b.startedAt || 0));
}

async function archivedMonitorStores() {
  if (!archivedMonitorStoresPromise) {
    const entries = Array.isArray(store.archiveRegistry) ? store.archiveRegistry : [];
    archivedMonitorStoresPromise = Promise.all(entries.map(async (entry) => {
      try {
        const data = JSON.parse(await readFile(String(entry.path), "utf8"));
        return { entry, data };
      } catch (error) {
        console.warn("无法读取监测历史归档", entry?.path, error?.message || error);
        return null;
      }
    })).then((items) => items.filter(Boolean));
  }
  return archivedMonitorStoresPromise;
}

function archivedBrowserMonitorTrendHistory(archives, selection = {}, questionSet = null, questionSetId = null) {
  const activeQuestionSetId = questionSetId || (questionSet ? localQuestionBankPrompts(questionSet)[0]?.questionSetId : null);
  return archives
    .flatMap(({ entry, data }) => (data.browserMonitorRuns || []).map((run) => ({ entry, run })))
    .filter(({ run }) => run.reportable !== false && browserMonitorRunIsComplete(run) && Number(run.total) === 30
      && runMatchesPlatformSelection(run, selection)
      && (!questionSet || run.questionSet === questionSet)
      && (!activeQuestionSetId || run.questionSetId === activeQuestionSetId))
    .map(({ entry, run }) => ({
      ...(run.visibilitySummary || browserMonitorVisibilitySummary(run, store.brands[0])),
      platform: effectivePlatform(run),
      platformMode: effectivePlatformMode(run),
      archive: true,
      archiveCreatedAt: entry.createdAt || null,
      observability: run.observability || buildObservabilityQuality(run),
      geoDropDiagnostics: run.geoDropDiagnostics ? {
        schemaVersion: run.geoDropDiagnostics.schemaVersion,
        triggered: run.geoDropDiagnostics.triggered,
        triggerReasons: run.geoDropDiagnostics.triggerReasons,
        baselineSampleSize: run.geoDropDiagnostics.baselineSampleSize,
        baselineRequested: run.geoDropDiagnostics.baselineRequested,
        thresholds: run.geoDropDiagnostics.thresholds,
        comparison: run.geoDropDiagnostics.comparison,
        observability: run.geoDropDiagnostics.observability || run.observability || buildObservabilityQuality(run),
      } : null,
    }))
    .sort((a, b) => Date.parse(a.completedAt || a.startedAt || 0) - Date.parse(b.completedAt || b.startedAt || 0));
}

function browserMonitorIncompleteHistory(selection = {}, questionSet = null, questionSetId = null) {
  const activeQuestionSetId = questionSetId || (questionSet ? localQuestionBankPrompts(questionSet)[0]?.questionSetId : null);
  return (store.browserMonitorRuns || [])
    .filter((run) => run.reportable !== false && run.mode === "full_daily" && Number(run.total) === 30
      && ["aborted", "failed"].includes(run.status) && runMatchesPlatformSelection(run, selection)
      && (!questionSet || run.questionSet === questionSet)
      && (!activeQuestionSetId || run.questionSetId === activeQuestionSetId))
    .map((run) => {
      const counts = browserMonitorQuestionCounts(run);
      const savedAnswers = counts.success;
      const failedAnswers = counts.failed;
      const abortedQuestions = counts.aborted;
      const unresolvedQuestions = Math.max(0, Number(run.total || 0) - savedAnswers - failedAnswers - abortedQuestions);
      return {
        runId: run.id,
        platform: effectivePlatform(run),
        platformMode: effectivePlatformMode(run),
        status: run.status,
        totalQuestions: Number(run.total || 0),
        savedAnswers,
        failedAnswers,
        abortedQuestions,
        unresolvedQuestions,
        startedAt: run.startedAt || run.createdAt || null,
        endedAt: run.completedAt || run.abortedAt || run.updatedAt || null,
        stopReason: run.pausedReason || null,
      };
    })
    .sort((a, b) => Date.parse(b.endedAt || b.startedAt || 0) - Date.parse(a.endedAt || a.startedAt || 0));
}

function browserMonitorWorkerSnapshot(run) {
  const configuredWorkers = Math.max(1, Number(run.executionPolicy?.workerConcurrency || run.executionPolicy?.browserPages || 1));
  const platform = effectivePlatform(run);
  const activeVerificationQuestionIds = new Set(platform === "doubao_web" ? activeVerificationEvents(run, { browserManager: doubaoBrowserManager, serverInstanceId: SERVER_INSTANCE_ID }).map((action) => action.questionId) : []);
  const activeQuestions = (run.questions || []).filter((question) => question.status === "running" || (question.status === "needs_verification" && activeVerificationQuestionIds.has(question.promptId)));
  return Array.from({ length: configuredWorkers }, (_, index) => {
    const pageIndex = index + 1;
    const workerId = `${platform === "deepseek_web" ? "deepseek" : "doubao"}-worker-${pageIndex}`;
    const question = activeQuestions.find((item) => item.workerId === workerId || Number(item.pageIndex) === pageIndex);
    if (!question) return { workerId, pageIndex, state: "idle", questionId: null, attempt: null, stage: null, startedAt: null, elapsedMs: 0 };
    const needsHumanAction = question.status === "needs_verification";
    const retrying = /retry|recovery|recreated/i.test(String(question.browserStage || ""));
    return {
      workerId: question.workerId || workerId,
      pageIndex: question.pageIndex || pageIndex,
      state: needsHumanAction ? "needs_human_action" : retrying ? "retrying" : "running",
      questionId: question.promptId,
      questionNumber: (run.questions || []).indexOf(question) + 1,
      questionText: question.questionText,
      attempt: question.attemptCount,
      stage: question.browserStage || "running",
      startedAt: question.startedAt || null,
      elapsedMs: durationBetween(question.startedAt, now()) || 0,
    };
  });
}

// This is deliberately calculated from answers already saved by the browser
// worker. It is only a live view of the current run and never changes the
// established GEO score/result definitions or creates extra probe records.
function browserMonitorProvisionalResult(run) {
  const validAnswers = (run.questions || [])
    .filter((question) => question.status === "success" && String(question.rawAnswer || "").trim())
    .map((question) => classifyBrowserVisibilityAnswer(question.rawAnswer, store.brands[0]))
    .filter((judgement) => judgement.hasValidCompanyAnswer !== false);
  const mentioned = validAnswers.filter((judgement) => judgement.brandMentioned).length;
  const priorityRecommended = validAnswers.filter((judgement) => ["first", "top3"].includes(judgement.recommendation)).length;
  const rate = (value) => validAnswers.length ? Math.round((value / validAnswers.length) * 10_000) / 100 : null;
  const terminal = run.completed === run.total && ["completed", "completed_with_errors"].includes(run.status);
  return {
    resultState: terminal ? "final" : "provisional",
    validCompleted: validAnswers.length,
    mentionCount: mentioned,
    priorityRecommendationCount: priorityRecommended,
    mentionRatePercent: rate(mentioned),
    priorityRecommendationRatePercent: rate(priorityRecommended),
  };
}

function browserMonitorProgressSnapshot(run) {
  const questionCounts = browserMonitorQuestionCounts(run);
  const humanActions = activeVerificationEvents(run, { browserManager: doubaoBrowserManager, serverInstanceId: SERVER_INSTANCE_ID });
  // Every human-verification display is derived from this same validated
  // collection; raw historical question statuses cannot inflate the UI.
  questionCounts.needs_verification = humanActions.length;
  return {
    runId: run.id,
    platform: effectivePlatform(run),
    platformMode: effectivePlatformMode(run),
    status: run.status,
    total: run.total,
    completed: run.completed,
    success: run.success,
    failed: run.failed,
    invalid: run.invalid || 0,
    questionCounts,
    workers: browserMonitorWorkerSnapshot(run),
    progressPercent: run.total ? Math.round((run.completed / run.total) * 10_000) / 100 : 0,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    accountSwitchRequired: Boolean(run.accountSwitchRequired),
    accountSwitchExperimentId: run.accountSwitchExperimentId || null,
    pausedReason: run.pausedReason || null,
    humanAction: humanActions.at(-1) || null,
    humanActions: run.humanActions || [],
    activeHumanActionCount: humanActions.length,
    result: browserMonitorProvisionalResult(run),
  };
}

function browserMonitorRunResponse(run) {
  return { ...browserMonitorRunSummary(run), progress: browserMonitorProgressSnapshot(run) };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publishBrowserMonitorProgress(run, event = "progress") {
  const payload = browserMonitorProgressSnapshot(run);
  for (const client of [...browserMonitorProgressClients]) {
    if (client.runId !== run.id || client.res.writableEnded || client.res.destroyed) {
      browserMonitorProgressClients.delete(client);
      continue;
    }
    try { writeSse(client.res, event, payload); }
    catch { browserMonitorProgressClients.delete(client); }
  }
}

function openBrowserMonitorProgressStream(req, res, run) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  const client = { runId: run.id, res };
  browserMonitorProgressClients.add(client);
  writeSse(res, "progress", browserMonitorProgressSnapshot(run));
  req.on("close", () => browserMonitorProgressClients.delete(client));
}

const browserMonitorProgressHeartbeat = setInterval(() => {
  for (const client of [...browserMonitorProgressClients]) {
    if (client.res.writableEnded || client.res.destroyed) browserMonitorProgressClients.delete(client);
    else {
      try { client.res.write(": keep-alive\n\n"); }
      catch { browserMonitorProgressClients.delete(client); }
    }
  }
}, 15_000);
browserMonitorProgressHeartbeat.unref?.();

async function doubaoApiConfigured() {
  if (DOUBAO_API_ACCESS_DISABLED) return false;
  if (process.env.ARK_API_KEY?.trim()) return true;
  try {
    await access(SECRET_PATH, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function secretStore(action, value = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SECRET_HELPER, "-Action", action, "-Name", "doubao-ark-api-key"],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || "无法访问豆包 API Key")));
    child.stdin.end(value, "utf8");
  });
}

async function storeDoubaoApiKey(apiKey) { await secretStore("set", apiKey); }
async function readDoubaoApiKey() { return (await secretStore("get")).trim(); }
async function removeDoubaoApiKey() { await secretStore("remove"); }

async function providerSettings() {
  return {
    doubao: {
      configured: false,
      disabled: true,
      provider: "火山方舟 · 豆包 API",
      storage: "Windows 当前用户 DPAPI 加密存储",
      model: DOUBAO_MODEL,
      webSearch: false,
      maxPromptsPerRun: DOUBAO_MAX_PROMPTS_PER_RUN,
    },
  };
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function sseEventsFromBuffer(buffer, onEvent) {
  let remaining = buffer;
  while (true) {
    const delimiter = remaining.search(/\r?\n\r?\n/);
    if (delimiter === -1) return remaining;
    const block = remaining.slice(0, delimiter);
    const delimiterLength = remaining.startsWith("\r\n\r\n", delimiter) ? 4 : 2;
    remaining = remaining.slice(delimiter + delimiterLength);
    const lines = block.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "";
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      onEvent(eventName, JSON.parse(data));
    } catch (error) {
      throw new Error(`豆包 API 返回了无法解析的 SSE JSON：${error.message}`);
    }
  }
}

function streamResponseFromEvents(events, textParts) {
  const completed = [...events].reverse().find(({ payload }) => payload?.response && typeof payload.response === "object");
  if (completed) return completed.payload.response;
  const responseLike = [...events].reverse().find(({ payload }) => Array.isArray(payload?.output));
  if (responseLike) return responseLike.payload;
  const responseId = [...events].reverse().map(({ payload }) => payload?.response_id || payload?.id).find(Boolean) || null;
  return {
    id: responseId,
    model: DOUBAO_MODEL,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: textParts.join("") }] }],
  };
}

async function nativeNodeDoubaoRequest(body, { headers: extraHeaders = {}, stream = DOUBAO_STREAM } = {}) {
  const apiKey = process.env.ARK_API_KEY?.trim();
  if (!apiKey) throw new Error("ARK_API_KEY 未配置，无法使用 Node 直连豆包 API");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const startedAt = Date.now();
  try {
    let response;
    try {
      response = await fetch(DOUBAO_RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...extraHeaders,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("豆包联网单题请求超过 90 秒，已取消且不会计入正式监测");
      throw new Error(`豆包 API 网络请求失败：${error.message}`);
    }

    if (!response.ok) {
      const responseText = await response.text();
      const error = new Error(`Doubao API HTTP ${response.status}: ${responseText}`);
      error.httpStatus = response.status;
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
      }
      throw error;
    }
    if (!stream) {
      const responseText = await response.text();
      if (!responseText.trim()) throw new Error("豆包 API 返回了空响应");
      try {
        return JSON.parse(responseText);
      } catch (error) {
        throw new Error(`豆包 API 返回了无法解析的 JSON：${error.message}`);
      }
    }
    if (!response.body) throw new Error("豆包 API 未返回可读取的 SSE 响应体");

    const diagnostics = { startedAt: new Date(startedAt).toISOString(), firstEventAt: null, firstOutputAt: null, completedAt: null, timeToFirstEventMs: null, timeToFirstOutputMs: null, totalLatencyMs: null, eventTypes: [] };
    const eventTypes = new Set();
    const events = [];
    const textParts = [];
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    const recordEvent = (eventName, payload) => {
      const eventType = String(payload?.type || eventName || "unknown");
      const receivedAt = Date.now();
      if (diagnostics.firstEventAt === null) {
        diagnostics.firstEventAt = new Date(receivedAt).toISOString();
        diagnostics.timeToFirstEventMs = receivedAt - startedAt;
      }
      eventTypes.add(eventType);
      if (typeof payload?.delta === "string" && /output.*text/i.test(eventType)) {
        if (diagnostics.firstOutputAt === null) {
          diagnostics.firstOutputAt = new Date(receivedAt).toISOString();
          diagnostics.timeToFirstOutputMs = receivedAt - startedAt;
        }
        textParts.push(payload.delta);
      }
      events.push({ eventName, payload });
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = sseEventsFromBuffer(buffer + decoder.decode(value, { stream: true }), recordEvent);
    }
    buffer = sseEventsFromBuffer(buffer + decoder.decode(), recordEvent);
    if (buffer.trim()) throw new Error("豆包 API SSE 响应在事件结束前中断");
    diagnostics.completedAt = new Date().toISOString();
    diagnostics.totalLatencyMs = Date.now() - startedAt;
    diagnostics.eventTypes = [...eventTypes];
    const payload = streamResponseFromEvents(events, textParts);
    Object.defineProperty(payload, "doubaoDiagnostics", { value: diagnostics, enumerable: false });
    Object.defineProperty(payload, "doubaoStreamEvents", { value: events, enumerable: false });
    console.log(`[doubao] stream=true firstEvent=${diagnostics.timeToFirstEventMs}ms firstOutput=${diagnostics.timeToFirstOutputMs}ms total=${diagnostics.totalLatencyMs}ms responseId=${payload.id || "unknown"} eventTypes=${diagnostics.eventTypes.join(",")}`);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("豆包联网单题请求超过 90 秒，已取消且不会计入正式监测");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function nativeDoubaoRequest(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", DOUBAO_HELPER, "-Endpoint", DOUBAO_RESPONSES_URL],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("豆包联网单题请求超过 60 秒，已停止且不会计入正式监测"));
    }, DOUBAO_REQUEST_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr || "豆包 API 请求失败"));
      try {
        const base64 = stdout.trim();
        if (!base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) throw new Error("响应不是 Base64 字节流");
        const responseBytes = Buffer.from(base64, "base64");
        const responseText = responseBytes.toString("utf8");
        if (!responseText.trim() || responseText.includes("\uFFFD")) throw new Error("响应不是有效 UTF-8 文本");
        resolve(JSON.parse(responseText));
      } catch (error) {
        reject(new Error(`豆包 API 返回了无法解析的 UTF-8 JSON：${error.message}`));
      }
    });
    child.stdin.end(Buffer.from(body, "utf8").toString("base64"), "ascii");
  });
}

function requestDoubao(body) {
  if (DOUBAO_TRANSPORT === "node") return nativeNodeDoubaoRequest(body);
  if (DOUBAO_TRANSPORT === "powershell") return nativeDoubaoRequest(body);
  throw new Error("DOUBAO_TRANSPORT 仅支持 node 或 powershell");
}

function rawAnswerFromResponse(payload) {
  return (payload.output || [])
    .filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function markdownCitationCandidates(rawAnswer) {
  const candidates = [];
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of String(rawAnswer || "").matchAll(markdown)) candidates.push({ url: match[2], title: match[1], summary: "", sourceMethod: "markdown_parsed" });
  const bare = /(?<!\]\()https?:\/\/[^\s)]+/g;
  for (const match of String(rawAnswer || "").matchAll(bare)) candidates.push({ url: match[0], title: "", summary: "", sourceMethod: "markdown_parsed" });
  return candidates;
}

function providerToolCitationCandidates(payload) {
  const candidates = [];
  const seen = new Set();
  const walk = (node, inTool = false) => {
    if (!node || typeof node !== "object") return;
    const type = String(node.type || node.name || "").toLowerCase();
    const toolContext = inTool || /tool|search|citation|source/.test(type);
    if (toolContext && typeof node.url === "string" && /^https?:\/\//i.test(node.url) && !seen.has(node.url)) {
      seen.add(node.url);
      candidates.push({ url: node.url, title: node.title || node.name || "", summary: node.summary || node.snippet || node.description || "", sourceMethod: "provider_tool" });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((item) => walk(item, toolContext));
      else if (value && typeof value === "object") walk(value, toolContext);
    }
  };
  for (const item of payload?.output || []) walk(item);
  return candidates;
}

function citationEvidence(rawAnswer, brand, candidates, citationMode) {
  const resolved = classifyCitations(candidates, brand, store.citationPolicy.ownedDomains);
  return { ...resolved, citationMode: candidates.length ? citationMode : "no_source_returned" };
}

function classifyApiProbe(prompt, rawAnswer, brand, payload, webSearch = false) {
  const matchedBrandAliases = findMatchedBrandAliases(rawAnswer, brand);
  const brandMentioned = matchedBrandAliases.length > 0;
  const negativeTerms = ["不推荐", "风险", "投诉", "虚假", "不靠谱"];
  const sentiment = brandMentioned ? (negativeTerms.some((term) => rawAnswer.includes(term)) ? "negative" : "neutral") : "neutral";
  const inferenceConfig = { webSearch, invocationMode: "api", temperature: "default", requestEncoding: "utf8_base64", ...(webSearch ? { searchStrategy: "search_required" } : {}) };
  const providerSources = providerToolCitationCandidates(payload);
  const evidence = citationEvidence(rawAnswer, brand, providerSources.length ? providerSources : markdownCitationCandidates(rawAnswer), providerSources.length ? "provider_tool" : "markdown_parsed");
  const recommendation = recommendationEvidence(rawAnswer, brand);
  return {
    id: uid("run"), promptId: prompt.id, surface: "豆包", createdAt: now(), rawAnswer,
    screenshot: null, ...evidence, brandMentioned, matchedBrandAliases,
    ...recommendation, brandCitation: false,
    officialCitation: evidence.ownedDomainCitations.length > 0,
    thirdPartyCitation: evidence.thirdPartyBrandCitations.length > 0,
    accurate: null, accuracyStatus: "unreviewed", sentiment, competitorMentions: 0, competitorCandidates: extractCompetitorCandidates(rawAnswer, brand),
    source: "doubao_api", status: "success", model: payload.model || DOUBAO_MODEL, modelId: payload.model || DOUBAO_MODEL, responseId: payload.id || null,
    ...inferenceConfig, configFingerprint: configFingerprintForRun(inferenceConfig),
  };
}

function isRetryableDoubaoError(error) {
  if (error?.httpStatus === 429) return true;
  return /timeout|timed out|TaskCanceled|超时|HTTP 5\d\d/i.test(String(error?.message || ""));
}

async function callDoubaoApi(prompt, brand, { webSearch = false, maxAttempts = 2 } = {}) {
  const inputText = webSearch
    ? `请先使用联网搜索检索公开网页来源，再客观回答以下问题。不要编造品牌或链接；无法核实则明确说明。\n\n问题：${prompt.text}`
    : prompt.text;
  const requestBody = JSON.stringify({
    model: DOUBAO_MODEL,
    store: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: inputText }] }],
    ...(webSearch ? { tools: [{ type: "web_search" }] } : {}),
    ...(DOUBAO_TRANSPORT === "node" && DOUBAO_STREAM ? { stream: true } : {}),
  });
  const allowedAttempts = maxAttempts === 1 ? 1 : 2;
  for (let attempt = 1; attempt <= allowedAttempts; attempt += 1) {
    let payload;
    try {
      payload = await requestDoubao(requestBody);
    } catch (error) {
      if (!isRetryableDoubaoError(error) || attempt === allowedAttempts) throw error;
      await wait(2000);
      continue;
    }
    const rawAnswer = rawAnswerFromResponse(payload);
    if (!rawAnswer) throw new Error("豆包 API 未返回可保存的文本回答");
    if (!hasEncodingCorruption(rawAnswer)) return classifyApiProbe(prompt, rawAnswer, brand, payload, webSearch);
    if (attempt === allowedAttempts) throw new Error("Detected response text encoding corruption");
    if (attempt === 2) throw new Error("检测到中文乱码；本题结果已拒绝保存，请稍后重试。未写入正式监测。" );
    await wait(1000);
  }
}

function buildDoubaoAppCanaryRequest(questionText, model = DOUBAO_MODEL) {
  return JSON.stringify({
    model,
    store: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: questionText }] }],
    tools: [{ type: "doubao_app", feature: { ai_search: { type: "enabled" } } }],
    stream: true,
  });
}

function canaryCitations(payload) {
  const outputAndEvents = {
    output: [
      ...(payload?.output || []),
      ...((payload?.doubaoStreamEvents || []).map((event) => event.payload)),
    ],
  };
  return providerToolCitationCandidates(outputAndEvents);
}

function alignmentCanaryRecord(prompt, mode, payload, startedAt, brand) {
  const rawAnswer = rawAnswerFromResponse(payload);
  if (!rawAnswer) throw new Error(`Doubao ${mode} Canary 未返回可保存的文本回答`);
  const matchedBrandAliases = findMatchedBrandAliases(rawAnswer, brand);
  return {
    promptId: prompt.id,
    question: prompt.text,
    mode,
    model: payload.model || DOUBAO_MODEL,
    latencyMs: Date.now() - startedAt,
    responseId: payload.id || null,
    rawAnswer,
    citations: canaryCitations(payload),
    targetBrandMentioned: matchedBrandAliases.length > 0,
    matchedBrandAliases,
    diagnostics: payload.doubaoDiagnostics || null,
  };
}

async function runDoubaoAppAlignmentCanary(prompts) {
  const brand = store.brands[0];
  const comparisons = [];
  for (const prompt of prompts) {
    const appStartedAt = Date.now();
    const appPayload = await nativeNodeDoubaoRequest(
      buildDoubaoAppCanaryRequest(prompt.text),
      { headers: { "ark-beta-doubao-app": "true" }, stream: true },
    );
    const doubaoApp = alignmentCanaryRecord(prompt, "doubao_app", appPayload, appStartedAt, brand);

    const webStartedAt = Date.now();
    const webProbe = await callDoubaoApi(prompt, brand, { webSearch: true, maxAttempts: 1 });
    const webSearch = {
      promptId: prompt.id,
      question: prompt.text,
      mode: "web_search",
      model: webProbe.model || DOUBAO_MODEL,
      latencyMs: Date.now() - webStartedAt,
      responseId: webProbe.responseId || null,
      rawAnswer: webProbe.rawAnswer,
      citations: webProbe.citations || [],
      targetBrandMentioned: webProbe.brandMentioned,
      matchedBrandAliases: webProbe.matchedBrandAliases || [],
    };
    comparisons.push({ promptId: prompt.id, question: prompt.text, webSearch, doubaoApp });
  }
  return { model: DOUBAO_MODEL, comparisons };
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function audit(action, details = {}) {
  store.audit.unshift({ id: uid("audit"), action, details, at: now() });
  store.audit = store.audit.slice(0, 200);
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求体必须是 JSON"); }
}

function route(url, method) {
  return `${method} ${url.pathname}`;
}

function findRule(platform) {
  return store.rules.find((item) => item.platform === platform && item.active);
}

function findArticle(id) {
  return store.articles.find((item) => item.id === id);
}

function baselineReview(article, facts, rule) {
  const local = validateArticle(article, rule, facts, store.articles);
  const moderation = { provider: "local_policy_guard", ...policyModeration(article) };
  return {
    provider: "codex_review_queue",
    pass: local.pass && !moderation.flagged,
    issues: [...local.issues, ...(moderation.flagged ? ["安全审核未通过"] : [])],
    checks: { evidence: local.issues.filter((issue) => issue.includes("资料") || issue.includes("事实")).length === 0, platformRules: local.issues.filter((issue) => !issue.includes("资料") && !issue.includes("事实")).length === 0, moderation: !moderation.flagged },
    moderation,
  };
}

function createCodexTask(type, payload) {
  const task = { id: uid("codex"), type, status: "queued", createdAt: now(), ...payload };
  store.codexTasks ||= [];
  store.codexTasks.unshift(task);
  return task;
}

function articleFromOutput(topic, platform, facts, rule, output, mode) {
  return {
    id: uid("article"), topicId: topic.id, brandId: topic.brandId, platform, ruleId: rule.id, ruleVersion: rule.version,
    title: output.title, summary: output.summary, body: output.body,
    citationFactIds: facts.map((item) => item.id),
    assets: { cover: facts.find((item) => item.assets?.cover)?.assets.cover || "", images: facts.flatMap((item) => item.assets?.images || []) },
    prohibited: topic.prohibited || [], writer: mode, generationProvider: output.provider, revisionCount: 0,
    status: "draft", createdAt: now(), updatedAt: now(), reviews: [],
  };
}

function latestSuccessfulRunsByPrompt(runs) {
  const latestByPrompt = new Map();
  for (const run of runs) {
    if (run.status !== "success" || !run.promptId) continue;
    const previous = latestByPrompt.get(run.promptId);
    if (!previous || Date.parse(run.createdAt || 0) > Date.parse(previous.createdAt || 0)) latestByPrompt.set(run.promptId, run);
  }
  return [...latestByPrompt.values()];
}

const chinaDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
function monitorDateKey(value) {
  const parts = chinaDateFormatter.formatToParts(new Date(value || 0));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return values.year ? `${values.year}-${values.month}-${values.day}` : "未记录日期";
}

const AUTO_PROMPT_REPLACEMENT_THRESHOLD = 2;
function normalizeDoubaoWorkerConcurrency(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(5, Math.max(1, Math.trunc(numeric))) : DOUBAO_WORKER_CONCURRENCY;
}

function createBrowserMonitorExecutionPolicy(workerConcurrency = DOUBAO_WORKER_CONCURRENCY) {
  const platform = arguments[1] || "doubao_web";
  if (platform === "deepseek_web") {
    const workers = Math.min(5, Math.max(1, Math.trunc(Number(workerConcurrency) || DEEPSEEK_WORKER_CONCURRENCY)));
    return Object.freeze({
      version: "deepseek_web_fixed_worker_pool_v1", provider: "deepseek_web", adapterVersion: "deepseek-web-adapter-v1",
      profileKey: "deepseek_web", browser: "playwright_chromium", trigger: "user_explicit_start_or_continue_only",
      questionSource: "latest_active_dongguan_local_30", browserProfile: "data/deepseek-profile", browserContexts: 1,
      browserWindows: 1, browserPages: workers, workerTabs: workers, parallelWorkers: workers, workerConcurrency: workers,
      reuseExistingWindows: true, createNewWindows: false,
      conversationLifecycle: "new_conversation_confirm_then_mode_prepare_and_real_aria_pressed_verify_before_every_question",
      scheduling: "shared_web_platform_runner_fixed_worker_pool_dynamic_next_available_page",
      answerCompletion: "assistant_node_nonempty_and_text_stable_plus_streaming_end_stop_absent_input_ready",
      maxQuestionRetries: MAX_QUESTION_RETRIES, retryRecoveryCooldownMs: DOUBAO_RETRY_RECOVERY_COOLDOWN,
      onChallengeOrLoginIssue: "pause_and_request_user_assistance", onUnresolvedException: "record_as_test_exception_not_invalid",
      persistEvidence: "every_completed_or_exceptional_question_to_date_monitoring_and_audit",
    });
  }
  const workers = normalizeDoubaoWorkerConcurrency(workerConcurrency);
  return Object.freeze({
  version: "doubao_web_fixed_worker_pool_v6",
  provider: "doubao_web",
  browser: "playwright_chromium",
  trigger: "user_explicit_start_or_continue_only",
  questionSource: "latest_active_dongguan_local_30",
  browserProfile: "data/doubao-profile",
  browserContexts: 1,
  browserWindows: 1,
  browserPages: workers,
  workerTabs: workers,
  parallelWorkers: workers,
  workerConcurrency: workers,
  reuseExistingWindows: false,
  createNewWindows: false,
  conversationLifecycle: "click_new_conversation_and_confirm_empty_before_every_question",
  scheduling: "fixed_worker_pool_dynamic_next_available_page_with_complete_answer_verification",
  answerCompletion: "assistant_node_nonempty_and_text_stable_plus_streaming_end_stop_absent_input_ready",
  answerStartTimeoutMs: ANSWER_START_TIMEOUT,
  answerCompleteTimeoutMs: ANSWER_COMPLETE_TIMEOUT,
  answerStableWindowMs: ANSWER_STABLE_WINDOW,
  maxQuestionRetries: MAX_QUESTION_RETRIES,
  composerTypingDelayMs: DOUBAO_TYPING_DELAY,
  retryRecoveryCooldownMs: DOUBAO_RETRY_RECOVERY_COOLDOWN,
  timeoutRecovery: "recover_or_replace_only_the_failed_worker_page_then_retry_in_fresh_conversation",
  onChallengeOrLoginIssue: "pause_and_request_user_assistance",
  onUnresolvedException: "record_as_test_exception_not_invalid",
  invalidAnswerThreshold: "at_least_two_separately_listed_companies_with_individual_explanations",
  persistEvidence: "every_completed_or_exceptional_question_to_date_monitoring_and_audit",
  });
}

const BROWSER_MONITOR_EXECUTION_POLICY = createBrowserMonitorExecutionPolicy();

function selectBrowserBenchmarkPrompts(prompts, requestedSize = 10) {
  const size = Math.min(30, Math.max(1, Math.trunc(Number(requestedSize) || 10)));
  const buckets = new Map();
  for (const prompt of prompts) {
    const key = prompt.region || "all";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(prompt);
  }
  const selected = [];
  while (selected.length < size) {
    let added = false;
    for (const bucket of buckets.values()) {
      const prompt = bucket.shift();
      if (!prompt) continue;
      selected.push(prompt);
      added = true;
      if (selected.length === size) break;
    }
    if (!added) break;
  }
  return selected;
}

function nextRecommendationQuestionText(questionText) {
  const base = String(questionText || "")
    .replace(/[？?。.!！]+$/u, "")
    .replace(/推荐[：:].*$/u, "")
    .replace(/(?:推荐怎么选|怎么选|有哪些|哪家好|找哪家|如何找|如何选)$/u, "")
    .trim()
    .replace(/[：:]+$/u, "");
  const subject = base || "毛绒玩具定制工厂";
  return `${subject}推荐：请列出至少 2 家具体工厂，并分别说明其主营能力、适合订单与核心优势。`;
}

function replaceBrowserMonitoringPrompt(prompt, { questionText, reason, failureStreak = null }) {
  const previousText = prompt.text;
  const previousVersion = Number(prompt.monitoringVersion || 1);
  const replacedAt = now();
  prompt.replacementHistory ||= [];
  prompt.replacementHistory.unshift({
    questionText: previousText,
    monitoringVersion: previousVersion,
    replacedAt,
    reason,
    failureStreak,
  });
  prompt.text = String(questionText || nextRecommendationQuestionText(previousText)).trim();
  prompt.monitoringVersion = previousVersion + 1;
  prompt.lastReplacedAt = replacedAt;
  prompt.updatedAt = replacedAt;
  return { previousText, questionText: prompt.text, previousVersion, monitoringVersion: prompt.monitoringVersion, replacedAt };
}

function consecutiveInvalidBrowserAnswerCount(prompt) {
  const currentVersion = Number(prompt.monitoringVersion || 1);
  const history = store.probeRuns
    .filter((run) => run.source === "browser_observed" && effectivePlatform(run) === "doubao_web" && run.status === "success" && run.promptId === prompt.id)
    .filter((run) => Number(run.promptVersion || 1) === currentVersion)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  let count = 0;
  for (const run of history) {
    if (run.hasValidCompanyAnswer !== false) break;
    count += 1;
  }
  return count;
}

function withEffectivePlatform(record) {
  return {
    ...record,
    platform: effectivePlatform(record),
    platformMode: effectivePlatformMode(record),
  };
}

function summarizeBrowserDate(runs, localPrompts) {
  const promptIds = new Set(localPrompts.map((prompt) => prompt.id));
  const latestByPrompt = new Map();
  const historyByPrompt = new Map(localPrompts.map((prompt) => [prompt.id, []]));
  for (const run of runs.filter((run) => promptIds.has(run.promptId))) {
    historyByPrompt.get(run.promptId).push(run);
    const previous = latestByPrompt.get(run.promptId);
    if (!previous || Date.parse(run.createdAt || 0) > Date.parse(previous.createdAt || 0)) latestByPrompt.set(run.promptId, run);
  }
  for (const history of historyByPrompt.values()) history.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const latestRuns = [...latestByPrompt.values()];
  const recordedTimes = runs
    .map((run) => Date.parse(run.createdAt || ""))
    .filter((value) => Number.isFinite(value));
  const monitoredStartedAt = recordedTimes.length ? new Date(Math.min(...recordedTimes)).toISOString() : null;
  const monitoredEndedAt = recordedTimes.length ? new Date(Math.max(...recordedTimes)).toISOString() : null;
  const validRuns = latestRuns.filter((run) => run.hasValidCompanyAnswer !== false);
  const invalidRuns = latestRuns.filter((run) => run.hasValidCompanyAnswer === false);
  const directRuns = validRuns.filter((run) => ["first", "top3"].includes(run.recommendation));
  const mentionedOnlyRuns = validRuns.filter((run) => run.brandMentioned && !["first", "top3"].includes(run.recommendation));
  const unmentionedRuns = validRuns.filter((run) => !run.brandMentioned);
  const rate = (numerator) => validRuns.length ? numerator / validRuns.length : null;
  return {
    testedCount: latestRuns.length,
    validCompletedCount: validRuns.length,
    invalidCompanyAnswerCount: invalidRuns.length,
    incompleteCount: Math.max(0, localPrompts.length - latestRuns.length),
    mentionCount: directRuns.length + mentionedOnlyRuns.length,
    directRecommendationCount: directRuns.length,
    mentionedOnlyCount: mentionedOnlyRuns.length,
    unmentionedCount: unmentionedRuns.length,
    mentionRate: rate(directRuns.length + mentionedOnlyRuns.length),
    priorityRecommendationRate: rate(directRuns.length),
    monitoredStartedAt,
    monitoredEndedAt,
    latestRuns: latestRuns.map(withEffectivePlatform),
    historyByPrompt: Object.fromEntries([...historyByPrompt.entries()].map(([promptId, history]) => [promptId, history.map(withEffectivePlatform)])),
    sourceSummary: buildCitationSourceSummary({ total: localPrompts.length, questions: runs.map((run) => ({
      promptId: run.promptId,
      status: run.status === "success" ? "success" : run.status,
      citations: run.browserCitations || run.citations || [],
      citationCaptureStatus: run.citationCaptureStatus,
      job: run.job,
    })) }, store.brands[0]),
  };
}

function summarizeBrowserWindow(runs, totalQuestions) {
  const validRuns = runs.filter((run) => run.hasValidCompanyAnswer !== false);
  const invalidRuns = runs.filter((run) => run.hasValidCompanyAnswer === false);
  const directRuns = validRuns.filter((run) => ["first", "top3"].includes(run.recommendation));
  const mentionedOnlyRuns = validRuns.filter((run) => run.brandMentioned && !["first", "top3"].includes(run.recommendation));
  const unmentionedRuns = validRuns.filter((run) => !run.brandMentioned);
  const rate = (numerator) => validRuns.length ? numerator / validRuns.length : null;
  return {
    testedCount: runs.length,
    validCompletedCount: validRuns.length,
    invalidCompanyAnswerCount: invalidRuns.length,
    incompleteCount: Math.max(0, totalQuestions - runs.length),
    mentionCount: directRuns.length + mentionedOnlyRuns.length,
    directRecommendationCount: directRuns.length,
    mentionedOnlyCount: mentionedOnlyRuns.length,
    unmentionedCount: unmentionedRuns.length,
    mentionRate: rate(directRuns.length + mentionedOnlyRuns.length),
    priorityRecommendationRate: rate(directRuns.length),
    latestRuns: runs,
  };
}

function browserMonitoringSummary(summary) {
  // The overview only needs aggregate GEO results. Keeping every raw answer
  // here made the initial page response tens of megabytes and prevented the
  // UI from becoming usable. Raw answers remain stored and are fetched only
  // when the operator opens one monitoring batch.
  const { latestRuns, historyByPrompt, ...aggregate } = summary;
  return aggregate;
}

function browserMonitoringDashboard(localPrompts, { includeEvidence = true } = {}) {
  const localIds = new Set(localPrompts.map((prompt) => prompt.id));
  const browserRuns = store.probeRuns.filter((run) => run.source === "browser_observed" && effectivePlatform(run) === "doubao_web" && run.status === "success" && localIds.has(run.promptId));
  // Each 30-question browser monitor run is one independently auditable
  // monitoring batch. Do not merge two batches just because they happened on
  // the same calendar day: users need to see both result cards and their
  // separate time ranges.
  const byMonitorRun = new Map();
  for (const run of browserRuns) {
    // Older manually recorded evidence predates browserMonitorRunId. Keep it
    // grouped by date so historical records remain available without making
    // unrelated legacy days look like one batch.
    const key = run.browserMonitorRunId || `legacy:${monitorDateKey(run.createdAt)}`;
    if (!byMonitorRun.has(key)) byMonitorRun.set(key, []);
    byMonitorRun.get(key).push(run);
  }
  const dates = [...byMonitorRun.entries()]
    .map(([monitorRunId, runs]) => {
      const summary = summarizeBrowserDate(runs, localPrompts);
      const monitorRun = monitorRunId.startsWith("legacy:") ? null : store.browserMonitorRuns.find((item) => item.id === monitorRunId);
      return {
        monitorRunId: monitorRunId.startsWith("legacy:") ? null : monitorRunId,
        questionSet: monitorRun?.questionSet || localPrompts[0]?.questionSet || null,
        questionSetId: monitorRun?.questionSetId || localPrompts[0]?.questionSetId || null,
        questionSetName: monitorRun?.questionSetName || localQuestionBankName(monitorRun?.questionSet || localPrompts[0]?.questionSet),
        date: monitorDateKey(summary.monitoredStartedAt || runs[0]?.createdAt),
        ...summary,
      };
    })
    .sort((a, b) => Date.parse(b.monitoredEndedAt || 0) - Date.parse(a.monitoredEndedAt || 0));
  // A partial ad-hoc check must not replace the formal 30-question baseline.
  // Prefer the most recent date that contains the complete active question set.
  const latest = dates.find((group) => group.testedCount >= localPrompts.length) || dates[0] || summarizeBrowserDate([], localPrompts);
  const sevenDayCutoff = new Date();
  sevenDayCutoff.setDate(sevenDayCutoff.getDate() - 6);
  sevenDayCutoff.setHours(0, 0, 0, 0);
  const recentRuns = browserRuns.filter((run) => new Date(run.createdAt) >= sevenDayCutoff);
  // A seven-day overview keeps every test as a sample. A repeat on a different
  // date is intentionally not collapsed into the newer result.
  const recentGroupCount = dates.filter((group) => new Date(`${group.date}T00:00:00`) >= sevenDayCutoff).length;
  const recent = summarizeBrowserWindow(recentRuns, localPrompts.length * Math.max(1, recentGroupCount));
  const promptById = new Map(localPrompts.map((prompt) => [prompt.id, prompt]));
  const intentWeight = new Map();
  for (const run of recent.latestRuns) {
    const prompt = promptById.get(run.promptId);
    if (!prompt || run.hasValidCompanyAnswer === false || run.brandMentioned) continue;
    const key = prompt.intent || "其他";
    intentWeight.set(key, (intentWeight.get(key) || 0) + Number(prompt.weight || 1));
  }
  const highPriorityGaps = [...intentWeight.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([intent, weight]) => ({ intent, weight }));
  const recentMentioned = recent.latestRuns.filter((run) => run.brandMentioned && run.hasValidCompanyAnswer !== false);
  const strengthSignals = {
    local: recentMentioned.filter((run) => /东莞|茶山/.test(promptById.get(run.promptId)?.text || "")).length,
    product: recentMentioned.filter((run) => /IP|胶脸|棉花娃|娃衣|挂件|文创|吉祥物/.test(promptById.get(run.promptId)?.text || "")).length,
    recommendation: recent.directRecommendationCount,
  };
  return {
    totalQuestions: localPrompts.length,
    latestDate: latest.date || null,
    overall: includeEvidence ? latest : browserMonitoringSummary(latest),
    dates: includeEvidence ? dates : dates.map(browserMonitoringSummary),
    recentSevenDays: {
      ...(includeEvidence ? recent : browserMonitoringSummary(recent)),
      dateCount: recentGroupCount,
      highPriorityGaps,
      strengthSignals,
    },
  };
}

function browserMonitorEvidenceGroup(runId, localPrompts) {
  const runs = store.probeRuns.filter((run) => run.source === "browser_observed" && effectivePlatform(run) === "doubao_web" && run.browserMonitorRunId === runId);
  const summary = summarizeBrowserDate(runs, localPrompts);
  const monitorRun = store.browserMonitorRuns.find((run) => run.id === runId);
  const geoDropDiagnostics = monitorRun?.geoDropDiagnostics || (monitorRun && browserMonitorRunIsComplete(monitorRun)
    ? buildGeoDropDiagnostics({ currentRun: monitorRun, historicalRuns: store.browserMonitorRuns || [], prompts: store.prompts || [], brand: store.brands[0], config: { baselineRuns: GEO_DIAGNOSTIC_BASELINE_RUNS, absoluteThreshold: GEO_DROP_ABSOLUTE_THRESHOLD, relativeThreshold: GEO_DROP_RELATIVE_THRESHOLD } })
    : null);
  return {
    monitorRunId: runId,
    platform: effectivePlatform(monitorRun),
    platformMode: effectivePlatformMode(monitorRun),
    date: monitorDateKey(summary.monitoredStartedAt || runs[0]?.createdAt),
    ...summary,
    sourceSummary: monitorRun?.sourceSummary || summary.sourceSummary,
    observability: monitorRun?.observability || (monitorRun && browserMonitorRunIsComplete(monitorRun) ? buildObservabilityQuality(monitorRun) : null),
    geoDropDiagnostics,
  };
}

async function archivedBrowserMonitorEvidenceGroup(runId, localPrompts) {
  const archives = await archivedMonitorStores();
  for (const { data } of archives) {
    const monitorRun = (data.browserMonitorRuns || []).find((run) => run.id === runId);
    if (!monitorRun) continue;
    const runs = (data.probeRuns || []).filter((run) => run.source === "browser_observed" && effectivePlatform(run) === "doubao_web" && run.browserMonitorRunId === runId);
    const summary = summarizeBrowserDate(runs, localPrompts);
    return {
      monitorRunId: runId,
      platform: effectivePlatform(monitorRun),
      platformMode: effectivePlatformMode(monitorRun),
      archive: true,
      date: monitorDateKey(summary.monitoredStartedAt || runs[0]?.createdAt),
      ...summary,
      sourceSummary: monitorRun.sourceSummary || summary.sourceSummary,
      observability: monitorRun.observability || (browserMonitorRunIsComplete(monitorRun) ? buildObservabilityQuality(monitorRun) : null),
      geoDropDiagnostics: monitorRun.geoDropDiagnostics || null,
    };
  }
  return null;
}

function dashboardStabilitySummary(stability) {
  if (!stability) return stability;
  return {
    ...stability,
    // Stability cards need their calculated rates, never the full answer text.
    groups: (stability.groups || []).map(({ runs, ...group }) => group),
  };
}

function dashboardScoreSummary(score) {
  return { ...score, stability: dashboardStabilitySummary(score?.stability) };
}

function dashboard() {
  const brand = store.brands[0];
  const prompts = new Map(store.prompts.map((item) => [item.id, item]));
  // The overview represents the current result for each question. Older
  // attempts remain stored for the stability/history views, but must not
  // inflate the current 30-question denominator.
  const browserRuns = latestSuccessfulRunsByPrompt(store.probeRuns.filter((run) => run.source === "browser_observed" && effectivePlatform(run) === "doubao_web"));
  const apiRuns = latestSuccessfulRunsByPrompt(store.probeRuns.filter((run) => run.source === "doubao_api"));
  const score = calculateScore(browserRuns, prompts);
  const apiScore = calculateScore(apiRuns, prompts);
  const evidenceMetrics = calculateEvidenceMetrics(browserRuns, prompts);
  const apiEvidenceMetrics = calculateEvidenceMetrics(apiRuns, prompts);
  const selectedQuestionSet = selectedLocalQuestionSet();
  const localPrompts = localQuestionBankPrompts(selectedQuestionSet);
  const originalPrompts = localQuestionBankPrompts("dongguan_local");
  const localPromptMap = new Map(localPrompts.map((prompt) => [prompt.id, prompt]));
  const browserMonitoring = browserMonitoringDashboard(localPrompts, { includeEvidence: false });
  const localRuns = apiRuns.filter((run) => localPromptMap.has(run.promptId));
  const localEvidenceMetrics = calculateEvidenceMetrics(localRuns, localPromptMap);
  const localScore = calculateLocalVisibilityScore(localRuns, localPromptMap);
  const localStability = groupStability(localRuns, localPromptMap);
  const competitorFrequency = new Map();
  for (const run of localRuns) for (const name of run.competitorCandidates || []) competitorFrequency.set(name, (competitorFrequency.get(name) || 0) + 1);
  const pendingCompetitors = [...competitorFrequency.entries()]
    .filter(([, occurrences]) => occurrences >= 2)
    .map(([name, occurrences]) => ({ name, occurrences, status: "pending_confirmation" }))
    .sort((a, b) => b.occurrences - a.occurrences);
  // Keep the dashboard payload light. Detailed, immutable raw answers remain
  // available through the monitoring-batch evidence endpoint.
  const latestRuns = store.probeRuns.filter((run) => run.reportable !== false).slice(0, 8).map((run) => ({
    ...withEffectivePlatform(run),
    rawAnswer: String(run.rawAnswer || "").slice(0, 500),
    rawAnswerTruncated: String(run.rawAnswer || "").length > 500,
  }));
  return {
    brand, score: dashboardScoreSummary(score), apiScore: dashboardScoreSummary(apiScore), evidenceMetrics, apiEvidenceMetrics, citationPolicy: store.citationPolicy, surfaces: SURFACES, platforms: PLATFORMS,
    localMonitoring: {
      config: {
        ...store.localMonitoringConfig,
        selectedQuestionSet,
        questionBanks: localQuestionBankCatalog(),
        regionPromptCounts: originalPrompts.reduce((counts, prompt) => ({ ...counts, [prompt.region]: (counts[prompt.region] || 0) + 1 }), {}),
      },
      prompts: localPrompts,
      score: localScore,
      evidenceMetrics: localEvidenceMetrics,
      stability: dashboardStabilitySummary(localStability),
      pendingCompetitors,
      runCount: localRuns.length,
    },
    browserMonitoring,
    counts: { prompts: store.prompts.length, approvedKnowledge: store.knowledge.filter((item) => item.status === "approved").length, articles: store.articles.length, scheduled: store.publicationJobs.filter((job) => job.status === "scheduled").length, exceptions: store.articles.filter((item) => item.status === "exception").length, codexTasks: (store.codexTasks || []).filter((item) => item.status === "queued").length },
    latestRuns, agent: store.agents[0] || null,
  };
}

function browserMonitorError(message, httpStatus = 409) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  return error;
}

function durationBetween(from, to) {
  const milliseconds = Date.parse(to || "") - Date.parse(from || "");
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function normalizeBrowserQuestionJob(run, question) {
  const status = question.status === "success" ? "completed"
    : question.status === "invalid" ? "invalid"
    : question.status === "failed" || question.status === "aborted" ? "failed"
      : question.status === "retrying" ? "retrying"
        : question.status === "running" ? "running" : "queued";
  const original = JSON.stringify(question.job || null);
  const terminalWorkerId = ["success", "failed", "invalid"].includes(question.status) ? "doubao-worker-1" : null;
  const workerId = question.job?.worker_id ?? question.workerId ?? terminalWorkerId;
  question.job ||= {};
  question.workerId ||= workerId;
  question.question ||= question.questionText;
  question.citations ||= Array.isArray(question.job.citations) ? question.job.citations : [];
  question.browserCitations ||= question.citations;
  question.citationCaptureStatus ||= question.job.citation_capture_status || "not_available";
  // V2 fields are future-answer evidence only.  Do not add null/default V2
  // fields while reconciling legacy queued work: that would rewrite audit
  // history merely because the service starts.
  const isV2Capture = question.citationCaptureVersion === "v2" || question.job.citation_capture_version === "v2";
  if (isV2Capture) {
    question.citationCaptureVersion = "v2";
    question.citationLegacyStatus ??= question.job.citation_legacy_status || null;
    question.citationCount ??= question.job.citation_count ?? question.browserCitations.length;
    question.citationCheckedChannels ??= question.job.citation_checked_channels || [];
  }
  // Preserve legacy records exactly as stored. `citationStatus` was introduced
  // with the V2 answer-time path, so adding a null value during startup is a
  // history mutation even when no answer or citation changed.
  const hasCitationStatus = Object.hasOwn(question, "citationStatus") || Object.hasOwn(question.job, "citation_status");
  if (hasCitationStatus) question.citationStatus ??= question.job.citation_status || null;
  question.citationCaptureError ||= question.job.citation_capture_error || null;
  question.citationCapture ||= question.job.citation_capture || null;
  if (isV2Capture) question.citationCaptureV2 ||= question.job.citation_capture_v2 || null;
  question.citationVisibilityMismatch ??= question.job.citation_visibility_mismatch ?? null;
  const v2JobFields = isV2Capture ? {
    citation_capture_version: "v2",
    citation_legacy_status: question.job.citation_legacy_status || question.citationLegacyStatus || null,
    citation_count: question.job.citation_count ?? question.citationCount ?? 0,
    citation_checked_channels: question.job.citation_checked_channels || question.citationCheckedChannels || [],
    citation_capture_v2: question.job.citation_capture_v2 ?? question.citationCaptureV2 ?? null,
  } : {};
  const citationStatusJobFields = hasCitationStatus ? {
    citation_status: question.job.citation_status || question.citationStatus || null,
  } : {};
  Object.assign(question.job, {
    run_id: question.job.run_id || run.id,
    question_id: question.job.question_id || question.promptId,
    worker_id: workerId,
    attempt: Number(question.job.attempt ?? question.attemptCount ?? 0),
    status: question.job.status || status,
    question: question.job.question || question.questionText,
    raw_answer: question.job.raw_answer ?? question.rawAnswer ?? null,
    citations: Array.isArray(question.job.citations) ? question.job.citations : [],
    citation_capture_status: question.job.citation_capture_status || question.citationCaptureStatus || "not_available",
    citation_capture_error: question.job.citation_capture_error || question.citationCaptureError || null,
    citation_capture: question.job.citation_capture || question.citationCapture || null,
    citation_visibility_mismatch: question.job.citation_visibility_mismatch ?? question.citationVisibilityMismatch ?? null,
    started_at: question.job.started_at ?? question.startedAt ?? null,
    completed_at: question.job.completed_at ?? question.completedAt ?? null,
    duration_ms: question.job.duration_ms ?? question.latencyMs ?? null,
    error_code: question.job.error_code ?? question.exceptionType ?? question.lastErrorCode ?? null,
    error_message: question.job.error_message ?? question.errorMessage ?? question.lastErrorMessage ?? null,
    lock_id: question.job.lock_id ?? null,
    locked_at: question.job.locked_at ?? null,
  }, citationStatusJobFields, v2JobFields);
  return JSON.stringify(question.job) !== original;
}

function normalizeBrowserQuestionTimingFromLatestAttempt(question) {
  const log = Array.isArray(question.executionLog) ? question.executionLog : [];
  let startIndex = -1;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index]?.stage === "STARTED") { startIndex = index; break; }
  }
  if (startIndex < 0) return;
  const latest = log.slice(startIndex);
  const timestamp = (stage) => latest.find((item) => item?.stage === stage)?.at || null;
  const startedAt = timestamp("STARTED");
  const pageReadyAt = timestamp("PAGE_READY");
  const newChatStartedAt = timestamp("NEW_CHAT_REQUESTED");
  const newChatReadyAt = timestamp("NEW_CHAT_CONFIRMED");
  const promptSubmittedAt = timestamp("PROMPT_SUBMITTED");
  const answerStartedAt = timestamp("ANSWER_STARTED");
  const generationEndedAt = timestamp("GENERATION_ENDED");
  const answerCompletedAt = timestamp("ANSWER_COMPLETE");
  const savedAt = timestamp("SAVED") || timestamp("FAILED");
  if (!startedAt || !savedAt) return;
  Object.assign(question, {
    startedAt, pageReadyAt, newChatStartedAt, newChatReadyAt, promptSubmittedAt,
    answerStartedAt, generationEndedAt, answerCompletedAt, savedAt, completedAt: savedAt,
    latencyMs: durationBetween(startedAt, savedAt),
    stageDurationsMs: {
      queueMs: durationBetween(question.activeAttemptQueuedAt || question.queuedAt, startedAt),
      pageLoadMs: durationBetween(startedAt, pageReadyAt),
      newChatMs: durationBetween(newChatStartedAt, newChatReadyAt),
      submitMs: durationBetween(newChatReadyAt, promptSubmittedAt),
      ttftMs: durationBetween(promptSubmittedAt, answerStartedAt),
      answerGenerationMs: durationBetween(answerStartedAt, answerCompletedAt),
      modelGenerationMs: durationBetween(answerStartedAt, generationEndedAt),
      completionVerificationMs: durationBetween(generationEndedAt, answerCompletedAt),
      saveMs: durationBetween(answerCompletedAt, savedAt),
      totalMs: durationBetween(startedAt, savedAt),
    },
  });
}

async function claimBrowserMonitorQuestion(run, worker = null) {
  const question = claimNextBrowserQuestion(run, worker);
  if (!question) return null;
  question.browserStage = "starting";
  audit("browser_monitor_question.claimed", { monitorRunId: run.id, promptId: question.promptId, workerId: question.workerId, pageIndex: question.pageIndex, lockId: question.job?.lock_id || null, attemptCount: question.attemptCount, execution: "playwright_worker_pool" });
  await persist();
  publishBrowserMonitorProgress(run);
  return question;
}

async function markBrowserMonitorQuestionWorker(question, worker = null) {
  if (question.status !== "running") return;
  question.workerId = worker?.workerId || null;
  question.pageIndex = Number(worker?.pageIndex || 0) || null;
  question.job ||= {};
  question.job.worker_id = question.workerId;
  question.executionLog ||= [];
  question.executionLog.push({ stage: "WORKER_CLAIMED", at: now(), worker: question.workerId ? { workerId: question.workerId, pageIndex: question.pageIndex } : null });
  await persist();
}

async function cancelBrowserMonitorQuestionClaim(run, question, worker = null) {
  if (question.status !== "running") return;
  question.status = "queued";
  question.browserStage = "paused_before_worker_start";
  question.job ||= {};
  Object.assign(question.job, { status: "queued", worker_id: worker?.workerId || question.workerId || null, lock_id: null, locked_at: null });
  question.executionLog ||= [];
  question.executionLog.push({ stage: "WORKER_CLAIM_CANCELLED", at: now(), worker });
  await persist();
  publishBrowserMonitorProgress(run);
}

async function retryBrowserMonitorQuestion(run, question, error, details = {}) {
  if (question.status !== "running") return;
  const retryAt = now();
  question.attemptHistory ||= [];
  question.attemptHistory.push({ attempt: question.attemptCount, workerId: question.workerId || null, failedAt: retryAt, errorCode: error.code || "doubao_web_execution_error", errorMessage: String(error.message || error).slice(0, 300), debugArtifact: details.debugArtifact || null });
  if (details.debugArtifact) {
    question.debugArtifacts ||= [];
    question.debugArtifacts.push({ attempt: question.attemptCount, capturedAt: retryAt, ...details.debugArtifact });
  }
  question.attemptCount += 1;
  question.browserStage = "retrying_after_recovery";
  question.activeAttemptQueuedAt = retryAt;
  question.lastErrorCode = error.code || "doubao_web_execution_error";
  question.lastErrorMessage = String(error.message || error).slice(0, 300);
  question.startedAt = retryAt;
  question.newChatStartedAt = null;
  question.newChatReadyAt = null;
  question.pageReadyAt = null;
  question.promptSubmittedAt = null;
  question.answerStartedAt = null;
  question.generationEndedAt = null;
  question.answerCompletedAt = null;
  question.savedAt = null;
  question.completedAt = null;
  question.latencyMs = null;
  question.stageDurationsMs = null;
  question.job ||= {};
  Object.assign(question.job, {
    status: "retrying",
    attempt: question.attemptCount,
    worker_id: details.worker?.workerId || question.workerId || null,
    error_code: question.lastErrorCode,
    error_message: question.lastErrorMessage,
    started_at: retryAt,
  });
  question.executionLog ||= [];
  question.executionLog.push({ stage: "RETRYING_AFTER_RECOVERY", at: retryAt, errorCode: question.lastErrorCode });
  if (details.conversation?.sessionUuid) {
    question.conversationHistory ||= [];
    question.conversationHistory.push({ ...details.conversation, outcome: "retry_failed", recordedAt: now() });
  }
  audit("browser_monitor_question.retrying", {
    monitorRunId: run.id,
    promptId: question.promptId,
    retry: details.retry || 1,
    maxQuestionRetries: details.maxQuestionRetries || 0,
    error: question.lastErrorMessage,
  });
  await persist();
  publishBrowserMonitorProgress(run);
}

async function markBrowserMonitorQuestionStage(run, question, stage, conversation = null, worker = null) {
  if (question.status !== "running") return;
  const normalizedStage = String(stage || "running").toUpperCase();
  const at = now();
  question.browserStage = normalizedStage.toLowerCase();
  const timestampField = {
    PAGE_READY: "pageReadyAt",
    NEW_CHAT_REQUESTED: "newChatStartedAt",
    NEW_CHAT_CONFIRMED: "newChatReadyAt",
    PROMPT_SUBMITTED: "promptSubmittedAt",
    ANSWER_STARTED: "answerStartedAt",
    GENERATION_ENDED: "generationEndedAt",
    ANSWER_COMPLETE: "answerCompletedAt",
  }[normalizedStage];
  if (timestampField) question[timestampField] ||= at;
  question.executionLog ||= [];
  question.executionLog.push({ stage: normalizedStage, at, worker: worker?.workerId ? { workerId: worker.workerId, pageIndex: worker.pageIndex || null } : null, conversation: conversation?.sessionUuid ? { sessionUuid: conversation.sessionUuid, conversationId: conversation.conversationId || null } : null });
  if (worker?.workerId) {
    question.workerId = worker.workerId;
    question.pageIndex = Number(worker.pageIndex || 0) || null;
  }
  if (conversation?.sessionUuid) {
    question.sessionUuid = conversation.sessionUuid;
    question.conversationId = conversation.conversationId || null;
  }
  if (normalizedStage === "PROMPT_SUBMITTED" && conversation?.promptIntegrity?.status === "verified") {
    question.promptIntegrity = conversation.promptIntegrity;
    question.job ||= {};
    question.job.prompt_integrity = conversation.promptIntegrity;
  }
  // Live stage updates are intentionally sent without a full-store disk
  // write. Completed/retried/failed records are persisted; this keeps normal
  // questions fast while the UI still shows the current Worker state.
  publishBrowserMonitorProgress(run);
}

async function pauseBrowserMonitorRun(run, question, reason, { stage = "paused_login", debugArtifact = null } = {}) {
  const pausedAt = now();
  if (question) {
    question.status = "queued";
    question.browserStage = stage;
    question.errorMessage = String(reason).slice(0, 300);
    question.job ||= {};
    Object.assign(question.job, { status: "queued", error_code: stage, error_message: question.errorMessage, lock_id: null, locked_at: null });
    if (debugArtifact) {
      question.debugScreenshot = debugArtifact.screenshotPath || null;
      question.debugArtifact = debugArtifact;
    }
    question.executionLog ||= [];
    question.executionLog.push({ stage: String(stage).toUpperCase(), at: pausedAt, reason: question.errorMessage });
  }
  run.status = "paused";
  run.pausedReason = String(reason).slice(0, 300);
  if (!question) {
    run.runErrors ||= [];
    run.runErrors.push({ at: pausedAt, code: stage, message: run.pausedReason });
  }
  run.updatedAt = pausedAt;
  audit("browser_monitor_run.paused", { monitorRunId: run.id, promptId: question?.promptId || null, reason: run.pausedReason });
  await persist();
  publishBrowserMonitorProgress(run, "paused");
  return browserMonitorRunResponse(run);
}

async function requireBrowserMonitorHumanAction(run, question, error, debugArtifact = null, worker = null) {
  const requestedAt = now();
  const type = error?.humanActionType || error?.blocking?.state || error?.code || "needs_human_action";
  const message = String(error?.message || "豆包页面需要人工完成验证").slice(0, 300);
  const questionId = question?.promptId || null;
  const workerId = worker?.workerId || question?.workerId || null;
  const pageId = worker?.pageId || question?.pageId || null;
  const runtimeWorker = workerId ? doubaoBrowserManager.getWorker(workerId) : null;
  const hasLiveBinding = Boolean(
    run?.id && questionId && workerId && pageId && type && requestedAt
    && runtimeWorker?.page && !runtimeWorker.page.isClosed?.()
    && runtimeWorker.pageId === pageId,
  );
  if (!hasLiveBinding) {
    // A Manager startup/login observation has no question or Worker Page
    // binding. Keep an audit trace, but never turn it into a user-facing
    // verification event, notification, or needs_verification question.
    run.verificationLog ||= [];
    run.verificationLog.push({
      verification_event_id: uid("verification_debug"), run_id: run.id, worker_id: workerId,
      page_id: pageId, question_id: questionId, verification_type: type,
      detected_at: requestedAt, resolved_at: null, verification_duration_ms: null,
      status: "unbound_blocking_state", source: "unbound_runtime_observation",
      server_instance_id: SERVER_INSTANCE_ID,
    });
    if (question?.status === "running") {
      question.status = "queued";
      question.browserStage = "unbound_blocking_state";
      question.job ||= {};
      Object.assign(question.job, { status: "queued", lock_id: null, locked_at: null, error_code: "unbound_blocking_state", error_message: message });
    }
    run.status = "paused";
    run.pausedReason = "检测到未绑定到当前 Worker/Page/题目的阻塞状态，已保留调试记录但未创建人工验证事件。";
    run.updatedAt = requestedAt;
    audit("browser_monitor.unbound_blocking_state", { monitorRunId: run.id, promptId: questionId, workerId, pageId, type });
    await persist();
    publishBrowserMonitorProgress(run, "paused");
    return browserMonitorRunResponse(run);
  }
  run.humanActions ||= [];
  // The same visible challenge can be detected again before it is solved.
  // Preserve its id so repeated progress events never create repeat alerts.
  const existingIndex = run.humanActions.findIndex((item) => item.active && item.status === "active" && item.questionId === questionId && item.workerId === workerId && item.pageId === pageId);
  const previousAction = existingIndex >= 0 ? run.humanActions[existingIndex] : null;
  const action = {
    verificationEventId: previousAction?.verificationEventId || uid("verification"),
    runId: run.id,
    active: true,
    status: "active",
    serverInstanceId: SERVER_INSTANCE_ID,
    type,
    verificationType: type,
    message,
    detectedAt: previousAction?.detectedAt || requestedAt,
    requestedAt: previousAction?.requestedAt || requestedAt,
    resolvedAt: null,
    questionId,
    questionNumber: question ? (run.questions || []).indexOf(question) + 1 : null,
    workerId,
    pageIndex: Number(worker?.pageIndex || question?.pageIndex || 0) || null,
    pageId,
    source: "runtime_worker",
    debugArtifact: debugArtifact || previousAction?.debugArtifact || null,
  };
  run.verificationLog ||= [];
  if (!run.verificationLog.some((event) => event.verification_event_id === action.verificationEventId)) {
    run.verificationLog.push({
      verification_event_id: action.verificationEventId,
      run_id: run.id,
      worker_id: workerId,
      page_id: pageId,
      question_id: questionId,
      verification_type: type,
      detected_at: action.detectedAt,
      resolved_at: null,
      verification_duration_ms: null,
      status: "active",
      source: "runtime_worker",
      server_instance_id: SERVER_INSTANCE_ID,
    });
  }
  if (question) {
    if (!previousAction) {
      question.attemptHistory ||= [];
      question.attemptHistory.push({
        attempt: question.attemptCount,
        workerId,
        startedAt: question.startedAt || null,
        interruptedAt: requestedAt,
        executionDurationMs: durationBetween(question.startedAt, requestedAt),
        outcome: "interrupted_by_verification",
        verificationEventId: action.verificationEventId,
        verificationType: type,
        conversation: error?.conversation || null,
      });
    }
    question.status = "needs_verification";
    question.pageId = pageId;
    question.browserStage = "needs_human_action";
    question.errorMessage = message;
    question.debugScreenshot = debugArtifact?.screenshotPath || null;
    question.debugArtifact = debugArtifact || null;
    question.job ||= {};
    Object.assign(question.job, {
      status: "needs_verification",
      worker_id: action.workerId,
      page_id: action.pageId,
      error_code: type,
      error_message: message,
      raw_answer: null,
      citations: [],
    });
    question.executionLog ||= [];
    question.executionLog.push({ stage: "NEEDS_HUMAN_ACTION", at: requestedAt, humanAction: action });
  }
  run.status = "needs_human_action";
  run.pausedReason = message;
  // A verification interruption makes any in-memory/provisional projection
  // non-final. The final summary is regenerated only after all jobs finish.
  run.visibilitySummary = null;
  if (existingIndex >= 0) run.humanActions[existingIndex] = action;
  else run.humanActions.push(action);
  run.humanAction = action;
  run.updatedAt = requestedAt;
  audit("browser_monitor_question.needs_human_action", { monitorRunId: run.id, promptId: action.questionId, workerId: action.workerId, type, message });
  await persist();
  publishBrowserMonitorProgress(run, "needs_human_action");
  return browserMonitorRunResponse(run);
}

async function resolveBrowserMonitorHumanAction(run, question, error, worker = null) {
  const resolvedAt = now();
  if (question?.status === "needs_verification") {
    // The old chat may contain a partial answer. Treat the verified retry as a
    // new attempt so its timings never include time spent awaiting a person.
    question.attemptCount += 1;
    question.status = "running";
    question.browserStage = "human_action_resolved";
    question.errorMessage = null;
    question.activeAttemptQueuedAt = resolvedAt;
    question.startedAt = resolvedAt;
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
    question.job ||= {};
    Object.assign(question.job, {
      status: "running",
      attempt: question.attemptCount,
      worker_id: worker?.workerId || question.workerId || null,
      started_at: resolvedAt,
      completed_at: null,
      duration_ms: null,
      error_code: null,
      error_message: null,
    });
    question.executionLog ||= [];
    question.executionLog.push({ stage: "HUMAN_ACTION_RESOLVED", at: resolvedAt, type: error?.humanActionType || error?.blocking?.state || error?.code || null });
  }
  run.humanActions ||= [];
  run.verificationLog ||= [];
  for (const action of run.humanActions) {
    if (action.active && action.status === "active" && action.questionId === question?.promptId && action.workerId === (worker?.workerId || question?.workerId || null) && action.pageId === (worker?.pageId || question?.pageId || null)) {
      action.active = false;
      action.status = "resolved";
      action.resolvedAt = resolvedAt;
      action.verificationDurationMs = durationBetween(action.detectedAt || action.requestedAt, resolvedAt) || 0;
      const event = run.verificationLog.find((item) => item.verification_event_id === action.verificationEventId);
      if (event) {
        event.resolved_at = resolvedAt;
        event.verification_duration_ms = action.verificationDurationMs;
        event.status = "resolved";
      }
    }
  }
  const nextHumanAction = activeVerificationEvents(run, { browserManager: doubaoBrowserManager, serverInstanceId: SERVER_INSTANCE_ID }).at(-1) || null;
  run.humanAction = nextHumanAction;
  if (run.status === "needs_human_action" && !nextHumanAction) {
    run.status = "running";
    run.pausedReason = null;
  }
  run.updatedAt = resolvedAt;
  audit("browser_monitor_question.human_action_resolved", { monitorRunId: run.id, promptId: question?.promptId || null, workerId: worker?.workerId || question?.workerId || null });
  await persist();
  publishBrowserMonitorProgress(run, "progress");
  return browserMonitorRunResponse(run);
}

async function focusBrowserMonitorVerificationPage(run, verificationEventId) {
  const action = (run.humanActions || []).find((item) => item.verificationEventId === verificationEventId);
  if (!action) return { focused: false, reason: "VERIFICATION_EVENT_NOT_FOUND", message: "该人工验证事件不存在。" };
  const validation = validateVerificationEvent({ run, action, browserManager: doubaoBrowserManager, serverInstanceId: SERVER_INSTANCE_ID });
  if (!validation.valid) {
    const status = validation.reasons.includes("server_instance_mismatch") ? "orphaned_after_restart"
      : validation.reasons.includes("binding_incomplete") ? "orphaned" : "stale";
    invalidateVerificationEvent(action, run.verificationLog || [], status, validation.reasons.join(","), now());
    reconcileVerificationEvents(run, { browserManager: doubaoBrowserManager, serverInstanceId: SERVER_INSTANCE_ID });
    await persist();
    publishBrowserMonitorProgress(run, "progress");
    return { focused: false, workerId: action.workerId || null, pageIndex: action.pageIndex || null, reason: "VERIFICATION_EVENT_STALE", message: "该人工验证事件已失效，当前没有对应的豆包测试页面。" };
  }
  const worker = validation.worker;
  try {
    // Playwright's supported tab-focus operation only selects the existing
    // worker Page in its Chromium window. It never synthesizes OS input,
    // refreshes the challenge, or touches another browser/profile.
    const focused = await doubaoBrowserManager.bringWorkerToFront(worker.workerId);
    if (!focused.focused) {
      return {
        focused: false,
        workerId: action.workerId,
        pageIndex: action.pageIndex,
        reason: focused.reason || "WORKER_PAGE_UNAVAILABLE",
        message: "该人工验证事件已失效，当前没有对应的豆包测试页面。",
      };
    }
    audit("browser_monitor_verification.page_focused", { monitorRunId: run.id, verificationEventId, workerId: action.workerId, pageIndex: action.pageIndex });
    return { focused: true, workerId: action.workerId, pageIndex: action.pageIndex, pageId: action.pageId };
  } catch (error) {
    return { focused: false, workerId: action.workerId, pageIndex: action.pageIndex, reason: "PAGE_FOCUS_UNAVAILABLE", message: String(error.message || error).slice(0, 200) };
  }
}

async function focusBrowserMonitorWorkerPage(run, workerId) {
  const pageIndex = Number(String(workerId).match(/(\d+)$/)?.[1]);
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 5) return { focused: false, workerId, pageIndex: null, reason: "INVALID_WORKER" };
  const worker = doubaoBrowserManager.getWorker(workerId);
  if (!worker?.page || worker.page.isClosed?.()) return { focused: false, workerId, pageIndex, reason: "WORKER_PAGE_UNAVAILABLE" };
  try {
    // This selects the already-open real Doubao Page only. It does not submit,
    // refresh, or otherwise interfere with the Worker and its current chat.
    const focused = await doubaoBrowserManager.bringWorkerToFront(workerId);
    audit("browser_monitor_worker.page_focused", { monitorRunId: run.id, workerId, pageIndex: worker.pageIndex || null });
    return { ...focused, workerId, pageIndex: worker.pageIndex || null };
  } catch (error) {
    return { focused: false, workerId, pageIndex: worker.pageIndex || null, reason: "PAGE_FOCUS_UNAVAILABLE", message: String(error.message || error).slice(0, 200) };
  }
}

async function previewBrowserMonitorWorkerPage(run, workerId) {
  const focused = await focusBrowserMonitorWorkerPage(run, workerId);
  if (!focused.focused) {
    const error = new Error(focused.message || "该 Worker 当前没有可查看的豆包页面");
    error.code = focused.reason || "WORKER_PAGE_UNAVAILABLE";
    throw error;
  }
  const worker = doubaoBrowserManager.getWorker(workerId);
  if (!worker?.page || worker.page.isClosed?.()) {
    const error = new Error("该 Worker 页面已关闭，无法生成预览");
    error.code = "WORKER_PAGE_UNAVAILABLE";
    throw error;
  }
  // This is a read-only diagnostic image of the existing real webpage.  It
  // neither types, submits, refreshes, nor changes the worker's conversation.
  const image = await worker.page.screenshot({ type: "png" });
  return { image, pageIndex: worker.pageIndex || focused.pageIndex || null };
}

// Read-only access for the Browser Connection Check workspace.  This route is
// intentionally independent from a monitor run so an operator can inspect
// the real headed Worker tabs before or after a test without creating a run,
// submitting a prompt, refreshing a page, or changing the conversation.
async function focusDoubaoBrowserWorker(workerId) {
  const pageIndex = Number(String(workerId).match(/(\d+)$/)?.[1]);
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 5) {
    return { focused: false, workerId, pageIndex: null, reason: "INVALID_WORKER" };
  }
  const worker = doubaoBrowserManager.getWorker(workerId);
  if (!worker?.page || worker.page.isClosed?.()) {
    return { focused: false, workerId, pageIndex, reason: "WORKER_PAGE_UNAVAILABLE" };
  }
  try {
    return { ...(await doubaoBrowserManager.bringWorkerToFront(workerId)), workerId, pageIndex: worker.pageIndex || pageIndex };
  } catch (error) {
    return { focused: false, workerId, pageIndex, reason: "PAGE_FOCUS_UNAVAILABLE", message: String(error.message || error).slice(0, 200) };
  }
}

async function previewDoubaoBrowserWorker(workerId) {
  // A preview poll must not steal focus from another Worker.  The explicit
  // “查看这个豆包页面” button calls the focus endpoint; image refreshes are
  // read-only screenshots of the existing Page.
  const pageIndex = Number(String(workerId).match(/(\d+)$/)?.[1]);
  const worker = doubaoBrowserManager.getWorker(workerId);
  if (!Number.isInteger(pageIndex) || !worker?.page || worker.page.isClosed?.()) {
    const error = new Error("该 Worker 当前没有可查看的豆包页面");
    error.code = "WORKER_PAGE_UNAVAILABLE";
    throw error;
  }
  const image = await worker.page.screenshot({ type: "png" });
  return { image, pageIndex: worker.pageIndex || pageIndex || null };
}

async function previewPlatformBrowserWorker(platform, workerId) {
  const runtime = getPlatformRuntime(platform);
  const worker = runtime.getWorker(workerId);
  if (!worker?.page || worker.page.isClosed?.()) {
    const error = new Error("该平台 Worker 页面当前不可用于预览");
    error.code = "WORKER_PAGE_UNAVAILABLE";
    throw error;
  }
  const image = await worker.page.screenshot({ type: "png" });
  return { image, pageIndex: worker.pageIndex || null };
}

async function abortBrowserMonitorRun(run, reason) {
  const abortedAt = now();
  // The runner checks this before every new browser action, and DeepSeek
  // answer waits are interruptible. Existing browser windows stay open.
  browserMonitorAbortControllers.get(run.id)?.abort();
  for (const question of run.questions.filter((item) => !["success", "failed", "invalid", "aborted"].includes(item.status))) {
    const wasInFlight = question.status === "running";
    question.status = "aborted";
    question.browserStage = wasInFlight ? "aborted" : "aborted_before_submission";
    question.completedAt = abortedAt;
    question.savedAt = abortedAt;
    question.job ||= {};
    Object.assign(question.job, { status: "aborted", completed_at: abortedAt, duration_ms: durationBetween(question.startedAt, abortedAt), error_code: "RUN_ABORTED", error_message: String(reason).slice(0, 300), lock_id: null, locked_at: null });
    question.executionLog ||= [];
    question.executionLog.push({ stage: wasInFlight ? "ABORTED" : "ABORTED_BEFORE_SUBMISSION", at: abortedAt, reason });
  }
  run.status = "aborted";
  run.abortedAt = abortedAt;
  run.pausedReason = String(reason).slice(0, 300);
  run.updatedAt = abortedAt;
  audit("browser_monitor_run.aborted", { monitorRunId: run.id, reason: run.pausedReason });
  await persist();
  publishBrowserMonitorProgress(run, "completed");
  return browserMonitorRunResponse(run);
}

async function deleteCompletedBrowserMonitorRun(runId) {
  const index = store.browserMonitorRuns.findIndex((run) => run.id === runId);
  if (index < 0) throw browserMonitorError("网页端监测任务不存在", 404);
  const run = store.browserMonitorRuns[index];
  if (!["completed", "completed_with_errors", "failed", "aborted"].includes(run.status)) {
    throw browserMonitorError("运行中的测试不能删除；请先停止或等待其完成", 409);
  }
  const deletedProbeCount = store.probeRuns.filter((item) => item.browserMonitorRunId === runId).length;
  store.browserMonitorRuns.splice(index, 1);
  store.probeRuns = store.probeRuns.filter((item) => item.browserMonitorRunId !== runId);
  audit("browser_monitor_run.deleted", { monitorRunId: runId, deletedProbeCount });
  await persist();
  return { runId, deletedProbeCount };
}

async function completeBrowserMonitorQuestion(run, input = {}) {
  const question = run.questions.find((item) => item.promptId === input.promptId && item.status === "running");
  if (!question) throw browserMonitorError("题目不是等待回传状态");
  const completedAt = now();
  question.completedAt = completedAt;
  question.savedAt = completedAt;
  question.latencyMs = Math.max(0, Date.parse(completedAt) - Date.parse(question.startedAt || completedAt));
  question.stageDurationsMs = {
    queueMs: durationBetween(question.activeAttemptQueuedAt || question.queuedAt, question.startedAt),
    pageLoadMs: durationBetween(question.startedAt, question.pageReadyAt),
    newChatMs: durationBetween(question.newChatStartedAt, question.newChatReadyAt),
    submitMs: durationBetween(question.newChatReadyAt, question.promptSubmittedAt),
    ttftMs: durationBetween(question.promptSubmittedAt, question.answerStartedAt),
    answerGenerationMs: durationBetween(question.answerStartedAt, question.answerCompletedAt),
    modelGenerationMs: durationBetween(question.answerStartedAt, question.generationEndedAt),
    completionVerificationMs: durationBetween(question.generationEndedAt, question.answerCompletedAt),
    saveMs: durationBetween(question.answerCompletedAt, question.savedAt),
    totalMs: durationBetween(question.startedAt, question.savedAt),
  };
  question.executionLog ||= [];
  question.executionLog.push({ stage: input.testException ? "FAILED" : "SAVED", at: completedAt, errorCode: input.testException || null });
  question.job ||= {};
  if (input.worker?.workerId) {
    question.workerId = input.worker.workerId;
    question.pageIndex = Number(input.worker.pageIndex || 0) || null;
  }
  if (input.browserConversation?.sessionUuid) {
    question.sessionUuid = input.browserConversation.sessionUuid;
    question.conversationId = input.browserConversation.conversationId || null;
    question.conversationHistory ||= [];
    question.conversationHistory.push({ ...input.browserConversation, outcome: input.testException ? "failed" : "success", recordedAt: completedAt });
  }
  const promptIntegrity = input.browserConversation?.promptIntegrity || question.promptIntegrity || null;
  if (promptIntegrity?.status === "verified") {
    question.promptIntegrity = promptIntegrity;
    question.job.prompt_integrity = promptIntegrity;
  }
  if (input.pausedReason) return pauseBrowserMonitorRun(run, question, input.pausedReason);
  if (input.testException) {
    question.status = "failed";
    question.browserStage = "exception";
    question.outcome = "test_exception";
    question.exceptionType = String(input.testException).slice(0, 80);
    question.errorMessage = String(input.errorMessage || input.testException).slice(0, 300);
    question.attemptHistory ||= [];
    question.attemptHistory.push({ attempt: question.attemptCount, outcome: "failed", failedAt: completedAt, errorCode: question.exceptionType, errorMessage: question.errorMessage, workerId: question.workerId || null, conversationId: question.conversationId || null, debugArtifact: input.debugArtifact || null });
    question.debugScreenshot = input.debugScreenshot || null;
    question.debugArtifact = input.debugArtifact || null;
    Object.assign(question.job, {
      status: "failed", raw_answer: null, citations: [], completed_at: completedAt,
      citation_capture_status: "not_available", citation_capture_error: null, citation_capture: null,
      citation_visibility_mismatch: null,
      duration_ms: question.latencyMs, error_code: question.exceptionType,
      error_message: question.errorMessage, lock_id: null, locked_at: null,
    });
    audit("browser_monitor_question.exception", {
      monitorRunId: run.id,
      promptId: question.promptId,
      exceptionType: question.exceptionType,
      error: question.errorMessage,
    });
    updateBrowserMonitorRunWithVisibilitySummary(run);
    await persist();
    publishBrowserMonitorProgress(run, run.status === "paused" ? "paused" : "progress");
    return browserMonitorRunResponse(run);
  }
  if (effectivePlatform(run) === "doubao_web" && promptIntegrity?.status !== "verified") {
    question.status = "failed";
    question.browserStage = "prompt_integrity_unverified";
    question.outcome = "test_exception";
    question.exceptionType = "DOUBAO_PROMPT_INTEGRITY_UNVERIFIED";
    question.errorMessage = "未取得发送前与发送后逐字一致证明，本题回答已拒绝保存。";
    question.attemptHistory ||= [];
    question.attemptHistory.push({ attempt: question.attemptCount, outcome: "failed", failedAt: completedAt, errorCode: question.exceptionType, errorMessage: question.errorMessage, workerId: question.workerId || null, conversationId: question.conversationId || null });
    Object.assign(question.job, {
      status: "failed", raw_answer: null, citations: [], completed_at: completedAt,
      prompt_integrity: promptIntegrity,
      citation_capture_status: "not_available", citation_capture_error: null, citation_capture: null,
      duration_ms: question.latencyMs, error_code: question.exceptionType,
      error_message: question.errorMessage, lock_id: null, locked_at: null,
    });
    question.executionLog[question.executionLog.length - 1] = { stage: "FAILED", at: completedAt, errorCode: question.exceptionType };
    audit("browser_monitor_question.prompt_integrity_rejected", { monitorRunId: run.id, promptId: question.promptId });
    updateBrowserMonitorRunWithVisibilitySummary(run);
    await persist();
    publishBrowserMonitorProgress(run, run.status === "paused" ? "paused" : "progress");
    return browserMonitorRunResponse(run);
  }
  if (!input.rawAnswer?.trim()) {
    question.status = "failed";
    question.browserStage = "exception";
    question.outcome = "test_exception";
    question.exceptionType = "unclassified_browser_error";
    question.errorMessage = String(input.errorMessage || "网页端未取得可保存回答").slice(0, 300);
    question.attemptHistory ||= [];
    question.attemptHistory.push({ attempt: question.attemptCount, outcome: "failed", failedAt: completedAt, errorCode: question.exceptionType, errorMessage: question.errorMessage, workerId: question.workerId || null, conversationId: question.conversationId || null });
    Object.assign(question.job, {
      status: "failed", raw_answer: null, citations: [], completed_at: completedAt,
      citation_capture_status: "not_available", citation_capture_error: null, citation_capture: null,
      duration_ms: question.latencyMs, error_code: question.exceptionType,
      error_message: question.errorMessage, lock_id: null, locked_at: null,
    });
    audit("browser_monitor_question.failed", { monitorRunId: run.id, promptId: question.promptId, error: question.errorMessage });
    updateBrowserMonitorRunWithVisibilitySummary(run);
    await persist();
    publishBrowserMonitorProgress(run, run.status === "paused" ? "paused" : "progress");
    return browserMonitorRunResponse(run);
  }

  const prompt = store.prompts.find((item) => item.id === question.promptId)
    || localQuestionBankPrompts(run.questionSet || selectedLocalQuestionSet(), run.questionSetId || null)
      .find((item) => item.id === question.promptId)
    || (question.questionText ? {
      id: question.promptId,
      text: question.questionText,
      questionSet: run.questionSet || question.questionSet || null,
      questionSetId: run.questionSetId || question.questionSetId || null,
      monitoringVersion: question.promptVersion || 1,
      reportable: run.reportable !== false,
      active: true,
    } : null);
  if (!prompt) throw browserMonitorError("题目不存在", 404);
  const judgement = classifyBrowserVisibilityAnswer(input.rawAnswer, store.brands[0]);
  const platform = effectivePlatform(run);
  const inferenceConfig = { webSearch: effectivePlatformMode(run) === "web_search" ? "browser_native" : "disabled", invocationMode: "browser_playwright", temperature: "unknown" };
  const previousRecord = question.replaceRunId && store.probeRuns.find((item) => item.id === question.replaceRunId);
  if (run.mode === "replace_invalid_answer" && !previousRecord) throw browserMonitorError("REPLACEMENT_TARGET_NOT_FOUND");
  const V2_CAPTURE_STATUSES = new Set(["CAPTURED", "NO_CITATION_CONFIRMED", "CAPTURED_PARTIAL", "CITATION_REGION_NOT_LOADED", "CAPTURE_FAILED"]);
  const citationCaptureVersion = input.citationCaptureVersion === "v2" || input.citationCaptureV2?.captureVersion === "v2" ? "v2" : null;
  const citationCaptureStatus = citationCaptureVersion && V2_CAPTURE_STATUSES.has(input.citationCaptureStatus)
    ? input.citationCaptureStatus
    : ["success", "empty", "partial", "failed", "not_available", "not_observed"].includes(input.citationCaptureStatus)
      ? input.citationCaptureStatus : "not_available";
  const citationStatus = citationCaptureVersion ? citationCaptureStatus
    : V2_CAPTURE_STATUSES.has(input.citationStatus) ? input.citationStatus : null;
  const citationLegacyStatus = citationCaptureVersion
    ? input.citationLegacyStatus || input.citationCaptureV2?.legacyStatus || "failed"
    : citationCaptureStatus;
  const browserCitations = Array.isArray(input.citations)
    ? input.citations.map((citation, index) => normalizeCitation(citation, {
      questionId: question.promptId,
      runId: run.id,
      workerId: input.worker?.workerId || question.workerId || null,
      conversationId: input.browserConversation?.conversationId || question.conversationId || null,
      pageUrl: input.browserConversation?.url || "",
      capturedAt: input.citationCapture?.capturedAt || completedAt,
    }, index + 1)).map((citation) => enrichCitationBrandRelation(citation, store.brands[0]))
    : [];
  question.citations = browserCitations;
  question.browserCitations = browserCitations;
  question.question = question.questionText;
  question.mentionResult = {
    brandMentioned: Boolean(judgement.brandMentioned),
    matchedBrandAliases: judgement.matchedBrandAliases || [],
  };
  question.recommendationResult = {
    recommendation: judgement.recommendation || "none",
    position: judgement.position ?? null,
    recommendationEvidence: judgement.recommendationEvidence || null,
  };
  question.visibilityClassificationVersion = VISIBILITY_CLASSIFICATION_VERSION;
  question.citationCaptureStatus = citationCaptureStatus;
  question.citationCaptureVersion = citationCaptureVersion;
  question.citationLegacyStatus = citationLegacyStatus;
  question.citationCount = browserCitations.length;
  question.citationCheckedChannels = Array.isArray(input.citationCheckedChannels)
    ? input.citationCheckedChannels : input.citationCaptureV2?.checkedChannels || [];
  question.citationStatus = citationStatus;
  question.citationCaptureError = input.citationCaptureError || input.citationCapture?.error || null;
  question.citationCapture = input.citationCapture || null;
  question.citationCaptureV2 = input.citationCaptureV2 || null;
  question.citationVisibilityMismatch = input.citationVisibilityMismatch ?? input.citationCapture?.citationVisibilityMismatch ?? null;
  question.promptIntegrity = promptIntegrity;
  if (run.mode === "performance_benchmark") {
    question.status = "success";
    question.browserStage = "saved";
    question.outcome = "benchmark_completed";
    question.errorMessage = null;
    question.rawAnswer = input.rawAnswer.trim();
    question.firstTokenAt = input.browserTiming?.firstTokenAt || null;
    question.answerDurationMs = Number(input.browserTiming?.durationMs || 0) || null;
    Object.assign(question.job, {
      status: "completed", raw_answer: question.rawAnswer, citations: browserCitations,
      prompt_integrity: promptIntegrity,
      citation_capture_status: citationCaptureStatus, citation_capture_version: citationCaptureVersion, citation_legacy_status: citationLegacyStatus, citation_count: question.citationCount, citation_checked_channels: question.citationCheckedChannels, citation_status: citationStatus, citation_capture_error: question.citationCaptureError, citation_capture: question.citationCapture, citation_capture_v2: question.citationCaptureV2,
      citation_visibility_mismatch: question.citationVisibilityMismatch,
      started_at: question.startedAt, completed_at: completedAt, duration_ms: question.latencyMs,
      error_code: null, error_message: null, lock_id: null, locked_at: null,
    });
    audit("browser_monitor_benchmark.question_completed", { monitorRunId: run.id, promptId: question.promptId, workerId: question.workerId, pageIndex: question.pageIndex });
    updateBrowserMonitorRunWithVisibilitySummary(run);
    await persist();
    publishBrowserMonitorProgress(run, browserMonitorCompletionEvent(run));
    return browserMonitorRunResponse(run);
  }
  const replacementFields = {
    promptId: prompt.id, question: question.questionText, surface: platform === "deepseek_web" ? "DeepSeek" : "豆包", ...browserMonitorPlatformFields(run), rawAnswer: input.rawAnswer.trim(), screenshot: null,
    questionSet: run.questionSet || question.questionSet || prompt.questionSet || null,
    questionSetId: run.questionSetId || question.questionSetId || prompt.questionSetId || null,
    questionSetName: run.questionSetName || localQuestionBankName(run.questionSet || question.questionSet || prompt.questionSet),
    answerStoreKey: `${run.questionSetId || question.questionSetId || prompt.questionSetId || run.questionSet || prompt.questionSet || "unassigned"}:${prompt.id}`,
    mentionResult: question.mentionResult, recommendationResult: question.recommendationResult,
    workerId: question.workerId || input.worker?.workerId || null, conversationId: question.conversationId || input.browserConversation?.conversationId || null, completedAt,
    // Preserve the legacy Doubao citation denominator. DeepSeek citations are
    // DOM-observed links and are therefore retained as evidence, never guessed.
    citations: platform === "deepseek_web" ? browserCitations : [], browserCitations, mentionResult: question.mentionResult, recommendationResult: question.recommendationResult,
    citationCaptureVersion, citationCaptureStatus: citationCaptureStatus, citationLegacyStatus, citationCount: question.citationCount, citationCheckedChannels: question.citationCheckedChannels, citationStatus, citationCaptureError: question.citationCaptureError,
    citationCapture: question.citationCapture, citationCaptureV2: question.citationCaptureV2, ownedDomainCitations: [], thirdPartyCitations: [], thirdPartyBrandCitations: [], citationMode: "browser_uncollected",
    citationVisibilityMismatch: question.citationVisibilityMismatch,
    ...judgement, visibilityClassificationVersion: VISIBILITY_CLASSIFICATION_VERSION, brandCitation: false, officialCitation: false, thirdPartyCitation: false, accurate: true, sentiment: "neutral", competitorMentions: 0,
    source: "browser_observed", status: "success", modelId: platform === "deepseek_web" ? "deepseek-web" : "doubao-web", ...inferenceConfig, configFingerprint: configFingerprintForRun(inferenceConfig), browserMonitorRunId: run.id,
    promptVersion: Number(question.promptVersion || prompt.monitoringVersion || 1),
    evidenceScope: input.evidenceScope || "full_response", visibleEvidence: String(input.visibleEvidence || "").trim() || null,
    browserTiming: input.browserTiming || null,
    browserConversation: input.browserConversation || null,
    promptIntegrity,
  };
  const runRecord = { id: uid("run"), createdAt: completedAt, ...replacementFields };
  store.probeRuns.unshift(runRecord);
  question.status = "success";
  question.browserStage = "saved";
  question.outcome = "completed";
  question.errorMessage = null;
  question.rawAnswer = input.rawAnswer.trim();
  question.firstTokenAt = input.browserTiming?.firstTokenAt || null;
  question.answerDurationMs = Number(input.browserTiming?.durationMs || 0) || null;
  Object.assign(question.job, {
    status: "completed", raw_answer: question.rawAnswer, citations: browserCitations,
    prompt_integrity: promptIntegrity,
    citation_capture_status: citationCaptureStatus, citation_capture_version: citationCaptureVersion, citation_legacy_status: citationLegacyStatus, citation_count: question.citationCount, citation_checked_channels: question.citationCheckedChannels, citation_status: citationStatus, citation_capture_error: question.citationCaptureError, citation_capture: question.citationCapture, citation_capture_v2: question.citationCaptureV2,
    citation_visibility_mismatch: question.citationVisibilityMismatch,
    started_at: question.startedAt, completed_at: completedAt, duration_ms: question.latencyMs,
    error_code: null, error_message: null, lock_id: null, locked_at: null,
  });
  audit("browser_monitor_question.completed", { monitorRunId: run.id, promptId: question.promptId, runId: runRecord.id, ...browserMonitorPlatformFields(run), execution: "playwright_fixed_worker_pool" });
  if (platform === "doubao_web" && runRecord.hasValidCompanyAnswer === false) {
    const failureStreak = consecutiveInvalidBrowserAnswerCount(prompt);
    if (failureStreak >= AUTO_PROMPT_REPLACEMENT_THRESHOLD) {
      const replacement = replaceBrowserMonitoringPrompt(prompt, { reason: "two_consecutive_invalid_company_answers", failureStreak });
      audit("browser_monitor_prompt.auto_replaced", { promptId: prompt.id, failureStreak, threshold: AUTO_PROMPT_REPLACEMENT_THRESHOLD, ...replacement });
    }
  }
  updateBrowserMonitorRunWithVisibilitySummary(run);
  await persist();
  publishBrowserMonitorProgress(run, browserMonitorCompletionEvent(run));
  return browserMonitorRunResponse(run);
}

function browserPreflightPauseReason(error) {
  if (error?.code !== "DOUBAO_WORKER_NOT_READY") return `豆包网页执行器异常：${String(error?.message || error).slice(0, 240)}`;
  const worker = error.workerStates?.[0] || {};
  return [
    "正式测试启动前检查失败",
    `${worker.workerId || "某个 Worker"} 页面状态暂时无法确认`,
    `URL：${worker.urlReady ? "正常" : "异常"}；登录：${worker.loginStatus || "unknown"}；输入框：${worker.inputReady ? "已就绪" : "未就绪"}；验证码：${worker.verificationStatus === "verification_required" ? "需要人工处理" : "未发现"}`,
    "建议：点击“浏览器连接检查”重新检查。",
  ].join("\n");
}

function startDoubaoWebMonitor(run) {
  const platform = effectivePlatform(run) || "doubao_web";
  const platformMode = effectivePlatformMode(run) || "chat";
  try { activePlatformRuns.register(platform, run.id); }
  catch { return; }
  const controller = new AbortController();
  browserMonitorAbortControllers.set(run.id, controller);
  const runtime = getPlatformRuntime(platform);
  run.status = "preparing_browser";
  run.pausedReason = null;
  run.updatedAt = now();
  void persist().then(() => publishBrowserMonitorProgress(run, "progress"));
  void executeDoubaoWebRun({
    run,
    browserManager: runtime,
    workerCount: normalizeDoubaoWorkerConcurrency(run.executionPolicy?.workerConcurrency),
    claimNextQuestion: (worker) => claimBrowserMonitorQuestion(run, worker),
    onQuestionStarted: (question, worker) => markBrowserMonitorQuestionWorker(question, worker),
    onQuestionCompleted: (question, result) => completeBrowserMonitorQuestion(run, {
      promptId: question.promptId,
      rawAnswer: result.answer,
      citations: result.citations,
      browserConversation: result.conversation ? { ...result.conversation, worker: result.worker || null } : null,
      citationCaptureStatus: result.citationCaptureStatus,
      citationCaptureVersion: result.citationCaptureVersion,
      citationLegacyStatus: result.citationLegacyStatus,
      citationCount: result.citationCount,
      citationCheckedChannels: result.citationCheckedChannels,
      citationStatus: result.citationStatus,
      citationCaptureError: result.citationCaptureError,
      citationVisibilityMismatch: result.citationVisibilityMismatch,
      citationCapture: result.citationCapture,
      citationCaptureV2: result.citationCaptureV2,
      worker: result.worker || null,
      browserTiming: {
        startedAt: result.startedAt,
        firstTokenAt: result.firstTokenAt,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
      },
    }),
    onQuestionRetry: (question, error, details) => retryBrowserMonitorQuestion(run, question, error, details),
    onQuestionStage: (question, stage, conversation, worker) => markBrowserMonitorQuestionStage(run, question, stage, conversation, worker),
    onWorkersReady: async (workers) => {
      if (run.status !== "preparing_browser") return;
      run.status = "running";
      run.startedAt ||= now();
      run.updatedAt = now();
      run.browserRuntime = runtime.diagnostics();
      audit("doubao_browser.ready", { monitorRunId: run.id, platform, platformMode, effectiveConcurrency: workers.length, runtime: run.browserRuntime });
      await persist();
      publishBrowserMonitorProgress(run, "progress");
    },
    onQuestionCancelled: (question, worker) => cancelBrowserMonitorQuestionClaim(run, question, worker),
    onHumanActionRequired: (question, error, debugArtifact, worker) => requireBrowserMonitorHumanAction(run, question, error, debugArtifact, worker),
    onHumanActionResolved: (question, error, worker) => resolveBrowserMonitorHumanAction(run, question, error, worker),
    onQuestionException: (question, error, debugScreenshot, debugArtifact, browserConversation, worker) => completeBrowserMonitorQuestion(run, {
      promptId: question.promptId,
      testException: error.code || "doubao_web_execution_error",
      errorMessage: error.message,
      debugScreenshot,
      debugArtifact,
      browserConversation,
      worker,
    }),
    maxQuestionRetries: MAX_QUESTION_RETRIES,
    retryRecoveryCooldownMs: DOUBAO_RETRY_RECOVERY_COOLDOWN,
    platformUnavailableThreshold: DOUBAO_PLATFORM_UNAVAILABLE_THRESHOLD,
    onLoginRequired: (question, error, debugArtifact) => waitForBrowserMonitorLogin(run, question, error, debugArtifact),
    onRateLimited: (question, error, debugArtifact) => pauseBrowserMonitorRun(
      run,
      question,
      `豆包发送频率限制：${String(error.message || error).slice(0, 240)}`,
      { stage: "paused_rate_limited", debugArtifact },
    ),
    onPlatformUnavailable: (question, _error, debugArtifact, details) => pauseBrowserMonitorRun(
      run,
      question,
      `豆包网页连续 ${details.consecutiveAnswerStartFailures} 道题未开始回答；测试已暂停，请稍后确认网页可正常回答后再恢复`,
      { stage: "paused_platform_unavailable", debugArtifact },
    ),
    signal: controller.signal,
    logger: console,
  }).catch(async (error) => {
    console.error("Doubao web monitor failed", error);
    if (run.status !== "aborted" && run.status !== "paused" && !["completed", "completed_with_errors"].includes(run.status)) {
      await pauseBrowserMonitorRun(run, null, browserPreflightPauseReason(error));
    }
  }).finally(async () => {
    if (browserMonitorAbortControllers.get(run.id) === controller) browserMonitorAbortControllers.delete(run.id);
    activePlatformRuns.release(platform, run.id);
    try { await finalizeDoubaoAccountAbRun(run); }
    catch (error) { console.error("Unable to finalize Doubao account A/B experiment", error); }
  });
}

function deepseekPreflightPauseReason(error) {
  const worker = error?.workerStates?.[0] || {};
  return `DeepSeek 正式测试启动前检查失败：${String(error?.message || error).slice(0, 240)}${worker.workerId ? `（${worker.workerId}：${worker.loginStatus || "unknown"}）` : ""}`;
}

async function waitForDeepSeekMonitorLogin(run, question, error, debugArtifact = null) {
  const waitingAt = now();
  if (question?.status === "running") {
    question.status = "queued"; question.browserStage = "waiting_for_login";
    question.errorMessage = "等待 DeepSeek 人工登录；该题不会计为失败";
    question.job ||= {};
    Object.assign(question.job, { status: "queued", error_code: "waiting_for_login", error_message: question.errorMessage, lock_id: null, locked_at: null });
    question.executionLog ||= []; question.executionLog.push({ stage: "WAITING_FOR_LOGIN", at: waitingAt, reason: String(error?.message || "DeepSeek 登录状态失效") });
    if (debugArtifact) question.debugArtifact = debugArtifact;
  }
  run.status = "waiting_for_login";
  run.pausedReason = "等待 DeepSeek 人工登录或页面处理；完成后请通过系统继续测试。";
  run.updatedAt = waitingAt;
  audit("deepseek_browser.waiting_for_login", { monitorRunId: run.id, promptId: question?.promptId || null });
  await persist(); publishBrowserMonitorProgress(run, "progress");
}

function startDeepSeekWebMonitor(run) {
  const platform = "deepseek_web";
  const platformMode = effectivePlatformMode(run) || "web_search";
  try { activePlatformRuns.register(platform, run.id); } catch { return; }
  const controller = new AbortController();
  browserMonitorAbortControllers.set(run.id, controller);
  const runtime = getPlatformRuntime(platform);
  run.status = "preparing_browser"; run.pausedReason = null; run.updatedAt = now();
  void persist().then(() => publishBrowserMonitorProgress(run, "progress"));
  void executeWebPlatformRun({
    platform, platformMode, run, runtime,
    workerCount: Number(run.executionPolicy?.workerConcurrency || DEEPSEEK_WORKER_CONCURRENCY),
    maxQuestionRetries: MAX_QUESTION_RETRIES, retryRecoveryCooldownMs: DOUBAO_RETRY_RECOVERY_COOLDOWN,
    claimNextQuestion: (worker) => claimBrowserMonitorQuestion(run, worker),
    onQuestionStarted: (question, worker) => markBrowserMonitorQuestionWorker(question, worker),
    onQuestionCompleted: (question, result) => completeBrowserMonitorQuestion(run, {
      promptId: question.promptId, rawAnswer: result.answer, citations: result.citations,
      browserConversation: result.conversation ? { ...result.conversation, worker: result.worker || null } : null,
      citationCaptureStatus: result.citationCaptureStatus, citationCaptureVersion: result.citationCaptureVersion, citationLegacyStatus: result.citationLegacyStatus, citationCount: result.citationCount, citationCheckedChannels: result.citationCheckedChannels, citationStatus: result.citationStatus, citationCaptureError: result.citationCaptureError,
      citationVisibilityMismatch: result.citationVisibilityMismatch, citationCapture: result.citationCapture, citationCaptureV2: result.citationCaptureV2, worker: result.worker || null,
      browserTiming: { startedAt: result.startedAt, firstTokenAt: result.firstTokenAt, completedAt: result.completedAt, durationMs: result.durationMs },
    }),
    onQuestionRetry: (question, error, details) => retryBrowserMonitorQuestion(run, question, error, details),
    onQuestionStage: (question, stage, conversation, worker) => markBrowserMonitorQuestionStage(run, question, stage, conversation, worker),
    onQuestionCancelled: (question, worker) => cancelBrowserMonitorQuestionClaim(run, question, worker),
    onWorkersReady: async (workers) => {
      if (run.status !== "preparing_browser") return;
      run.status = "running"; run.startedAt ||= now(); run.updatedAt = now(); run.browserRuntime = runtime.diagnostics();
      audit("deepseek_browser.ready", { monitorRunId: run.id, platform, platformMode, effectiveConcurrency: workers.length, runtime: run.browserRuntime });
      await persist(); publishBrowserMonitorProgress(run, "progress");
    },
    onLoginRequired: (question, error, artifact) => waitForDeepSeekMonitorLogin(run, question, error, artifact),
    onHumanActionRequired: async (question, error, artifact) => {
      if (question?.status === "running") { question.browserStage = "needs_human_action"; question.debugArtifact = artifact || null; }
      run.status = "needs_human_action"; run.pausedReason = `DeepSeek 需要人工处理：${String(error.message || error).slice(0, 240)}`; run.updatedAt = now();
      await persist(); publishBrowserMonitorProgress(run, "progress");
    },
    onHumanActionResolved: async () => { if (run.status === "needs_human_action") { run.status = "running"; run.pausedReason = null; run.updatedAt = now(); await persist(); publishBrowserMonitorProgress(run, "progress"); } },
    onRateLimited: (question, error, artifact) => pauseBrowserMonitorRun(run, question, `DeepSeek 发送频率限制：${String(error.message || error).slice(0, 240)}`, { stage: "paused_rate_limited", debugArtifact: artifact }),
    onPlatformUnavailable: (question, _error, artifact, details) => pauseBrowserMonitorRun(run, question, `DeepSeek 连续 ${details.consecutiveAnswerStartFailures} 道题未开始回答；测试已暂停。`, { stage: "paused_platform_unavailable", debugArtifact: artifact }),
    errorPolicy: {
      isLoginRequired: (error) => error?.code === "PLATFORM_LOGIN_REQUIRED",
      isHumanActionRequired: (error) => error?.code === "VERIFICATION_REQUIRED",
      isRateLimited: (error) => error?.code === "PLATFORM_SEND_RATE_LIMIT",
      isAnswerStartFailure: (error) => error?.code === "DEEPSEEK_ANSWER_NOT_STARTED",
    }, signal: controller.signal, logger: console,
  }).catch(async (error) => {
    console.error("DeepSeek web monitor failed", error);
    if (run.status !== "aborted" && run.status !== "paused" && !["completed", "completed_with_errors", "waiting_for_login", "needs_human_action"].includes(run.status)) await pauseBrowserMonitorRun(run, null, deepseekPreflightPauseReason(error));
  }).finally(() => {
    if (browserMonitorAbortControllers.get(run.id) === controller) browserMonitorAbortControllers.delete(run.id);
    activePlatformRuns.release(platform, run.id);
  });
}

function startPlatformWebMonitor(run) {
  return effectivePlatform(run) === "deepseek_web" ? startDeepSeekWebMonitor(run) : startDoubaoWebMonitor(run);
}

async function waitForBrowserMonitorLogin(run, question, error, debugArtifact = null) {
  const waitingAt = now();
  if (question?.status === "running") {
    question.status = "queued";
    question.browserStage = "waiting_for_login";
    question.errorMessage = "等待豆包登录；该题不会计为失败";
    question.job ||= {};
    Object.assign(question.job, { status: "queued", error_code: "waiting_for_login", error_message: question.errorMessage, lock_id: null, locked_at: null });
    question.executionLog ||= [];
    question.executionLog.push({ stage: "WAITING_FOR_LOGIN", at: waitingAt, reason: String(error?.message || "豆包登录状态失效") });
    if (debugArtifact) question.debugArtifact = debugArtifact;
  }
  run.status = "waiting_for_login";
  run.pausedReason = "等待豆包登录：测试浏览器已打开，请直接在同一 Chromium 窗口完成登录；登录成功后会自动继续。";
  run.updatedAt = waitingAt;
  audit("browser_monitor_run.waiting_for_login", { monitorRunId: run.id, promptId: question?.promptId || null });
  await persist();
  publishBrowserMonitorProgress(run, "progress");
  if (browserMonitorLoginWatchers.has(run.id)) return browserMonitorRunResponse(run);
  browserMonitorLoginWatchers.add(run.id);
  void doubaoBrowserManager.waitForLogin({
    isWaiting: () => run.status === "waiting_for_login",
  }).then(async (login) => {
    if (!login || run.status !== "waiting_for_login") return;
    run.status = "preparing_browser";
    run.pausedReason = null;
    run.updatedAt = now();
    await persist();
    publishBrowserMonitorProgress(run, "progress");
    startDoubaoWebMonitor(run);
  }).catch(async (loginError) => {
    if (run.status !== "waiting_for_login") return;
    run.pausedReason = `等待豆包登录时页面异常：${String(loginError?.message || loginError).slice(0, 200)}`;
    run.updatedAt = now();
    await persist();
    publishBrowserMonitorProgress(run, "progress");
  }).finally(() => browserMonitorLoginWatchers.delete(run.id));
  return browserMonitorRunResponse(run);
}

async function api(req, res, url) {
  if (await publishService.handle(req, res, url, bodyOf, json)) return;
  if (await competitorService.handle(req, res, url, bodyOf, json)) return;
  const path = url.pathname;
  const method = req.method;
  const platformSelection = (input = {}) => resolvePlatformSelection({
    platform: input.platform ?? url.searchParams.get("platform") ?? "doubao_web",
    platformMode: input.platformMode ?? url.searchParams.get("platformMode") ?? undefined,
    platformRegistry,
  });
  const sendPlatformSelectionError = (selection) => json(res, selection.status || 400, {
    error: selection.error || "INVALID_PLATFORM",
    platform: selection.platform,
    platformMode: selection.platformMode,
    supportedModes: selection.supportedModes,
  });
  const sendPlatformNotImplemented = (selection) => json(res, 501, platformNotImplementedPayload(selection));
  if (route(url, method) === "GET /api/platforms") return json(res, 200, { platforms: listPlatformCapabilities(platformRegistry) });
  if (route(url, method) === "GET /api/dashboard") return json(res, 200, dashboard());
  if (route(url, method) === "GET /api/runtime") return json(res, 200, {
    project: "geo-system",
    serverInstanceId: SERVER_INSTANCE_ID,
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
    interactiveSession: SERVER_INTERACTIVE_LAUNCH,
    browserRuntimeMode: "headed_persistent_context",
    startupSource: SERVER_STARTUP_SOURCE,
  });
  if (route(url, method) === "GET /api/doubao-browser/runtime") return json(res, 200, getPlatformRuntime("doubao_web").diagnostics());
  if (route(url, method) === "GET /api/doubao-browser/topology") return json(res, 200, await getPlatformRuntime("doubao_web").getTopologySnapshot());
  if (route(url, method) === "GET /api/doubao-browser/inspect") {
    if (!DEVELOPMENT_RUNTIME) return json(res, 404, { error: "DOUBAO_BROWSER_INSPECT_UNAVAILABLE" });
    const runtime = getPlatformRuntime("doubao_web");
    await runtime.ensureBrowser();
    const worker = runtime.getWorker("doubao-worker-1");
    const page = worker?.page;
    if (!page || page.isClosed?.()) return json(res, 409, { error: "DOUBAO_WORKER_PAGE_UNAVAILABLE" });
    const inspection = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 12000),
      candidates: [...document.querySelectorAll("textarea, input, [contenteditable='true'], button, [role='button']")]
        .slice(0, 160)
        .map((element) => ({
          tag: element.tagName,
          text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 300),
          placeholder: element.getAttribute("placeholder"),
          ariaLabel: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          contentEditable: element.getAttribute("contenteditable"),
          className: String(element.className || "").slice(0, 300),
        })),
    }));
    return json(res, 200, inspection);
  }
  const platformBrowserInspectMatch = path.match(/^\/api\/platforms\/([^/]+)\/browser\/inspect$/);
  if (method === "GET" && platformBrowserInspectMatch) {
    if (!DEVELOPMENT_RUNTIME) return json(res, 404, { error: "平台浏览器检查不可用" });
    const selection = platformSelection({ platform: decodeURIComponent(platformBrowserInspectMatch[1]) });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    if (selection.platform !== "deepseek_web") return json(res, 404, { error: "PLATFORM_BROWSER_INSPECT_UNAVAILABLE" });
    const runtime = getPlatformRuntime(selection.platform);
    await runtime.ensureBrowser();
    return json(res, 200, await runtime.inspectWorkerDom("deepseek-worker-1"));
  }
  if (route(url, method) === "POST /api/doubao-browser/smoke") {
    if (!DEVELOPMENT_RUNTIME) return json(res, 404, { error: "开发环境浏览器检查不可用" });
    // This endpoint intentionally does not create/resume/update any GEO run.
    // It only proves the BrowserManager can expose the fixed worker tabs.
    return json(res, 200, await getPlatformRuntime("doubao_web").prepareForSmokeTest(DOUBAO_WORKER_CONCURRENCY));
  }
  const deepseekCanaryMatch = path.match(/^\/api\/platforms\/deepseek_web\/canaries(?:\/([^/]+))?$/);
  if (deepseekCanaryMatch && method === "GET") {
    const runId = deepseekCanaryMatch[1] ? decodeURIComponent(deepseekCanaryMatch[1]) : null;
    const runs = (store.deepseekCanaryRuns || []).filter((item) => !runId || item.id === runId);
    if (runId && !runs.length) return json(res, 404, { error: "DEEPSEEK_CANARY_NOT_FOUND", runId });
    return json(res, 200, {
      canaries: runs.map((run) => ({
        ...run,
        evidence: store.probeRuns.filter((probe) => probe.deepseekCanaryRunId === run.id),
      })),
    });
  }
  if (deepseekCanaryMatch && method === "POST" && !deepseekCanaryMatch[1]) {
    const input = await bodyOf(req);
    const selection = platformSelection({ ...input, platform: "deepseek_web" });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    const prompt = localQuestionBankPrompts()[0];
    if (!prompt) return json(res, 409, { error: "DEEPSEEK_CANARY_PROMPT_NOT_FOUND", message: "未找到当前正式题库的可用第一题" });
    const retryable = (store.deepseekCanaryRuns || []).find((item) => item.platformMode === selection.platformMode
      && item.status === "failed" && item.questions?.[0]?.promptId === prompt.id && item.questions?.[0]?.promptSubmitted === false);
    const run = retryable ? prepareDeepSeekCanaryRetry(retryable) : createDeepSeekCanaryRun(prompt, { platformMode: selection.platformMode });
    if (!retryable) store.deepseekCanaryRuns.unshift(run);
    await persist();
    try {
      activePlatformRuns.register("deepseek_web", run.id);
    } catch (error) {
      run.status = "failed";
      run.errorCode = error.code || "PLATFORM_RUN_ALREADY_ACTIVE";
      run.errorMessage = String(error.message || error);
      run.updatedAt = now();
      await persist();
      return json(res, 409, { error: run.errorCode, run });
    }
    try {
      const runtime = getPlatformRuntime("deepseek_web");
      const worker = await runtime.ensureBrowser();
      const result = await executeDeepSeekCanary({
        run,
        worker,
        classify: (rawAnswer) => classifyBrowserVisibilityAnswer(rawAnswer, store.brands[0]),
        storeProbe: async (probe) => { store.probeRuns.unshift(probe); },
        persist,
      });
      audit("deepseek_canary.completed", { runId: run.id, probeRunId: result.probeRun.id, promptId: prompt.id, platformMode: run.platformMode, reportable: false });
      await persist();
      return json(res, 200, { run: result.run, question: result.question, evidence: result.probeRun });
    } catch (error) {
      audit("deepseek_canary.failed", { runId: run.id, promptId: prompt.id, platformMode: run.platformMode, errorCode: error.code || "DEEPSEEK_CANARY_FAILED" });
      await persist();
      return json(res, 409, {
        error: error.code || "DEEPSEEK_CANARY_FAILED",
        message: String(error.message || error),
        run,
      });
    } finally {
      activePlatformRuns.release("deepseek_web", run.id);
    }
  }
  const platformBrowserSmokeMatch = path.match(/^\/api\/platforms\/([^/]+)\/browser\/smoke$/);
  if (method === "POST" && platformBrowserSmokeMatch) {
    const input = await bodyOf(req);
    const selection = platformSelection({ ...input, platform: decodeURIComponent(platformBrowserSmokeMatch[1]) });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    if (!selection.capability.capabilities?.browserSmoke) return sendPlatformNotImplemented(selection);
    // Only a registered runtime may execute; there is intentionally no
    // fallback to the Doubao runtime for a future platform.
    const concurrency = selection.platform === "deepseek_web" ? DEEPSEEK_WORKER_CONCURRENCY : DOUBAO_WORKER_CONCURRENCY;
    return json(res, 200, await getPlatformRuntime(selection.platform).prepareForSmokeTest(concurrency, selection.platformMode));
  }
  if (route(url, method) === "POST /api/doubao-browser/run-preflight") {
    if (!DEVELOPMENT_RUNTIME) return json(res, 404, { error: "开发环境浏览器检查不可用" });
    // Production-equivalent readiness validation only: no GEO Run is created,
    // no question is claimed, and no prompt is submitted.
    return json(res, 200, await doubaoBrowserManager.prepareForRunPreflight(DOUBAO_WORKER_CONCURRENCY));
  }
  const doubaoBrowserWorkerFocusMatch = path.match(/^\/api\/doubao-browser\/workers\/([^/]+)\/focus$/);
  if (method === "POST" && doubaoBrowserWorkerFocusMatch) {
    return json(res, 200, await focusDoubaoBrowserWorker(decodeURIComponent(doubaoBrowserWorkerFocusMatch[1])));
  }
  const doubaoBrowserWorkerPreviewMatch = path.match(/^\/api\/doubao-browser\/workers\/([^/]+)\/preview$/);
  if (method === "GET" && doubaoBrowserWorkerPreviewMatch) {
    const preview = await previewDoubaoBrowserWorker(decodeURIComponent(doubaoBrowserWorkerPreviewMatch[1]));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-geo-worker-page": String(preview.pageIndex || "") });
    return res.end(preview.image);
  }
  const platformBrowserWorkerPreviewMatch = path.match(/^\/api\/platforms\/([^/]+)\/browser\/workers\/([^/]+)\/preview$/);
  if (method === "GET" && platformBrowserWorkerPreviewMatch) {
    const selection = platformSelection({ platform: decodeURIComponent(platformBrowserWorkerPreviewMatch[1]) });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    if (!selection.capability.capabilities?.browserSmoke) return sendPlatformNotImplemented(selection);
    const preview = await previewPlatformBrowserWorker(selection.platform, decodeURIComponent(platformBrowserWorkerPreviewMatch[2]));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-geo-worker-page": String(preview.pageIndex || "") });
    return res.end(preview.image);
  }
  const platformBrowserWorkerFocusMatch = path.match(/^\/api\/platforms\/([^/]+)\/browser\/workers\/([^/]+)\/focus$/);
  if (method === "POST" && platformBrowserWorkerFocusMatch) {
    const selection = platformSelection({ platform: decodeURIComponent(platformBrowserWorkerFocusMatch[1]) });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    if (!selection.capability.capabilities?.browserSmoke) return sendPlatformNotImplemented(selection);
    return json(res, 200, await getPlatformRuntime(selection.platform).bringWorkerToFront(decodeURIComponent(platformBrowserWorkerFocusMatch[2])));
  }
  if (route(url, method) === "POST /api/doubao-browser/login") {
    await doubaoBrowserManager.ensureBrowser();
    await doubaoBrowserManager.ensureVisibleWindow();
    return json(res, 200, { ...await doubaoBrowserManager.detectLoginState(), runtime: doubaoBrowserManager.diagnostics() });
  }
  if (route(url, method) === "GET /api/doubao-account-ab") {
    return json(res, 200, { experiments: (store.doubaoAccountExperiments || []).map(accountAbExperimentSummary) });
  }
  const accountAbMatch = path.match(/^\/api\/doubao-account-ab\/([^/]+)$/);
  if (method === "GET" && accountAbMatch) {
    const experiment = (store.doubaoAccountExperiments || []).find((item) => item.experimentId === decodeURIComponent(accountAbMatch[1]));
    if (!experiment) return json(res, 404, { error: "DOUBAO_ACCOUNT_AB_NOT_FOUND" });
    return json(res, 200, { experiment: accountAbExperimentSummary(experiment) });
  }
  if (route(url, method) === "POST /api/doubao-account-ab/start") {
    const existingExperiment = activeDoubaoAccountAbExperiment();
    if (existingExperiment) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_ALREADY_ACTIVE", experimentId: existingExperiment.experimentId });
    const existingRun = findActiveBrowserMonitorRun(store.browserMonitorRuns);
    if (existingRun || activePlatformRuns.isPlatformRunActive("doubao_web")) return json(res, 409, { error: "DOUBAO_WEB_MONITOR_ALREADY_RUNNING", existingRunId: existingRun?.id || activePlatformRuns.getActiveRunId("doubao_web") });
    const questionSet = selectedLocalQuestionSet();
    const localPrompts = localQuestionBankPrompts(questionSet);
    if (localPrompts.length !== 30) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_QUESTION_SET_NOT_30", message: `账号 A/B 实验要求当前正式题库严格为 30 题，当前为 ${localPrompts.length} 题。` });
    const experiment = createDoubaoAccountAbExperiment({
      companyId: store.brands?.[0]?.id || null,
      questionSet,
      questionSetId: localPrompts[0]?.questionSetId || null,
      totalQuestions: localPrompts.length,
    });
    const run = createBrowserMonitorRun(localPrompts, {
      runId: nextBrowserMonitorRunId(),
      mode: "account_ab",
      executionPolicy: createBrowserMonitorExecutionPolicy(DOUBAO_WORKER_CONCURRENCY),
      ...browserMonitorRunMetadata(localPrompts),
    });
    Object.assign(run, { experimentType: DOUBAO_ACCOUNT_AB_TYPE, experimentId: experiment.experimentId, experimentArm: "A", accountLabel: experiment.armA });
    attachAccountAbRun(experiment, "A", run.id, { accountLabel: experiment.armA });
    store.doubaoAccountExperiments.unshift(experiment);
    store.browserMonitorRuns.unshift(run);
    audit("doubao_account_ab.created", { experimentId: experiment.experimentId, arm: "A", monitorRunId: run.id, promptCount: run.total, workerConcurrency: DOUBAO_WORKER_CONCURRENCY });
    await persist();
    publishBrowserMonitorProgress(run);
    startDoubaoWebMonitor(run);
    return json(res, 202, { experiment: accountAbExperimentSummary(experiment), run: browserMonitorRunResponse(run) });
  }
  const accountAbSwitchMatch = path.match(/^\/api\/doubao-account-ab\/([^/]+)\/confirm-switch$/);
  if (method === "POST" && accountAbSwitchMatch) {
    const experiment = (store.doubaoAccountExperiments || []).find((item) => item.experimentId === decodeURIComponent(accountAbSwitchMatch[1]));
    if (!experiment) return json(res, 404, { error: "DOUBAO_ACCOUNT_AB_NOT_FOUND" });
    if (experiment.status !== ACCOUNT_AB_STATUS.WAITING_FOR_ACCOUNT_SWITCH) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_NOT_WAITING_FOR_SWITCH", status: experiment.status });
    const input = await bodyOf(req);
    const confirmedLabel = String(input.userConfirmedAccountLabel || input.accountLabel || "").trim();
    if (confirmedLabel !== experiment.armB) return json(res, 400, { error: "DOUBAO_ACCOUNT_AB_ACCOUNT_LABEL_CONFIRMATION_REQUIRED", expected: experiment.armB });
    const runA = store.browserMonitorRuns.find((run) => run.id === experiment.runAId);
    if (!accountAbRunIsFullSuccess(runA)) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_ARM_A_NOT_COMPLETE" });
    if (!accountAbQuestionSetUnchanged(runA)) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_QUESTION_SET_CHANGED", message: "A/B 实验无法继续：第二轮题库、Prompt 或顺序与第一轮不一致。" });
    if (activePlatformRuns.isPlatformRunActive("doubao_web")) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_BROWSER_STILL_BUSY" });
    beginAccountAbSwitch(experiment);
    await persist();
    let preflight;
    try {
      preflight = await doubaoBrowserManager.prepareForAccountSwitch(DOUBAO_WORKER_CONCURRENCY);
      recordAccountAbPreflight(experiment, preflight, { userConfirmedAccountLabel: confirmedLabel });
      if (!preflight.ready) {
        await persist();
        return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_PREFLIGHT_NOT_READY", experiment: accountAbExperimentSummary(experiment) });
      }
    } catch (error) {
      const details = { ready: false, errorCode: error.code || "ACCOUNT_SWITCH_PREFLIGHT_FAILED", errorMessage: String(error.message || error).slice(0, 300), workerId: error.workerId || null };
      recordAccountAbPreflight(experiment, details);
      await persist();
      audit("doubao_account_ab.preflight_failed", { experimentId: experiment.experimentId, ...details });
      return json(res, 409, { error: details.errorCode, message: details.errorMessage, experiment: accountAbExperimentSummary(experiment) });
    }
    const prompts = accountAbPromptsFromRun(runA);
    const runB = createBrowserMonitorRun(prompts, {
      runId: nextBrowserMonitorRunId(),
      mode: "account_ab",
      executionPolicy: createBrowserMonitorExecutionPolicy(DOUBAO_WORKER_CONCURRENCY),
      platform: runA.platform,
      platformMode: runA.platformMode,
      companyId: runA.companyId,
      questionSet: runA.questionSet,
      questionSetId: runA.questionSetId,
      questionSetName: runA.questionSetName || localQuestionBankName(runA.questionSet),
    });
    Object.assign(runB, { experimentType: DOUBAO_ACCOUNT_AB_TYPE, experimentId: experiment.experimentId, experimentArm: "B", accountLabel: experiment.armB, userConfirmedAccountLabel: confirmedLabel });
    attachAccountAbRun(experiment, "B", runB.id, { accountLabel: experiment.armB });
    store.browserMonitorRuns.unshift(runB);
    audit("doubao_account_ab.switch_confirmed", { experimentId: experiment.experimentId, arm: "B", monitorRunId: runB.id, ...browserMonitorPlatformFields(runB), workerCount: preflight.workerCount });
    await persist();
    publishBrowserMonitorProgress(runB);
    startDoubaoWebMonitor(runB);
    return json(res, 202, { experiment: accountAbExperimentSummary(experiment), run: browserMonitorRunResponse(runB), preflight });
  }
  if (route(url, method) === "GET /api/settings/providers") return json(res, 200, await providerSettings());
  if (route(url, method) === "DELETE /api/settings/providers/doubao") {
    await removeDoubaoApiKey();
    audit("provider.doubao_key_removed", { storage: "windows_dpapi" });
    await persist();
    return json(res, 200, await providerSettings());
  }
  if (route(url, method) === "POST /api/settings/providers/doubao") {
    if (DOUBAO_API_ACCESS_DISABLED) return json(res, 403, { error: "豆包 API 调用已关闭；当前系统只使用豆包网页端实测数据" });
    const input = await bodyOf(req);
    const apiKey = String(input.apiKey || "").trim();
    if (apiKey.length < 16) return json(res, 400, { error: "请输入完整的豆包 API Key" });
    await storeDoubaoApiKey(apiKey);
    audit("provider.doubao_key_configured", { storage: "windows_dpapi", keyLength: apiKey.length });
    await persist();
    return json(res, 200, await providerSettings());
  }
  if (route(url, method) === "GET /api/brands") return json(res, 200, store.brands);
  if (route(url, method) === "PUT /api/brands") {
    const input = await bodyOf(req);
    const brand = store.brands[0] || { id: "brand_primary", createdAt: now(), competitors: [] };
    const name = String(input.name || "").trim();
    if (!name) return json(res, 400, { error: "请填写要监测的名称" });
    const aliases = [...new Set(String(input.aliases || "").split(/[\n,，;；]/).map((item) => item.trim()).filter(Boolean))].filter((item) => item !== name);
    const domain = String(input.domain || "").trim();
    if (domain && !/^https?:\/\//i.test(domain)) return json(res, 400, { error: "官网地址需以 http:// 或 https:// 开头" });
    Object.assign(brand, {
      name,
      legalName: String(input.legalName || "").trim(),
      aliases,
      domain,
      industry: String(input.industry || "").trim(),
      location: String(input.location || "").trim(),
    });
    store.brands = [brand];
    const ownedDomain = domain ? new URL(domain).hostname.replace(/^www\./i, "") : "";
    store.citationPolicy = { ...(store.citationPolicy || {}), ownedDomains: ownedDomain ? [ownedDomain] : [] };
    audit("target_brand.configured", { brandId: brand.id, name, aliasCount: aliases.length, domain: ownedDomain || null });
    await persist();
    return json(res, 200, brand);
  }
  if (route(url, method) === "GET /api/prompts") return json(res, 200, store.prompts);
  if (route(url, method) === "POST /api/local-monitoring/config") {
    const input = await bodyOf(req);
    const selectedRegions = [...new Set((input.selectedRegions || []).filter((region) => store.localMonitoringConfig.allowedRegions.includes(region)))];
    if (!selectedRegions.length) return json(res, 400, { error: "请至少选择一个地域范围" });
    for (const prompt of store.prompts.filter((item) => item.questionSet === "dongguan_local" && item.active)) {
      prompt.active = false;
      prompt.reportable = false;
      prompt.archivedAt = now();
    }
    const generated = createLocalPromptSet(store.brands[0].id, selectedRegions);
    store.prompts.push(...generated.prompts);
    store.localMonitoringConfig.selectedRegions = selectedRegions;
    store.localMonitoringConfig.questionSetId = generated.id;
    audit("local_monitoring.question_set_generated", { questionSetId: generated.id, selectedRegions, promptCount: generated.prompts.length });
    await persist();
    return json(res, 201, { config: store.localMonitoringConfig, prompts: generated.prompts });
  }
  if (route(url, method) === "POST /api/local-monitoring/question-bank") {
    const input = await bodyOf(req);
    const questionSet = String(input.questionSet || "").trim();
    const bank = localQuestionBankDefinition(questionSet);
    if (!bank) return json(res, 400, { error: "INVALID_LOCAL_QUESTION_BANK", message: "请选择有效的题库" });
    const prompts = localQuestionBankPrompts(questionSet);
    if (prompts.length !== 30) return json(res, 409, { error: "LOCAL_QUESTION_BANK_NOT_READY", message: `${bank.name}当前不是完整的30题题库。` });
    const activeRun = findActiveBrowserMonitorRun(store.browserMonitorRuns);
    if (activeRun) return json(res, 409, { error: "QUESTION_BANK_CHANGE_BLOCKED_BY_ACTIVE_RUN", message: "当前测试仍在运行，完成或停止后才能切换题库。", existingRunId: activeRun.id });
    store.localMonitoringConfig.selectedQuestionSet = questionSet;
    audit("local_monitoring.question_bank_selected", { questionSet, questionSetId: prompts[0]?.questionSetId || null, questionSetName: bank.name, promptCount: prompts.length });
    await persist();
    return json(res, 200, { selectedQuestionSet: questionSet, questionBank: { ...bank, promptCount: prompts.length, questionSetId: prompts[0]?.questionSetId || null }, prompts });
  }
  if (route(url, method) === "POST /api/prompts") {
    const input = await bodyOf(req);
    const item = { id: uid("prompt"), brandId: store.brands[0].id, text: input.text, intent: input.intent || "解决方案", weight: Number(input.weight || 3), active: true };
    if (!item.text?.trim()) return json(res, 400, { error: "请输入问题" });
    store.prompts.push(item); audit("prompt.created", { promptId: item.id }); await persist(); return json(res, 201, item);
  }
  if (route(url, method) === "GET /api/probes") return json(res, 200, store.probeRuns.map(withEffectivePlatform));
  if (route(url, method) === "POST /api/browser-monitor-prompts/replace") {
    const input = await bodyOf(req);
    const replacements = Array.isArray(input.replacements) ? input.replacements : [];
    if (!replacements.length) return json(res, 400, { error: "NO_BROWSER_PROMPT_REPLACEMENTS" });
    const changed = [];
    for (const item of replacements) {
      const prompt = store.prompts.find((candidate) => candidate.id === item.promptId);
      const questionText = String(item.questionText || "").trim();
      if (!prompt || !localQuestionBankDefinition(prompt.questionSet) || !questionText) {
        return json(res, 400, { error: "INVALID_BROWSER_PROMPT_REPLACEMENT" });
      }
      const replacement = replaceBrowserMonitoringPrompt(prompt, {
        questionText,
        reason: "manual_replace_after_invalid_company_answer",
      });
      audit("browser_monitor_prompt.replaced", { promptId: prompt.id, ...replacement, reason: "manual_replace_after_invalid_company_answer" });
      changed.push({ promptId: prompt.id, ...replacement });
    }
    await persist();
    return json(res, 200, { replacements: changed });
  }
  const isLegacyDoubaoRunStart = route(url, method) === "POST /api/browser-monitor-runs/doubao";
  const isGenericPlatformRunStart = route(url, method) === "POST /api/browser-monitor-runs";
  if (isLegacyDoubaoRunStart || isGenericPlatformRunStart) {
    const input = await bodyOf(req);
    const selection = isGenericPlatformRunStart
      ? platformSelection(input)
      : platformSelection({ platform: "doubao_web", platformMode: "chat" });
    if (!selection.ok) return sendPlatformSelectionError(selection);
    if (!selection.capability.capabilities?.monitorRun) return sendPlatformNotImplemented(selection);
    input.platform = selection.platform;
    input.platformMode = selection.platformMode;
    const accountAbExperiment = selection.platform === "doubao_web" ? activeDoubaoAccountAbExperiment() : null;
    if (accountAbExperiment) return json(res, 409, { error: "DOUBAO_ACCOUNT_AB_IN_PROGRESS", experimentId: accountAbExperiment.experimentId, status: accountAbExperiment.status });
    const existing = findActiveBrowserMonitorRun(store.browserMonitorRuns, { platform: selection.platform });
    if (existing || activePlatformRuns.isPlatformRunActive(selection.platform)) return json(res, 409, { error: "PLATFORM_WEB_MONITOR_ALREADY_RUNNING", existingRunId: existing?.id || activePlatformRuns.getActiveRunId(selection.platform) });
    const requestedQuestionSet = String(input.questionSet || selectedLocalQuestionSet()).trim();
    const bank = localQuestionBankDefinition(requestedQuestionSet);
    if (!bank) return json(res, 400, { error: "INVALID_LOCAL_QUESTION_BANK", message: "请选择有效的题库后再开始测试。" });
    const localPrompts = localQuestionBankPrompts(requestedQuestionSet);
    if (localPrompts.length !== 30) return json(res, 409, { error: "LOCAL_QUESTION_BANK_NOT_READY", message: `${bank.name}当前不是完整的30题题库。` });
    const workerConcurrency = selection.platform === "deepseek_web" ? DEEPSEEK_WORKER_CONCURRENCY : normalizeDoubaoWorkerConcurrency(input.concurrency);
    if (selection.platform === "deepseek_web" && input.mode && input.mode !== "full_daily") return json(res, 400, { error: "DEEPSEEK_FORMAL_RUN_REQUIRES_FULL_DAILY" });
    if (input.mode === "performance_benchmark") {
      const prompts = selectBrowserBenchmarkPrompts(localPrompts, input.sampleSize);
      const run = createBrowserMonitorRun(prompts, {
        runId: nextBrowserMonitorRunId(),
        mode: "performance_benchmark",
        platform: selection.platform,
        platformMode: selection.platformMode,
        executionPolicy: createBrowserMonitorExecutionPolicy(workerConcurrency, selection.platform),
        ...browserMonitorRunMetadata(prompts, selection.platform),
      });
      run.benchmark = { sampleSize: prompts.length, requestedConcurrency: workerConcurrency, persistence: "benchmark_only_no_geo_probe_or_score_update" };
      store.browserMonitorRuns.unshift(run);
      audit("browser_monitor_benchmark.created", { monitorRunId: run.id, ...browserMonitorPlatformFields(run), promptCount: run.total, workerConcurrency });
      await persist();
      publishBrowserMonitorProgress(run);
      startPlatformWebMonitor(run);
      return json(res, 202, browserMonitorRunResponse(run));
    }
    if (input.mode === "full_daily") {
      const policy = createBrowserMonitorExecutionPolicy(workerConcurrency, selection.platform);
      const run = createBrowserMonitorRun(localPrompts, { runId: nextBrowserMonitorRunId(), mode: "full_daily", platform: selection.platform, platformMode: selection.platformMode, provider: selection.platform, reportable: true, adapterVersion: policy.adapterVersion || null, profileKey: policy.profileKey || null, executionPolicy: policy, ...browserMonitorRunMetadata(localPrompts, selection.platform) });
      store.browserMonitorRuns.unshift(run);
      audit("browser_monitor_run.created", { monitorRunId: run.id, ...browserMonitorPlatformFields(run), mode: run.mode, promptCount: run.total });
      await persist();
      publishBrowserMonitorProgress(run);
      startPlatformWebMonitor(run);
      return json(res, 202, browserMonitorRunResponse(run));
    }
    if (input.mode === "retry_failed_questions") {
      const requestedSourceRunId = String(input.sourceRunId || "").trim();
      const sourceRun = requestedSourceRunId
        ? store.browserMonitorRuns.find((item) => item.id === requestedSourceRunId)
        : store.browserMonitorRuns.find((item) => (item.failed > 0 || item.invalid > 0 || (item.questions || []).some((question) => question.status === "invalid")) && runMatchesPlatformSelection(item, selection));
      if (!sourceRun || !runMatchesPlatformSelection(sourceRun, selection)) {
        return json(res, 404, { error: "FAILED_QUESTION_RETRY_SOURCE_NOT_FOUND", message: "未找到本平台可补测的失败题目批次。" });
      }
      const failedPromptIds = new Set((sourceRun.questions || []).filter((question) => ["failed", "invalid"].includes(question.status)).map((question) => question.promptId));
      const prompts = localPrompts.filter((item) => failedPromptIds.has(item.id));
      if (!prompts.length) {
        return json(res, 409, { error: "NO_FAILED_BROWSER_QUESTION_TO_RETRY", message: "该批次没有仍在当前题库中的失败或无效题目可补测。" });
      }
      const run = createBrowserMonitorRun(prompts, {
        runId: nextBrowserMonitorRunId(),
        mode: "retry_failed_questions",
        retrySourceRunId: sourceRun.id,
        platform: selection.platform,
        platformMode: selection.platformMode,
        executionPolicy: createBrowserMonitorExecutionPolicy(workerConcurrency, selection.platform),
        ...browserMonitorRunMetadata(prompts, selection.platform),
      });
      store.browserMonitorRuns.unshift(run);
      audit("browser_monitor_run.created", { monitorRunId: run.id, ...browserMonitorPlatformFields(run), mode: run.mode, retrySourceRunId: sourceRun.id, promptCount: run.total });
      await persist();
      publishBrowserMonitorProgress(run);
      startPlatformWebMonitor(run);
      return json(res, 202, browserMonitorRunResponse(run));
    }
    const latestBrowserResults = browserMonitoringDashboard(localPrompts);
    const invalidRuns = latestBrowserResults.overall.latestRuns.filter((item) => item.hasValidCompanyAnswer === false);
    if (!invalidRuns.length) {
      return json(res, 409, { error: "NO_INVALID_BROWSER_ANSWER_TO_REPLACE", message: "当前一轮没有作废回答，无需补测。" });
    }
    const invalidRunByPromptId = new Map(invalidRuns.map((item) => [item.promptId, item]));
    const prompts = localPrompts.filter((item) => invalidRunByPromptId.has(item.id));
    const replaceRunIds = Object.fromEntries(invalidRuns.map((item) => [item.promptId, item.id]));
    const run = createBrowserMonitorRun(prompts, {
      runId: nextBrowserMonitorRunId(),
      mode: "replace_invalid_answer",
      platform: selection.platform,
      platformMode: selection.platformMode,
      sourceDate: latestBrowserResults.latestDate,
      replaceRunIds,
      executionPolicy: createBrowserMonitorExecutionPolicy(workerConcurrency, selection.platform),
      ...browserMonitorRunMetadata(prompts, selection.platform),
    });
    store.browserMonitorRuns.unshift(run);
    audit("browser_monitor_run.created", { monitorRunId: run.id, ...browserMonitorPlatformFields(run), mode: run.mode, sourceDate: run.sourceDate, promptCount: run.total });
    await persist();
    publishBrowserMonitorProgress(run);
    startPlatformWebMonitor(run);
    return json(res, 202, browserMonitorRunResponse(run));
  }
  const browserMonitorResumeMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/resume$/);
  if (method === "POST" && browserMonitorResumeMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === browserMonitorResumeMatch[1]);
    if (!run) return json(res, 404, { error: "网页端监测任务不存在" });
    if (run.status !== "paused") return json(res, 409, { error: "DOUBAO_WEB_MONITOR_NOT_PAUSED" });
    run.status = "queued";
    run.pausedReason = null;
    run.updatedAt = now();
    audit("browser_monitor_run.resumed", { monitorRunId: run.id, execution: "playwright_fixed_worker_pool" });
    await persist();
    publishBrowserMonitorProgress(run);
    startPlatformWebMonitor(run);
    return json(res, 202, browserMonitorRunResponse(run));
  }
  const browserMonitorStopMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/stop$/);
  if (method === "POST" && browserMonitorStopMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === browserMonitorStopMatch[1]);
    if (!run) return json(res, 404, { error: "BROWSER_MONITOR_RUN_NOT_FOUND" });
    if (!["queued", "preparing_browser", "waiting_for_login", "running", "paused", "needs_human_action"].includes(run.status)) {
      return json(res, 409, { error: "BROWSER_MONITOR_RUN_NOT_ACTIVE", status: run.status });
    }
    const input = await bodyOf(req);
    return json(res, 200, await abortBrowserMonitorRun(run, String(input.reason || "manually_aborted_for_diagnostic_recovery")));
  }
  if (route(url, method) === "GET /api/browser-monitor-runs/active") {
    const selection = platformSelection();
    if (!selection.ok) return sendPlatformSelectionError(selection);
    const run = findActiveBrowserMonitorRun(store.browserMonitorRuns, { platform: selection.platform });
    const questionSet = String(url.searchParams.get("questionSet") || selectedLocalQuestionSet()).trim();
    const latestTerminalRun = store.browserMonitorRuns.find((item) => ["completed", "completed_with_errors", "failed", "aborted"].includes(item.status) && item.questionSet === questionSet && runMatchesPlatformSelection(item, selection)) || null;
    return json(res, 200, {
      run: run ? browserMonitorRunResponse(run) : null,
      latestTerminalRun: latestTerminalRun ? browserMonitorRunResponse(latestTerminalRun) : null,
    });
  }
  if (route(url, method) === "GET /api/browser-monitor-runs/history") {
    const selection = platformSelection();
    if (!selection.ok) return sendPlatformSelectionError(selection);
    const requestedQuestionSet = String(url.searchParams.get("questionSet") || selectedLocalQuestionSet()).trim();
    const questionSet = localQuestionBankDefinition(requestedQuestionSet) ? requestedQuestionSet : selectedLocalQuestionSet();
    const currentQuestionSetId = localQuestionBankPrompts(questionSet)[0]?.questionSetId || null;
    return json(res, 200, { platform: selection.platform, platformMode: selection.platformMode, questionSet, questionSetId: currentQuestionSetId, questionSetName: localQuestionBankName(questionSet), summaries: browserMonitorTrendHistory(selection, questionSet, currentQuestionSetId), incompleteRuns: browserMonitorIncompleteHistory(selection, questionSet, currentQuestionSetId) });
  }
  if (route(url, method) === "GET /api/browser-monitor-runs/archive-history") {
    const selection = platformSelection();
    if (!selection.ok) return sendPlatformSelectionError(selection);
    const requestedQuestionSet = String(url.searchParams.get("questionSet") || selectedLocalQuestionSet()).trim();
    const questionSet = localQuestionBankDefinition(requestedQuestionSet) ? requestedQuestionSet : selectedLocalQuestionSet();
    const currentQuestionSetId = localQuestionBankPrompts(questionSet)[0]?.questionSetId || null;
    const archives = await archivedMonitorStores();
    const summaries = archivedBrowserMonitorTrendHistory(archives, selection, questionSet, currentQuestionSetId);
    return json(res, 200, {
      platform: selection.platform,
      platformMode: selection.platformMode,
      questionSet,
      questionSetId: currentQuestionSetId,
      questionSetName: localQuestionBankName(questionSet),
      archived: true,
      summaries,
      archiveFileCount: archives.length,
    });
  }
  const browserMonitorWorkerFocusMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/workers\/([^/]+)\/focus$/);
  if (method === "POST" && browserMonitorWorkerFocusMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === decodeURIComponent(browserMonitorWorkerFocusMatch[1]));
    if (!run) return json(res, 404, { error: "浏览器端监测任务不存在" });
    return json(res, 200, await focusBrowserMonitorWorkerPage(run, decodeURIComponent(browserMonitorWorkerFocusMatch[2])));
  }
  const browserMonitorWorkerPreviewMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/workers\/([^/]+)\/preview$/);
  if (method === "GET" && browserMonitorWorkerPreviewMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === decodeURIComponent(browserMonitorWorkerPreviewMatch[1]));
    if (!run) return json(res, 404, { error: "浏览器端监测任务不存在" });
    const preview = await previewBrowserMonitorWorkerPage(run, decodeURIComponent(browserMonitorWorkerPreviewMatch[2]));
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-geo-worker-page": String(preview.pageIndex || "") });
    return res.end(preview.image);
  }
  const browserMonitorEvidenceMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/evidence$/);
  if (method === "GET" && browserMonitorEvidenceMatch) {
    const runId = decodeURIComponent(browserMonitorEvidenceMatch[1]);
    const archiveRequested = url.searchParams.get("source") === "archive";
    const run = store.browserMonitorRuns.find((item) => item.id === runId);
    if (!run && !archiveRequested) return json(res, 404, { error: "网页端监测任务不存在" });
    if (url.searchParams.has("platform") || url.searchParams.has("platformMode")) {
      const selection = platformSelection();
      if (!selection.ok) return sendPlatformSelectionError(selection);
      if (run && !evidenceMatchesPlatformSelection(run, selection)) {
        return json(res, 404, { error: "BROWSER_MONITOR_RUN_NOT_FOUND_FOR_PLATFORM", platform: selection.platform, platformMode: selection.platformMode });
      }
    }
    if (archiveRequested) {
      const localPrompts = localQuestionBankPrompts(String(url.searchParams.get("questionSet") || selectedLocalQuestionSet()));
      const evidence = await archivedBrowserMonitorEvidenceGroup(runId, localPrompts);
      if (!evidence) return json(res, 404, { error: "归档中的网页端监测任务不存在" });
      return json(res, 200, evidence);
    }
    const localPrompts = localQuestionBankPrompts(run.questionSet || selectedLocalQuestionSet(), run.questionSetId || null);
    return json(res, 200, browserMonitorEvidenceGroup(run.id, localPrompts));
  }
  const browserMonitorVerificationFocusMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/verification\/([^/]+)\/focus$/);
  if (method === "POST" && browserMonitorVerificationFocusMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === browserMonitorVerificationFocusMatch[1]);
    if (!run) return json(res, 404, { error: "浏览器端监测任务不存在" });
    return json(res, 200, await focusBrowserMonitorVerificationPage(run, decodeURIComponent(browserMonitorVerificationFocusMatch[2])));
  }
  const browserMonitorEventsMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/events$/);
  if (method === "GET" && browserMonitorEventsMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === browserMonitorEventsMatch[1]);
    if (!run) return json(res, 404, { error: "浏览器端监测任务不存在" });
    return openBrowserMonitorProgressStream(req, res, run);
  }
  const browserMonitorRunMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)$/);
  const browserMonitorDiagnosticsMatch = path.match(/^\/api\/browser-monitor-runs\/([^/]+)\/diagnostics$/);
  if (method === "GET" && browserMonitorDiagnosticsMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === decodeURIComponent(browserMonitorDiagnosticsMatch[1]));
    if (!run) return json(res, 404, { error: "网页端监测任务不存在" });
    const diagnostics = run.geoDropDiagnostics || (browserMonitorRunIsComplete(run)
      ? buildGeoDropDiagnostics({ currentRun: run, historicalRuns: store.browserMonitorRuns || [], prompts: store.prompts || [], brand: store.brands[0], config: { baselineRuns: GEO_DIAGNOSTIC_BASELINE_RUNS, absoluteThreshold: GEO_DROP_ABSOLUTE_THRESHOLD, relativeThreshold: GEO_DROP_RELATIVE_THRESHOLD } })
      : null);
    if (diagnostics && !diagnostics.observability) diagnostics.observability = run.observability || buildObservabilityQuality(run);
    return json(res, 200, diagnostics);
  }
  if (method === "DELETE" && browserMonitorRunMatch) {
    return json(res, 200, await deleteCompletedBrowserMonitorRun(decodeURIComponent(browserMonitorRunMatch[1])));
  }
  if (method === "GET" && browserMonitorRunMatch) {
    const run = store.browserMonitorRuns.find((item) => item.id === browserMonitorRunMatch[1]);
    if (!run) return json(res, 404, { error: "网页端监测任务不存在" });
    return json(res, 200, browserMonitorRunResponse(run));
  }
  if (route(url, method) === "POST /api/browser-monitor-agent/claim") {
    const input = await bodyOf(req);
    const run = store.browserMonitorRuns.find((item) => item.id === input.runId);
    if (!run) return json(res, 404, { error: "网页端监测任务不存在" });
    const requestedPromptId = String(input.promptId || "").trim();
    const worker = { workerId: String(input.workerId || "external-browser-worker").trim() || "external-browser-worker", pageIndex: Number(input.pageIndex || 0) || null };
    const question = requestedPromptId
      ? claimBrowserQuestionById(run, requestedPromptId, worker)
      : claimNextBrowserQuestion(run, worker);
    if (requestedPromptId && !question) return json(res, 409, { error: "题目不是待领取状态" });
    if (!question) return json(res, 200, { run: browserMonitorRunSummary(run), question: null });
    audit("browser_monitor_question.claimed", { monitorRunId: run.id, promptId: question.promptId, attemptCount: question.attemptCount });
    await persist();
    publishBrowserMonitorProgress(run);
    return json(res, 200, { run: browserMonitorRunSummary(run), question });
  }
  if (route(url, method) === "POST /api/browser-monitor-agent/requeue") {
    const input = await bodyOf(req);
    const run = store.browserMonitorRuns.find((item) => item.id === input.runId);
    const promptIds = [...new Set((input.promptIds || []).filter(Boolean))];
    if (!run || !promptIds.length) return json(res, 400, { error: "INVALID_BROWSER_QUESTION_REQUEUE" });
    const reason = String(input.reason || "browser_submission_not_confirmed").slice(0, 160);
    const requeued = [];
    for (const question of run.questions) {
      if (!promptIds.includes(question.promptId) || question.status === "success") continue;
      question.status = "queued";
      question.startedAt = null;
      question.completedAt = null;
      question.latencyMs = null;
      question.rawAnswer = null;
      question.errorMessage = null;
      question.outcome = null;
      question.exceptionType = null;
      question.job ||= {};
      Object.assign(question.job, { status: "queued", raw_answer: null, citations: [], citation_capture_status: "not_available", citation_capture_error: null, citation_capture: null, started_at: null, completed_at: null, duration_ms: null, error_code: null, error_message: null, lock_id: null, locked_at: null });
      requeued.push(question.promptId);
    }
    run.status = "running";
    run.completedAt = null;
    run.pausedReason = null;
    updateBrowserMonitorRunWithVisibilitySummary(run);
    audit("browser_monitor_question.requeued", { monitorRunId: run.id, promptIds: requeued, reason });
    await persist();
    publishBrowserMonitorProgress(run);
    return json(res, 200, { run: browserMonitorRunSummary(run), requeued });
  }
  if (route(url, method) === "POST /api/browser-monitor-agent/replace-question") {
    const input = await bodyOf(req);
    const run = store.browserMonitorRuns.find((item) => item.id === input.runId);
    const question = run?.questions.find((item) => item.promptId === input.promptId);
    const prompt = store.prompts.find((item) => item.id === input.promptId);
    const questionText = String(input.questionText || "").trim();
    if (!run || !question || !prompt || !questionText) return json(res, 400, { error: "INVALID_BROWSER_QUESTION_REPLACEMENT" });
    const replacement = replaceBrowserMonitoringPrompt(prompt, {
      questionText,
      reason: "agent_replace_question",
    });
    question.questionText = questionText;
    question.promptVersion = prompt.monitoringVersion;
    question.status = "queued";
    question.rawAnswer = null;
    question.errorMessage = null;
    question.startedAt = null;
    question.completedAt = null;
    question.latencyMs = null;
    run.status = "running";
    run.completedAt = null;
    run.pausedReason = null;
    updateBrowserMonitorRunWithVisibilitySummary(run);
    audit("browser_monitor_question.replaced", { monitorRunId: run.id, promptId: prompt.id, ...replacement });
    await persist();
    publishBrowserMonitorProgress(run);
    return json(res, 200, browserMonitorRunSummary(run));
  }
  if (route(url, method) === "POST /api/browser-monitor-agent/complete") {
    const input = await bodyOf(req);
    const run = store.browserMonitorRuns.find((item) => item.id === input.runId);
    if (run) return json(res, 200, await completeBrowserMonitorQuestion(run, input));
    if (!run) return json(res, 404, { error: "网页端监测任务不存在" });
    const question = run.questions.find((item) => item.promptId === input.promptId && item.status === "running");
    if (!question) return json(res, 409, { error: "题目不是等待回传状态" });
    const completedAt = now();
    question.completedAt = completedAt;
    question.latencyMs = Math.max(0, Date.parse(completedAt) - Date.parse(question.startedAt || completedAt));
    if (input.pausedReason) {
      question.status = "queued";
      question.errorMessage = String(input.pausedReason).slice(0, 300);
      run.status = "paused";
      run.pausedReason = question.errorMessage;
      run.updatedAt = completedAt;
      audit("browser_monitor_run.paused", { monitorRunId: run.id, promptId: question.promptId, reason: question.errorMessage });
      await persist();
      return json(res, 200, browserMonitorRunSummary(run));
    }
    if (input.testException) {
      question.status = "failed";
      question.outcome = "test_exception";
      question.exceptionType = String(input.testException).slice(0, 80);
      question.errorMessage = String(input.errorMessage || input.testException).slice(0, 300);
      audit("browser_monitor_question.exception", {
        monitorRunId: run.id,
        promptId: question.promptId,
        exceptionType: question.exceptionType,
        error: question.errorMessage,
      });
      updateBrowserMonitorRunWithVisibilitySummary(run);
      await persist();
      return json(res, 200, browserMonitorRunSummary(run));
    }
    if (input.rawAnswer?.trim()) {
      const prompt = store.prompts.find((item) => item.id === question.promptId);
      const judgement = classifyBrowserVisibilityAnswer(input.rawAnswer, store.brands[0]);
      // Viewport evidence remains attached for audit, but cannot lower the
      // required threshold: at least two separately explained companies.
      const inferenceConfig = { webSearch: "browser_native", invocationMode: "browser_agent", temperature: "unknown" };
      const previousRecord = question.replaceRunId && store.probeRuns.find((item) => item.id === question.replaceRunId);
      if (run.mode === "replace_invalid_answer" && !previousRecord) {
        return json(res, 409, { error: "REPLACEMENT_TARGET_NOT_FOUND" });
      }
      const replacementFields = {
        promptId: prompt.id, surface: "豆包", ...browserMonitorPlatformFields(run), rawAnswer: input.rawAnswer.trim(), screenshot: null,
        citations: [], ownedDomainCitations: [], thirdPartyCitations: [], thirdPartyBrandCitations: [], citationMode: "browser_uncollected",
        ...judgement, visibilityClassificationVersion: VISIBILITY_CLASSIFICATION_VERSION, brandCitation: false, officialCitation: false, thirdPartyCitation: false, accurate: true, sentiment: "neutral", competitorMentions: 0,
        source: "browser_observed", status: "success", modelId: "doubao-web", ...inferenceConfig, configFingerprint: configFingerprintForRun(inferenceConfig), browserMonitorRunId: run.id,
        promptVersion: Number(question.promptVersion || prompt.monitoringVersion || 1),
        evidenceScope: input.evidenceScope || "full_response", visibleEvidence: String(input.visibleEvidence || "").trim() || null,
      };
      // Every attempt is an immutable audit record. Retests link back through
      // `replaceRunId`, but never overwrite the original raw answer.
      const runRecord = { id: uid("run"), createdAt: completedAt, ...replacementFields };
      store.probeRuns.unshift(runRecord);
      question.status = "success";
      question.outcome = "completed";
      question.rawAnswer = input.rawAnswer.trim();
      question.mentionResult = { brandMentioned: Boolean(judgement.brandMentioned), matchedBrandAliases: judgement.matchedBrandAliases || [] };
      question.recommendationResult = { recommendation: judgement.recommendation || "none", position: judgement.position ?? null, recommendationEvidence: judgement.recommendationEvidence || null };
      question.visibilityClassificationVersion = VISIBILITY_CLASSIFICATION_VERSION;
      audit("browser_monitor_question.completed", { monitorRunId: run.id, promptId: question.promptId, runId: runRecord.id, ...browserMonitorPlatformFields(run) });
      if (runRecord.hasValidCompanyAnswer === false && prompt) {
        const failureStreak = consecutiveInvalidBrowserAnswerCount(prompt);
        if (failureStreak >= AUTO_PROMPT_REPLACEMENT_THRESHOLD) {
          const replacement = replaceBrowserMonitoringPrompt(prompt, {
            reason: "two_consecutive_invalid_company_answers",
            failureStreak,
          });
          audit("browser_monitor_prompt.auto_replaced", {
            promptId: prompt.id,
            failureStreak,
            threshold: AUTO_PROMPT_REPLACEMENT_THRESHOLD,
            ...replacement,
          });
        }
      }
    } else {
      question.status = "failed";
      question.outcome = "test_exception";
      question.exceptionType = "unclassified_browser_error";
      question.errorMessage = String(input.errorMessage || "网页端未取得可保存回答").slice(0, 300);
      audit("browser_monitor_question.failed", { monitorRunId: run.id, promptId: question.promptId, error: question.errorMessage });
    }
    updateBrowserMonitorRunWithVisibilitySummary(run);
    await persist();
    return json(res, 200, browserMonitorRunSummary(run));
  }
  if (route(url, method) === "POST /api/monitor-runs/doubao") {
    const input = await bodyOf(req);
    const limit = parseMonitorRunLimit(input.limit);
    if (limit === null) return json(res, 400, { error: "limit 必须是 1 到 30 的整数" });
    const existingRun = findActiveDoubaoMonitorRun(store.monitorRuns);
    if (existingRun) return json(res, 409, { error: "DOUBAO_MONITOR_ALREADY_RUNNING", existingRunId: existingRun.id });
    if (!await doubaoApiConfigured()) return json(res, 400, { error: "请先在系统设置中配置豆包 API Key" });
    const prompts = store.prompts.filter((item) => item.active).slice(0, limit);
    if (!prompts.length) return json(res, 400, { error: "没有可执行的监测问题" });
    const monitorRun = createMonitorRun(prompts);
    store.monitorRuns.unshift(monitorRun);
    audit("monitor_run.doubao_created", { monitorRunId: monitorRun.id, promptCount: monitorRun.total });
    await persist();
    void executeMonitorRun(monitorRun, {
      brand: store.brands[0],
      callDoubaoApi,
      persist,
      saveProbeRun: (probeRun) => store.probeRuns.unshift(probeRun),
      concurrency: GEO_DOUABO_CONCURRENCY,
      maxRetries: GEO_DOUABO_MAX_RETRIES,
      isRetryableError: isRetryableDoubaoError,
    }).then(() => {
      audit("monitor_run.doubao_completed", { monitorRunId: monitorRun.id, status: monitorRun.status, success: monitorRun.success, failed: monitorRun.failed });
      return persist();
    }).catch(async (error) => {
      monitorRun.status = "failed";
      monitorRun.completedAt = now();
      monitorRun.updatedAt = monitorRun.completedAt;
      audit("monitor_run.doubao_failed", { monitorRunId: monitorRun.id, error: String(error?.message || "任务执行失败").slice(0, 500) });
      await persist();
    });
    return json(res, 202, monitorRunSummary(monitorRun));
  }
  const monitorRunMatch = path.match(/^\/api\/monitor-runs\/([^/]+)$/);
  if (method === "GET" && monitorRunMatch) {
    const monitorRun = (store.monitorRuns || []).find((item) => item.id === monitorRunMatch[1]);
    if (!monitorRun) return json(res, 404, { error: "MonitorRun 不存在" });
    return json(res, 200, monitorRunSummary(monitorRun));
  }
  if (route(url, method) === "POST /api/probes/run") {
    const input = await bodyOf(req); const prompts = input.promptIds?.length ? store.prompts.filter((item) => input.promptIds.includes(item.id)) : store.prompts.filter((item) => item.active);
    const surfaces = input.surfaces?.length ? input.surfaces.filter((surface) => SURFACES.includes(surface)) : SURFACES;
    const brand = store.brands[0]; const runs = prompts.flatMap((prompt) => surfaces.map((surface) => deterministicProbe(prompt, surface, brand, brand.competitors)));
    store.probeRuns.unshift(...runs); audit("probe.simulated", { runCount: runs.length, source: "simulated_probe" }); await persist(); return json(res, 201, { runs, score: dashboard().score });
  }
  if (route(url, method) === "POST /api/probes/record") {
    const input = await bodyOf(req);
    const prompt = store.prompts.find((item) => item.id === input.promptId);
    if (!prompt) return json(res, 400, { error: "监测问题不存在" });
    if (!SURFACES.includes(input.surface)) return json(res, 400, { error: "不支持的模型平台" });
    if (!input.rawAnswer?.trim()) return json(res, 400, { error: "必须保存模型的原始回答" });
    const source = input.source || "browser_observed";
    const inferenceConfig = { webSearch: input.webSearch ?? "unknown", invocationMode: input.invocationMode || (source === "browser_observed" ? "browser_manual" : source), temperature: input.temperature ?? "default" };
    const brand = store.brands[0];
    const suppliedSources = Array.isArray(input.citations) ? input.citations
      .filter((citation) => citation && typeof citation.url === "string")
      .map((citation) => ({ ...citation, sourceMethod: citation.sourceMethod || "browser_recorded" })) : [];
    const candidates = suppliedSources.length ? suppliedSources : markdownCitationCandidates(input.rawAnswer);
    const evidence = citationEvidence(input.rawAnswer, brand, candidates, suppliedSources.length ? "browser_recorded" : "markdown_parsed");
    const derivedRecommendation = recommendationEvidence(input.rawAnswer, brand);
    const providedRecommendationIsEvidenceBacked = ["first", "top3", "mentioned"].includes(input.recommendation) && typeof input.recommendationEvidence === "string" && input.recommendationEvidence.trim();
    const recommendation = providedRecommendationIsEvidenceBacked
      ? { recommendation: input.recommendation, position: input.position || null, recommendationEvidence: input.recommendationEvidence.trim() }
      : derivedRecommendation;
    const matchedBrandAliases = findMatchedBrandAliases(input.rawAnswer, brand);
    const platform = isPlatformId(input.platform)
      ? input.platform
      : (source === "browser_observed" && input.surface === "豆包" ? "doubao_web" : null);
    const platformMode = isPlatformMode(input.platformMode)
      ? input.platformMode
      : (platform === "doubao_web" ? "chat" : null);
    const run = {
      id: uid("run"), promptId: prompt.id, surface: input.surface, createdAt: now(), rawAnswer: input.rawAnswer,
      platform, platformMode,
      screenshot: input.screenshot || null, ...evidence, brandMentioned: matchedBrandAliases.length > 0, matchedBrandAliases,
      ...recommendation, brandCitation: false,
      officialCitation: evidence.ownedDomainCitations.length > 0, thirdPartyCitation: evidence.thirdPartyBrandCitations.length > 0,
      accurate: input.accurate !== false, sentiment: ["positive", "neutral", "negative"].includes(input.sentiment) ? input.sentiment : "neutral", competitorMentions: Number(input.competitorMentions || 0),
      source, status: "success", modelId: input.modelId || input.model || `${input.surface}-web`, ...inferenceConfig, configFingerprint: input.configFingerprint || configFingerprintForRun(inferenceConfig),
    };
    store.probeRuns.unshift(run); audit("probe.recorded", { runId: run.id, surface: run.surface, promptId: run.promptId, source: run.source }); await persist(); return json(res, 201, { run, score: dashboard().score });
  }
  if (route(url, method) === "POST /api/probes/doubao/run") {
    if (doubaoRunInProgress) return json(res, 409, { error: "豆包 API 监测正在运行，请等待当前批次完成" });
    if (!await doubaoApiConfigured()) return json(res, 400, { error: "请先在系统设置中配置豆包 API Key" });
    const input = await bodyOf(req);
    const webSearch = input.webSearch === true;
    const selected = input.promptIds?.length ? store.prompts.filter((item) => input.promptIds.includes(item.id) && item.active) : store.prompts.filter((item) => item.active).slice(0, 1);
    if (!selected.length) return json(res, 400, { error: "没有可执行的监测问题" });
    if (selected.length > DOUBAO_MAX_PROMPTS_PER_RUN) return json(res, 400, { error: `单次最多运行 ${DOUBAO_MAX_PROMPTS_PER_RUN} 题，以保护额度与限流` });
    doubaoRunInProgress = true;
    try {
      const runs = [];
      for (const [index, prompt] of selected.entries()) {
        if (index) await wait(DOUBAO_MIN_INTERVAL_MS);
        runs.push(await callDoubaoApi(prompt, store.brands[0], { webSearch }));
      }
      store.probeRuns.unshift(...runs);
      audit("probe.doubao_api", { runCount: runs.length, model: DOUBAO_MODEL, webSearch, promptIds: selected.map((item) => item.id) });
      await persist();
      return json(res, 201, { runs, score: dashboard().apiScore, model: DOUBAO_MODEL, webSearch });
    } finally {
      doubaoRunInProgress = false;
    }
  }
  if (route(url, method) === "POST /api/probes/doubao/alignment-canary") {
    if (DOUBAO_TRANSPORT !== "node") return json(res, 400, { error: "Doubao App Alignment Canary 仅支持 DOUBAO_TRANSPORT=node" });
    if (!await doubaoApiConfigured()) return json(res, 400, { error: "请先在系统设置中配置豆包 API Key" });
    const input = await bodyOf(req);
    const requestedIds = Array.isArray(input.promptIds) ? [...new Set(input.promptIds)] : [];
    if (!requestedIds.length || requestedIds.length > 3) return json(res, 400, { error: "promptIds 必须包含 1 至 3 道当前启用问题" });
    const selected = store.prompts.filter((item) => item.active && requestedIds.includes(item.id));
    if (selected.length !== requestedIds.length) return json(res, 400, { error: "包含不存在或未启用的监测问题" });
    try {
      const result = await runDoubaoAppAlignmentCanary(selected);
      return json(res, 200, result);
    } catch (error) {
      return json(res, error?.httpStatus || 502, {
        error: "DOUBAO_APP_ALIGNMENT_CANARY_FAILED",
        message: error?.message || "Doubao App Alignment Canary 请求失败",
        httpStatus: error?.httpStatus || null,
      });
    }
  }
  if (route(url, method) === "GET /api/scores") return json(res, 200, dashboard().score);
  if (route(url, method) === "GET /api/published-contents") {
    const platform = url.searchParams.get("platform");
    const brand = url.searchParams.get("brand");
    const items = (store.publishedContents || []).filter((item) => (!platform || item.platform === platform) && (!brand || item.brand === brand));
    return json(res, 200, items);
  }
  if (route(url, method) === "POST /api/published-contents") {
    const input = await bodyOf(req);
    const createdAt = now();
    const item = normalizePublishedContent(input, { contentId: uid("content"), brand: input.brand || store.brands[0]?.id || null, createdAt });
    const validation = validatePublishedContent(item);
    if (!validation.valid) return json(res, 400, { error: "INVALID_PUBLISHED_CONTENT", details: validation.errors });
    store.publishedContents ||= [];
    store.publishedContents.push(item);
    audit("published_content.recorded", { contentId: item.contentId, platform: item.platform, hasPublishedAt: Boolean(item.publishedAt) });
    await persist();
    return json(res, 201, item);
  }
  if (route(url, method) === "GET /api/knowledge") return json(res, 200, store.knowledge);
  if (route(url, method) === "POST /api/knowledge") {
    const input = await bodyOf(req);
    const item = { id: uid("fact"), brandId: store.brands[0].id, type: input.type || "产品资料", title: input.title, facts: input.facts || [], sourceUrl: input.sourceUrl || "", status: input.status || "pending", assets: input.assets || { cover: "", images: [] }, approvedAt: input.status === "approved" ? now() : null };
    if (!item.title || !item.facts.length) return json(res, 400, { error: "资料标题和至少一条事实必填" });
    store.knowledge.push(item); audit("knowledge.created", { knowledgeId: item.id, status: item.status }); await persist(); return json(res, 201, item);
  }
  if (route(url, method) === "POST /api/knowledge/approve") {
    const { id } = await bodyOf(req); const item = store.knowledge.find((entry) => entry.id === id); if (!item) return json(res, 404, { error: "资料不存在" });
    item.status = "approved"; item.approvedAt = now(); audit("knowledge.approved", { knowledgeId: id }); await persist(); return json(res, 200, item);
  }
  if (route(url, method) === "GET /api/rules") return json(res, 200, store.rules);
  if (route(url, method) === "POST /api/rules") {
    const input = await bodyOf(req); const current = findRule(input.platform); if (!current) return json(res, 400, { error: "平台不受支持" });
    current.active = false;
    const next = { ...current, ...input, id: uid("rule"), version: input.version || `${current.version}+1`, active: true, updatedAt: now() };
    store.rules.push(next); audit("rule.versioned", { platform: input.platform, ruleId: next.id }); await persist(); return json(res, 201, next);
  }
  if (route(url, method) === "GET /api/topics") return json(res, 200, store.topics);
  if (route(url, method) === "POST /api/topics") {
    const input = await bodyOf(req); const approved = approvedFacts(store, input.factIds || []); if (!approved.length) return json(res, 400, { error: "选题必须关联至少一项审批资料" });
    const item = { id: uid("topic"), brandId: store.brands[0].id, title: input.title, sourcePromptId: input.sourcePromptId || null, opportunity: input.opportunity || "人工创建选题", audience: input.audience || "目标客户", intent: input.intent || "解决方案", cta: input.cta || "联系团队了解更多", prohibited: input.prohibited || [], factIds: approved.map((entry) => entry.id), platforms: input.platforms?.filter((platform) => PLATFORMS.includes(platform)) || PLATFORMS, status: "ready", createdAt: now() };
    if (!item.title) return json(res, 400, { error: "请输入选题标题" }); store.topics.push(item); audit("topic.created", { topicId: item.id }); await persist(); return json(res, 201, item);
  }
  if (route(url, method) === "GET /api/articles") return json(res, 200, store.articles);
  const generateMatch = path.match(/^\/api\/topics\/([^/]+)\/generate$/);
  if (method === "POST" && generateMatch) {
    const topic = store.topics.find((item) => item.id === generateMatch[1]); const input = await bodyOf(req); if (!topic) return json(res, 404, { error: "选题不存在" });
    const platform = input.platform; const rule = findRule(platform); const facts = approvedFacts(store, topic.factIds); if (!rule || !facts.length) return json(res, 400, { error: "缺少有效的平台规则或审批资料" });
    if (input.writer === "workbuddy") {
      const task = { id: uid("wbtask"), type: "write_article", status: "queued", topicId: topic.id, platform, ruleId: rule.id, factIds: facts.map((item) => item.id), createdAt: now(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      store.workerTasks.push(task); audit("workbuddy.task_queued", { taskId: task.id }); await persist(); return json(res, 202, { task, message: "已交给固定工作机；若未在十分钟内回传，可改为提交 Codex 写作队列。" });
    }
    const task = createCodexTask("write_article", { topicId: topic.id, platform, ruleId: rule.id, factIds: facts.map((item) => item.id) });
    audit("codex.write_task_queued", { taskId: task.id, topicId: topic.id }); await persist(); return json(res, 202, { task, message: "已进入 Codex 写作队列。请在 Codex 中执行该任务后回传稿件。" });
  }
  const reviewMatch = path.match(/^\/api\/articles\/([^/]+)\/review$/);
  if (method === "POST" && reviewMatch) {
    const article = findArticle(reviewMatch[1]); if (!article) return json(res, 404, { error: "文章不存在" });
    if (article.status === "waiting_codex_review") return json(res, 409, { error: "该文章已经在 Codex 审核队列中" });
    const task = createCodexTask("review_article", { articleId: article.id, platform: article.platform, ruleId: article.ruleId, factIds: article.citationFactIds });
    article.status = "waiting_codex_review"; article.updatedAt = now(); audit("codex.review_task_queued", { taskId: task.id, articleId: article.id }); await persist(); return json(res, 202, { task, article });
  }
  const scheduleMatch = path.match(/^\/api\/articles\/([^/]+)\/schedule$/);
  if (method === "POST" && scheduleMatch) {
    const article = findArticle(scheduleMatch[1]); const input = await bodyOf(req); if (!article) return json(res, 404, { error: "文章不存在" }); if (article.status !== "approved") return json(res, 409, { error: "只有审核通过的稿件可以排期" });
    const rule = store.rules.find((item) => item.id === article.ruleId); const sameDay = store.publicationJobs.filter((job) => job.platform === article.platform && job.status === "scheduled" && job.scheduledAt.slice(0, 10) === String(input.scheduledAt || "").slice(0, 10));
    if (sameDay.length >= rule.dailyLimit) return json(res, 409, { error: `该平台当日发布上限为 ${rule.dailyLimit} 篇` });
    const job = { id: uid("publish"), articleId: article.id, platform: article.platform, scheduledAt: input.scheduledAt || new Date(Date.now() + 3600_000).toISOString(), status: "scheduled", receiptUrl: null, createdAt: now() };
    store.publicationJobs.unshift(job); article.status = "scheduled"; audit("publication.scheduled", { articleId: article.id, jobId: job.id }); await persist(); return json(res, 201, job);
  }
  if (route(url, method) === "GET /api/publications") return json(res, 200, store.publicationJobs);
  const executeMatch = path.match(/^\/api\/publications\/([^/]+)\/execute$/);
  if (method === "POST" && executeMatch) {
    const input = await bodyOf(req); const job = store.publicationJobs.find((item) => item.id === executeMatch[1]); if (!job) return json(res, 404, { error: "发布任务不存在" });
    if (input.attentionRequired) { job.status = "paused"; job.pauseReason = input.attentionRequired; audit("publication.paused", { jobId: job.id, reason: job.pauseReason }); await persist(); return json(res, 200, job); }
    job.status = "published"; job.publishedAt = now(); job.receiptUrl = input.receiptUrl || `https://publisher.example/receipt/${job.id}`; const article = findArticle(job.articleId); if (article) article.status = "published";
    audit("publication.completed", { jobId: job.id, receiptUrl: job.receiptUrl }); await persist(); return json(res, 200, job);
  }
  if (route(url, method) === "GET /api/worker/tasks") {
    if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) return json(res, 401, { error: "工作机身份校验失败" });
    const task = store.workerTasks.find((item) => item.status === "queued"); return json(res, 200, task || null);
  }
  if (route(url, method) === "GET /api/codex/tasks") return json(res, 200, (store.codexTasks || []).filter((task) => task.status === "queued"));
  const codexTaskMatch = path.match(/^\/api\/codex\/tasks\/([^/]+)$/);
  if (method === "GET" && codexTaskMatch) {
    const task = (store.codexTasks || []).find((item) => item.id === codexTaskMatch[1]); if (!task) return json(res, 404, { error: "Codex 任务不存在" });
    const article = task.articleId ? findArticle(task.articleId) : null; const topic = store.topics.find((item) => item.id === (task.topicId || article?.topicId)); const rule = store.rules.find((item) => item.id === (task.ruleId || article?.ruleId)); const facts = approvedFacts(store, task.factIds || topic?.factIds || []);
    return json(res, 200, { task, topic, article, rule, approvedFacts: facts, instructions: task.type === "review_article" ? "逐项核验：文章所有事实均有批准资料支持；符合平台规则；不存在夸大承诺、禁用表达、明显重复或安全风险。返回 pass、issues 与 rewriteInstructions。" : "只用 approvedFacts 与 rule 写作，不得添加外部事实；正文须含 AIGC 辅助创作声明。返回 title、summary、body。" });
  }
  const codexCompleteMatch = path.match(/^\/api\/codex\/tasks\/([^/]+)\/complete$/);
  if (method === "POST" && codexCompleteMatch) {
    const task = (store.codexTasks || []).find((item) => item.id === codexCompleteMatch[1]); const input = await bodyOf(req); if (!task) return json(res, 404, { error: "Codex 任务不存在" }); if (task.status !== "queued") return json(res, 409, { error: "任务已完成或已取消" });
    if (task.type === "write_article") {
      const topic = store.topics.find((item) => item.id === task.topicId); const rule = store.rules.find((item) => item.id === task.ruleId); const facts = approvedFacts(store, task.factIds);
      if (!input.title || !input.body) return json(res, 400, { error: "Codex 写作结果缺少标题或正文" });
      const article = articleFromOutput(topic, task.platform, facts, rule, { title: input.title, summary: input.summary || "", body: input.body, provider: "codex" }, "codex");
      store.articles.unshift(article); task.status = "completed"; task.articleId = article.id; task.result = { articleId: article.id }; task.completedAt = now(); audit("codex.write_task_completed", { taskId: task.id, articleId: article.id }); await persist(); return json(res, 201, article);
    }
    const article = findArticle(task.articleId); if (!article) return json(res, 404, { error: "审核文章不存在" }); const topic = store.topics.find((item) => item.id === article.topicId); const facts = approvedFacts(store, topic.factIds); const rule = store.rules.find((item) => item.id === article.ruleId);
    const baseline = baselineReview(article, facts, rule); const requestedPass = input.pass === true; const review = { id: uid("review"), provider: "codex", pass: requestedPass && baseline.pass, issues: [...baseline.issues, ...(input.issues || [])], rewriteInstructions: input.rewriteInstructions || [], checks: baseline.checks, moderation: baseline.moderation, at: now() };
    article.reviews.unshift(review); article.updatedAt = now();
    if (review.pass) article.status = "approved"; else if (article.revisionCount >= 2) article.status = "exception"; else { article.status = "needs_revision"; article.revisionCount += 1; }
    task.status = "completed"; task.completedAt = now(); task.result = { pass: review.pass, articleStatus: article.status }; audit("codex.review_task_completed", { taskId: task.id, articleId: article.id, pass: review.pass }); await persist(); return json(res, 200, article);
  }
  const completeMatch = path.match(/^\/api\/worker\/tasks\/([^/]+)\/complete$/);
  if (method === "POST" && completeMatch) {
    if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) return json(res, 401, { error: "工作机身份校验失败" });
    const task = store.workerTasks.find((item) => item.id === completeMatch[1]); const input = await bodyOf(req); if (!task) return json(res, 404, { error: "任务不存在" });
    const topic = store.topics.find((item) => item.id === task.topicId); const rule = store.rules.find((item) => item.id === task.ruleId); const facts = approvedFacts(store, task.factIds);
    if (!input.title || !input.body) return json(res, 400, { error: "WorkBuddy 回传缺少标题或正文" });
    const article = articleFromOutput(topic, task.platform, facts, rule, { title: input.title, summary: input.summary || "", body: input.body, provider: "workbuddy" }, "workbuddy");
    store.articles.unshift(article); task.status = "completed"; task.articleId = article.id; task.completedAt = now(); audit("workbuddy.task_completed", { taskId: task.id, articleId: article.id }); await persist(); return json(res, 201, article);
  }
  if (route(url, method) === "POST /api/worker/heartbeat") {
    if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) return json(res, 401, { error: "工作机身份校验失败" });
    const input = await bodyOf(req); const agent = { machineId: input.machineId || "windows-publisher-01", status: input.status || "online", capabilities: input.capabilities || ["workbuddy", "browser_handoff"], lastSeenAt: now() };
    store.agents = [agent]; audit("agent.heartbeat", agent); await persist(); return json(res, 200, agent);
  }
  if (route(url, method) === "GET /api/audit") return json(res, 200, store.audit);
  return json(res, 404, { error: "接口不存在" });
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
async function staticFile(res, pathname) {
  const safe = normalizePath(pathname === "/" ? "/index.html" : pathname).replace(/^([/\\])+/, "");
  const file = join(PUBLIC_PATH, safe);
  if (!file.startsWith(PUBLIC_PATH)) return json(res, 403, { error: "非法路径" });
  try { const content = await readFile(file); res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream" }); res.end(content); }
  catch { const content = await readFile(join(PUBLIC_PATH, "index.html")); res.writeHead(200, { "content-type": mime[".html"] }); res.end(content); }
}

await loadStore();
const competitorService = await createCompetitorService({ path: join(ROOT, "data", "competitors.json"), getSource: () => store });
const publishService = await createPublishService({ root: ROOT, getSource: () => store });
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try { if (url.pathname.startsWith("/api/")) await api(req, res, url); else await staticFile(res, url.pathname); }
  catch (error) { console.error(error); json(res, 500, { error: error.message || "服务器错误" }); }
}).listen(PORT, HOST, () => console.log(`GEO Content Ops running at http://${HOST}:${PORT}`));

// A service restart never blindly resubmits an interrupted prompt. Questions
// that already exhausted their permitted retries are preserved as audited
// failures; only eligible browser-recovery runs are restarted. A user-paused
// run remains paused until the user chooses to continue it.
queueMicrotask(() => {
  const recoveryRun = store.browserMonitorRuns?.find((run) => run.status === "preparing_browser");
  if (recoveryRun) startPlatformWebMonitor(recoveryRun);
});
