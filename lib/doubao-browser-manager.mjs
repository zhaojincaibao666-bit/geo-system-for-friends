import { DoubaoAdapter, DoubaoLoginRequiredError, DoubaoHumanActionRequiredError } from "./doubao-adapter.mjs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium as bundledChromium } from "playwright";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * The sole owner of the real Doubao browser runtime.
 *
 * There is exactly one root Adapter (and therefore one Persistent Context).
 * Worker adapters never launch a browser: each receives a Page from the root
 * context and is bound to it permanently by worker id for the life of a run.
 */
export class DoubaoBrowserManager {
  constructor(options = {}) {
    this.options = { ...options, headless: false };
    this.chromium = options.chromium || bundledChromium;
    this.workerCount = Math.min(5, Math.max(1, Number(options.workerCount || 4)));
    this.adapterFactory = options.adapterFactory || ((adapterOptions) => new DoubaoAdapter(adapterOptions));
    this.context = null;
    this.root = null;
    this.workers = new Map();
    this.initializePromise = null;
    // Browser creation has a small lock, but topology changes need a wider
    // critical section.  A Smoke request, a formal-run preflight and a worker
    // replacement must never concurrently mutate the same Context/worker map.
    this.operationTail = Promise.resolve();
    this.coalescedOperations = new Map();
    this.operationDepth = 0;
    this.operation = { state: "idle", kind: null, startedAt: null, completedAt: null, error: null };
    this.browserInstanceId = null;
    this.contextInstanceId = null;
    this.topologyGeneration = 0;
    this.events = [];
    this.lastSmokeSnapshot = null;
  }

  async ensureBrowser() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      // Playwright keeps a Context object after Chromium has crashed or been
      // closed externally.  Treat that object as stale; otherwise the next
      // `context.newPage()` throws `Target ... has been closed` forever.
      if (this.context && !this._contextUsable()) await this._discardClosedContext();
      if (!this.context) await this._launchPersistentContext();
      if (!this.root) this.root = this._createWorkerAdapter("doubao-worker-1", 1, await this._takeRootPage());
      await this.root.initialize();
      this.workers.set("doubao-worker-1", this.root);
      return this.root;
    })();
    try { return await this.initializePromise; }
    finally { this.initializePromise = null; }
  }

  async ensurePersistentContext() {
    await this.ensureBrowser();
    if (!this.context || !this._contextUsable()) throw new Error("DOUBAO_PERSISTENT_CONTEXT_UNAVAILABLE");
    return this.context;
  }

  async ensureVisibleWindow() {
    const root = await this.ensureBrowser();
    await root.page?.bringToFront?.();
    // Playwright can select the tab but Windows may deny foreground stealing.
    // We report that limitation instead of creating a second browser/window.
    return { headed: root.headless === false, tabFocusRequested: true };
  }

  async ensureLoginPage() {
    const root = await this.ensureBrowser();
    await root.ensurePageReady();
    await this.ensureVisibleWindow();
    return root.page;
  }

  async detectLoginState() {
    return this._withBrowserOperation("login_status", () => this._detectLoginStateUnsafe());
  }

  async _detectLoginStateUnsafe() {
    await this.ensureLoginPage();
    const readiness = await this._inspectWorkerReadinessUnsafe(this.root);
    return { state: readiness.loginStatus, blocking: readiness.blocking || null, readiness };
  }

  async _inspectWorkerReadinessUnsafe(worker, { timeoutMs = 1_500 } = {}) {
    if (typeof worker?.inspectDoubaoPageState === "function") return worker.inspectDoubaoPageState({ timeoutMs });
    // Compatibility only for test doubles. Production adapters all use the
    // shared inspectDoubaoPageState implementation above.
    const login = await worker.inspectLoginReadiness({ timeoutMs });
    const inputReady = Boolean(login.inputReady ?? await worker.inspectInputReady({ timeoutMs }));
    const url = worker.page?.url?.() || null;
    return {
      workerId: worker.workerId,
      pageId: worker.pageId || null,
      url,
      urlReady: Boolean(url && /^https:\/\/(?:www\.)?doubao\.com\/chat(?:\/|\?|$)/i.test(url)),
      inputReady,
      loginStatus: login.state || "unknown",
      verificationStatus: login.state === "verification_required" ? "verification_required" : "none",
      loadingStatus: "none",
      readyForPrompt: login.state === "logged_in" && inputReady,
      composer: null,
      blocking: login.blocking || null,
      checkedAt: new Date().toISOString(),
    };
  }

  async _prepareWorkerReadinessUnsafe(count = this.workerCount, { recovery = true } = {}) {
    await this.ensureBrowser();
    const workers = await this._reconcileWorkerTopology(count);
    await this.ensureVisibleWindow();
    let states = await Promise.all(workers.map((worker) => this._inspectWorkerReadinessUnsafe(worker)));
    const needsSecondCheck = () => states.filter((state) => ["unknown", "loading"].includes(state.loginStatus));
    if (needsSecondCheck().length) {
      await wait(350);
      states = await Promise.all(workers.map((worker) => this._inspectWorkerReadinessUnsafe(worker)));
    }
    // A transient shell hydration problem is recovered on that Worker only;
    // healthy Pages retain their object and page id.
    if (recovery && needsSecondCheck().length) {
      for (const state of needsSecondCheck()) {
        const worker = workers.find((candidate) => candidate.workerId === state.workerId);
        if (!worker?.page?.reload) continue;
        await worker.page.reload({ waitUntil: "domcontentloaded", timeout: worker.navigationTimeoutMs || 45_000 }).catch(() => null);
        await worker.ensurePageReady().catch(() => null);
      }
      states = await Promise.all(workers.map((worker) => this._inspectWorkerReadinessUnsafe(worker, { timeoutMs: 2_000 })));
    }
    const byWorkerId = new Map(states.map((state) => [state.workerId, state]));
    const topology = await this._topologySnapshot({ expectedWorkers: count, workerReadiness: byWorkerId });
    const verification = states.find((state) => state.loginStatus === "verification_required");
    const loginRequired = states.find((state) => state.loginStatus === "login_required");
    const readyForRun = topology.topologyReady && states.length === workers.length && states.every((state) => state.readyForPrompt);
    const loginStatus = readyForRun ? "logged_in"
      : verification ? "verification_required"
        : loginRequired ? "login_required"
          : states.some((state) => state.loginStatus === "loading") ? "loading" : "unknown";
    if (!readyForRun) {
      for (const state of states.filter((candidate) => !candidate.readyForPrompt)) {
        const worker = workers.find((candidate) => candidate.workerId === state.workerId);
        if (typeof worker?.captureDebugArtifact !== "function") continue;
        state.debugArtifact = await worker.captureDebugArtifact({ stage: "run_preflight_not_ready" }).catch(() => null);
      }
    }
    return { readyForRun, loginStatus, workers, workerStates: states, topology, blocking: verification?.blocking || null };
  }

  _workerNotReadyError(preflight) {
    const failed = preflight.workerStates.filter((state) => !state.readyForPrompt);
    const details = failed.map((state) => `${state.workerId} pageId=${state.pageId || "unknown"} url=${state.url || "unknown"} login=${state.loginStatus} inputReady=${state.inputReady} verification=${state.verificationStatus}`).join("; ");
    const error = new Error(`DOUBAO_WORKER_NOT_READY: ${details}`);
    error.code = "DOUBAO_WORKER_NOT_READY";
    error.preflight = preflight;
    error.workerStates = failed;
    return error;
  }

  async ensureWorkerPages(count = this.workerCount) {
    return this.reconcileWorkerTopology(count);
  }

  /** The only shared-worker topology reconciler used by Smoke and formal runs. */
  async reconcileWorkerTopology(count = this.workerCount) {
    return this._withBrowserOperation("reconcile_topology", () => this._reconcileWorkerTopology(count));
  }

  async _reconcileWorkerTopology(count = this.workerCount) {
    const expected = Math.min(5, Math.max(1, Number(count || this.workerCount)));
    const context = await this.ensurePersistentContext();
    const root = this.root;
    if (!root.page || root.page.isClosed?.()) await root.recreatePage();
    this.workers.set("doubao-worker-1", root);
    for (let pageIndex = 2; pageIndex <= expected; pageIndex += 1) {
      const workerId = `doubao-worker-${pageIndex}`;
      let worker = this.workers.get(workerId);
      if (!worker) {
        worker = this._createWorkerAdapter(workerId, pageIndex);
        this.workers.set(workerId, worker);
      }
      if (!worker.page || worker.page.isClosed?.()) await worker.initialize();
    }
    // Only manager-owned surplus tabs are removed when a deliberately lower
    // concurrency is selected. User-created/browser-owned tabs are untouched.
    for (const [workerId, worker] of [...this.workers]) {
      if (Number(worker.pageIndex) > expected) {
        await worker.close().catch(() => null);
        this.workers.delete(workerId);
      }
    }
    if (this.workers.size !== expected) throw new Error(`Unexpected worker page count: ${this.workers.size}/${expected}`);
    const workers = this.getWorkerPages(expected);
    workers.forEach((worker) => assertDoubaoWorkerAdapterInterface(worker, worker.workerId));
    // A map with four keys is not enough: each key must own a different live
    // Playwright Page. If a prior interrupted operation left a duplicate
    // reference, replace only the later worker Page and keep the first intact.
    const seenPages = new Set();
    for (const worker of workers) {
      if (!worker.page || worker.page.isClosed?.() || seenPages.has(worker.page)) {
        const previous = worker.page || null;
        worker.page = await this._replaceWorkerPageUnsafe(worker.workerId, { previous, closeExisting: false, reason: "topology_duplicate_or_closed" });
        await worker.initialize();
      }
      seenPages.add(worker.page);
    }
    await Promise.all(workers.map((worker) => worker.ensurePageReady()));
    const topology = await this._topologySnapshot({ expectedWorkers: expected });
    if (!topology.topologyReady) {
      const error = new Error(`DOUBAO_WORKER_TOPOLOGY_INVALID: ${topology.topologyErrors.join(", ")}`);
      error.code = "DOUBAO_WORKER_TOPOLOGY_INVALID";
      error.topology = topology;
      throw error;
    }
    this._recordEvent("WORKER_TOPOLOGY_READY", { expectedWorkers: expected, contextPageCount: topology.contextPageCount, workers: topology.workers.map((worker) => ({ workerId: worker.workerId, pageId: worker.pageId, url: worker.url })) });
    return workers;
  }

  async prepareForRun(count = this.workerCount) {
    return this._withBrowserOperation("prepare_run", async () => {
      const preflight = await this._prepareWorkerReadinessUnsafe(count);
      if (preflight.loginStatus === "login_required") throw new DoubaoLoginRequiredError("豆包登录状态失效：请在可见 Chromium 中完成登录");
      if (preflight.loginStatus === "verification_required") throw new DoubaoHumanActionRequiredError(preflight.blocking, "login_check");
      if (!preflight.readyForRun) throw this._workerNotReadyError(preflight);
      this._recordEvent("RUN_PREFLIGHT_READY", { topology: preflight.topology, workers: preflight.workerStates });
      return preflight.workers;
    });
  }

  /** Non-prompt production-equivalent readiness check; it never creates a Run. */
  async prepareForRunPreflight(count = this.workerCount) {
    return this._withBrowserOperation("run_preflight", async () => {
      const preflight = await this._prepareWorkerReadinessUnsafe(count);
      this._recordEvent(preflight.readyForRun ? "RUN_PREFLIGHT_READY" : "RUN_PREFLIGHT_NOT_READY", { topology: preflight.topology, workers: preflight.workerStates });
      return {
        readyForRun: preflight.readyForRun,
        loginStatus: preflight.loginStatus,
        workerCount: preflight.workers.length,
        workers: preflight.workerStates,
        topology: preflight.topology,
        blocking: preflight.blocking,
        runtime: this.diagnostics(),
      };
    });
  }

  /**
   * Account-switch preflight is deliberately separate from prepareForRun.
   * It never submits a prompt and never changes credentials. The operator
   * switches accounts in the visible Doubao window; we then verify every
   * managed Page and reset each Page into a confirmed blank conversation.
   */
  async prepareForAccountSwitch(count = this.workerCount) {
    return this._withBrowserOperation("account_switch_preflight", async () => {
      await this.ensureBrowser();
      await this.ensureVisibleWindow();
      const preflight = await this._prepareWorkerReadinessUnsafe(count);
      if (!preflight.readyForRun) throw this._workerNotReadyError(preflight);
      const workers = preflight.workers;
      const workerStates = [];
      for (const worker of workers) {
        const previous = await worker.startNewConversation();
        await worker.confirmNewConversation(previous);
        workerStates.push({
          workerId: worker.workerId,
          pageIndex: worker.pageIndex,
          pageId: worker.pageId || null,
          ready: true,
          conversationReset: true,
        });
      }
      return {
        ready: workerStates.length === workers.length,
        workerCount: workers.length,
        workers: workerStates,
        runtime: this.diagnostics(),
      };
    });
  }

  /**
   * Development-only, no-prompt launch verification.  It never creates a GEO
   * run or claims a question.  Login is checked before extra worker tabs are
   * created so an expired session remains a recoverable waiting state.
   */
  async prepareForSmokeTest(count = this.workerCount) {
    return this._withBrowserOperation("smoke", async () => {
      this._recordEvent("SMOKE_STARTED", { expectedWorkers: count });
      const preflight = await this._prepareWorkerReadinessUnsafe(count);
      const workers = preflight.workers;
      const browserTopology = preflight.topology;
      if (!browserTopology.topologyReady) {
        const error = new Error(`DOUBAO_SMOKE_TOPOLOGY_FAILED: ${browserTopology.topologyErrors.join(", ")}`);
        error.code = "DOUBAO_SMOKE_TOPOLOGY_FAILED";
        error.browserTopology = browserTopology;
        this._recordEvent("SMOKE_FAILED", { error: error.message, topology: browserTopology });
        throw error;
      }
      const status = preflight.readyForRun ? "ready"
        : preflight.loginStatus === "login_required" ? "waiting_for_login"
          : preflight.loginStatus === "verification_required" ? "verification_required"
            : "unknown";
      const result = {
        status,
        topologyStatus: "ready",
        loginStatus: preflight.loginStatus,
        workerCount: workers.length,
        workers: preflight.workerStates,
        blocking: preflight.blocking || null,
        browserTopology,
        runtime: this.diagnostics(),
      };
      this.lastSmokeSnapshot = { checkedAt: new Date().toISOString(), topologyGeneration: browserTopology.topologyGeneration, browserInstanceId: browserTopology.browserInstanceId, contextInstanceId: browserTopology.contextInstanceId, loginStatus: preflight.loginStatus, readyWorkers: preflight.workerStates.filter((worker) => worker.readyForPrompt).length, workers: preflight.workerStates.map((worker) => ({ workerId: worker.workerId, pageId: worker.pageId, url: worker.url })) };
      this._recordEvent(status === "ready" ? "SMOKE_READY" : status === "waiting_for_login" ? "SMOKE_WAITING_FOR_LOGIN" : "SMOKE_FAILED", { loginStatus: preflight.loginStatus, topology: browserTopology });
      return result;
    }, { coalesceKey: "smoke" });
  }

  getWorkerPage(workerId) { return this.workers.get(workerId)?.page || null; }
  getWorker(workerId) { return this.workers.get(workerId) || null; }
  getWorkerPages(count = this.workerCount) {
    return Array.from({ length: count }, (_, index) => this.workers.get(`doubao-worker-${index + 1}`)).filter(Boolean);
  }

  async bringWorkerToFront(workerId) {
    // Never fall back to Worker 1: a focus request must select the exact
    // existing Worker tab, or report that the requested tab is unavailable.
    const worker = this.getWorker(workerId);
    if (!worker?.page || worker.page.isClosed?.()) return { focused: false, reason: "WORKER_PAGE_UNAVAILABLE" };
    await worker.page.bringToFront();
    return { focused: true, workerId, pageIndex: worker.pageIndex, headed: worker.headless === false };
  }

  async waitForLogin({ pollIntervalMs = 1_500, isWaiting = () => true } = {}) {
    while (isWaiting()) {
      const login = await this.detectLoginState();
      if (login.state === "logged_in") return login;
      await wait(pollIntervalMs);
    }
    return null;
  }

  diagnostics() {
    return {
      persistentContext: Boolean(this.context && this._contextUsable()),
      headless: false,
      browserInstanceId: this.browserInstanceId,
      contextInstanceId: this.contextInstanceId,
      topologyGeneration: this.topologyGeneration,
      lastSmokeSnapshot: this.lastSmokeSnapshot,
      operation: { ...this.operation },
      managedWorkerPages: this.workers.size,
      workers: this.getWorkerPages(5).map((worker) => ({ workerId: worker.workerId, pageIndex: worker.pageIndex, pageId: worker.pageId || null, pageClosed: Boolean(worker.page?.isClosed?.()), createdAt: worker.createdAt || null })),
    };
  }

  async shutdown() {
    return this._withBrowserOperation("shutdown", async () => {
      await this.context?.close().catch(() => null);
      this.context = null;
      this.root = null;
      this.workers.clear();
    });
  }

  _managedPagesAreAllClosed() {
    const managed = [...this.workers.values()];
    return managed.length > 0 && managed.every((worker) => !worker?.page || worker.page.isClosed?.());
  }

  _contextUsable() {
    if (!this.context) return false;
    try {
      if (this._managedPagesAreAllClosed()) return false;
      const browser = this.context.browser?.();
      if (browser && typeof browser.isConnected === "function") return browser.isConnected();
      // Test doubles and older Playwright adapters may not expose
      // `context.browser()`.  A successful pages() call is the strongest
      // portable liveness signal in that case; an empty list is still a valid
      // newly-created Persistent Context.
      this.context.pages?.();
      return true;
    } catch {
      return false;
    }
  }

  async _discardClosedContext() {
    const staleContext = this.context;
    this.context = null;
    this.root = null;
    this.workers.clear();
    await staleContext?.close?.().catch(() => null);
  }

  async _launchPersistentContext() {
    if (!this.options.profileDir) throw new Error("DOUBAO_PROFILE_REQUIRED");
    await mkdir(this.options.profileDir, { recursive: true });
    await mkdir(this.options.debugDir || `${this.options.profileDir}/debug`, { recursive: true });
    const context = await this.chromium.launchPersistentContext(this.options.profileDir, {
      headless: false,
      viewport: null,
      args: ["--start-maximized"],
      locale: "zh-CN",
    });
    this.context = context;
    this.browserInstanceId ||= `doubao-browser-${randomUUID()}`;
    this.contextInstanceId = `doubao-context-${randomUUID()}`;
    this.topologyGeneration += 1;
    this._recordEvent("BROWSER_CONTEXT_CREATED", { browserInstanceId: this.browserInstanceId, contextInstanceId: this.contextInstanceId, profileDir: this.options.profileDir });
    context.on?.("close", () => {
      // Do not retain closed Page/Context handles after a user closes the
      // visible Chromium window or the renderer exits unexpectedly.
      if (this.context === context) {
        this.context = null;
        this.root = null;
        this.workers.clear();
      }
    });
  }

  async _takeRootPage() {
    const [rootPage, ...startupPages] = this.context.pages();
    // This runs only immediately after a newly-created Context, before a user
    // can create pages in it. Any extra blank startup target is Chromium-owned
    // and may be safely removed; never apply this cleanup to later pages.
    await Promise.all(startupPages.filter((page) => !page.isClosed()).map((page) => page.close()));
    return rootPage || null;
  }

  _createWorkerAdapter(workerId, pageIndex, page = null) {
    const worker = this.adapterFactory({
      ...this.options,
      headless: false,
      context: this.context,
      page,
      ownsContext: false,
      workerId,
      pageIndex,
      pageId: `doubao-page-${randomUUID()}`,
      requestWorkerPage: (request) => this.replaceWorkerPage(workerId, request),
      releaseWorkerPage: (request) => this.releaseWorkerPage(workerId, request),
    });
    worker.pageId ||= `doubao-page-${randomUUID()}`;
    worker.createdAt ||= new Date().toISOString();
    this._recordEvent("WORKER_PAGE_CREATED", { workerId, pageId: worker.pageId, pageIndex, initialPageBound: Boolean(page) });
    return worker;
  }

  async replaceWorkerPage(workerId, { previous = null, closeExisting = false } = {}) {
    if (this.operationDepth > 0) return this._replaceWorkerPageUnsafe(workerId, { previous, closeExisting, reason: "manager_operation" });
    return this._withBrowserOperation("replace_worker_page", () => this._replaceWorkerPageUnsafe(workerId, { previous, closeExisting, reason: "worker_recovery" }));
  }

  async _replaceWorkerPageUnsafe(workerId, { previous = null, closeExisting = false, reason = "unknown" } = {}) {
    if (!this.context) throw new Error("DOUBAO_PERSISTENT_CONTEXT_UNAVAILABLE");
    if (closeExisting && previous && !previous.isClosed()) await previous.close().catch(() => null);
    const page = await this.context.newPage();
    const worker = this.getWorker(workerId) || (this.root?.workerId === workerId ? this.root : null);
    if (worker) {
      worker.pageId = `doubao-page-${randomUUID()}`;
      worker.createdAt = new Date().toISOString();
    }
    this.topologyGeneration += 1;
    this._recordEvent(previous ? "WORKER_PAGE_REPLACED" : "WORKER_PAGE_CREATED", { workerId, pageId: worker?.pageId || null, reason });
    return page;
  }

  async releaseWorkerPage(workerId, { page = null, reason = "adapter_release" } = {}) {
    if (this.operationDepth > 0) return this._releaseWorkerPageUnsafe(workerId, { page, reason });
    return this._withBrowserOperation("release_worker_page", () => this._releaseWorkerPageUnsafe(workerId, { page, reason }));
  }

  async _releaseWorkerPageUnsafe(workerId, { page = null, reason = "adapter_release" } = {}) {
    const worker = this.getWorker(workerId) || (this.root?.workerId === workerId ? this.root : null);
    const target = page || worker?.page || null;
    await target?.close?.().catch(() => null);
    if (worker?.page === target) worker.page = null;
    this.topologyGeneration += 1;
    this._recordEvent("WORKER_PAGE_RELEASED", { workerId, pageId: worker?.pageId || null, reason });
  }

  async getTopologySnapshot() {
    if (!this.context || !this._contextUsable()) return this._topologySnapshot({ expectedWorkers: this.workerCount, loginStatus: "unknown" });
    return this._withBrowserOperation("topology_snapshot", async () => {
      const login = await this._detectLoginStateUnsafe().catch(() => ({ state: "unknown" }));
      return this._topologySnapshot({ expectedWorkers: this.workerCount, loginStatus: login.state || "unknown" });
    });
  }

  async _topologySnapshot({ expectedWorkers = this.workerCount, loginStatus = "unknown", workerReadiness = null } = {}) {
    const contextReady = Boolean(this.context && this._contextUsable());
    const pages = contextReady ? this.context.pages() : [];
    const workers = this.getWorkerPages(expectedWorkers);
    const workerSnapshots = await Promise.all(workers.map(async (worker) => {
      const page = worker.page;
      const closed = !page || page.isClosed?.();
      const url = closed ? null : page.url();
      const title = closed ? null : await page.title().catch(() => null);
      const readiness = workerReadiness?.get?.(worker.workerId) || null;
      const inputReady = closed ? false : Boolean(readiness?.inputReady ?? await worker.inspectInputReady({ timeoutMs: 750 }).catch(() => false));
      const urlReady = Boolean(url && /^https:\/\/(?:www\.)?doubao\.com\//i.test(url));
      const status = closed ? "closed"
        : !urlReady ? "not_on_doubao"
          : readiness?.loginStatus === "login_required" ? "login_required"
            : readiness?.loginStatus === "verification_required" ? "verification_required"
              : readiness?.readyForPrompt ? "ready"
                : inputReady ? "page_ready" : "not_ready";
      return { workerId: worker.workerId, pageId: worker.pageId || null, pageIndex: worker.pageIndex, closed, url, title, inputReady, urlReady, status, readiness };
    }));
    const pageRefs = workers.map((worker) => worker.page).filter(Boolean);
    const pageIds = workerSnapshots.map((worker) => worker.pageId).filter(Boolean);
    const topologyErrors = [];
    if (!contextReady) topologyErrors.push("context_unavailable");
    if (workers.length !== expectedWorkers) topologyErrors.push(`worker_count_${workers.length}/${expectedWorkers}`);
    if (pageRefs.length !== expectedWorkers) topologyErrors.push("worker_page_missing");
    if (new Set(pageRefs).size !== pageRefs.length) topologyErrors.push("worker_pages_not_unique");
    if (new Set(pageIds).size !== pageIds.length || pageIds.length !== expectedWorkers) topologyErrors.push("worker_page_ids_not_unique");
    if (workerSnapshots.some((worker) => worker.closed)) topologyErrors.push("worker_page_closed");
    if (workerSnapshots.some((worker) => !worker.urlReady)) topologyErrors.push("worker_url_not_doubao");
    return {
      contextReady,
      contextPageCount: pages.length,
      browserInstanceId: this.browserInstanceId,
      contextInstanceId: this.contextInstanceId,
      topologyGeneration: this.topologyGeneration,
      expectedWorkers,
      readyWorkers: workerSnapshots.filter((worker) => !worker.closed && worker.urlReady).length,
      allWorkerPagesUnique: pageRefs.length === expectedWorkers && new Set(pageRefs).size === expectedWorkers,
      allWorkerPageIdsUnique: pageIds.length === expectedWorkers && new Set(pageIds).size === expectedWorkers,
      allWorkerUrlsReady: workerSnapshots.length === expectedWorkers && workerSnapshots.every((worker) => worker.urlReady),
      loginStatus: workerReadiness ? (workerSnapshots.every((worker) => worker.readiness?.readyForPrompt) ? "logged_in" : loginStatus) : loginStatus,
      topologyReady: topologyErrors.length === 0,
      topologyErrors,
      workers: workerSnapshots,
      operation: { ...this.operation },
    };
  }

  async _withBrowserOperation(kind, task, { coalesceKey = null } = {}) {
    if (coalesceKey && this.coalescedOperations.has(coalesceKey)) return this.coalescedOperations.get(coalesceKey);
    const execute = async () => {
      this.operation = { state: "running", kind, startedAt: new Date().toISOString(), completedAt: null, error: null };
      this.operationDepth += 1;
      try {
        const result = await task();
        this.operation = { ...this.operation, state: "completed", completedAt: new Date().toISOString() };
        return result;
      } catch (error) {
        this.operation = { ...this.operation, state: "failed", completedAt: new Date().toISOString(), error: { code: error?.code || null, message: String(error?.message || error).slice(0, 300) } };
        throw error;
      } finally {
        this.operationDepth -= 1;
      }
    };
    const operation = this.operationTail.then(execute, execute);
    this.operationTail = operation.catch(() => null);
    if (!coalesceKey) return operation;
    const shared = operation.finally(() => this.coalescedOperations.delete(coalesceKey));
    this.coalescedOperations.set(coalesceKey, shared);
    return shared;
  }

  _recordEvent(type, details = {}) {
    const event = { type, serverInstanceId: this.options.serverInstanceId || null, at: new Date().toISOString(), ...details };
    this.events.unshift(event);
    this.events = this.events.slice(0, 100);
    this.options.logger?.info?.("[doubao-browser]", event);
  }
}

const REQUIRED_WORKER_ADAPTER_METHODS = [
  "initialize",
  "ensurePageReady",
  "startNewConversation",
  "submitPrompt",
  "waitForAnswerComplete",
  "getAnswer",
  "detectBlockingState",
  "ask",
];

export function assertDoubaoWorkerAdapterInterface(worker, workerId = "unknown") {
  const missing = REQUIRED_WORKER_ADAPTER_METHODS.filter((method) => typeof worker?.[method] !== "function");
  if (!missing.length) return true;
  const error = new Error(`DOUBAO_ADAPTER_INTERFACE_ERROR: worker ${workerId} missing method ${missing.join(", ")}`);
  error.code = "DOUBAO_ADAPTER_INTERFACE_ERROR";
  error.workerId = workerId;
  error.missingMethods = missing;
  throw error;
}
