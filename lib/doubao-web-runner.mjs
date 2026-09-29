import {
  DoubaoConversationCollisionError,
  DoubaoHumanActionRequiredError,
  DoubaoLoginRequiredError,
  DoubaoRateLimitedError,
} from "./doubao-adapter.mjs";
import { executeWebPlatformRun } from "./web-platform-runner.mjs";

// Compatibility entrypoint: server routes and existing tests retain their
// Doubao-facing API while queue, retry and verification control is shared.
export function executeDoubaoWebRun({ browserManager, ...options }) {
  return executeWebPlatformRun({
    ...options,
    platform: "doubao_web",
    platformMode: "chat",
    runtime: browserManager,
    errorPolicy: {
      isLoginRequired: (error) => error instanceof DoubaoLoginRequiredError || error?.code === "DOUBAO_LOGIN_REQUIRED",
      isHumanActionRequired: (error) => error instanceof DoubaoHumanActionRequiredError
        || ["DOUBAO_IMAGE_VERIFICATION", "DOUBAO_SLIDER_VERIFICATION", "DOUBAO_SMS_VERIFICATION", "DOUBAO_ACCOUNT_SECURITY", "DOUBAO_REGION_RESTRICTED"].includes(error?.code),
      isRateLimited: (error) => error instanceof DoubaoRateLimitedError || error?.code === "DOUBAO_SEND_RATE_LIMIT",
      isAnswerStartFailure: (error) => error?.code === "DOUBAO_ANSWER_NOT_STARTED",
      // Once a mismatching/unknown user bubble exists, retrying would create a
      // duplicate external question. Record the integrity failure once.
      isNonRetryable: (error) => error?.sentPromptMayExist === true,
      createConversationCollisionError: (conversationId, details) => new DoubaoConversationCollisionError(conversationId, details),
    },
  });
}
