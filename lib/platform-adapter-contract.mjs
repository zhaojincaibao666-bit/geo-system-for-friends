// The shared runner invokes `ask` today, while these primitives keep each
// platform adapter independently testable and ready for future mode changes.
export const PLATFORM_ADAPTER_METHODS = Object.freeze([
  "inspectPageState",
  "ensureLoggedIn",
  "startNewConversation",
  "confirmNewConversation",
  "prepareMode",
  "verifyMode",
  "submitPrompt",
  "waitForAnswerStart",
  "waitForAnswerComplete",
  "getAnswer",
  "getCitations",
  "detectBlockingState",
  "waitForBlockingStateClear",
  "recoverPage",
]);

export function assertPlatformAdapterContract(adapter, platform = "unknown") {
  const missing = PLATFORM_ADAPTER_METHODS.filter((method) => typeof adapter?.[method] !== "function");
  if (!missing.length) return true;
  const error = new Error(`PLATFORM_ADAPTER_INTERFACE_ERROR: ${platform} missing ${missing.join(", ")}`);
  error.code = "PLATFORM_ADAPTER_INTERFACE_ERROR";
  error.platform = platform;
  error.missingMethods = missing;
  throw error;
}
