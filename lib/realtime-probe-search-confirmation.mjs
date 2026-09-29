/**
 * One-shot gate for a non-formal realtime probe.  This module knows nothing
 * about Playwright or prompts: callers supply the real mode verifier and the
 * human-confirmation wait.  An Enter key is therefore never proof of mode.
 */
export async function resolveRealtimeProbeSearchMode({ verify, waitForManualConfirmation, onPause = async () => {} } = {}) {
  const first = await verify();
  if (first?.ready) return { state: "VERIFIED", mode: first, manualConfirmationUsed: false };
  await onPause(first);
  const confirmation = await waitForManualConfirmation(first);
  if (confirmation?.cancelled) return { state: "CANCELLED", mode: first, manualConfirmationUsed: true };
  const second = await verify();
  return second?.ready
    ? { state: "VERIFIED", mode: second, manualConfirmationUsed: true }
    : { state: "UNVERIFIED", mode: second, manualConfirmationUsed: true };
}

/** Enforces a single send even if a caller accidentally invokes it repeatedly. */
export function createOneShotPromptGuard(send) {
  let sent = false;
  return {
    get questionSent() { return sent ? 1 : 0; },
    async sendOnce() {
      if (sent) throw Object.assign(new Error("PROBE_MAX_QUESTIONS_EXCEEDED"), { code: "PROBE_MAX_QUESTIONS_EXCEEDED" });
      sent = true;
      return send();
    },
  };
}
