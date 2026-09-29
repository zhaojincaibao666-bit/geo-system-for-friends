import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium as bundledChromium } from "playwright";
import { DeepSeekAdapter } from "./deepseek-adapter.mjs";

export class DeepSeekBrowserManager {
  constructor(options = {}) {
    this.options = { ...options, headless: false };
    this.chromium = options.chromium || bundledChromium;
    this.workerCount = Math.min(5, Math.max(1, Number(options.workerCount || 4)));
    this.adapterFactory = options.adapterFactory || ((adapterOptions) => new DeepSeekAdapter(adapterOptions));
    this.context = null; this.workers = new Map(); this.initializePromise = null;
    this.operationTail = Promise.resolve(); this.browserInstanceId = null; this.contextInstanceId = null; this.topologyGeneration = 0;
  }

  async ensureBrowser() {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      if (!this.context) await this._launchPersistentContext();
      if (!this.workers.get("deepseek-worker-1")) await this._createWorker("deepseek-worker-1", 1, (this.context.pages?.() || [])[0] || null);
      return this.workers.get("deepseek-worker-1");
    })();
    try { return await this.initializePromise; } finally { this.initializePromise = null; }
  }

  async _launchPersistentContext() {
    await mkdir(this.options.profileDir, { recursive: true });
    const context = await this.chromium.launchPersistentContext(this.options.profileDir, {
      // Do not inherit an implicit/headless launch path. These explicit flags
      // keep the dedicated DeepSeek window on the active desktop instead of
      // relying on maximization or a remembered off-screen window position.
      headless: false,
      viewport: { width: 1400, height: 900 },
      screen: { width: 1400, height: 900 },
      args: ["--window-size=1400,900", "--window-position=100,100", "--new-window"],
      locale: "zh-CN",
    });
    this.context = context; this.browserInstanceId = `deepseek-browser-${randomUUID()}`; this.contextInstanceId = `deepseek-context-${randomUUID()}`; this.topologyGeneration += 1;
    context.on?.("close", () => { if (this.context === context) { this.context = null; this.workers.clear(); } });
  }

  async _createWorker(workerId, pageIndex, page = null) {
    const worker = this.adapterFactory({ context: this.context, page, workerId, pageIndex, webUrl: this.options.webUrl, navigationTimeoutMs: this.options.navigationTimeoutMs });
    await worker.initialize(); this.workers.set(workerId, worker); return worker;
  }

  async ensurePersistentContext() { await this.ensureBrowser(); return this.context; }
  async ensureVisibleWindow() { const worker = await this.ensureBrowser(); await worker.page?.bringToFront?.(); return { headed: true, tabFocusRequested: true }; }
  getWorker(workerId) { return this.workers.get(workerId) || null; }
  getWorkerPages(count = this.workerCount) { return Array.from({ length: count }, (_, index) => this.workers.get(`deepseek-worker-${index + 1}`)).filter(Boolean); }
  async inspectWorkerDom(workerId = "deepseek-worker-1") {
    const worker = this.getWorker(workerId);
    if (!worker) throw new Error("DEEPSEEK_WORKER_NOT_FOUND");
    return worker.inspectDom();
  }

  async reconcileWorkerTopology(count = this.workerCount) {
    return this._withOperation(() => this._reconcileWorkerTopology(count));
  }

  async _reconcileWorkerTopology(count = this.workerCount) {
    await this.ensureBrowser();
    const expected = Math.min(5, Math.max(1, Number(count)));
    for (let index = 2; index <= expected; index += 1) if (!this.workers.get(`deepseek-worker-${index}`)) await this._createWorker(`deepseek-worker-${index}`, index);
    for (const [id, worker] of [...this.workers]) if (worker.pageIndex > expected) { await worker.close(); this.workers.delete(id); }
    const workers = this.getWorkerPages(expected);
    if (workers.length !== expected || new Set(workers.map((worker) => worker.page)).size !== expected) throw new Error("DEEPSEEK_WORKER_TOPOLOGY_INVALID");
    return workers;
  }

  async getTopologySnapshot() { return this._topologySnapshot(this.workerCount); }
  async _topologySnapshot(expected = this.workerCount, states = []) {
    const workers = this.getWorkerPages(expected).map((worker) => ({ workerId: worker.workerId, pageIndex: worker.pageIndex, pageId: worker.pageId, url: worker.page?.url?.() || null, pageReady: Boolean(worker.page && !worker.page.isClosed?.()), inputReady: states.find((state) => state.workerId === worker.workerId)?.inputReady || false }));
    return { contextReady: Boolean(this.context), contextPageCount: this.context?.pages?.().length || 0, browserInstanceId: this.browserInstanceId, contextInstanceId: this.contextInstanceId, topologyGeneration: this.topologyGeneration, expectedWorkers: expected, readyWorkers: workers.filter((worker) => worker.pageReady).length, allWorkerPagesUnique: new Set(this.getWorkerPages(expected).map((worker) => worker.page)).size === expected, allWorkerPageIdsUnique: new Set(workers.map((worker) => worker.pageId)).size === expected, topologyReady: workers.length === expected && workers.every((worker) => worker.pageReady), workers };
  }

  async prepareForSmokeTest(count = this.workerCount, platformMode = "web_search") {
    return this._withOperation(async () => {
      const workers = await this._reconcileWorkerTopology(count); await this.ensureVisibleWindow();
      const states = await Promise.all(workers.map((worker) => worker.inspectPageState()));
      const topology = await this._topologySnapshot(count, states);
      const loginRequired = states.some((state) => state.loginStatus === "login_required");
      const blocking = states.find((state) => state.loginStatus === "verification_required")?.blocking || null;
      if (loginRequired || blocking || states.some((state) => state.loginStatus !== "logged_in")) return { status: loginRequired ? "waiting_for_login" : blocking ? "verification_required" : "unknown", loginStatus: loginRequired ? "login_required" : blocking ? "verification_required" : "unknown", platformMode, workerCount: workers.length, workers: states, blocking, browserTopology: topology, runtime: this.diagnostics() };
      // This intentionally remains fail-closed until the user has manually
      // logged in and the current official DOM is audited.
      const prepared = await Promise.all(workers.map(async (worker) => {
        const previous = await worker.startNewConversation();
        const conversation = await worker.confirmNewConversation(previous);
        await worker.prepareMode(platformMode);
        const mode = await worker.verifyMode(platformMode);
        const page = await worker.inspectPageState();
        return { ...page, ...mode, conversation, ready: Boolean(page.readyForPrompt && mode.ready) };
      }));
      const ready = prepared.every((state) => state?.ready === true);
      return { status: ready ? "ready" : "unknown", loginStatus: "logged_in", platformMode, workerCount: workers.length, workers: prepared, browserTopology: await this._topologySnapshot(count, prepared), runtime: this.diagnostics() };
    });
  }

  // Formal execution is deliberately non-mutating: Smoke owns the explicit
  // new-chat/mode preparation, while the adapter repeats that sequence per
  // question immediately before a prompt may be submitted.
  async prepareForRun(count = this.workerCount) {
    return this._withOperation(async () => {
      const workers = await this._reconcileWorkerTopology(count);
      const states = await Promise.all(workers.map((worker) => worker.inspectPageState()));
      const blocked = states.find((state) => state.loginStatus === "verification_required" || state.loginStatus === "rate_limited");
      if (blocked) {
        const error = new Error(`DeepSeek Worker 当前不可执行：${blocked.loginStatus}`);
        error.code = blocked.loginStatus === "verification_required" ? "VERIFICATION_REQUIRED" : "PLATFORM_SEND_RATE_LIMIT";
        error.workerStates = states;
        throw error;
      }
      if (states.some((state) => state.loginStatus === "login_required")) {
        const error = new Error("DeepSeek 尚未登录"); error.code = "PLATFORM_LOGIN_REQUIRED"; error.workerStates = states; throw error;
      }
      if (states.some((state) => state.loginStatus !== "logged_in" || !state.readyForPrompt)) {
        const error = new Error("DeepSeek Worker 页面未就绪"); error.code = "DEEPSEEK_WORKER_NOT_READY"; error.workerStates = states; throw error;
      }
      return workers;
    });
  }

  async bringWorkerToFront(workerId) { const worker = this.getWorker(workerId); if (!worker?.page || worker.page.isClosed?.()) return { focused: false, reason: "WORKER_PAGE_UNAVAILABLE" }; await worker.page.bringToFront(); return { focused: true, workerId, pageIndex: worker.pageIndex, headed: true }; }
  diagnostics() { return { persistentContext: Boolean(this.context), headless: false, browserInstanceId: this.browserInstanceId, contextInstanceId: this.contextInstanceId, topologyGeneration: this.topologyGeneration, managedWorkerPages: this.workers.size, workers: this.getWorkerPages(5).map((worker) => ({ workerId: worker.workerId, pageIndex: worker.pageIndex, pageId: worker.pageId, pageClosed: Boolean(worker.page?.isClosed?.()) })) }; }
  async shutdown() { await this.context?.close().catch(() => null); this.context = null; this.workers.clear(); }
  async _withOperation(task) { const previous = this.operationTail; let release; this.operationTail = new Promise((resolve) => { release = resolve; }); await previous; try { return await task(); } finally { release(); } }
}
