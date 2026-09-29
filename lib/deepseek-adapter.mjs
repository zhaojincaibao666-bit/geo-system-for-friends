import { randomUUID } from "node:crypto";
import { DEEPSEEK_LOCATORS, inspectDeepSeekDom, normalizeDeepSeekCitationCandidates } from "./deepseek-locators.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const visible = async (locator) => locator.count().then((count) => count > 0 && locator.first().isVisible().catch(() => false)).catch(() => false);
const throwIfAborted = (signal) => {
  if (signal?.aborted) throw new DeepSeekAdapterError("DeepSeek 监测任务已停止", "RUN_ABORTED");
};
const waitWithAbort = (milliseconds, signal) => {
  throwIfAborted(signal);
  if (!signal) return wait(milliseconds);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DeepSeekAdapterError("DeepSeek 监测任务已停止", "RUN_ABORTED")); };
    function done() { signal.removeEventListener("abort", abort); resolve(); }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
};

export class DeepSeekAdapterError extends Error {
  constructor(message, code = "DEEPSEEK_WEB_ADAPTER_ERROR") {
    super(message); this.name = "DeepSeekAdapterError"; this.code = code;
  }
}

// Answer text can legitimately contain words such as “验证” or “网络错误”.
// Those words identify a blocking page only when the Composer is unavailable;
// otherwise a completed assistant answer must remain a ready conversation.
export function resolveDeepSeekPageState({ url = "", bodyText = "", composerEditable = false } = {}) {
  const text = String(bodyText).toLowerCase();
  const includes = (words) => words.some((word) => text.includes(word.toLowerCase()));
  const verification = includes(DEEPSEEK_LOCATORS.verificationText);
  const login = includes(DEEPSEEK_LOCATORS.loginText);
  const rateLimited = includes(["访问频繁", "请求过于频繁", "rate limit"]);
  const systemError = includes(["服务繁忙", "网络错误", "系统异常", "service error"]);
  const loading = !String(bodyText).trim() || /加载中|loading/.test(text);
  const signInPage = /^https:\/\/chat\.deepseek\.com\/sign_in(?:\?|$)/i.test(url);
  if (signInPage || (login && !composerEditable)) return "login_required";
  if (verification && !composerEditable) return "verification_required";
  if (rateLimited && !composerEditable) return "rate_limited";
  if (systemError && !composerEditable) return "system_error";
  if (composerEditable) return "ready";
  return loading ? "page_loading" : "unknown";
}

export class DeepSeekAdapter {
  constructor(options = {}) {
    this.page = options.page || null;
    this.context = options.context || null;
    this.workerId = options.workerId || "deepseek-worker-1";
    this.pageIndex = Number(options.pageIndex || 1);
    this.pageId = options.pageId || `deepseek-page-${randomUUID()}`;
    this.webUrl = options.webUrl;
    this.navigationTimeoutMs = Number(options.navigationTimeoutMs || 45_000);
    this.createdAt = new Date().toISOString();
    this.lastAnswerSnapshot = null;
  }

  async initialize() {
    if (!this.page) this.page = await this.context.newPage();
    this.page.setDefaultTimeout?.(this.navigationTimeoutMs);
    await this.ensurePageReady();
    return this;
  }

  async ensurePageReady() {
    const currentUrl = this.page?.url?.() || "";
    if (!/^https:\/\/chat\.deepseek\.com(?:\/|$)/i.test(currentUrl)) {
      await this.page.goto(this.webUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
    }
    return this.inspectPageState();
  }

  async _composer() {
    for (const selector of DEEPSEEK_LOCATORS.composer) {
      const locator = this.page.locator(selector);
      if (await visible(locator)) return locator.first();
    }
    return null;
  }

  _textControl(text) { return this.page.getByText(text, { exact: true }).first(); }
  _webSearchControl() { return this.page.locator("[aria-pressed]").filter({ hasText: DEEPSEEK_LOCATORS.webSearchText }).first(); }
  async _webSearchState() {
    const control = this._webSearchControl();
    if (!await visible(control)) return null;
    const value = await control.getAttribute("aria-pressed");
    return value === "true" ? true : value === "false" ? false : null;
  }

  async inspectPageState() {
    const audit = await inspectDeepSeekDom(this.page);
    const text = audit.bodyText.toLowerCase();
    const composer = await this._composer();
    const composerVisible = Boolean(composer);
    const composerEditable = composerVisible && await composer.evaluate((element) => {
      const disabled = element.matches("textarea, input") ? element.disabled || element.readOnly : false;
      return !disabled && (element.matches("textarea, input") || element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox");
    }).catch(() => false);
    const state = resolveDeepSeekPageState({ url: audit.url, bodyText: audit.bodyText, composerEditable });
    const verification = state === "verification_required";
    const rateLimited = state === "rate_limited";
    const systemError = state === "system_error";
    const webSearchEnabled = await this._webSearchState();
    return {
      workerId: this.workerId, pageId: this.pageId, pageIndex: this.pageIndex,
      url: audit.url, title: audit.title, loginStatus: state === "ready" ? "logged_in" : state,
      state, composer: { exists: composerVisible, visible: composerVisible, editable: composerEditable },
      mode: webSearchEnabled === true ? "web_search" : webSearchEnabled === false ? "chat" : null,
      inputReady: composerEditable, readyForPrompt: state === "ready", blocking: verification || rateLimited || systemError ? { state } : null,
      checkedAt: new Date().toISOString(),
    };
  }

  async inspectDom() { return inspectDeepSeekDom(this.page); }

  async ensureLoggedIn() {
    const state = await this.inspectPageState();
    if (state.loginStatus !== "logged_in") {
      const code = state.loginStatus === "login_required" ? "PLATFORM_LOGIN_REQUIRED"
        : state.loginStatus === "verification_required" ? "VERIFICATION_REQUIRED"
          : state.loginStatus === "rate_limited" ? "PLATFORM_SEND_RATE_LIMIT"
            : "DEEPSEEK_PAGE_NOT_READY";
      throw new DeepSeekAdapterError("DeepSeek 尚未处于可发送状态，请在已打开的窗口中处理登录或页面状态。", code);
    }
    return state;
  }

  async startNewConversation() {
    await this.ensureLoggedIn();
    const control = this._textControl(DEEPSEEK_LOCATORS.newConversationText);
    if (!await visible(control)) throw new DeepSeekAdapterError("未找到 DeepSeek 新对话入口", "DEEPSEEK_NEW_CONVERSATION_UNAVAILABLE");
    const previous = { url: this.page.url(), mode: await this._webSearchState(), at: new Date().toISOString() };
    await control.click();
    await wait(250);
    return previous;
  }

  async confirmNewConversation(previous = null) {
    const state = await this.inspectPageState();
    const composer = await this._composer();
    const empty = composer && await composer.evaluate((element) => String(element.value ?? element.textContent ?? "").trim().length === 0).catch(() => false);
    if (state.loginStatus !== "logged_in" || !state.composer.editable || !empty) {
      throw new DeepSeekAdapterError("DeepSeek 新对话未确认：Composer 未处于空白可编辑状态", "DEEPSEEK_NEW_CONVERSATION_NOT_CONFIRMED");
    }
    return { confirmed: true, previous, url: state.url, composerEmpty: true, mode: state.mode, checkedAt: new Date().toISOString() };
  }

  async prepareMode(mode = "chat") {
    if (!["chat", "web_search"].includes(mode)) throw new DeepSeekAdapterError(`不支持的 DeepSeek 模式：${mode}`, "INVALID_PLATFORM_MODE");
    await this.ensureLoggedIn();
    const expected = mode === "web_search";
    const control = this._webSearchControl();
    if (!await visible(control)) throw new DeepSeekAdapterError("未找到 DeepSeek 智能搜索开关", "DEEPSEEK_MODE_CONTROL_UNAVAILABLE");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const actual = await this._webSearchState();
      if (actual === expected) return this.verifyMode(mode);
      if (actual === null) throw new DeepSeekAdapterError("无法从真实页面读取智能搜索状态", "PLATFORM_MODE_NOT_READY");
      await control.click();
      await wait(350);
    }
    return this.verifyMode(mode);
  }

  async verifyMode(mode = "chat") {
    if (!["chat", "web_search"].includes(mode)) throw new DeepSeekAdapterError(`不支持的 DeepSeek 模式：${mode}`, "INVALID_PLATFORM_MODE");
    const actual = await this._webSearchState();
    const expected = mode === "web_search";
    const ready = actual === expected;
    if (!ready) throw new DeepSeekAdapterError(`DeepSeek 模式未就绪：期望 ${mode}，实际 ${actual === true ? "web_search" : actual === false ? "chat" : "unknown"}`, "PLATFORM_MODE_NOT_READY");
    return { workerId: this.workerId, pageId: this.pageId, pageIndex: this.pageIndex, ready, mode, webSearchEnabled: actual, composer: (await this.inspectPageState()).composer, checkedAt: new Date().toISOString() };
  }

  async _answerSnapshot() {
    return this.page.evaluate(({ selectors, generatingText }) => {
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const ordered = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!seen.has(element) && isVisible(element)) { seen.add(element); ordered.push({ element, selector }); }
        }
      }
      const candidates = ordered.map(({ element, selector }) => ({
        selector,
        text: String(element.innerText || element.textContent || "").replace(/\n{3,}/g, "\n\n").trim(),
      })).filter((item) => item.text);
      const preferred = candidates.filter((item) => /ds-markdown|assistant/.test(item.selector));
      const answerText = (preferred.length ? preferred : candidates).at(-1)?.text || "";
      const body = String(document.body?.innerText || "");
      const composer = document.querySelector("textarea[placeholder*='给 DeepSeek 发送消息'], textarea, [contenteditable='true'][role='textbox'], [contenteditable='true'], [role='textbox']");
      const composerReady = Boolean(composer && isVisible(composer) && !(composer.disabled || composer.readOnly));
      return {
        answerText,
        answerTexts: candidates.map((item) => item.text),
        generating: generatingText.some((text) => body.includes(text)),
        composerReady,
        observedAt: new Date().toISOString(),
      };
    }, { selectors: DEEPSEEK_LOCATORS.assistantAnswer, generatingText: DEEPSEEK_LOCATORS.generatingText });
  }

  async submitPrompt(questionText, { platformMode = "chat" } = {}) {
    const text = String(questionText || "").trim();
    if (!text) throw new DeepSeekAdapterError("DeepSeek Canary 缺少问题文本", "DEEPSEEK_PROMPT_EMPTY");
    if (!["chat", "web_search"].includes(platformMode)) throw new DeepSeekAdapterError(`不支持的 DeepSeek 模式：${platformMode}`, "INVALID_PLATFORM_MODE");
    await this.ensureLoggedIn();
    const expectedWebSearch = platformMode === "web_search";
    const actualWebSearch = await this._webSearchState();
    if (actualWebSearch !== expectedWebSearch) {
      throw new DeepSeekAdapterError(`发送前模式校验失败：期望 ${platformMode}`, "PLATFORM_MODE_NOT_READY");
    }
    const composer = await this._composer();
    if (!composer) throw new DeepSeekAdapterError("未找到 DeepSeek Composer", "DEEPSEEK_COMPOSER_UNAVAILABLE");
    const baseline = await this._answerSnapshot();
    await composer.fill(text);
    const exactText = await composer.evaluate((element) => String(element.value ?? element.textContent ?? "").trim()).catch(() => "");
    if (exactText !== text) throw new DeepSeekAdapterError("DeepSeek Composer 未保留原始问题文本", "DEEPSEEK_PROMPT_INPUT_MISMATCH");
    // Enter is the official composer submission action. It is issued only
    // after the mode hard guard above has read the real aria-pressed state.
    await composer.press("Enter");
    const submittedAt = new Date().toISOString();
    return { submittedAt, platformMode, webSearchEnabled: actualWebSearch, baselineAnswerTexts: baseline.answerTexts, pageId: this.pageId, workerId: this.workerId };
  }

  async waitForAnswerStart({ baselineAnswerTexts = [], timeoutMs = 60_000, pollIntervalMs = 350, signal = null } = {}) {
    const baseline = new Set((baselineAnswerTexts || []).map((text) => String(text).trim()).filter(Boolean));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const snapshot = await this._answerSnapshot();
      if (snapshot.generating || snapshot.answerTexts.some((text) => text && !baseline.has(text))) {
        this.lastAnswerSnapshot = snapshot;
        return { startedAt: new Date().toISOString(), snapshot };
      }
      await waitWithAbort(pollIntervalMs, signal);
    }
    throw new DeepSeekAdapterError("DeepSeek 回答未开始", "DEEPSEEK_ANSWER_NOT_STARTED");
  }

  async waitForAnswerComplete({ timeoutMs = 120_000, pollIntervalMs = 500, stableMs = 1_500, signal = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let stableText = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      const snapshot = await this._answerSnapshot();
      const text = String(snapshot.answerText || "").trim();
      if (text && !snapshot.generating && snapshot.composerReady) {
        if (text === stableText) {
          if (Date.now() - stableSince >= stableMs) {
            this.lastAnswerSnapshot = snapshot;
            return { completedAt: new Date().toISOString(), snapshot };
          }
        } else { stableText = text; stableSince = Date.now(); }
      } else { stableText = ""; stableSince = 0; }
      await waitWithAbort(pollIntervalMs, signal);
    }
    throw new DeepSeekAdapterError("DeepSeek 回答未完成", "DEEPSEEK_ANSWER_TIMEOUT");
  }

  async getAnswer() {
    const snapshot = this.lastAnswerSnapshot || await this._answerSnapshot();
    const answer = String(snapshot.answerText || "").trim();
    if (!answer) throw new DeepSeekAdapterError("DeepSeek 未返回可保存的完整回答", "DEEPSEEK_EMPTY_ANSWER");
    return answer;
  }

  async _expandCitationPanels() {
    const controls = this.page.locator("button, [role='button']");
    const indexes = await controls.evaluateAll((nodes, labels) => nodes
      .map((node, index) => ({ index, text: String(node.innerText || node.getAttribute("aria-label") || "").trim() }))
      .filter((item) => item.text && labels.some((label) => item.text === label || item.text.startsWith(`${label} `)))
      .map((item) => item.index), DEEPSEEK_LOCATORS.citationPanelText).catch(() => []);
    for (const index of indexes.slice(0, 3)) await controls.nth(index).click().catch(() => null);
  }

  async getCitations() {
    await this._expandCitationPanels();
    const candidates = await this.page.evaluate((selectors) => {
      const scopes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
      const links = scopes.flatMap((scope) => [...scope.querySelectorAll("a[href]")].map((link) => ({
        title: String(link.innerText || link.getAttribute("aria-label") || "").trim(),
        url: link.getAttribute("href") || "",
        sourceName: String(scope.getAttribute("data-source-name") || scope.querySelector("[class*='source-name']")?.textContent || "").trim(),
        sourceMethod: "deepseek_dom_citation_panel",
      })));
      return links;
    }, DEEPSEEK_LOCATORS.citationContainer);
    const citations = normalizeDeepSeekCitationCandidates(candidates);
    return {
      citations,
      citationCaptureStatus: citations.length ? "success" : "empty",
      citationCapture: { capturedAt: new Date().toISOString(), source: "deepseek_visible_dom", candidateCount: candidates.length },
      citationCaptureError: null,
    };
  }

  // The formal runner calls this single contract for every question.  Keeping
  // the conversation reset and the aria-pressed guard here makes it impossible
  // for a queued web-search question to inherit a prior tab's chat mode.
  async ask(questionText, { platformMode = "web_search", onStage = async () => {}, signal = null } = {}) {
    if (!['chat', 'web_search'].includes(platformMode)) throw new DeepSeekAdapterError(`不支持的 DeepSeek 模式：${platformMode}`, "INVALID_PLATFORM_MODE");
    const startedAt = new Date().toISOString();
    throwIfAborted(signal);
    await this.ensureLoggedIn();
    throwIfAborted(signal);
    await onStage("PAGE_READY", null);
    const previous = await this.startNewConversation();
    throwIfAborted(signal);
    await onStage("NEW_CHAT_REQUESTED", { previous, url: this.page.url() });
    const conversation = await this.confirmNewConversation(previous);
    throwIfAborted(signal);
    await onStage("NEW_CHAT_CONFIRMED", conversation);
    await this.prepareMode(platformMode);
    throwIfAborted(signal);
    const mode = await this.verifyMode(platformMode);
    // submitPrompt performs the second, immediate aria-pressed read directly
    // before Enter.  Do not move this guard out of the adapter.
    if (mode.webSearchEnabled !== (platformMode === "web_search")) {
      throw new DeepSeekAdapterError(`发送前模式校验失败：期望 ${platformMode}`, "PLATFORM_MODE_NOT_READY");
    }
    throwIfAborted(signal);
    const submitted = await this.submitPrompt(questionText, { platformMode });
    throwIfAborted(signal);
    await onStage("PROMPT_SUBMITTED", { ...conversation, platformMode, webSearchEnabled: mode.webSearchEnabled });
    const answerStarted = await this.waitForAnswerStart({ baselineAnswerTexts: submitted.baselineAnswerTexts, signal });
    await onStage("ANSWER_STARTED", conversation);
    const answerCompleted = await this.waitForAnswerComplete({ signal });
    await onStage("GENERATION_ENDED", conversation);
    await onStage("ANSWER_COMPLETE", conversation);
    const citations = await this.getCitations();
    const completedAt = answerCompleted.completedAt;
    const url = this.page.url();
    return {
      answer: await this.getAnswer(),
      ...citations,
      conversation: { ...conversation, conversationId: url, sessionUuid: url, url, platformMode, webSearchEnabled: mode.webSearchEnabled },
      startedAt,
      firstTokenAt: answerStarted.startedAt,
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    };
  }

  async detectBlockingState() { const state = await this.inspectPageState(); return state.blocking; }
  async waitForBlockingStateClear({ pollIntervalMs = 1000, timeoutMs = this.navigationTimeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.inspectPageState();
      if (!state.blocking) return state;
      await wait(pollIntervalMs);
    }
    throw new DeepSeekAdapterError("DeepSeek 阻塞状态未解除", "DEEPSEEK_BLOCKING_STATE_TIMEOUT");
  }

  async recoverPage() { await this.page.reload({ waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs }); return this.inspectPageState(); }
  async recreatePage() { await this.page?.close().catch(() => null); this.page = await this.context.newPage(); return this.initialize(); }
  async close() { await this.page?.close().catch(() => null); }
}
