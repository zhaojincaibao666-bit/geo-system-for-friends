import { PLATFORM_IDS, isPlatformId, isPlatformMode } from "./platform.mjs";
import { DoubaoAdapter } from "./doubao-adapter.mjs";
import { DeepSeekAdapter } from "./deepseek-adapter.mjs";

export class PlatformNotImplementedError extends Error {
  constructor(platform) {
    super(`Platform runtime is not implemented: ${platform}`);
    this.name = "PlatformNotImplementedError";
    this.code = "PLATFORM_NOT_IMPLEMENTED";
    this.platform = platform;
  }
}

function validateDefinition(definition) {
  if (!isPlatformId(definition?.id)) throw new Error(`PLATFORM_DEFINITION_INVALID: ${definition?.id || "missing id"}`);
  if (!String(definition.displayName || "").trim()) throw new Error(`PLATFORM_DEFINITION_INVALID: ${definition.id} needs displayName`);
  if (!Array.isArray(definition.supportedModes) || !definition.supportedModes.length || !definition.supportedModes.every(isPlatformMode)) {
    throw new Error(`PLATFORM_DEFINITION_INVALID: ${definition.id} has invalid supportedModes`);
  }
  if (!definition.supportedModes.includes(definition.defaultMode)) throw new Error(`PLATFORM_DEFINITION_INVALID: ${definition.id} defaultMode is unsupported`);
  if (typeof definition.runtimeFactory !== "function") throw new Error(`PLATFORM_DEFINITION_INVALID: ${definition.id} needs runtimeFactory`);
  return Object.freeze({ ...definition, supportedModes: Object.freeze([...definition.supportedModes]) });
}

export class PlatformRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const definition of definitions) this.register(definition);
  }

  register(definition) {
    const validated = validateDefinition(definition);
    if (this.definitions.has(validated.id)) throw new Error(`PLATFORM_ALREADY_REGISTERED: ${validated.id}`);
    this.definitions.set(validated.id, validated);
    return validated;
  }

  getPlatform(platform) { return this.definitions.get(platform) || null; }
  requirePlatform(platform) {
    const definition = this.getPlatform(platform);
    if (!definition) throw new PlatformNotImplementedError(platform);
    return definition;
  }
  listRegistered() { return [...this.definitions.values()]; }
  isRegistered(platform) { return this.definitions.has(platform); }
}

export function createDoubaoPlatformDefinition({ runtimeFactory }) {
  return {
    id: "doubao_web",
    displayName: "豆包",
    supportedModes: ["chat"],
    defaultMode: "chat",
    adapterFactory: (options) => new DoubaoAdapter(options),
    runtimeFactory,
    profileKey: "doubao_web",
    defaultConcurrency: 4,
  };
}

export function createDeepSeekPlatformDefinition({ runtimeFactory }) {
  return {
    id: "deepseek_web",
    displayName: "DeepSeek",
    supportedModes: ["chat", "web_search"],
    defaultMode: "web_search",
    adapterFactory: (options) => new DeepSeekAdapter(options),
    runtimeFactory,
    profileKey: "deepseek_web",
    defaultConcurrency: 4,
    capabilities: { browserSmoke: true, monitorRun: true },
  };
}

// These are canonical future identifiers only. They are deliberately absent
// from the runtime registry until a real adapter and runtime exist.
export const FUTURE_PLATFORM_IDS = Object.freeze(PLATFORM_IDS.filter((id) => id !== "doubao_web"));
