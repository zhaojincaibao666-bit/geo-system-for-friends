const SEARCH_LABEL = /联网|网页|搜索|search|online|web|深度思考|deep\s*think/i;

function explicitState(control) {
  const values = [control.ariaPressed, control.ariaChecked, control.dataState, control.checked];
  if (values.some((value) => value === true || value === "true" || value === "on" || value === "checked")) return "ON";
  if (values.some((value) => value === false || value === "false" || value === "off" || value === "unchecked")) return "OFF";
  return "UNKNOWN";
}

function isExplicitToggle(control) {
  return control.role === "switch" || control.type === "checkbox"
    || control.ariaPressed !== null || control.ariaChecked !== null || control.dataState !== null || typeof control.checked === "boolean";
}

/**
 * Classify search capability from concrete, visible UI evidence. It never
 * assumes that an absent legacy toggle means search is disabled.
 */
export function classifyDoubaoSearchCapability({ readiness = {}, controls = [], defaultCapabilityEvidence = [] } = {}) {
  const pageReady = readiness.loginStatus === "logged_in" && readiness.pageState === "ready" && readiness.readyForPrompt === true;
  const composerReady = Boolean(readiness.inputReady);
  const visibleControls = controls.filter((control) => control?.visible && SEARCH_LABEL.test(String(control.text || "")));
  const evidence = [
    { kind: "page_readiness", loginStatus: readiness.loginStatus || "unknown", pageState: readiness.pageState || "unknown", readyForPrompt: Boolean(readiness.readyForPrompt) },
    { kind: "composer", ready: composerReady },
    ...visibleControls.map((control) => ({ kind: "search_control", ...control })),
    ...defaultCapabilityEvidence.map((item) => ({ kind: "default_capability", ...item })),
  ];
  const base = { pageReady, composerReady, searchControlPresent: visibleControls.length > 0, evidence };
  if (readiness.loginStatus !== "logged_in") return { ...base, searchCapability: "UNAVAILABLE", searchModeModel: "UNKNOWN", explicitState: "UNKNOWN", reason: "LOGIN_NOT_READY" };
  if (!pageReady || !composerReady) return { ...base, searchCapability: "UNAVAILABLE", searchModeModel: "UNKNOWN", explicitState: "UNKNOWN", reason: "PAGE_OR_COMPOSER_NOT_READY" };

  const toggles = visibleControls.filter(isExplicitToggle);
  if (toggles.length) {
    const states = toggles.map(explicitState);
    if (states.includes("OFF")) return { ...base, searchCapability: "UNAVAILABLE", searchModeModel: "EXPLICIT_TOGGLE", explicitState: "OFF", reason: "EXPLICIT_SEARCH_TOGGLE_OFF" };
    if (states.every((state) => state === "ON")) return { ...base, searchCapability: "AVAILABLE", searchModeModel: "EXPLICIT_TOGGLE", explicitState: "ON", reason: "EXPLICIT_SEARCH_TOGGLE_ON" };
    return { ...base, searchCapability: "UNKNOWN", searchModeModel: "EXPLICIT_TOGGLE", explicitState: "UNKNOWN", reason: "EXPLICIT_SEARCH_TOGGLE_STATE_UNKNOWN" };
  }
  if (visibleControls.length) return { ...base, searchCapability: "AVAILABLE", searchModeModel: "SEARCH_ENTRY", explicitState: "NOT_APPLICABLE", reason: "VISIBLE_SEARCH_ENTRY" };
  if (defaultCapabilityEvidence.length) return { ...base, searchCapability: "AVAILABLE", searchModeModel: "DEFAULT_CAPABILITY", explicitState: "NOT_APPLICABLE", reason: "DEFAULT_CAPABILITY_EVIDENCE" };
  return { ...base, searchCapability: "UNKNOWN", searchModeModel: "UNKNOWN", explicitState: "UNKNOWN", reason: "NO_RELIABLE_SEARCH_CAPABILITY_EVIDENCE" };
}
