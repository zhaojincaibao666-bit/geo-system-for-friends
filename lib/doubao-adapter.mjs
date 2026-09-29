import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createDoubaoLocators,
  classifyDoubaoBlockingSnapshot,
  classifyDoubaoPageSnapshot,
  isDoubaoFailureState,
  isDoubaoHumanActionState,
  DOUBAO_PAGE_STATES,
  DOUBAO_LOCATOR_VERSION,
  inspectDoubaoComposer,
  deriveDoubaoReadiness,
} from "./doubao-locators.mjs";
import { captureDoubaoReferenceList, failedReferenceCapture } from "./doubao-reference-list.mjs";
import { classifyDoubaoSearchCapability } from "./doubao-search-capability.mjs";
import { fillDoubaoComposerExact, findNewUserMessages, readComposerText, sentPromptTextEquivalent, USER_MESSAGE_SELECTOR } from "./doubao-prompt-send.mjs";

export class DoubaoLoginRequiredError extends Error {
  constructor(message = "豆包登录状态失效") {
    super(message);
    this.name = "DoubaoLoginRequiredError";
    this.code = "DOUBAO_LOGIN_REQUIRED";
    this.stage = "login_check";
  }
}

export class DoubaoAdapterError extends Error {
  constructor(message, code = "DOUBAO_WEB_ADAPTER_ERROR", stage = "unknown") {
    super(message);
    this.name = "DoubaoAdapterError";
    this.code = code;
    this.stage = stage;
  }
}

/**
 * Human verification is a platform control, not a retryable browser error.
 * This error carries only detection metadata; it never attempts to interact
 * with a challenge widget.
 */
export class DoubaoHumanActionRequiredError extends DoubaoAdapterError {
  constructor(blocking, stage = "detect_blocking_state") {
    const state = blocking?.state || "needs_human_action";
    super(`豆包需要人工处理：${state}`, `DOUBAO_${String(state).toUpperCase()}`, stage);
    this.name = "DoubaoHumanActionRequiredError";
    this.blocking = blocking || { state };
    this.humanActionType = state;
  }
}

/**
 * A verified new-chat screen is necessary but not sufficient once Doubao has
 * assigned a server-side chat id.  Reusing an id would make the provenance of
 * the answer ambiguous, so the runner treats it as an isolation failure and
 * retries from another confirmed blank chat.
 */
export class DoubaoConversationCollisionError extends DoubaoAdapterError {
  constructor(conversationId, details = null) {
    super("豆包返回了本轮已使用的会话 ID，拒绝保存可能串题的回答", "DOUBAO_CONVERSATION_ID_COLLISION", "validate_conversation_isolation");
    this.name = "DoubaoConversationCollisionError";
    this.conversationId = conversationId;
    this.details = details;
  }
}

/**
 * A platform-side send throttle is neither an answer nor a normal question
 * failure.  The runner pauses so it does not turn a temporary account limit
 * into thirty invalid GEO observations.
 */
export class DoubaoRateLimitedError extends DoubaoAdapterError {
  constructor(message = "豆包当前触发发送频率限制", details = null) {
    super(message, "DOUBAO_SEND_RATE_LIMIT", "wait_answer_start");
    this.name = "DoubaoRateLimitedError";
    this.details = details;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** One worker owns one Page; workers share only the persistent context. */
export class DoubaoAdapter {
  constructor(options = {}) {
    this.profileDir = options.profileDir;
    this.debugDir = options.debugDir || join(options.profileDir || process.cwd(), "debug");
    this.doubaoUrl = options.doubaoUrl || "https://www.doubao.com/chat/";
    this.logger = options.logger || console;
    this.headless = options.headless ?? false;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? 45_000;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 12_000;
    this.answerStartTimeoutMs = options.answerStartTimeoutMs ?? 30_000;
    this.answerCompleteTimeoutMs = options.answerCompleteTimeoutMs ?? 120_000;
    // This is an event-driven confirmation window, not a blind post-answer
    // sleep. It prevents transient `data-streaming=false` states from being
    // mistaken for the final answer.
    this.answerStableMs = options.answerStableMs ?? 1_800;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    // Retained for compatibility with callers that still pass this option.
    // Formal prompt entry is atomic because incremental input can move the
    // ProseMirror caret while the component re-renders.
    this.typingDelayMs = options.typingDelayMs ?? 25;
    // Disabled by default. When enabled in a development investigation, a
    // single-worker run may additionally save Playwright traces on failures.
    this.debugMode = options.debugMode === true;
    this.debugTrace = this.debugMode && options.debugTrace === true;
    this.context = options.context || null;
    this.page = options.page || null;
    // A BrowserManager owns Chromium, the persistent Context and all Page
    // allocation.  The adapter is deliberately limited to the Page assigned
    // to its worker.  `requestWorkerPage` is the manager-controlled recovery
    // path for a broken worker tab.
    this.requestWorkerPage = options.requestWorkerPage || null;
    this.releaseWorkerPage = options.releaseWorkerPage || null;
    this.ownsContext = false;
    this.workerId = options.workerId || "doubao-worker-1";
    this.pageIndex = Number(options.pageIndex || 1);
    this.pageId = options.pageId || null;
    this.workerPool = null;
    this.locators = null;
    this.answerBaseline = { count: 0, text: "" };
    this.completedAnswer = null;
    this.currentConversation = null;
    this.activeQuestionId = null;
    this.promptTransport = { submittedAt: null, completionConnectedAt: null, rateLimit: null, promptIntegrity: null };
    this._responseObserverAttached = false;
    this._pageDiagnosticsAttached = false;
    this._traceEnabled = false;
    this._traceChunkActive = false;
    this.diagnostics = { console: [], pageErrors: [], networkErrors: [], httpErrors: [] };
  }

  async initialize() {
    if (!this.context) {
      throw new DoubaoAdapterError("DoubaoAdapter 必须由 DoubaoBrowserManager 绑定 Persistent Context", "DOUBAO_BROWSER_MANAGER_REQUIRED", "initialize");
    }
    if (!this.page || this.page.isClosed()) await this._replaceWorkerPage();
    this._configurePage();
    await this.ensurePageReady();
    return this;
  }

  async ensureLoggedIn() {
    const readiness = await this.inspectDoubaoPageState({ timeoutMs: this.actionTimeoutMs });
    if (readiness.loginStatus === "verification_required") throw new DoubaoHumanActionRequiredError(readiness.blocking, "login_check");
    if (readiness.loginStatus === "login_required") {
      throw new DoubaoLoginRequiredError();
    }
    if (!readiness.readyForPrompt) {
      const error = new DoubaoAdapterError("豆包 Worker 页面尚未就绪", "DOUBAO_WORKER_NOT_READY", "login_check");
      error.readiness = readiness;
      throw error;
    }
    return true;
  }

  // Mode hooks are intentionally explicit even though Doubao only supports
  // chat in this phase. They avoid platform checks in the shared runner.
  async prepareMode(mode = "chat") {
    if (mode !== "chat") throw new DoubaoAdapterError(`豆包网页暂不支持模式：${mode}`, "DOUBAO_MODE_UNSUPPORTED", "prepare_mode");
    return { mode: "chat", ready: true };
  }

  async verifyMode(mode = "chat") {
    if (mode !== "chat") throw new DoubaoAdapterError(`豆包网页暂不支持模式：${mode}`, "DOUBAO_MODE_UNSUPPORTED", "verify_mode");
    return { mode: "chat", verified: true };
  }

  /**
   * Lightweight, non-destructive login observation for topology/Smoke checks.
   * A temporarily absent composer is intentionally `unknown`, not logout.
   */
  async inspectLoginReadiness({ timeoutMs = 1_500 } = {}) {
    const readiness = await this.inspectDoubaoPageState({ timeoutMs });
    return { state: readiness.loginStatus, blocking: readiness.blocking || null, inputReady: readiness.inputReady, readiness };
  }

  async inspectInputReady({ timeoutMs = 750 } = {}) {
    return (await this.inspectDoubaoPageState({ timeoutMs })).inputReady;
  }

  /**
   * The only login/input readiness implementation used by Smoke, formal run
   * preflight, account-switch recovery and lightweight per-question checks.
   */
  async inspectDoubaoPageState({ timeoutMs = 1_500 } = {}) {
    await this.ensurePageReady();
    const composer = await this._inspectComposer({ timeoutMs: Math.max(80, timeoutMs) });
    const blocking = await this.detectBlockingState({ composer });
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    const pageState = classifyDoubaoPageSnapshot({ url: this.page.url(), bodyText, hasComposer: composer.inputReady });
    return {
      ...deriveDoubaoReadiness({ url: this.page.url(), bodyText, pageState, blocking, composer }),
      workerId: this.workerId,
      pageId: this.pageId || null,
      url: this.page.url(),
      title: await this.page.title().catch(() => null),
      pageState,
      blocking,
      composer: this._composerMetadata(composer),
      checkedAt: new Date().toISOString(),
    };
  }

  async inspectPageState(options = {}) {
    return this.inspectDoubaoPageState(options);
  }

  async ensurePageReady() {
    if (!this.context || !this.page || this.page.isClosed()) {
      if (this.context) {
        await this._replaceWorkerPage();
      } else throw new DoubaoAdapterError("DoubaoAdapter 尚未绑定 Worker Page", "DOUBAO_WORKER_PAGE_UNBOUND", "ensure_page_ready");
    }
    if (!/doubao\.com/i.test(this.page.url())) await this.page.goto(this.doubaoUrl, { waitUntil: "domcontentloaded" });
    return this.page;
  }

  async startNewConversation({ sessionUuid = randomUUID() } = {}) {
    await this.ensureLoggedIn();
    const previous = await this._conversationSnapshot();
    const button = await this._newConversationControl();
    if (!button) throw new DoubaoAdapterError("未找到豆包“新对话”按钮", "DOUBAO_NEW_CONVERSATION_BUTTON_MISSING", "new_conversation");
    this.currentConversation = {
      sessionUuid,
      conversationId: null,
      requestedAt: new Date().toISOString(),
      confirmedAt: null,
      requestUrl: previous.url,
      confirmation: null,
    };
    await button.click();
    return previous;
  }

  async confirmNewConversation(previous = null, { allowHomepageRecovery = true } = {}) {
    const confirmation = await this._waitForConfirmedNewConversation(previous);
    if (confirmation) return confirmation;
    if (allowHomepageRecovery) {
      // Never submit into an unconfirmed old chat. A single controlled recovery
      // goes to the Doubao home route, requests another new chat, then performs
      // the same strict confirmation once more.
      await this._recoverFreshConversation(previous);
      return this.confirmNewConversation(previous, { allowHomepageRecovery: false });
    }
    throw new DoubaoAdapterError("点击新对话后未确认进入空白聊天", "DOUBAO_NEW_CONVERSATION_NOT_CONFIRMED", "confirm_new_conversation");
  }

  async _waitForConfirmedNewConversation(previous = null) {
    const deadline = Date.now() + this.actionTimeoutMs;
    while (Date.now() < deadline) {
      await this._assertHealthyPage("confirm_new_conversation");
      const composer = (await this._inspectComposer({ timeoutMs: 250 })).locator;
      const current = await this._conversationSnapshot();
      const routeChanged = Boolean(previous?.url && previous.url !== current.url);
      const messagesCleared = (previous?.messageCount || 0) > 0 && current.messageCount === 0;
      const blankState = await this._visible(this.locators.newConversationBlankState(), 80);
      const previousPath = (() => { try { return new URL(previous?.url || "").pathname; } catch { return ""; } })();
      const alreadyAtBlankRoute = /^\/chat\/?$/u.test(previousPath);
      // Do not treat the always-present blank-state copy as proof by itself:
      // Doubao can render it behind an old conversation while a route change
      // is still pending. Existing messages must disappear; when the message
      // list was empty, require either a route transition or an already-blank
      // /chat route plus the visible blank state.
      const oldChatGone = (previous?.messageCount || 0) > 0
        ? messagesCleared
        : routeChanged || alreadyAtBlankRoute;
      // Current Doubao keeps an unsent draft when a previous send is
      // interrupted, even after its blank-chat screen is shown.  That draft is
      // not a message in the new conversation, but the old implementation
      // treated it as proof that the new chat had failed.  This stranded every
      // worker before it could submit its next question.  Once the blank-chat
      // state and an empty message list prove that this is a fresh chat, clear
      // only that residual draft and then continue with the normal empty-input
      // gate.  We never clear text from a non-blank or message-bearing chat.
      let draftCleared = false;
      if (oldChatGone && blankState && composer && !await this._isInputEmpty(composer)) {
        draftCleared = await this._clearFreshConversationDraft(composer);
      }
      const inputReady = Boolean(composer && await this._isInputEmpty(composer));
      if (oldChatGone && blankState && inputReady) {
        this.currentConversation ||= { sessionUuid: randomUUID(), requestedAt: new Date().toISOString() };
        this.currentConversation.confirmedAt = new Date().toISOString();
        this.currentConversation.conversationId = this._conversationIdFromUrl(current.url);
        this.currentConversation.confirmation = { routeChanged, messagesCleared, blankState: true, inputReady: true, draftCleared, url: current.url };
        return this._conversationMetadata();
      }
      await delay(this.pollIntervalMs);
    }
    return null;
  }

  async _recoverFreshConversation(previous) {
    await this.ensurePageReady();
    await this.page.goto(this.doubaoUrl, { waitUntil: "domcontentloaded" });
    await this.ensureLoggedIn();
    const button = await this._newConversationControl();
    if (!button) throw new DoubaoAdapterError("恢复后未找到豆包“新对话”按钮", "DOUBAO_NEW_CONVERSATION_BUTTON_MISSING", "recover_new_conversation");
    await button.click();
    this.currentConversation ||= { sessionUuid: randomUUID(), requestedAt: new Date().toISOString() };
    this.currentConversation.recoveredAt = new Date().toISOString();
    this.currentConversation.requestUrl = previous?.url || this.page.url();
  }

  // Original production send flow. Reference capture runs only after the
  // completed answer and must not introduce Probe-specific send gates.
  async submitPrompt(question) {
    const text = String(question || "").trim();
    if (!text) throw new DoubaoAdapterError("题目不能为空", "DOUBAO_EMPTY_PROMPT", "submit_prompt");
    await this.ensureLoggedIn();
    await this._assertHealthyPage("submit_prompt");
    const composer = (await this._inspectComposer()).locator;
    if (!composer) throw new DoubaoLoginRequiredError("豆包登录状态失效：输入框不可用");
    if (!await this._isInputEmpty(composer)) {
      throw new DoubaoAdapterError("新对话输入框不为空，拒绝提交以避免串题", "DOUBAO_COMPOSER_NOT_EMPTY", "submit_prompt");
    }
    this.answerBaseline = await this._assistantSnapshot();
    this.completedAnswer = null;
    this.promptTransport = { submittedAt:null, completionConnectedAt:null, rateLimit:null, promptIntegrity:null };
    const userBaseline = await this._userMessageSnapshot();
    await fillDoubaoComposerExact(composer, text);
    await this._assertHealthyPage("submit_prompt");
    const send = await this._waitForEnabledSend();
    if (!send) throw new DoubaoAdapterError("豆包发送按钮未变为可用状态", "DOUBAO_SEND_UNAVAILABLE", "submit_prompt");
    // Re-read immediately before the one allowed click. A late ProseMirror
    // render must not be able to change the audited question after the first
    // equality check.
    const beforeClick = await readComposerText(composer);
    if (beforeClick !== text) {
      const error = new DoubaoAdapterError("豆包输入框内容与题库问题不一致，已阻止发送", "DOUBAO_QUESTION_TEXT_MISMATCH", "submit_prompt");
      error.expectedText = text;
      error.actualText = beforeClick;
      throw error;
    }
    const submittedAt = new Date().toISOString();
    this.promptTransport.submittedAt = submittedAt;
    await send.click();
    const sentMessage = await this._waitForExactUserMessage(userBaseline, text);
    this.promptTransport.promptIntegrity = {
      status: "verified",
      method: "atomic_fill_pre_and_post_send_exact_match",
      expectedText: text,
      observedText: sentMessage.text,
      userMessageId: sentMessage.id,
      matchMode: sentMessage.text === text ? "exact" : "whitespace_normalized",
      verifiedAt: new Date().toISOString(),
    };
    return submittedAt;
  }

  async _waitForEnabledSend() {
    const deadline = Date.now() + this.actionTimeoutMs;
    while (Date.now() < deadline) {
      const send = await this._visible(this.locators.send(), 200);
      if (send && await send.isEnabled().catch(() => false)) return send;
      await delay(100);
    }
    return null;
  }

  async waitForAnswerStart() {
    const deadline = Date.now() + this.answerStartTimeoutMs;
    while (Date.now() < deadline) {
      this._throwIfRateLimited();
      await this._assertHealthyPage("wait_answer_start");
      const current = await this._assistantSnapshot();
      if (current.count > this.answerBaseline.count || (current.text && current.text !== this.answerBaseline.text)) return new Date().toISOString();
      await delay(this.pollIntervalMs);
    }
    throw new DoubaoAdapterError("豆包在规定时间内未开始回答", "DOUBAO_ANSWER_NOT_STARTED", "wait_answer_start");
  }

  async waitForAnswerComplete({ onGenerationEnded = async () => {} } = {}) {
    const deadline = Date.now() + this.answerCompleteTimeoutMs;
    let lastText = "";
    let stableSince = null;
    let generationEnded = false;
    while (Date.now() < deadline) {
      this._throwIfRateLimited();
      await this._assertHealthyPage("wait_answer_complete");
      const message = await this._lastAssistantMessage();
      if (message) {
        const answer = (await message.innerText().catch(() => "")).trim();
        const completed = await this.locators.completedContent(message).isVisible().catch(() => false);
        const streaming = await this.locators.streamingContent(message).isVisible().catch(() => false);
        const stopVisible = await this._visible(this.locators.stopGenerating(), 80);
        const composer = (await this._inspectComposer({ timeoutMs: 80 })).locator;
        const inputReady = Boolean(composer && await this._isInputEmpty(composer));
        if (answer !== lastText) {
          lastText = answer;
          stableSince = null;
        } else if (answer && completed && !streaming && !stopVisible && inputReady) {
          if (!generationEnded) {
            generationEnded = true;
            await onGenerationEnded();
          }
          stableSince ||= Date.now();
          if (Date.now() - stableSince >= this.answerStableMs) {
            this.completedAnswer = answer;
            return new Date().toISOString();
          }
        }
      }
      await delay(this.pollIntervalMs);
    }
    throw new DoubaoAdapterError("豆包回答超过单题等待上限", "DOUBAO_ANSWER_TIMEOUT", "wait_answer_complete");
  }

  async getAnswer() {
    await this._assertHealthyPage("get_answer");
    if (!this.completedAnswer) return "";
    const message = await this._lastAssistantMessage();
    if (!message) return "";
    const completed = await this.locators.completedContent(message).isVisible().catch(() => false);
    const liveAnswer = (await message.innerText().catch(() => "")).trim();
    // Fail closed if the DOM changed after the completion confirmation.
    if (!completed || liveAnswer !== this.completedAnswer) return "";
    return this.completedAnswer;
  }

  async getCitationCapture({ questionId = this.activeQuestionId, runId = null, workerId = this.workerId } = {}) {
    try {
      const latest = await this._lastAssistantMessage();
      const id = await latest?.getAttribute("data-message-id");
      const message = id ? this.page.locator(`[data-message-id=${JSON.stringify(id)}]`) : null;
      return await captureDoubaoReferenceList({
        message, pageUrl:this.page?.url?.() || "",
        questionRunId:`${runId || "run"}:${questionId || "question"}`,
        timeoutMs:this.actionTimeoutMs,
      });
    } catch (error) { return failedReferenceCapture(error, {questionRunId:`${runId || "run"}:${questionId || "question"}`}); }
  }

  /** Read current search capability without clicking, typing, or submitting. */
  async getWebSearchCapability() {
    if (!this.page || this.page.isClosed()) {
      return classifyDoubaoSearchCapability({ readiness: { loginStatus: "unknown", pageState: "page_not_ready", readyForPrompt: false, inputReady: false } });
    }
    const readiness = await this.inspectDoubaoPageState();
    const observation = await this.page.locator("button, [role=button], [role=switch], input[type=checkbox], a").evaluateAll((nodes) => nodes.map((node) => {
      const text = [node.textContent, node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-testid")]
        .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
      return {
        text,
        visible: Boolean(node.getClientRects().length),
        role: node.getAttribute("role"), type: node.getAttribute("type"),
        ariaPressed: node.getAttribute("aria-pressed"), ariaChecked: node.getAttribute("aria-checked"), dataState: node.getAttribute("data-state"),
        checked: node instanceof HTMLInputElement && node.type === "checkbox" ? node.checked : undefined,
      };
    })).catch(() => []);
    const defaultCapabilityEvidence = await this.page.locator("[data-search-capability], [data-search-mode='default'], [data-web-search-enabled='true']").evaluateAll((nodes) => nodes
      .filter((node) => node.getClientRects().length)
      .map((node) => ({ tag: node.tagName, searchCapability: node.getAttribute("data-search-capability"), searchMode: node.getAttribute("data-search-mode"), webSearchEnabled: node.getAttribute("data-web-search-enabled") }))).catch(() => []);
    return { ...classifyDoubaoSearchCapability({ readiness, controls: observation, defaultCapabilityEvidence }), checkedAt: new Date().toISOString() };
  }

  /** Compatibility wrapper for callers that only need a pass/fail gate. */
  async verifyWebSearchMode() {
    const capability = await this.getWebSearchCapability();
    return { ready: capability.searchCapability === "AVAILABLE", state: capability.searchCapability.toLowerCase(), observation: capability.evidence, capability, checkedAt: capability.checkedAt };
  }

  // Preserve the original adapter contract for callers that only need the
  // citation list. The richer capture status is available to ask().
  async getCitations(options = {}) {
    return (await this.getCitationCapture(options)).citations;
  }

  async getPageState() {
    if (!this.page || this.page.isClosed()) return DOUBAO_PAGE_STATES.PAGE_NOT_READY;
    const composer = await this._inspectComposer({ timeoutMs: 80 });
    const bodyText = await this.page.locator("body").innerText().catch(() => "");
    return classifyDoubaoPageSnapshot({ url: this.page.url(), bodyText, hasComposer: composer.inputReady });
  }

  async detectBlockingState({ composer: existingComposer = null } = {}) {
    if (!this.page || this.page.isClosed()) return { state: null, requiresHumanAction: false, evidence: { pageClosed: true } };
    const [composer, bodyText, hasVerificationDialog, hasVerificationFrame, hasVerificationControl, hasImageSelection, hasVerificationSubmit, hasSliderControl] = await Promise.all([
      existingComposer || this._inspectComposer({ timeoutMs: 80 }),
      this.page.locator("body").innerText().catch(() => ""),
      this._hasVisibleLocator(this.locators.verificationDialog()),
      this._hasVisibleLocator(this.locators.verificationFrame()),
      this._hasVisibleLocator(this.locators.verificationControl()),
      this._hasVisibleLocator(this.locators.verificationImageSelection()),
      this._hasVisibleLocator(this.locators.verificationSubmit()),
      this._hasVisibleLocator(this.locators.verificationSlider()),
    ]);
    const composerBlocked = !composer?.inputReady;
    const blocking = classifyDoubaoBlockingSnapshot({
      url: this.page.url(),
      bodyText,
      hasComposer: Boolean(composer?.inputReady),
      hasVerificationDialog,
      hasVerificationFrame,
      hasVerificationControl,
      hasImageSelection,
      hasVerificationSubmit,
      hasSliderControl,
      composerBlocked,
    });
    if (blocking.requiresHumanAction) return blocking;
    if (this.promptTransport.rateLimit) return { state: DOUBAO_PAGE_STATES.RATE_LIMIT, requiresHumanAction: false, evidence: blocking.evidence };
    const pageState = classifyDoubaoPageSnapshot({ url: this.page.url(), bodyText, hasComposer: Boolean(composer?.inputReady) });
    return { ...blocking, state: pageState === DOUBAO_PAGE_STATES.READY ? null : pageState };
  }

  async waitForBlockingStateClear({ pollIntervalMs = 1_000, recoveryTimeoutMs = this.actionTimeoutMs } = {}) {
    // Intentionally no refresh, click, drag, or challenge-specific
    // interaction. A human completes the visible challenge. Its disappearance
    // alone is not enough: require the normal Doubao shell and an enabled
    // composer before a worker is allowed to create the replacement chat.
    let clearedAt = null;
    const normalizedPollInterval = Math.max(250, Number(pollIntervalMs) || 1_000);
    const normalizedRecoveryTimeout = Math.max(1_000, Number(recoveryTimeoutMs) || this.actionTimeoutMs);
    for (;;) {
      const blocking = await this.detectBlockingState();
      if (blocking.requiresHumanAction) {
        clearedAt = null;
        await delay(normalizedPollInterval);
        continue;
      }
      clearedAt ||= Date.now();
      await this.ensurePageReady();
      await this._assertHealthyPage("human_action_recovery");
      const composer = await this._inspectComposer({ timeoutMs: 250 });
      const inputReady = composer.inputReady;
      if (inputReady) {
        // Never reuse any partial answer from the interrupted conversation.
        // The runner will call ask() again, which strictly creates and confirms
        // a new blank chat before it submits this same question.
        this.completedAnswer = null;
        return { ...blocking, inputReady: true, resolvedAt: new Date().toISOString() };
      }
      if (Date.now() - clearedAt >= normalizedRecoveryTimeout) {
        throw new DoubaoAdapterError("人工验证已消失，但豆包页面尚未恢复可用输入框", "DOUBAO_HUMAN_ACTION_RECOVERY_NOT_READY", "human_action_recovery");
      }
      await delay(normalizedPollInterval);
    }
  }

  async captureDebugArtifact({ stage = "unknown", questionId = null, attempt = null, error = null } = {}) {
    await mkdir(this.debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeQuestion = String(questionId || "no-question").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
    const safeStage = String(stage).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 50);
    const base = `doubao-${safeQuestion}-${safeStage}-${stamp}`;
    const screenshotPath = join(this.debugDir, `${base}.png`);
    const htmlPath = join(this.debugDir, `${base}.html`);
    const debugPath = join(this.debugDir, `${base}.json`);
    const tracePath = join(this.debugDir, `${base}.zip`);
    const trace = await this._stopTraceChunk(tracePath);
    if (!this.page || this.page.isClosed()) {
      await writeFile(debugPath, JSON.stringify({
        capturedAt: new Date().toISOString(), questionId, attempt, stage, locatorVersion: DOUBAO_LOCATOR_VERSION,
        pageState: DOUBAO_PAGE_STATES.PAGE_NOT_READY,
        error: error ? { name: error.name, code: error.code, message: error.message, stage: error.stage } : null,
        diagnostics: this.diagnostics,
        worker: { workerId: this.workerId, pageIndex: this.pageIndex }, tracePath: trace,
      }, null, 2), "utf8");
      return { screenshotPath: null, htmlPath: null, debugPath, tracePath: trace, pageState: DOUBAO_PAGE_STATES.PAGE_NOT_READY };
    }
    const [state, blockingState, html, bodyText, controls] = await Promise.all([
      this.getPageState().catch(() => DOUBAO_PAGE_STATES.PAGE_NOT_READY),
      this.detectBlockingState().catch(() => ({ state: null, requiresHumanAction: false })),
      this.page.content().catch(() => ""),
      this.page.locator("body").innerText().catch(() => ""),
      this.page.locator("button, textarea, [data-message-id], [data-streaming]").evaluateAll((nodes) => nodes.slice(-80).map((node) => ({
        tag: node.tagName,
        text: (node.innerText || node.textContent || "").trim().slice(0, 500),
        id: node.id || null,
        role: node.getAttribute("role"),
        ariaLabel: node.getAttribute("aria-label"),
        placeholder: node.getAttribute("placeholder"),
        dataMessageId: node.getAttribute("data-message-id"),
        dataStreaming: node.getAttribute("data-streaming"),
        disabled: "disabled" in node ? Boolean(node.disabled) : null,
      }))).catch(() => []),
    ]);
    await Promise.all([
      this.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null),
      writeFile(htmlPath, html, "utf8"),
      writeFile(debugPath, JSON.stringify({
        capturedAt: new Date().toISOString(), questionId, attempt, stage, locatorVersion: DOUBAO_LOCATOR_VERSION,
        url: this.page.url(), pageState: state, blockingState, conversation: this._conversationMetadata(), error: error ? { name: error.name, code: error.code, message: error.message, stage: error.stage } : null,
        bodyText, controls, promptTransport: this.promptTransport, diagnostics: this.diagnostics, tracePath: trace,
        worker: { workerId: this.workerId, pageIndex: this.pageIndex },
      }, null, 2), "utf8"),
    ]);
    return { screenshotPath, htmlPath, debugPath, tracePath: trace, pageState: state };
  }

  async takeDebugScreenshot(label = "debug") {
    return (await this.captureDebugArtifact({ stage: label }))?.screenshotPath || null;
  }

  async recoverPage() {
    return this._recoverWorkerPage({ forceNewPage: false });
  }

  /** Replace only this worker's Page while retaining the shared login Context. */
  async recreatePage() {
    return this._recoverWorkerPage({ forceNewPage: true });
  }

  async _recoverWorkerPage({ forceNewPage = false } = {}) {
    if (!this.context) throw new DoubaoAdapterError("DoubaoAdapter 尚未绑定 Persistent Context", "DOUBAO_BROWSER_MANAGER_REQUIRED", "recover_page");
    this.activeQuestionId = null;
    this.currentConversation = null;
    this.completedAnswer = null;
    this.answerBaseline = { count: 0, text: "" };
    try {
      if (forceNewPage || !this.page || this.page.isClosed()) await this._replaceWorkerPage({ closeExisting: forceNewPage });
      if (!/doubao\.com/i.test(this.page.url())) await this.page.goto(this.doubaoUrl, { waitUntil: "domcontentloaded" });
      else await this.page.reload({ waitUntil: "domcontentloaded" });
      await this.ensureLoggedIn();
      return this.page;
    } catch (error) {
      if (error instanceof DoubaoLoginRequiredError || error?.code === "DOUBAO_LOGIN_REQUIRED" || forceNewPage) throw error;
      // A reload can fail while a renderer/tab is unhealthy. Do not restart
      // Chromium: discard just this Page and retry against the same Context.
      return this._recoverWorkerPage({ forceNewPage: true });
    }
  }

  async close() {
    const page = this.page;
    if (typeof this.releaseWorkerPage === "function") await this.releaseWorkerPage({ workerId: this.workerId, pageIndex: this.pageIndex, page, reason: "adapter_close" });
    else await page?.close().catch(() => null);
    this.page = null;
    this.locators = null;
    this._responseObserverAttached = false;
    this._pageDiagnosticsAttached = false;
    this.workerPool = null;
  }

  async ask(question, { questionId = null, runId = null, workerId = this.workerId, onStage = async () => {} } = {}) {
    if (this.activeQuestionId) {
      throw new DoubaoAdapterError("A Doubao worker Page is already processing another question", "DOUBAO_WORKER_PAGE_BUSY", "ask");
    }
    this.activeQuestionId = questionId || randomUUID();
    this.diagnostics = { console: [], pageErrors: [], networkErrors: [], httpErrors: [] };
    let succeeded = false;
    try {
      await this.initialize();
      await this.ensureLoggedIn();
      await this._startTraceChunk(questionId);
      await onStage("PAGE_READY", this._conversationMetadata());
      const conversation = await this.startNewConversation();
      await onStage("NEW_CHAT_REQUESTED", this._conversationMetadata());
      const confirmedConversation = await this.confirmNewConversation(conversation);
      await onStage("NEW_CHAT_CONFIRMED", confirmedConversation);
      await onStage("INPUT_READY", confirmedConversation);
      const startedAt = await this.submitPrompt(question);
      await onStage("PROMPT_SUBMITTED", this._conversationMetadata());
      const firstTokenAt = await this.waitForAnswerStart();
      await onStage("ANSWER_STARTED", this._conversationMetadata());
      const completedAt = await this.waitForAnswerComplete({
        onGenerationEnded: () => onStage("GENERATION_ENDED", this._conversationMetadata()),
      });
      await onStage("ANSWER_COMPLETE", this._conversationMetadata());
      const answer = await this.getAnswer();
      if (!answer) throw new DoubaoAdapterError("豆包回答为空，拒绝保存", "DOUBAO_EMPTY_ANSWER", "get_answer");
      succeeded = true;
      const citationCapture = await this.getCitationCapture({ questionId, runId, workerId });
      if (citationCapture.legacyStatus === "failed" && this.debugMode) {
        try {
          citationCapture.debugArtifact = await this.captureDebugArtifact({
            stage: "citation_capture",
            questionId,
            error: new DoubaoAdapterError(citationCapture.error || "citation capture failed", "DOUBAO_CITATION_CAPTURE_FAILED", "citation_capture"),
          });
        } catch (debugError) {
          this.logger.warn?.("Unable to capture citation debug artifact", debugError);
        }
      }
      // V2 is an answer-time enrichment. captureCitationV2 is deliberately
      // fail-closed into CAPTURE_FAILED rather than throwing, so no citation
      // fault can discard this completed answer or trigger a prompt retry.
      return { success: true, question: String(question), answer, citations: citationCapture.citations,
        citationCaptureVersion: "v2", citationCaptureStatus: citationCapture.status,
        citationLegacyStatus: citationCapture.legacyStatus, citationStatus: citationCapture.status,
        citationCount: citationCapture.citationCount, citationCheckedChannels: citationCapture.checkedChannels,
        citationCaptureV2: citationCapture, citationCaptureError: citationCapture.error,
        citationVisibilityMismatch: citationCapture.citationVisibilityMismatch ?? null, citationCapture,
        conversation: this._conversationMetadata(), startedAt, firstTokenAt, completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) };
    } catch (error) {
      error.questionId ||= questionId;
      error.conversation ||= this._conversationMetadata();
      throw error;
    } finally {
      if (succeeded) await this._stopTraceChunk();
      this.activeQuestionId = null;
    }
  }

  _configurePage() {
    this.page.setDefaultTimeout(this.actionTimeoutMs);
    this.page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.locators = createDoubaoLocators(this.page);
    this._attachResponseObserver();
    this._attachPageDiagnostics();
  }

  async _replaceWorkerPage({ closeExisting = false } = {}) {
    const previous = this.page;
    if (typeof this.requestWorkerPage !== "function") {
      throw new DoubaoAdapterError("Worker Page 替换必须由 DoubaoBrowserManager 执行", "DOUBAO_BROWSER_MANAGER_REQUIRED", "replace_worker_page");
    }
    this.page = await this.requestWorkerPage({ workerId: this.workerId, pageIndex: this.pageIndex, previous, closeExisting });
    if (!this.page) throw new DoubaoAdapterError("DoubaoBrowserManager 未返回 Worker Page", "DOUBAO_WORKER_PAGE_UNAVAILABLE", "replace_worker_page");
    this._responseObserverAttached = false;
    this._pageDiagnosticsAttached = false;
    this._configurePage();
    return this.page;
  }

  async _inspectComposer({ timeoutMs = this.actionTimeoutMs } = {}) {
    if (!this.page || this.page.isClosed()) {
      return { locator: null, candidateCount: 0, visibleCandidateCount: 0, inputReady: false, locatorType: null, placeholder: null, ariaLabel: null, contentEditable: null, visible: false, enabled: false, editable: false };
    }
    return inspectDoubaoComposer(this.page, { timeoutMs });
  }

  _composerMetadata(composer) {
    return {
      locatorType: composer?.locatorType || null,
      placeholder: composer?.placeholder || null,
      ariaLabel: composer?.ariaLabel || null,
      contentEditable: composer?.contentEditable || null,
      visible: Boolean(composer?.visible),
      enabled: Boolean(composer?.enabled),
      editable: Boolean(composer?.editable),
      candidateCount: Number(composer?.candidateCount || 0),
      visibleCandidateCount: Number(composer?.visibleCandidateCount || 0),
    };
  }

  async _visible(locator, timeout = this.actionTimeoutMs) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) return candidate;
      }
      await delay(100);
    }
    return null;
  }

  async _newConversationControl() {
    const candidates = [
      this.locators.newConversation(),
      this.locators.newConversationFallback?.(),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const control = await this._visible(candidate, Math.min(500, this.actionTimeoutMs));
      if (control) return control;
    }
    return null;
  }

  async _hasVisibleLocator(locator) {
    return Boolean(await this._visible(locator, 80));
  }

  _attachResponseObserver() {
    if (!this.page || this._responseObserverAttached) return;
    this._responseObserverAttached = true;
    this.page.on("response", (response) => { void this._observeDoubaoResponse(response); });
  }

  _diagnosticEvent(bucket, value) {
    const entries = this.diagnostics[bucket] ||= [];
    entries.push({ at: new Date().toISOString(), ...value });
    if (entries.length > 120) entries.splice(0, entries.length - 120);
  }

  _attachPageDiagnostics() {
    if (!this.page || this._pageDiagnosticsAttached) return;
    this._pageDiagnosticsAttached = true;
    this.page.on("console", (message) => {
      this._diagnosticEvent("console", { level: message.type(), text: message.text().slice(0, 1200) });
    });
    this.page.on("pageerror", (error) => {
      this._diagnosticEvent("pageErrors", { message: String(error?.message || error).slice(0, 1200) });
    });
    this.page.on("requestfailed", (request) => {
      this._diagnosticEvent("networkErrors", { url: request.url(), method: request.method(), failure: request.failure()?.errorText || "request_failed" });
    });
    this.page.on("response", (response) => {
      if (response.status() >= 400) this._diagnosticEvent("httpErrors", { url: response.url(), status: response.status() });
    });
  }

  async _enableTraceForSingleWorker(workerCount) {
    if (!this.debugTrace || workerCount !== 1 || this._traceEnabled || !this.context?.tracing) return;
    try {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      this._traceEnabled = true;
    } catch (error) {
      // Debug observability must never prevent the real browser test itself.
      this.logger.warn?.("Unable to enable Playwright tracing; failure artifacts will still include DOM, screenshot, console, and network logs", error);
    }
  }

  async _startTraceChunk(questionId) {
    if (!this._traceEnabled || this._traceChunkActive) return;
    await this.context.tracing.startChunk({ title: `doubao-${questionId || "question"}-attempt-${this.activeQuestionId}` });
    this._traceChunkActive = true;
  }

  async _stopTraceChunk(path = null) {
    if (!this._traceEnabled || !this._traceChunkActive) return null;
    try {
      await this.context.tracing.stopChunk(path ? { path } : undefined);
      return path;
    } catch (error) {
      this.logger.warn?.("Unable to save Playwright trace", error);
      return null;
    } finally {
      this._traceChunkActive = false;
    }
  }

  async _observeDoubaoResponse(response) {
    const url = response.url();
    if (!this.promptTransport.submittedAt) return;
    if (/\/chat\/completion(?:\?|$)/i.test(url) && response.status() >= 200 && response.status() < 400) {
      this.promptTransport.completionConnectedAt ||= new Date().toISOString();
      return;
    }
    if (!/\/im\/message\/send_rate_limit(?:\?|$)/i.test(url)) return;
    const body = await response.text().catch(() => "");
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* Keep the raw diagnostic below. */ }
    const rateCheck = parsed?.downlink_body?.check_message_send_rate_limit_downlink_body || parsed?.data?.rate_limit || null;
    const limitTips = String(rateCheck?.limit_tips || parsed?.message || parsed?.msg || parsed?.data?.message || "")
      .replace(/\s+/g, " ").slice(0, 500);
    const responseCode = parsed?.code ?? parsed?.data?.code ?? parsed?.status_code ?? null;
    const numericCode = Number(responseCode);
    const explicitLimit = rateCheck?.is_limit === true
      || (Number.isFinite(numericCode) && numericCode !== 0)
      || /(?:rate.?limit|too.?frequent|frequency|限流|频繁|限制)/i.test(limitTips);
    // The endpoint is also called as a normal pre-send eligibility check. A
    // successful { code: 0 } response must never pause a valid test.
    if (!explicitLimit) return;
    this.promptTransport.rateLimit = {
      observedAt: new Date().toISOString(),
      status: response.status(),
      message: limitTips || "豆包当前触发发送频率限制",
      responseCode,
    };
  }

  _throwIfRateLimited() {
    if (!this.promptTransport.rateLimit) return;
    throw new DoubaoRateLimitedError(this.promptTransport.rateLimit.message || "豆包当前触发发送频率限制", this.promptTransport.rateLimit);
  }

  async _lastAssistantMessage() {
    const messages = this.locators.messages();
    const count = await messages.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const message = messages.nth(index);
      const assistant = await message.evaluate((node) => !node.classList.contains("justify-end") && Boolean(node.querySelector('[data-container-type="block-v2"]'))).catch(() => false);
      if (assistant && await message.isVisible().catch(() => false)) return message;
    }
    return null;
  }

  async _assistantSnapshot() {
    const messages = this.locators.messages();
    const count = await messages.count().catch(() => 0);
    const message = await this._lastAssistantMessage();
    return { count, text: message ? (await message.innerText().catch(() => "")).trim() : "" };
  }

  async _userMessageSnapshot() {
    const messages = this.page.locator(USER_MESSAGE_SELECTOR);
    return messages.evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute("data-message-id"),
      text: String(node.innerText || node.textContent || "").trim(),
      visible: Boolean(node.getClientRects().length),
      failed: Boolean(node.querySelector('[data-testid="message_box_failed_icon"]')),
    }))).catch(() => []);
  }

  async _waitForExactUserMessage(baseline, expectedText) {
    const deadline = Date.now() + this.actionTimeoutMs;
    while (Date.now() < deadline) {
      await this._assertHealthyPage("confirm_prompt_integrity");
      const current = await this._userMessageSnapshot();
      const fresh = findNewUserMessages(current, baseline).filter((item) => item.visible);
      if (fresh.some((item) => item.failed)) {
        const error = new DoubaoAdapterError("豆包已显示发送失败标记，问题未成功提交", "DOUBAO_SEND_REJECTED", "confirm_prompt_integrity");
        error.expectedText = expectedText;
        error.actualText = fresh.map((item) => item.text).join("\n");
        error.sentPromptMayExist = true;
        throw error;
      }
      const exact = fresh.find((item) => item.text === expectedText);
      if (exact) return exact;
      const equivalent = fresh.find((item) => sentPromptTextEquivalent(item.text, expectedText));
      if (equivalent) return equivalent;
      if (fresh.length) {
        const error = new DoubaoAdapterError("豆包实际发送的问题与题库问题不一致，本题已拒绝保存", "DOUBAO_SENT_PROMPT_TEXT_MISMATCH", "confirm_prompt_integrity");
        error.expectedText = expectedText;
        error.actualText = fresh.map((item) => item.text).join("\n");
        error.sentPromptMayExist = true;
        throw error;
      }
      await delay(Math.min(100, this.pollIntervalMs));
    }
    const error = new DoubaoAdapterError("未能确认豆包用户消息与题库问题逐字一致", "DOUBAO_SENT_PROMPT_NOT_CONFIRMED", "confirm_prompt_integrity");
    error.expectedText = expectedText;
    error.sentPromptMayExist = true;
    throw error;
  }

  async _conversationSnapshot() {
    return { url: this.page.url(), messageCount: await this.locators.messages().count().catch(() => 0) };
  }

  _conversationIdFromUrl(url = this.page?.url() || "") {
    const match = String(url).match(/\/chat\/([^/?#]+)/i);
    return match ? match[1] : null;
  }

  _conversationMetadata() {
    if (!this.currentConversation) return null;
    return {
      ...this.currentConversation,
      conversationId: this._conversationIdFromUrl() || this.currentConversation.conversationId || null,
      promptIntegrity: this.promptTransport?.promptIntegrity || null,
    };
  }

  async _isInputEmpty(composer) {
    const value = await composer.inputValue().catch(() => null);
    return value !== null ? !value.trim() : !(await composer.innerText().catch(() => "")).trim();
  }

  async _clearFreshConversationDraft(composer) {
    try {
      // `fill` dispatches the same input events as ordinary typing for both
      // the current contenteditable composer and the legacy textarea shell.
      await composer.fill("");
      return this._isInputEmpty(composer);
    } catch {
      return false;
    }
  }

  async _assertHealthyPage(stage) {
    const blocking = await this.detectBlockingState();
    if (blocking.requiresHumanAction || isDoubaoHumanActionState(blocking.state)) {
      throw new DoubaoHumanActionRequiredError(blocking, stage);
    }
    const state = await this.getPageState();
    if ([DOUBAO_PAGE_STATES.LOGIN_REQUIRED, DOUBAO_PAGE_STATES.REGION_RESTRICTED].includes(state)) throw new DoubaoLoginRequiredError();
    if (isDoubaoFailureState(state)) this._throwForPageState(state, stage);
  }

  _throwForPageState(state, stage) {
    const codeByState = {
      [DOUBAO_PAGE_STATES.SYSTEM_EXCEPTION]: "DOUBAO_SYSTEM_EXCEPTION",
      [DOUBAO_PAGE_STATES.NETWORK_ERROR]: "DOUBAO_NETWORK_ERROR",
      [DOUBAO_PAGE_STATES.RESPONSE_ERROR]: "DOUBAO_RESPONSE_ERROR",
    };
    throw new DoubaoAdapterError(`豆包页面异常：${state}`, codeByState[state] || "DOUBAO_PAGE_NOT_READY", stage);
  }
}
