export const verificationNotificationEventId = (action) => action?.verificationEventId || `${action?.runId || "run"}:${action?.workerId || "worker"}:${action?.questionId || "question"}:${action?.detectedAt || action?.requestedAt || "unknown"}`;

// Side effects are injected so development tests can verify the exact
// once-per-event contract without touching browser sound or notifications.
export function dispatchVerificationNotifications({ actions = [], progress = {}, hasSent, markSent, playSound, showDesktopNotification }) {
  const emitted = [];
  for (const action of actions.filter((item) => item?.active)) {
    const eventId = verificationNotificationEventId(action);
    if (!hasSent(eventId, "sound")) {
      markSent(eventId, "sound");
      playSound(action);
      emitted.push({ eventId, channel: "sound" });
    }
    if (!hasSent(eventId, "desktop")) {
      const delivered = showDesktopNotification(action, progress);
      if (delivered) {
        markSent(eventId, "desktop");
        emitted.push({ eventId, channel: "desktop" });
      }
    }
  }
  return emitted;
}
