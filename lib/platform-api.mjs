import { PLATFORM_IDS, effectivePlatform, effectivePlatformMode, isPlatformId, isPlatformMode } from "./platform.mjs";

// Runtime registration remains the source of truth for executable platforms.
// This small read-only capability layer gives the UI a complete product map
// without pretending that future platforms have adapters or browser runtimes.
const PLATFORM_PRESENTATION = Object.freeze({
  doubao_web: { displayName: "豆包", supportedModes: ["chat"], defaultMode: "chat", capabilities: { browserSmoke: true, monitorRun: true } },
  deepseek_web: { displayName: "DeepSeek", supportedModes: ["chat", "web_search"], defaultMode: "web_search", capabilities: { browserSmoke: false, monitorRun: false } },
  wenxin_web: { displayName: "文心一言", supportedModes: ["chat"], defaultMode: "chat", capabilities: { browserSmoke: false, monitorRun: false } },
});

export function listPlatformCapabilities(platformRegistry) {
  return PLATFORM_IDS.map((id) => {
    const definition = platformRegistry?.getPlatform?.(id) || null;
    const presentation = PLATFORM_PRESENTATION[id];
    const capabilities = definition?.capabilities || presentation.capabilities;
    return { id, ...presentation, implemented: Boolean(definition || platformRegistry?.isRegistered?.(id)), capabilities };
  });
}

export function resolvePlatformSelection({ platform, platformMode, platformRegistry } = {}) {
  const id = String(platform || "doubao_web").trim();
  if (!isPlatformId(id)) return { ok: false, status: 400, error: "INVALID_PLATFORM", platform: id };
  const capability = listPlatformCapabilities(platformRegistry).find((item) => item.id === id);
  const mode = String(platformMode || capability.defaultMode).trim();
  if (!isPlatformMode(mode) || !capability.supportedModes.includes(mode)) {
    return { ok: false, status: 400, error: "INVALID_PLATFORM_MODE", platform: id, platformMode: mode, supportedModes: capability.supportedModes };
  }
  return { ok: true, platform: id, platformMode: mode, capability };
}

export function platformNotImplementedPayload(selection) {
  return {
    error: "PLATFORM_NOT_IMPLEMENTED",
    platform: selection.platform,
    platformMode: selection.platformMode,
    message: `${selection.capability?.displayName || selection.platform} 网页自动化尚未完成接入。`,
  };
}

export function runMatchesPlatformSelection(run, { platform, platformMode } = {}) {
  if (platform && effectivePlatform(run) !== platform) return false;
  if (platformMode && effectivePlatformMode(run) !== platformMode) return false;
  return true;
}

export function evidenceMatchesPlatformSelection(run, selection) {
  return Boolean(run) && runMatchesPlatformSelection(run, selection);
}
