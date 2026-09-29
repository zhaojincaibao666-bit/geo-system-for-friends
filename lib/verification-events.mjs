const ACTIVE = "active";

export function hasVerificationBinding(action) {
  return Boolean(
    action?.runId
    && action?.workerId
    && action?.pageId
    && action?.questionId
    && action?.verificationType
    && action?.detectedAt,
  );
}

export function validateVerificationEvent({ run, action, browserManager = null, serverInstanceId = null } = {}) {
  const reasons = [];
  if (!action || action.active !== true || action.status !== ACTIVE) reasons.push("event_not_active");
  if (!run || action?.runId !== run.id) reasons.push("run_missing_or_mismatch");
  if (!hasVerificationBinding(action)) reasons.push("binding_incomplete");
  if (serverInstanceId && action?.serverInstanceId !== serverInstanceId) reasons.push("server_instance_mismatch");
  const question = run?.questions?.find((item) => item.promptId === action?.questionId);
  if (!question || question.status !== "needs_verification") reasons.push("question_not_waiting_for_verification");
  if (question && (question.workerId !== action.workerId || question.pageId !== action.pageId)) reasons.push("question_binding_mismatch");
  const worker = browserManager?.getWorker?.(action?.workerId) || null;
  if (browserManager) {
    if (!worker) reasons.push("worker_not_found");
    else if (worker.pageId !== action.pageId || !worker.page || worker.page.isClosed?.()) reasons.push("worker_page_not_found");
  }
  return { valid: reasons.length === 0, reasons, question, worker };
}

export function activeVerificationEvents(run, options = {}) {
  return (run?.humanActions || []).filter((action) => validateVerificationEvent({ run, action, ...options }).valid);
}

export function invalidateVerificationEvent(action, verificationLog, status, reason, at) {
  action.active = false;
  action.status = status;
  action.invalidatedAt = at;
  action.invalidationReason = reason;
  const event = (verificationLog || []).find((item) => item.verification_event_id === action.verificationEventId);
  if (event) {
    event.status = status;
    event.invalidated_at = at;
    event.invalidation_reason = reason;
  }
}

export function reconcileVerificationEvents(run, { browserManager = null, serverInstanceId = null, at = new Date().toISOString(), afterRestart = false } = {}) {
  let changed = false;
  run.humanActions ||= [];
  run.verificationLog ||= [];
  for (const action of run.humanActions) {
    if (!action.active) continue;
    const result = validateVerificationEvent({ run, action, browserManager, serverInstanceId });
    if (result.valid) continue;
    const status = afterRestart || result.reasons.includes("server_instance_mismatch") ? "orphaned_after_restart"
      : result.reasons.includes("binding_incomplete") ? "orphaned"
        : "stale";
    invalidateVerificationEvent(action, run.verificationLog, status, result.reasons.join(","), at);
    changed = true;
  }
  const active = activeVerificationEvents(run, { browserManager, serverInstanceId });
  run.humanAction = active.at(-1) || null;
  if (run.status === "needs_human_action" && !active.length) {
    run.status = "paused";
    run.pausedReason = "人工验证事件已失效：当前没有绑定到本服务 Worker/Page/题目的有效验证。";
    run.updatedAt = at;
    changed = true;
  }
  return { changed, active };
}
