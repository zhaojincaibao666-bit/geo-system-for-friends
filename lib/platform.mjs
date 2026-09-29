// Platform identity is intentionally resolved at read time so legacy records
// remain immutable while new records use explicit structured fields.
export const PLATFORM_IDS = Object.freeze([
  "doubao_web",
  "deepseek_web",
  "wenxin_web",
]);

export const PLATFORM_MODES = Object.freeze(["chat", "web_search"]);

export function isPlatformId(value) {
  return PLATFORM_IDS.includes(value);
}

export function isPlatformMode(value) {
  return PLATFORM_MODES.includes(value);
}

export function isLegacyDoubaoBrowserProbe(record) {
  return record?.source === "browser_observed"
    && record?.surface === "豆包"
    && typeof record?.browserMonitorRunId === "string"
    && record.browserMonitorRunId.trim().length > 0;
}

export function effectivePlatform(record) {
  if (isPlatformId(record?.platform)) return record.platform;
  // Browser monitor runs historically used provider as their sole platform
  // identifier. Keep that narrow compatibility contract for old runs.
  if (record?.provider === "doubao_web") return "doubao_web";
  // A probe is a confirmed legacy Doubao webpage projection only when it is
  // linked to a browser-monitor run. Surface text alone is never sufficient.
  if (isLegacyDoubaoBrowserProbe(record)) return "doubao_web";
  return null;
}

export function effectivePlatformMode(record) {
  if (isPlatformMode(record?.platformMode)) return record.platformMode;
  return effectivePlatform(record) === "doubao_web" ? "chat" : null;
}

// Only call this when creating a Doubao browser-monitor projection. It keeps
// the run and its linked probe record on the same explicit platform contract.
export function browserMonitorPlatformFields(run) {
  return {
    platform: effectivePlatform(run) || "doubao_web",
    platformMode: effectivePlatformMode(run) || "chat",
  };
}
