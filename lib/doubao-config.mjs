import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const truthy = (value) => ["1", "true", "yes"].includes(String(value || "").toLowerCase());

function configuredInteger(environment, names, fallback, minimum, maximum) {
  for (const name of names) {
    const value = Number(environment[name]);
    if (Number.isFinite(value)) return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
  }
  return fallback;
}

function configuredNumber(environment, names, fallback, minimum, maximum) {
  for (const name of names) {
    const value = Number(environment[name]);
    if (Number.isFinite(value)) return Math.min(maximum, Math.max(minimum, value));
  }
  return fallback;
}

function configuredPath(root, value, fallback) {
  const selected = String(value || fallback).trim();
  return isAbsolute(selected) ? selected : resolve(root, selected);
}

function localEnvironment(root, environment) {
  try {
    const fileValues = Object.fromEntries(readFileSync(join(root, ".env"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
        return [key, value];
      }));
    return { ...fileValues, ...environment };
  } catch {
    return environment;
  }
}

/**
 * One source of truth for the real Doubao web executor. The legacy aliases
 * keep existing local environments working while the documented names remain
 * short and explicit.
 */
export function readDoubaoWebConfig({ root, environment = process.env } = {}) {
  if (!root) throw new Error("readDoubaoWebConfig requires the project root");
  const values = localEnvironment(root, environment);
  const debugMode = truthy(values.DOUBAO_DEBUG_MODE);
  return Object.freeze({
    url: String(values.DOUBAO_URL || "https://www.doubao.com/chat/").trim(),
    profileDir: configuredPath(root, values.DOUBAO_PROFILE_PATH, join("data", "doubao-profile")),
    debugDir: configuredPath(root, values.DOUBAO_DEBUG_PATH, join("data", "doubao-debug")),
    // Four persistent Pages are the verified production setting for this
    // account. It can still be lowered or raised (within the safe bound) in
    // the local environment when an operator deliberately changes it.
    concurrency: configuredInteger(values, ["DOUBAO_CONCURRENCY", "DOUBAO_WORKER_CONCURRENCY"], 4, 1, 5),
    maxRetries: configuredInteger(values, ["MAX_RETRIES", "MAX_QUESTION_RETRIES"], 2, 0, 3),
    answerStartTimeoutMs: configuredInteger(values, ["ANSWER_START_TIMEOUT"], 30_000, 5_000, 90_000),
    answerCompleteTimeoutMs: configuredInteger(values, ["ANSWER_COMPLETE_TIMEOUT"], 120_000, 15_000, 300_000),
    textStableMs: configuredInteger(values, ["TEXT_STABLE_MS", "ANSWER_STABLE_WINDOW"], 1_800, 1_500, 2_500),
    typingDelayMs: configuredInteger(values, ["DOUBAO_TYPING_DELAY"], 25, 15, 80),
    retryRecoveryCooldownMs: configuredInteger(values, ["DOUBAO_RETRY_RECOVERY_COOLDOWN"], 5_000, 1_000, 20_000),
    platformUnavailableThreshold: configuredInteger(values, ["DOUBAO_PLATFORM_UNAVAILABLE_THRESHOLD"], 3, 2, 10),
    diagnosticBaselineRuns: configuredInteger(values, ["GEO_DIAGNOSTIC_BASELINE_RUNS"], 5, 1, 20),
    geoDropAbsoluteThreshold: configuredNumber(values, ["GEO_DROP_ABSOLUTE_THRESHOLD"], 0.10, 0.01, 1),
    geoDropRelativeThreshold: configuredNumber(values, ["GEO_DROP_RELATIVE_THRESHOLD"], 0.25, 0.01, 1),
    debugMode,
    debugTrace: debugMode && truthy(values.DOUBAO_DEBUG_TRACE),
  });
}
