export const BROWSER_SMOKE_PHASES = Object.freeze([
  "idle",
  "preparing",
  "ready",
  "waiting_for_login",
  "verification_required",
  "unknown",
  "failed",
]);

export function initialBrowserSmokeState() {
  return { phase: "idle", result: null, error: null, startedAt: null, completedAt: null };
}

export function transitionBrowserSmoke(state = initialBrowserSmokeState(), event = {}) {
  if (event.type === "START") return { phase: "preparing", result: null, error: null, startedAt: event.at || new Date().toISOString(), completedAt: null };
  if (event.type === "RESULT") {
    const phase = BROWSER_SMOKE_PHASES.includes(event.result?.status) ? event.result.status : "failed";
    return { phase, result: event.result || null, error: null, startedAt: state.startedAt, completedAt: event.at || new Date().toISOString() };
  }
  if (event.type === "FAIL") return { phase: "failed", result: null, error: event.error || "Smoke failed", startedAt: state.startedAt, completedAt: event.at || new Date().toISOString() };
  return state;
}
