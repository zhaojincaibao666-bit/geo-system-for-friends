import { isAbsolute, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

function configuredInteger(values, name, fallback, minimum, maximum) {
  const value = Number(values[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.trunc(value))) : fallback;
}

function configuredPath(root, value, fallback) {
  const selected = String(value || fallback).trim();
  return isAbsolute(selected) ? selected : resolve(root, selected);
}

function localEnvironment(root, environment) {
  try {
    const fileValues = Object.fromEntries(readFileSync(join(root, ".env"), "utf8")
      .split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^("|')(.*)\1$/, "$2")];
      }));
    return { ...fileValues, ...environment };
  } catch { return environment; }
}

export function readDeepSeekWebConfig({ root, environment = process.env } = {}) {
  if (!root) throw new Error("readDeepSeekWebConfig requires the project root");
  const values = localEnvironment(root, environment);
  return Object.freeze({
    platform: "deepseek_web",
    displayName: "DeepSeek",
    webUrl: String(values.DEEPSEEK_WEB_URL || "https://chat.deepseek.com/").trim(),
    profileDir: configuredPath(root, values.DEEPSEEK_PROFILE_DIR, join("data", "deepseek-profile")),
    debugDir: configuredPath(root, values.DEEPSEEK_DEBUG_DIR, join("data", "deepseek-debug")),
    concurrency: configuredInteger(values, "DEEPSEEK_CONCURRENCY", 4, 1, 5),
    navigationTimeoutMs: configuredInteger(values, "DEEPSEEK_NAVIGATION_TIMEOUT_MS", 45_000, 5_000, 120_000),
  });
}
