import { findMatchedBrandAliases, classifyBrowserVisibilityAnswer, recommendationEvidence } from "./core.mjs";
import { browserMonitorVisibilitySummary } from "./browser-monitor-run.mjs";
import { buildCitationSourceSummary } from "./doubao-citation-analysis.mjs";
import { buildGeoDropDiagnostics } from "./geo-drop-diagnostics.mjs";
import { buildObservabilityQuality } from "./observability-quality.mjs";
import { buildAccountAbComparison } from "./doubao-account-ab.mjs";

export const VISIBILITY_CLASSIFICATION_VERSION = "browser_visibility_v6";

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function complete(run) {
  const questions = run.questions || [];
  return ["completed", "completed_with_errors"].includes(run.status)
    && Number(run.completed) === Number(run.total)
    && questions.length === Number(run.total)
    && questions.every((question) => ["success", "failed", "invalid"].includes(question.status));
}

function browserQuestionJudgement(question, brand) {
  const judgement = classifyBrowserVisibilityAnswer(question.rawAnswer, brand);
  return {
    judgement,
    mentionResult: {
      brandMentioned: Boolean(judgement.brandMentioned),
      matchedBrandAliases: judgement.matchedBrandAliases || [],
    },
    recommendationResult: {
      recommendation: judgement.recommendation || "none",
      position: judgement.position ?? null,
      recommendationEvidence: judgement.recommendationEvidence || null,
    },
  };
}

function probeJudgement(run, brand) {
  if (run.source === "browser_observed") return classifyBrowserVisibilityAnswer(run.rawAnswer, brand);
  const matchedBrandAliases = findMatchedBrandAliases(run.rawAnswer, brand);
  return {
    brandMentioned: matchedBrandAliases.length > 0,
    matchedBrandAliases,
    ...recommendationEvidence(run.rawAnswer, brand),
  };
}

// Rebuild only derived visibility fields.  Raw answers, citations, timing and
// audit events remain untouched, so every corrected result remains traceable
// to the original captured answer.
export function rejudgeStoredVisibility(store, { diagnosticConfig = {} } = {}) {
  const brand = store?.brands?.[0];
  if (!brand) return { changed: false, aliasesAdded: 0, probeRunsUpdated: 0, questionsUpdated: 0, summariesUpdated: 0, experimentsUpdated: 0 };
  let changed = false;
  let aliasesAdded = 0;
  let probeRunsUpdated = 0;
  let questionsUpdated = 0;
  let summariesUpdated = 0;
  let experimentsUpdated = 0;

  brand.aliases ||= [];
  for (const run of store.probeRuns || []) {
    if (!String(run.rawAnswer || "").trim()) continue;
    const judgement = probeJudgement(run, brand);
    const fields = run.source === "browser_observed"
      ? judgement
      : {
        brandMentioned: judgement.brandMentioned,
        matchedBrandAliases: judgement.matchedBrandAliases,
        recommendation: judgement.recommendation,
        position: judgement.position,
        recommendationEvidence: judgement.recommendationEvidence,
      };
    let runChanged = false;
    for (const [key, value] of Object.entries(fields)) {
      if (!same(run[key], value)) { run[key] = value; runChanged = true; }
    }
    if (run.visibilityClassificationVersion !== VISIBILITY_CLASSIFICATION_VERSION) {
      run.visibilityClassificationVersion = VISIBILITY_CLASSIFICATION_VERSION;
      runChanged = true;
    }
    if (runChanged) { probeRunsUpdated += 1; changed = true; }
  }

  for (const monitorRun of store.browserMonitorRuns || []) {
    let monitorRunChanged = false;
    for (const question of monitorRun.questions || []) {
      if (question.status !== "success" || !String(question.rawAnswer || "").trim()) continue;
      const { mentionResult, recommendationResult } = browserQuestionJudgement(question, brand);
      let questionChanged = false;
      if (!same(question.mentionResult, mentionResult)) { question.mentionResult = mentionResult; questionChanged = true; }
      if (!same(question.recommendationResult, recommendationResult)) {
        question.recommendationResult = recommendationResult;
        questionChanged = true;
      }
      if (question.visibilityClassificationVersion !== VISIBILITY_CLASSIFICATION_VERSION) {
        question.visibilityClassificationVersion = VISIBILITY_CLASSIFICATION_VERSION;
        questionChanged = true;
      }
      if (questionChanged) { questionsUpdated += 1; monitorRunChanged = true; }
    }
    if (!complete(monitorRun)) continue;
    const sourceSummary = buildCitationSourceSummary(monitorRun, brand);
    const visibilitySummary = browserMonitorVisibilitySummary({ ...monitorRun, sourceSummary }, brand);
    if (!same(monitorRun.sourceSummary, sourceSummary)) { monitorRun.sourceSummary = sourceSummary; monitorRunChanged = true; }
    if (!same(monitorRun.visibilitySummary, visibilitySummary)) { monitorRun.visibilitySummary = visibilitySummary; monitorRunChanged = true; }
    if (!monitorRun.observability) { monitorRun.observability = buildObservabilityQuality(monitorRun); monitorRunChanged = true; }
    if (monitorRunChanged) {
      monitorRun.geoDropDiagnostics = null;
      summariesUpdated += 1;
      changed = true;
    }
  }

  // Diagnostics deliberately read the corrected per-question results. Build
  // them only after every run has been rejudged, so their baselines agree.
  for (const monitorRun of store.browserMonitorRuns || []) {
    if (!complete(monitorRun)) continue;
    const diagnostics = buildGeoDropDiagnostics({
      currentRun: monitorRun,
      historicalRuns: store.browserMonitorRuns || [],
      prompts: store.prompts || [],
      brand,
      config: diagnosticConfig,
    });
    // `generatedAt` is metadata, not a diagnostic result. Preserve it when
    // the substantive result is unchanged so a normal service restart does
    // not rewrite every historical run.
    const previousDiagnostics = monitorRun.geoDropDiagnostics;
    const sameDiagnostics = previousDiagnostics && same(
      { ...previousDiagnostics, generatedAt: null },
      { ...diagnostics, generatedAt: null },
    );
    if (sameDiagnostics) diagnostics.generatedAt = previousDiagnostics.generatedAt;
    if (!same(previousDiagnostics, diagnostics)) {
      monitorRun.geoDropDiagnostics = diagnostics;
      changed = true;
    }
  }

  for (const experiment of store.doubaoAccountExperiments || []) {
    if (!experiment.runAId || !experiment.runBId) continue;
    const runA = (store.browserMonitorRuns || []).find((run) => run.id === experiment.runAId);
    const runB = (store.browserMonitorRuns || []).find((run) => run.id === experiment.runBId);
    if (!runA || !runB) continue;
    const comparison = buildAccountAbComparison(runA, runB, { experimentId: experiment.id, brand });
    if (!same(experiment.comparison, comparison)) {
      experiment.comparison = comparison;
      experimentsUpdated += 1;
      changed = true;
    }
  }

  return { changed, aliasesAdded, probeRunsUpdated, questionsUpdated, summariesUpdated, experimentsUpdated };
}
