export class PlatformRunAlreadyActiveError extends Error {
  constructor(platform, activeRunId) {
    super(`PLATFORM_RUN_ALREADY_ACTIVE: ${platform} is occupied by ${activeRunId}`);
    this.name = "PlatformRunAlreadyActiveError";
    this.code = "PLATFORM_RUN_ALREADY_ACTIVE";
    this.platform = platform;
    this.activeRunId = activeRunId;
  }
}

export class ActivePlatformRunRegistry {
  constructor() { this.activeRunsByPlatform = new Map(); }
  register(platform, runId) {
    const existing = this.activeRunsByPlatform.get(platform);
    if (existing && existing !== runId) throw new PlatformRunAlreadyActiveError(platform, existing);
    this.activeRunsByPlatform.set(platform, runId);
    return { platform, runId };
  }
  isPlatformRunActive(platform) { return this.activeRunsByPlatform.has(platform); }
  getActiveRunId(platform) { return this.activeRunsByPlatform.get(platform) || null; }
  release(platform, runId = null) {
    const existing = this.activeRunsByPlatform.get(platform);
    if (!existing || (runId && existing !== runId)) return false;
    this.activeRunsByPlatform.delete(platform);
    return true;
  }
}
