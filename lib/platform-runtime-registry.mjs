import { PlatformNotImplementedError } from "./platform-registry.mjs";

export class PlatformRuntimeRegistry {
  constructor(platformRegistry) {
    this.platformRegistry = platformRegistry;
    this.runtimeByPlatform = new Map();
  }

  getPlatformRuntime(platform) {
    const definition = this.platformRegistry.requirePlatform(platform);
    const existing = this.runtimeByPlatform.get(platform);
    if (existing) return existing;
    const runtime = definition.runtimeFactory({ platform, definition });
    if (!runtime) throw new PlatformNotImplementedError(platform);
    this.runtimeByPlatform.set(platform, runtime);
    return runtime;
  }

  getExistingPlatformRuntime(platform) { return this.runtimeByPlatform.get(platform) || null; }
  hasPlatformRuntime(platform) { return this.runtimeByPlatform.has(platform); }
  registeredRuntimePlatforms() { return [...this.runtimeByPlatform.keys()]; }
}
