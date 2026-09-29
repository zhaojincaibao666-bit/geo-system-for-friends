/**
 * Locators verified against the authenticated Doubao web UI on 2026-08-14.
 * Keep all browser-facing selectors here so a Doubao UI change has one edit
 * point.  These intentionally use visible text, placeholder, IDs, and data
 * attributes rather than layout- or position-based selectors.
 */
export const DOUBAO_LOCATOR_VERSION = "doubao-web-2026-08-14";

export const DOUBAO_PAGE_STATES = Object.freeze({
  READY: "ready",
  IMAGE_VERIFICATION: "image_verification",
  SLIDER_VERIFICATION: "slider_verification",
  LOGIN_REQUIRED: "login_required",
  SMS_VERIFICATION: "sms_verification",
  ACCOUNT_SECURITY: "account_security",
  RATE_LIMIT: "rate_limit",
  REGION_RESTRICTED: "region_restricted",
  SYSTEM_EXCEPTION: "system_exception",
  NETWORK_ERROR: "network_error",
  RESPONSE_ERROR: "response_error",
  PAGE_ERROR: "page_error",
  PAGE_NOT_READY: "page_not_ready",
});

const ERROR_TEXT = /系统异常|网络异常|加载失败|请求失败|服务异常/i;
const REGENERATE_TEXT = /重新生成|重新回答/i;
const IMAGE_VERIFICATION_TEXT = /请选择所有(?:符合上文描述|符合描述|包含).{0,40}图片|选择所有.{0,40}图片|图片验证|图形验证/i;
const SLIDER_VERIFICATION_TEXT = /拖拽到下方|拖动滑块|向右滑动|滑块验证|拼图验证/i;
const SMS_VERIFICATION_TEXT = /短信验证码|手机验证码|验证码已发送|输入验证码/i;
const ACCOUNT_SECURITY_TEXT = /账号安全|安全验证|身份验证|风险验证|安全中心/i;
const PAGE_LOADING_TEXT = /加载中|正在加载|初始化中|请稍候/i;

/**
 * The authenticated chat composer observed on 2026-09-17 is a ProseMirror
 * `DIV[contenteditable="true"]` without a textbox role. Older shells exposed
 * `role="textbox"`, so retain both shapes plus the textarea fallback. Never
 * make placeholder wording the condition for a logged-in state.
 */
export function getComposerLocator(page) {
  return page.locator('.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea, input[role="textbox"]');
}

export function selectDoubaoComposerCandidate(candidates = []) {
  const usable = candidates
    .filter((candidate) => candidate?.visible && candidate?.enabled && candidate?.editable)
    .map((candidate, index) => {
      const tag = String(candidate.tag || "").toUpperCase();
      const role = String(candidate.role || "").toLowerCase();
      const contentEditable = String(candidate.contentEditable || "").toLowerCase();
      const placeholder = candidate.placeholder || null;
      const ariaLabel = candidate.ariaLabel || null;
      let score = 0;
      if (role === "textbox") score += 40;
      if (contentEditable === "true") score += 40;
      if (tag === "TEXTAREA") score += 30;
      if (/发消息|消息/.test(`${placeholder || ""} ${ariaLabel || ""}`)) score += 10;
      return { ...candidate, index, tag, role: role || null, contentEditable: contentEditable || null, placeholder, ariaLabel, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return usable[0] || null;
}

/**
 * Returns the actual interactive composer plus non-sensitive diagnostic
 * metadata.  It deliberately records attributes only, never editor text.
 */
export async function inspectDoubaoComposer(page, { timeoutMs = 800 } = {}) {
  const candidates = getComposerLocator(page);
  const deadline = Date.now() + Math.max(80, timeoutMs);
  let observed = [];
  do {
    const count = await candidates.count().catch(() => 0);
    observed = [];
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      const [visible, enabled, editable, tag, role, contentEditable, placeholder, ariaLabel] = await Promise.all([
        locator.isVisible().catch(() => false),
        locator.isEnabled().catch(() => false),
        locator.isEditable().catch(() => false),
        locator.evaluate((node) => node.tagName).catch(() => null),
        locator.getAttribute("role").catch(() => null),
        locator.getAttribute("contenteditable").catch(() => null),
        locator.getAttribute("placeholder").catch(() => null),
        locator.getAttribute("aria-label").catch(() => null),
      ]);
      observed.push({ locator, visible, enabled, editable, tag, role, contentEditable, placeholder, ariaLabel });
    }
    const selected = selectDoubaoComposerCandidate(observed);
    if (selected) {
      return {
        locator: selected.locator,
        candidateCount: count,
        visibleCandidateCount: observed.filter((candidate) => candidate.visible).length,
        inputReady: true,
        locatorType: selected.tag === "TEXTAREA" ? "textarea" : `${selected.tag || "element"}[role=${selected.role || "none"}][contenteditable=${selected.contentEditable || "none"}]`,
        placeholder: selected.placeholder,
        ariaLabel: selected.ariaLabel,
        contentEditable: selected.contentEditable,
        visible: selected.visible,
        enabled: selected.enabled,
        editable: selected.editable,
      };
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 80));
  } while (Date.now() < deadline);
  return {
    locator: null,
    candidateCount: observed.length,
    visibleCandidateCount: observed.filter((candidate) => candidate.visible).length,
    inputReady: false,
    locatorType: null,
    placeholder: null,
    ariaLabel: null,
    contentEditable: null,
    visible: false,
    enabled: false,
    editable: false,
  };
}

export function deriveDoubaoReadiness({ url = "", bodyText = "", pageState = null, blocking = null, composer = null } = {}) {
  const urlReady = /^https:\/\/(?:www\.)?doubao\.com\/chat(?:\/|\?|$)/i.test(url);
  const inputReady = Boolean(composer?.inputReady);
  const verificationStatus = blocking?.requiresHumanAction ? "verification_required" : "none";
  const explicitLogin = pageState === DOUBAO_PAGE_STATES.LOGIN_REQUIRED || pageState === DOUBAO_PAGE_STATES.REGION_RESTRICTED;
  const pageFailure = [DOUBAO_PAGE_STATES.SYSTEM_EXCEPTION, DOUBAO_PAGE_STATES.NETWORK_ERROR, DOUBAO_PAGE_STATES.RESPONSE_ERROR, DOUBAO_PAGE_STATES.PAGE_ERROR].includes(pageState);
  const loadingStatus = !inputReady && !explicitLogin && !blocking?.requiresHumanAction && PAGE_LOADING_TEXT.test(bodyText) ? "loading" : "none";
  const loginStatus = blocking?.requiresHumanAction ? "verification_required"
    : explicitLogin ? "login_required"
      : urlReady && inputReady && !pageFailure ? "logged_in"
        : loadingStatus === "loading" ? "loading" : "unknown";
  return {
    urlReady,
    inputReady,
    loginStatus,
    verificationStatus,
    loadingStatus,
    readyForPrompt: loginStatus === "logged_in" && verificationStatus === "none",
  };
}

export function createDoubaoLocators(page) {
  return {
    // Observed as the exact sidebar control text in the real authenticated UI.
    newConversation: () => page.locator('[data-testid="create_conversation_button"]'),
    newConversationFallback: () => page.getByText("新对话", { exact: true }).first(),
    // Observed on the real empty-chat page after a successful new conversation.
    newConversationBlankState: () => page.getByText("有什么我能帮你的吗？", { exact: true }),
    // Actual authenticated shell: DIV[role=textbox][contenteditable=true].
    // `getComposerLocator` retains a semantic textarea fallback without
    // treating placeholder wording as a login requirement.
    composer: () => getComposerLocator(page),
    // Observed after text is entered. It has an explicit, app-owned ID.
    send: () => page.locator("#flow-end-msg-send"),
    // Each rendered message has a data-message-id.  User bubbles are the
    // right-aligned entries; assistant entries are the remaining entries.
    messages: () => page.locator('[data-testid="send_message"], [data-testid="receive_message"], [data-message-id]'),
    // The currently observed completed-answer citation surface is an href
    // inside the assistant message. Keep this selector here, not in the
    // adapter, so future Doubao UI changes have one edit point.
    citationLinks: (message) => message.locator("a[href]"),
    streamingContent: (message) => message.locator('[data-streaming="true"]'),
    completedContent: (message) => message.locator('[data-streaming="false"]'),
    // “停止生成” is semantic UI text. Completion itself is determined from the
    // verified data-streaming attribute, not from the absence of this button.
    stopGenerating: () => page.getByText(/停止生成|停止回答/, { exact: false }).last(),
    loginButton: () => page.getByRole("button", { name: "登录", exact: true }).first(),
    regionRestriction: () => page.getByText("受区域限制，请先登录再使用豆包。", { exact: true }),
    systemException: () => page.getByText("系统异常", { exact: true }),
    pageError: () => page.getByText(ERROR_TEXT, { exact: false }).first(),
    regenerate: () => page.getByText(REGENERATE_TEXT, { exact: false }).last(),
    // Human-verification vendors change their internal DOM frequently. These
    // are deliberately broad semantic surfaces (dialog/iframe/stable attrs),
    // combined with visible instruction text in `classifyDoubaoBlockingSnapshot`.
    verificationDialog: () => page.locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
    verificationFrame: () => page.locator('iframe[src*="captcha" i], iframe[src*="verify" i], iframe[src*="security" i]'),
    verificationControl: () => page.locator('[data-testid*="captcha" i], [data-testid*="verify" i], [data-testid*="challenge" i], [id*="captcha" i], [id*="verify" i]'),
    verificationImageSelection: () => page.locator('[role="dialog"] img, [role="dialog"] canvas, [aria-modal="true"] img, [aria-modal="true"] canvas, [data-testid*="captcha" i] img, [data-testid*="challenge" i] img'),
    verificationSubmit: () => page.getByRole("button", { name: /提交|验证|确认|继续/ }),
    verificationSlider: () => page.locator('[role="slider"], input[type="range"], [data-testid*="slider" i], [class*="slider" i]'),
  };
}

export function classifyDoubaoBlockingSnapshot({
  url = "",
  bodyText = "",
  hasComposer = false,
  hasVerificationDialog = false,
  hasVerificationFrame = false,
  hasVerificationControl = false,
  hasImageSelection = false,
  hasVerificationSubmit = false,
  hasSliderControl = false,
  composerBlocked = false,
} = {}) {
  const verificationSurface = hasVerificationDialog || hasVerificationFrame || hasVerificationControl;
  const imageInstruction = IMAGE_VERIFICATION_TEXT.test(bodyText);
  const sliderInstruction = SLIDER_VERIFICATION_TEXT.test(bodyText);
  const smsInstruction = SMS_VERIFICATION_TEXT.test(bodyText);
  const accountSecurityInstruction = ACCOUNT_SECURITY_TEXT.test(bodyText);
  const loginInstruction = /登录|扫码登录|手机号登录/.test(bodyText);
  const securityUrl = /(?:\/security\/|captcha|verify|challenge|passport|account)/i.test(url);
  const evidence = { hasVerificationDialog, hasVerificationFrame, hasVerificationControl, hasImageSelection, hasVerificationSubmit, hasSliderControl, composerBlocked, imageInstruction, sliderInstruction, smsInstruction, accountSecurityInstruction };
  // A keyword or a hidden vendor fragment is never enough. Every manual
  // verification result needs multiple visible, blocking UI signals.
  if (imageInstruction && verificationSurface && hasImageSelection && hasVerificationSubmit) return { state: DOUBAO_PAGE_STATES.IMAGE_VERIFICATION, requiresHumanAction: true, evidence };
  if (sliderInstruction && verificationSurface && hasSliderControl && composerBlocked) return { state: DOUBAO_PAGE_STATES.SLIDER_VERIFICATION, requiresHumanAction: true, evidence };
  if (smsInstruction && verificationSurface && hasVerificationSubmit && composerBlocked) return { state: DOUBAO_PAGE_STATES.SMS_VERIFICATION, requiresHumanAction: true, evidence };
  if (accountSecurityInstruction && verificationSurface && hasVerificationSubmit && composerBlocked) return { state: DOUBAO_PAGE_STATES.ACCOUNT_SECURITY, requiresHumanAction: true, evidence };
  // Login is a separate waiting-for-login state, not a verification event.
  if (/login|passport|account/i.test(url) || (!hasComposer && loginInstruction)) return { state: DOUBAO_PAGE_STATES.LOGIN_REQUIRED, requiresHumanAction: false, evidence };
  return { state: null, requiresHumanAction: false, evidence };
}

export function classifyDoubaoPageSnapshot({ url = "", bodyText = "", hasComposer = false }) {
  if (/\/security\/doubao-region-ban(?:\?|$)/i.test(url) || bodyText.includes("受区域限制，请先登录再使用豆包。")) {
    return DOUBAO_PAGE_STATES.REGION_RESTRICTED;
  }
  const blocking = classifyDoubaoBlockingSnapshot({ url, bodyText, hasComposer });
  if (blocking.state) return blocking.state;
  if (/login|passport|account/i.test(url) || (!hasComposer && /登录|扫码登录|手机号登录/.test(bodyText))) {
    return DOUBAO_PAGE_STATES.LOGIN_REQUIRED;
  }
  if (/系统异常/.test(bodyText)) return DOUBAO_PAGE_STATES.SYSTEM_EXCEPTION;
  if (/网络异常|加载失败|请求失败|服务异常/.test(bodyText)) return DOUBAO_PAGE_STATES.NETWORK_ERROR;
  if (/重新生成|重新回答/.test(bodyText)) return DOUBAO_PAGE_STATES.RESPONSE_ERROR;
  return hasComposer ? DOUBAO_PAGE_STATES.READY : DOUBAO_PAGE_STATES.PAGE_NOT_READY;
}

export function isDoubaoFailureState(state) {
  return ![DOUBAO_PAGE_STATES.READY, DOUBAO_PAGE_STATES.PAGE_NOT_READY].includes(state);
}

export function isDoubaoHumanActionState(state) {
  return [
    DOUBAO_PAGE_STATES.IMAGE_VERIFICATION,
    DOUBAO_PAGE_STATES.SLIDER_VERIFICATION,
    DOUBAO_PAGE_STATES.SMS_VERIFICATION,
    DOUBAO_PAGE_STATES.ACCOUNT_SECURITY,
  ].includes(state);
}
