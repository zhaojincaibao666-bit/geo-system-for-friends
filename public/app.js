import { dispatchVerificationNotifications, verificationNotificationEventId } from "./verification-notification.mjs";
import { initialBrowserSmokeState, transitionBrowserSmoke } from "./browser-smoke-state.mjs";
import { competitorsView, mountCompetitors } from "./competitors.js";
import { publisherView, mountPublisher } from "./publisher.js";
import { referenceSourceLabel, renderReferenceSources } from "./reference-sources.mjs";

const state = { view: "overview", dashboard: null, runtime: null, browserTopology: null, browserSmoke: initialBrowserSmokeState(), browserTrend: [], trendRange: "30", probeRuns: [], browserEvidenceByRunId: {}, browserEvidenceLoading: new Set(), archiveHistoryByQuestionSet: {}, archiveHistoryLoading: new Set(), prompts: [], brands: [], knowledge: [], topics: [], articles: [], rules: [], jobs: [], codexTasks: [], providers: null, accountAbExperiments: [], stabilityFilter: "all", evidenceFilter: "all", evidenceScope: "browser", localEvidenceFilter: "all", monitorRun: null, monitorRunId: null, browserWorkspace: null, platforms: [], selectedPlatform: "doubao_web", selectedPlatformMode: "chat", platformModes: { doubao_web: "chat", deepseek_web: "web_search", wenxin_web: "chat" }, platformRunState: {}, platformBrowserState: {}, platformHistory: {}, platformTechnicalErrors: [] };
const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => { const response = await fetch(`/api${path}`, { headers: { "content-type":"application/json", ...(options.headers || {}) }, ...options }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error || "操作失败"); error.status = response.status; Object.assign(error, data); throw error; } return data; };
const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
const flash = (message, bad = false) => { const node = $("#flash"); node.textContent = message; node.classList.remove("hidden"); node.style.background = bad ? "#a83a48" : "#173a62"; setTimeout(() => node.classList.add("hidden"), 3500); };
const ACTIVE_DOUBAO_MONITOR_RUN_KEY = "activeDoubaoBrowserMonitorRunId";
const MONITOR_POLL_INTERVAL_MS = 2000;
let monitorPollTimer = null;
let monitorPollInFlight = false;
let monitorPollFailures = 0;
let monitorProgressStream = null;
let monitorLiveClock = null;
let verificationAudioContext = null;
const VERIFICATION_ALERTED_STORAGE_PREFIX = "geo.doubao.verification.alerted.";
const recommendationLabel = (value) => ({
  first: "优先推荐",
  top3: "推荐靠前",
  mentioned: "仅提及",
  none: "未作推荐",
}[value] || value);
const statusChip = (status) => { const tone = /approved|published|online|completed/.test(status) ? "green" : /exception|paused|needs_revision/.test(status) ? "red" : "amber"; return `<span class="chip ${tone}">${esc(recommendationLabel(status))}</span>`; };
const monitorRunIsActive = (run) => Boolean(run && ["queued", "preparing_browser", "waiting_for_login", "running", "paused", "needs_human_action"].includes(run.status));
const monitorRunIsTerminal = (run) => Boolean(run && ["completed", "completed_with_errors", "failed", "aborted"].includes(run.status));
const monitorPlatformId = (run) => run?.platform || "doubao_web";
const monitorPlatformName = (run) => monitorPlatformId(run) === "deepseek_web" ? "DeepSeek" : "豆包";
const monitorStorageKey = (platform) => `activeBrowserMonitorRunId:${platform}`;
function currentMonitorRun() {
  const platform = state.selectedPlatform || "doubao_web";
  const run = state.platformRunState[platform] || null;
  return run || (monitorPlatformId(state.monitorRun) === platform ? state.monitorRun : null);
}
const activeVerificationActions = (run) => (run?.humanActions || (run?.humanAction ? [run.humanAction] : [])).filter((action) => action?.active && action.status === "active" && action.runId && action.workerId && action.pageId && action.questionId && action.verificationType && action.detectedAt);
const verificationEventId = verificationNotificationEventId;
function wasVerificationAlerted(eventId, channel) {
  try { return localStorage.getItem(`${VERIFICATION_ALERTED_STORAGE_PREFIX}${channel}.${eventId}`) === "1"; }
  catch { return false; }
}
function markVerificationAlerted(eventId, channel) {
  try { localStorage.setItem(`${VERIFICATION_ALERTED_STORAGE_PREFIX}${channel}.${eventId}`, "1"); }
  catch { /* Storage failure must never affect a browser monitor run. */ }
}
function prepareVerificationAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  verificationAudioContext ||= new AudioContextClass();
  if (verificationAudioContext.state === "suspended") void verificationAudioContext.resume().catch(() => {});
  return verificationAudioContext;
}
async function playVerificationAlertSound() {
  const context = prepareVerificationAudio();
  if (!context) return;
  try {
    if (context.state === "suspended") await context.resume();
    const startAt = context.currentTime;
    [0, 0.22].forEach((offset) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.12, startAt + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.18);
    });
  } catch { /* Audio permission/autoplay rules must not affect the run. */ }
}
function requestVerificationNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  // Called directly from the "start monitor" user action, so browsers may
  // show their normal permission prompt without interrupting the test.
  void Notification.requestPermission().catch(() => {});
}
function notifyVerificationActions(run) {
  const progress = monitorProgress(run);
  dispatchVerificationNotifications({
    actions: activeVerificationActions(run),
    progress,
    hasSent: wasVerificationAlerted,
    markSent: markVerificationAlerted,
    playSound: () => { void playVerificationAlertSound(); },
    showDesktopNotification: (action) => {
      if (!("Notification" in window) || Notification.permission !== "granted") return false;
      try {
        new Notification("星图 GEO", {
          body: `${monitorPlatformName(run)}需要人工验证\nWorker ${action.pageIndex || action.workerId || "?"} 已暂停\n当前进度 ${progress.completed}/${progress.total}`,
          tag: `geo-${monitorPlatformId(run)}-${verificationEventId(action)}`,
          renotify: false,
        });
        return true;
      } catch { return false; }
    },
  });
}
function renderVerificationAlert(run) {
  const banner = $("#doubao-verification-alert");
  const actions = activeVerificationActions(run);
  if (!actions.length) { banner.classList.add("hidden"); banner.innerHTML = ""; return; }
  const progress = monitorProgress(run);
  const primary = actions[actions.length - 1];
  const workerDetails = actions.map((action) => {
    const worker = action.pageIndex || action.workerId;
    const page = action.pageIndex || action.pageId;
    const question = action.questionNumber ? `Q${action.questionNumber}` : action.questionId;
    return `Worker ${worker} · Page ${page} · 当前问题 ${question}`;
  }).join("；");
  const platformName = monitorPlatformName(run);
  const title = actions.length === 1 ? `${platformName}需要人工验证` : `${actions.length} 个${platformName}窗口需要人工处理`;
  banner.classList.remove("hidden");
  const focusAction = monitorPlatformId(run) === "doubao_web" ? `<button type="button" class="verification-alert-action" data-verification-focus data-verification-event-id="${esc(verificationEventId(primary))}">前往处理</button>` : "";
  banner.innerHTML = `<div class="verification-alert-icon" aria-hidden="true">⚠</div><div class="verification-alert-copy"><b>${esc(title)}</b><span>${esc(workerDetails)} 已暂停；其他 Worker 正常运行</span><small>当前进度：${progress.completed} / ${progress.total}</small></div>${focusAction}`;
}
function monitorVerificationDetails(run) {
  const actions = activeVerificationActions(run);
  if (!actions.length) return "";
  const rows = actions.map((action) => {
    const worker = action.pageIndex || action.workerId;
    const page = action.pageIndex || action.pageId;
    const question = action.questionNumber ? `Q${action.questionNumber}` : action.questionId;
    const detectedAt = action.detectedAt || action.requestedAt;
    const detected = detectedAt ? new Date(detectedAt).toLocaleString("zh-CN", { hour12: false }) : "记录时间缺失";
    return `<li><b>Worker ${esc(worker)} · Page ${esc(page)} · ${esc(question)}</b><span>验证开始：${esc(detected)}</span></li>`;
  }).join("");
  return `<section class="monitor-verification-status" aria-live="polite"><div><b>需要人工处理</b><span>这是待处理状态，不是失败；其他 Worker 会继续保存结果。</span></div><ul>${rows}</ul></section>`;
}
function monitorQuestionCounts(run) {
  if (run.progress?.questionCounts) return run.progress.questionCounts;
  const counts = { queued: 0, running: 0, retry_pending: 0, retrying: 0, needs_verification: 0, aborted: 0 };
  for (const question of run.questions || []) if (question.status in counts) counts[question.status] += 1;
  return counts;
}
function monitorRuntimeState(progress, counts, run = null) {
  const humanActionCount = Number(progress.activeHumanActionCount ?? counts.needs_verification ?? 0);
  const metric = (label, value, tone = "") => `<span class="monitor-runtime-metric ${tone}"><small>${label}</small><b>${value}</b></span>`;
  return `<section class="monitor-runtime-state" aria-label="${esc(monitorPlatformName(run))} GEO 测试实时状态">${metric("总题数", progress.total)}${metric("已完成", progress.completed, "completed")}${metric("运行中", counts.running || 0, "running")}${metric("需要人工处理", humanActionCount, "human-action")}${metric("等待执行", counts.queued || 0, "queued")}${metric("自动重测轮次", run?.failedQuestionRetryRounds || 0)}${metric("无效", run?.invalid || 0, "failed")}</section>`;
}
function monitorProgress(run) {
  const progress = run.progress || {};
  const total = Number(progress.total ?? run.total ?? 0);
  const completed = Number(progress.completed ?? run.completed ?? 0);
  return { ...progress, total, completed, percent: Number(progress.progressPercent ?? (total ? Math.round((completed / total) * 10_000) / 100 : 0)), result: progress.result || null };
}
function monitorElapsed(startedAt) { const milliseconds = Date.now() - Date.parse(startedAt || ""); return Number.isFinite(milliseconds) && milliseconds > 0 ? `${Math.floor(milliseconds / 1000)}秒` : "0秒"; }
function monitorWorkerDebug(run) {
  const workers = run.progress?.workers || [];
  if (!workers.length) return "";
  const runtime = state.runtime ? `<small class="runtime-instance">服务实例：${esc(state.runtime.serverInstanceId?.slice(-8) || "—")} · PID ${esc(state.runtime.pid || "—")} · 启动 ${esc(state.runtime.startedAt ? new Date(state.runtime.startedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—")}</small>` : "";
  return `<section class="monitor-worker-debug"><div><b>运行中 Worker / Debug 摘要</b><small>仅展示状态与阶段耗时；异常证据在题目记录中保存。</small>${runtime}</div><div class="monitor-worker-grid">${workers.map((worker) => {
    const state = worker.state === "idle" ? "空闲" : worker.state === "needs_human_action" ? `Q${worker.questionNumber || "?"} 等待人工验证` : worker.state === "retrying" ? `Q${worker.questionNumber || "?"} Retry ${worker.attempt || 1}` : `Q${worker.questionNumber || "?"} 运行 ${monitorElapsed(worker.startedAt)}`;
    const detail = worker.state === "idle" ? "等待队列" : `${worker.stage || "running"} · ${worker.questionText || worker.questionId || ""}`;
    return `<div class="monitor-worker ${esc(worker.state || "idle")}"><b>Worker ${esc(String(worker.pageIndex || "?"))}</b><span>${esc(state)}</span><small>${esc(detail)}</small><button type="button" class="worker-focus" data-worker-focus data-worker-id="${esc(worker.workerId || "")}">查看${esc(monitorPlatformName(run))}页面</button></div>`;
  }).join("")}</div></section>`;
}
function renderMonitorRunProgress() {
  const panel = $("#doubao-monitor-progress");
  const button = $("#probe-button");
  const run = currentMonitorRun();
  if (!run) {
    renderVerificationAlert(null);
    panel.classList.add("hidden");
    const invalidCount = state.dashboard?.browserMonitoring?.overall?.invalidCompanyAnswerCount || 0;
    button.disabled = invalidCount === 0;
    button.textContent = invalidCount ? `补测 ${invalidCount} 条作废回答` : "本轮无需补测";
    return;
  }
  const counts = monitorQuestionCounts(run);
  const progress = monitorProgress(run);
  renderVerificationAlert(run);
  const liveResult = progress.result;
  const active = monitorRunIsActive(run);
  const terminal = monitorRunIsTerminal(run);
  const platformName = monitorPlatformName(run);
  const message = run.accountSwitchRequired ? "新账号测试已完成，实验已暂停，等待你手动切换到旧账号。" : run.status === "completed" ? `${platformName}网页端监测已完成。${run.invalid ? ` ${run.invalid} 道题重测后仍未取得可核验回答，已标为无效。` : ""}` : run.status === "completed_with_errors" ? `网页端监测完成，但有 ${run.failed} 道问题未成功。` : run.status === "aborted" ? `${platformName}测试已停止；已保存的回答和中止原因保留在审计记录中。` : run.status === "preparing_browser" ? `正在启动${platformName}测试浏览器并确认 4 个 Worker 页面。` : run.status === "waiting_for_login" ? `等待${platformName}登录：测试浏览器已打开，请在同一 Chromium 窗口完成登录；成功后将自动开始。` : run.status === "needs_human_action" ? `需要人工处理${platformName}验证：${run.humanAction?.type || run.pausedReason || "请在对应页面完成验证，系统会自动恢复"}` : run.status === "paused" ? `网页端监测已暂停：${run.pausedReason || "请处理浏览器登录或页面状态后继续"}` : run.status === "failed" ? `${platformName}网页端监测任务未能完成。` : active ? `${platformName} GEO 测试中。` : "等待网页端监测 Agent 处理。";
  panel.className = `monitor-progress${terminal && run.status !== "failed" ? " finished" : run.status === "failed" ? " failed" : ""}`;
  const resultLabel = liveResult?.resultState === "final" ? "最终结果" : "当前结果 / 暂定结果";
  const resultHtml = liveResult ? `<div class="monitor-live-result"><b>${resultLabel}</b><span>有效题目：${liveResult.validCompleted}</span><span>当前提及率：${liveResult.mentionRatePercent === null ? "—" : `${liveResult.mentionRatePercent.toFixed(1)}%`}</span><span>当前推荐率：${liveResult.priorityRecommendationRatePercent === null ? "—" : `${liveResult.priorityRecommendationRatePercent.toFixed(1)}%`}</span></div>` : "";
  const loginAction = run.status === "waiting_for_login" && monitorPlatformId(run) === "doubao_web" ? `<div class="monitor-login-action"><button type="button" class="primary" data-doubao-login-page>查看豆包登录页面</button><small>仅切换 GEO 专用 Chromium 的 Worker 1 页面，不会新建浏览器或提交题目。</small></div>` : "";
  const stopAction = active ? `<button type="button" class="danger monitor-stop-action" data-stop-browser-monitor>停止本轮测试</button>` : "";
  panel.innerHTML = `<div class="monitor-progress-head"><div><h2>${message}</h2><p>平台：${esc(platformName)} · 模式：${esc(platformModeLabel(run.platformMode))} · 已完成：${progress.completed} / ${progress.total} · 进度 ${progress.percent.toFixed(1)}%</p></div><span class="chip ${run.status === "failed" ? "red" : terminal ? "green" : "amber"}">${esc(run.status)}</span></div><div class="monitor-progress-bar" role="progressbar" aria-label="${esc(platformName)} GEO 测试进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"><i style="width:${Math.min(100, Math.max(0, progress.percent))}%"></i></div><div class="monitor-progress-metrics"><span>总问题：${progress.total}</span><span>成功：${run.success || 0}</span><span>无效：${run.invalid || 0}</span><span>待重测：${run.failed || 0}</span><span>自动重测轮次：${run.failedQuestionRetryRounds || 0}</span><span>已中止：${counts.aborted || 0}</span><span>网页端处理中：${counts.running || 0}</span><span>等待中：${counts.queued || 0}</span><span>重试中：${counts.retrying || counts.retry_pending || 0}</span><span>等待人工验证：${counts.needs_verification || 0}</span></div>${stopAction}${loginAction}${resultHtml}${monitorWorkerDebug(run)}`;
  panel.querySelector(".monitor-progress-bar")?.insertAdjacentHTML("afterend", monitorRuntimeState(progress, counts, run));
  panel.insertAdjacentHTML("beforeend", monitorVerificationDetails(run));
  if (monitorPlatformId(run) !== "doubao_web") {
    button.disabled = true;
    button.textContent = active ? `${platformName}正式测试进行中 ${run.completed || 0}/${run.total || 0}` : `${platformName}不支持补测`;
    return;
  }
  const selectedQuestionSet = state.dashboard?.localMonitoring?.config?.selectedQuestionSet;
  const selectedBank = state.dashboard?.localMonitoring?.config?.questionBanks?.find((item) => item.id === selectedQuestionSet);
  const questionBankVersionChanged = Boolean(run.questionSetId && selectedBank?.questionSetId && run.questionSetId !== selectedBank.questionSetId);
  if (!active && questionBankVersionChanged) {
    button.disabled = true;
    button.textContent = "旧版记录不补测，请开始新测试";
    return;
  }
  const failedCount = Number(run.failed || 0) + Number(run.invalid || 0);
  const invalidCount = Number(state.dashboard?.browserMonitoring?.overall?.invalidCompanyAnswerCount || 0);
  button.disabled = active && run.status !== "paused";
  button.textContent = run.accountSwitchRequired ? "等待手动切换账号" : run.status === "waiting_for_login" ? "等待豆包登录（将自动继续）" : run.status === "needs_human_action" ? "请完成豆包验证，系统将自动恢复" : run.status === "paused" ? "继续测试" : active ? `自动重测中 ${run.completed || 0}/${run.total || 0}` : failedCount ? `重测 ${failedCount} 道无效题` : invalidCount ? `补测 ${invalidCount} 条作废回答` : "本轮无需补测";
}
function stopMonitorPolling() { if (monitorPollTimer) clearTimeout(monitorPollTimer); monitorPollTimer = null; }
function stopMonitorProgressStream() { if (monitorProgressStream) monitorProgressStream.close(); monitorProgressStream = null; }
function startMonitorLiveClock() { if (monitorLiveClock) return; monitorLiveClock = setInterval(() => { if (monitorRunIsActive(state.monitorRun)) renderMonitorRunProgress(); }, 1000); }
function stopMonitorLiveClock() { if (monitorLiveClock) clearInterval(monitorLiveClock); monitorLiveClock = null; }
function clearActiveMonitorRun(platform = monitorPlatformId(state.monitorRun)) {
  if (state.monitorRunId && state.monitorRun?.platform === platform) state.monitorRunId = null;
  delete state.platformRunState[platform];
  localStorage.removeItem(monitorStorageKey(platform));
  if (platform === "doubao_web") localStorage.removeItem(ACTIVE_DOUBAO_MONITOR_RUN_KEY);
}
function scheduleMonitorPoll() { stopMonitorPolling(); if (monitorProgressStream || !state.monitorRunId || !monitorRunIsActive(state.monitorRun) || state.monitorRun?.status === "paused") return; monitorPollTimer = setTimeout(() => pollMonitorRun(state.monitorRunId), MONITOR_POLL_INTERVAL_MS); }
async function finishMonitorRun(run) {
  stopMonitorPolling();
  stopMonitorProgressStream();
  stopMonitorLiveClock();
  if (!run.accountSwitchRequired) clearActiveMonitorRun();
  state.monitorRun = run;
  renderMonitorRunProgress();
  if (run.accountSwitchRequired) flash("新账号 30/30 已保存。请手动切换到旧账号后确认。");
  if (run.accountSwitchRequired) { await refresh(); renderMonitorRunProgress(); return; }
  const platformName = monitorPlatformName(run);
  if (run.status === "completed") flash(`${platformName}网页端监测已完成。${run.invalid ? ` ${run.invalid} 道题重测后仍无可核验回答，已列为无效。` : ""}`, Boolean(run.invalid));
  else if (run.status === "completed_with_errors") flash(`${platformName}网页端监测完成，但有 ${run.failed} 道问题未成功。`, true);
  else if (run.status === "aborted") flash(`${platformName}本轮测试已停止；没有再发送新题目。`);
  else flash(`${platformName}网页端监测任务未能完成。`, true);
  await refresh();
  renderMonitorRunProgress();
}
function applyMonitorProgressUpdate(progress, { isVerificationEvent = false } = {}) {
  if (!progress?.runId) return;
  const platform = progress.platform || "doubao_web";
  state.platformRunState[platform] = { ...(state.platformRunState[platform] || {}), ...progress, progress };
  if (platform !== state.selectedPlatform || progress.runId !== state.monitorRunId) return;
  state.monitorRun = { ...(state.monitorRun || {}), ...progress, progress };
  renderMonitorRunProgress();
  if (isVerificationEvent) notifyVerificationActions(state.monitorRun);
  if (monitorRunIsTerminal(state.monitorRun)) void finishMonitorRun(state.monitorRun);
}
function startMonitorProgressStream(runId) {
  if (!runId || !window.EventSource) return scheduleMonitorPoll();
  if (monitorProgressStream?.runId === runId) return;
  stopMonitorProgressStream();
  const source = new EventSource(`/api/browser-monitor-runs/${encodeURIComponent(runId)}/events`);
  source.runId = runId;
  monitorProgressStream = source;
  const receive = (event, options = {}) => {
    try { applyMonitorProgressUpdate(JSON.parse(event.data), options); }
    catch { /* A malformed transient event must not interrupt the test. */ }
  };
  source.addEventListener("progress", receive);
  source.addEventListener("paused", receive);
  source.addEventListener("needs_human_action", (event) => receive(event, { isVerificationEvent: true }));
  source.addEventListener("account_switch_required", receive);
  source.addEventListener("completed", receive);
  source.onopen = () => { monitorPollFailures = 0; stopMonitorPolling(); };
  source.onerror = () => {
    if (monitorProgressStream !== source) return;
    stopMonitorProgressStream();
    scheduleMonitorPoll();
  };
}
async function pollMonitorRun(runId) {
  if (monitorPollInFlight || state.monitorRunId !== runId) return;
  monitorPollInFlight = true;
  try {
    const run = await api(`/browser-monitor-runs/${runId}`);
    if (state.monitorRunId !== runId) return;
    monitorPollFailures = 0;
    state.monitorRun = run;
    renderMonitorRunProgress();
    if (monitorRunIsTerminal(run)) await finishMonitorRun(run);
    else startMonitorProgressStream(runId);
  } catch (error) {
    if (error.status === 404) {
      clearActiveMonitorRun();
      state.monitorRun = null;
      renderMonitorRunProgress();
    } else {
      monitorPollFailures += 1;
      if (monitorPollFailures === 3) flash("进度连接暂时异常，正在重试。", true);
    }
  } finally {
    monitorPollInFlight = false;
    scheduleMonitorPoll();
  }
}
function watchMonitorRun(run, message) {
  const platform = monitorPlatformId(run);
  state.platformRunState[platform] = run;
  state.monitorRun = run;
  state.monitorRunId = run.runId;
  localStorage.setItem(monitorStorageKey(platform), run.runId);
  if (platform === "doubao_web") localStorage.setItem(ACTIVE_DOUBAO_MONITOR_RUN_KEY, run.runId);
  renderMonitorRunProgress();
  syncMonitoringHeader();
  startMonitorLiveClock();
  if (message) flash(message);
  startMonitorProgressStream(run.runId);
  void pollMonitorRun(run.runId);
}
const fmt = (date) => date ? new Date(date).toLocaleString("zh-CN", { hour12:false }) : "—";

const browserWorkspaceStatus = (status, platformName = "豆包") => ({
  ready: ["已登录 / 页面可用", "green"],
  waiting_for_login: [`等待${platformName}登录`, "amber"],
  verification_required: ["需要人工验证", "amber"],
  unknown: ["登录状态待确认", "amber"],
  page_error: ["页面异常", "red"],
  checking: ["正在检查连接", "amber"],
  check_timeout: ["检查超时（现场仍可查看）", "amber"],
})[status] || [status || "未检查", "amber"];
const browserQuestionStatus = (status) => ({ success: "成功", completed: "已完成", invalid: "无效（重测未完成）", running: "回答中", needs_verification: "需要人工验证", retrying: "重试中", queued: "等待执行", failed: "待重测", aborted: "已中止" }[status] || status || "未开始");
const platformModeLabel = (mode) => mode === "web_search" ? "联网搜索" : mode === "chat" ? "普通聊天" : mode || "未确认";

function browserWorkspaceQuestionRows(run) {
  const questions = Array.isArray(run?.questions) ? run.questions : [];
  if (!questions.length) return `<div class="browser-workspace-empty">本次检查没有发送 Prompt，因此没有逐题测试结果。点击检查不会创建测试任务。</div>`;
  return `<div class="browser-workspace-question-list">${questions.map((question, index) => {
    const status = question.status || "queued";
    const answer = String(question.rawAnswer || "").trim();
    const mentioned = question.mentionResult?.brandMentioned ?? question.mentioned;
    const priority = question.recommendationResult?.recommendation || question.priorityRecommended;
    const citationStatus = question.citationCaptureStatus || question.job?.citation_capture_status || "not_available";
    const worker = question.workerId ? `Worker ${question.pageIndex || question.workerId}` : "—";
    return `<article class="browser-workspace-question ${esc(status)}"><div class="browser-workspace-question-head"><b>Q${index + 1}</b><span class="chip ${status === "success" ? "green" : ["failed", "invalid"].includes(status) ? "red" : status === "needs_verification" ? "amber" : ""}">${esc(browserQuestionStatus(status))}</span><small>${esc(worker)} · Attempt ${esc(question.attemptCount || 0)}</small></div><p class="browser-workspace-prompt">${esc(question.questionText || question.question || question.promptId || "未记录题目")}</p><div class="browser-workspace-question-meta"><span>回答：${answer ? `已保存（${answer.length} 字）` : "暂无完整回答"}</span><span>提及：${mentioned === true ? "是" : mentioned === false ? "否" : "未判定"}</span><span>优先推荐：${priority ? esc(priority === true ? "是" : priority) : "未判定"}</span><span>来源：${esc(question.citationCaptureVersion === "v2" ? referenceSourceLabel(question) : citationStatus)}</span></div>${question.citationCaptureVersion === "v2" ? renderReferenceSources(question) : ""}${question.errorMessage || question.errorCode ? `<small class="browser-workspace-error">${esc(question.errorMessage || question.errorCode)}</small>` : ""}</article>`;
  }).join("")}</div>`;
}

function browserWorkspaceHtml(result, run, platform = currentPlatform()) {
  const [loginText, loginTone] = browserWorkspaceStatus(result?.status, platform.displayName);
  const topology = result?.browserTopology || result?.topology || state.browserTopology || {};
  const runtime = result?.runtime || {};
  const workers = topology.workers || result?.workers || runtime.workers || Array.from({ length: 4 }, (_, index) => ({ workerId: `${platform.id.replace("_web", "")}-worker-${index + 1}`, pageIndex: index + 1, pageReady: false }));
  const activeActions = activeVerificationActions(run);
  const actionByWorker = new Map(activeActions.map((action) => [action.workerId, action]));
  const runStatus = run ? `${run.runId} · ${run.status} · 已完成 ${run.completed || 0}/${run.total || 0}` : "当前没有正在执行的测试任务";
  const topologyText = topology.contextReady ? `页面：${topology.readyWorkers || 0}/${topology.expectedWorkers || 4} · Context 页面：${topology.contextPageCount ?? "—"}` : "正在等待浏览器拓扑";
  const loginHint = result?.status === "waiting_for_login" ? `<strong>浏览器已准备完成：4/4 Worker 页面已创建。请在打开的 ${esc(platform.displayName)} 窗口中手动登录，完成后再次检查。</strong>` : result?.blocking ? `<strong>人工处理：${esc(result.blocking.type || result.blocking.state || "页面验证")}</strong>` : "";
  return `<div class="browser-workspace"><div class="browser-workspace-title"><div><h2>${esc(platform.displayName)}网页测试现场</h2><p>这里展示当前真实 Playwright Chromium 正在使用的页面。仅查看，不会提交题目或改变测试。</p></div><span class="chip ${loginTone}">${esc(loginText)}</span></div><div class="browser-workspace-notice"><b>登录状态：${esc(loginText)}</b><span>模式：${platformModeLabel(result?.platformMode || state.selectedPlatformMode)} · Chromium：${runtime.headless === false ? "可见窗口" : "未确认"} · Persistent Context：${topology.contextReady || runtime.persistentContext ? "正常" : "未建立"} · ${esc(topologyText)}</span>${loginHint}</div><div class="browser-workspace-run"><b>当前测试任务</b><span>${esc(runStatus)}</span><small>Smoke 检查本身不发送 Prompt。</small></div><section><div class="browser-workspace-section-head"><h3>Worker ${esc(platform.displayName)} 页面</h3><small>每个 Worker 显示页面、登录、Composer 与模式状态。</small></div><div class="browser-workspace-workers">${workers.map((worker) => { const action = actionByWorker.get(worker.workerId); const current = run?.progress?.workers?.find((item) => item.workerId === worker.workerId) || run?.workers?.find?.((item) => item.workerId === worker.workerId); const pageReady = worker.pageReady ?? (!worker.closed && worker.urlReady); const stateText = action ? `需要人工验证 · Q${action.questionNumber || "?"}` : current?.state === "running" ? `Q${current.questionNumber || "?"} · ${current.stage || "回答中"}` : current?.state === "retrying" ? `Q${current.questionNumber || "?"} · 重试中` : worker.ready === false ? "Mode Not Ready" : pageReady ? "Ready" : worker.status || "页面未就绪"; return `<article class="browser-workspace-worker"><div><b>Worker ${esc(String(worker.pageIndex || worker.workerId))}</b><span class="${action ? "human" : current?.state === "running" ? "running" : pageReady && worker.ready !== false ? "ready" : "human"}">${esc(stateText)}</span></div><small>PageId：${esc(worker.pageId || "—")}</small><small>登录：${esc(worker.loginStatus || "未确认")} · Composer：${worker.composer?.editable || worker.inputReady ? "Ready" : "Not Ready"}</small><small>模式：${esc(worker.mode || result?.platformMode || state.selectedPlatformMode || "未确认")}</small><button type="button" class="tiny browser-workspace-focus" data-browser-worker-focus data-worker-id="${esc(worker.workerId)}" ${pageReady ? "" : "disabled"}>查看这个${esc(platform.displayName)}页面</button>${pageReady ? `<img class="browser-workspace-preview" data-browser-worker-preview data-worker-id="${esc(worker.workerId)}" alt="Worker ${esc(String(worker.pageIndex || ""))} ${esc(platform.displayName)}页面实时预览" src="/api/platforms/${encodeURIComponent(platform.id)}/browser/workers/${encodeURIComponent(worker.workerId)}/preview?at=${Date.now()}" />` : ""}</article>`; }).join("")}</div></section></div>`;
}

function showBrowserWorkspace(result, run) {
  const modal = $("#dialog");
  const form = $("#dialog-form");
  const content = $("#dialog-content");
  const platform = currentPlatform();
  const renderWorkspace = () => { content.innerHTML = browserWorkspaceHtml(result, run, platform); };
  renderWorkspace();
  modal.classList.add("browser-workspace-dialog");
  form.onsubmit = (event) => { event.preventDefault(); modal.close(); };
  modal.addEventListener("close", () => { if (state.browserWorkspace?.timer) clearInterval(state.browserWorkspace.timer); state.browserWorkspace = null; modal.classList.remove("browser-workspace-dialog"); }, { once: true });
  modal.showModal();
  const timer = setInterval(() => {
    if (!modal.open) return;
    document.querySelectorAll("[data-browser-worker-preview]").forEach((image) => { image.src = `/api/platforms/${encodeURIComponent(platform.id)}/browser/workers/${encodeURIComponent(image.dataset.workerId)}/preview?at=${Date.now()}`; });
  }, 2500);
  state.browserWorkspace = { timer };
}

async function load() {
  // The first screen deliberately excludes raw answers. They are often very
  // large and are loaded only after an operator opens a specific run.
  const [dashboard, runtime, browserTopology, trendHistory, prompts, brands, knowledge, topics, articles, rules, jobs, codexTasks, providers, accountAb, platformList] = await Promise.all([api("/dashboard"), api("/runtime"), api("/doubao-browser/topology"), api("/browser-monitor-runs/history?platform=doubao_web&platformMode=chat"), api("/prompts"), api("/brands"), api("/knowledge"), api("/topics"), api("/articles"), api("/rules"), api("/publications"), api("/codex/tasks"), api("/settings/providers"), api("/doubao-account-ab"), api("/platforms")]);
  state.runtime = runtime;
  state.browserTopology = browserTopology;
  Object.assign(state, { dashboard, browserTrend: trendHistory.summaries || [], prompts, brands, knowledge, topics, articles, rules, jobs, codexTasks, providers, accountAbExperiments: accountAb.experiments || [], platforms: platformList.platforms || [] });
  const agent = dashboard.agent; $("#machine-status").textContent = agent ? `工作机：${agent.machineId} · ${agent.status}` : "工作机：尚未连接（将使用 API 写作兜底）"; $("#machine-status").classList.toggle("online", Boolean(agent && agent.status === "online"));
}

function browserRate(value) { return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—"; }
function browserOutcome(run) {
  if (!run) return { text: "未测试", tone: "pending" };
  if (run.hasValidCompanyAnswer === false) return { text: "无效回答：未分点推荐至少 2 家公司", tone: "invalid" };
  if (["first", "top3"].includes(run.recommendation)) return { text: `优先推荐${run.position ? `（第 ${run.position} 位）` : ""}`, tone: "direct" };
  if (run.brandMentioned) return { text: "已提及，未在前 5 推荐", tone: "mentioned" };
  return { text: "未提及", tone: "unmentioned" };
}
function browserPie(title, slices) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  let cursor = 0;
  const stops = slices.filter((slice) => slice.value > 0).map((slice) => {
    const next = cursor + (total ? slice.value / total * 100 : 0); const stop = `${slice.color} ${cursor}% ${next}%`; cursor = next; return stop;
  });
  return `<section class="browser-pie-card"><div class="browser-pie" style="background:${stops.length ? `conic-gradient(${stops.join(",")})` : "#edf1f6"}"><span>${total}</span><small>题</small></div><div><h3>${esc(title)}</h3><div class="pie-legend">${slices.map((slice) => `<span><i style="background:${slice.color}"></i>${esc(slice.label)} <b>${slice.value}</b></span>`).join("")}</div></div></section>`;
}
function browserSummaryCards(summary) {
  return `<div class="browser-summary-cards"><div><b>${summary.testedCount}</b><small>一共问了多少题</small></div><div><b>${summary.validCompletedCount}</b><small>有明确厂家回答</small></div><div><b>${browserRate(summary.mentionRate)}</b><small>回答里提到目标品牌</small></div><div><b>${browserRate(summary.priorityRecommendationRate)}</b><small>排在推荐名单前 5 位</small></div></div>`;
}
function trendDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(value || 0));
  const date = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return date.year ? `${date.year}-${date.month}-${date.day}` : "未记录日期";
}
function trendRate(value) { return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—"; }
function visibleTrendSummaries() {
  const days = Number(state.trendRange);
  if (!Number.isFinite(days)) return state.browserTrend;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return state.browserTrend.filter((summary) => new Date(summary.completedAt || summary.startedAt || 0) >= cutoff);
}
function legacyVisibilityTrendTooltip(summary) {
  const denominator = summary.validAnswers || 0;
  const sources = summary.sourceSummary || {};
  const accountLine = summary.experimentType === "doubao_account_ab" ? `<span class="trend-account-ab">账号 A/B：${esc(summary.experimentArm || "")} · ${esc(summary.accountLabel || "")}</span>` : "";
  const sourceLine = Number.isFinite(sources.totalCitations) ? `<span>品牌相关引用：${sources.brandRelatedCitationCount || 0}（覆盖题数 ${sources.brandRelatedCitationQuestions || 0}） · 唯一域名：${sources.uniqueDomains || 0}</span>` : "";
  const diagnosticLine = summary.geoDropDiagnostics?.triggered ? `<span class="trend-alert-line">⚠ 可见度显著下降 · 点击数据点查看诊断</span>` : "";
  return `<b>${esc(trendDate(summary.completedAt || summary.startedAt))}</b><span>测试题数：${summary.totalQuestions}</span><span>有效回答：${denominator}</span><span><i class="trend-dot mention"></i>提及率：${trendRate(summary.mentionRate)}（${summary.mentionedCount}/${denominator}）</span><span><i class="trend-dot priority"></i>优先推荐率：${trendRate(summary.priorityRate)}（${summary.priorityCount}/${denominator}）</span>${sourceLine}${diagnosticLine}`;
}
// Account A/B points are labelled separately so they are not read as a
// natural historical trend between unrelated account environments.
function visibilityTrendTooltip(summary) {
  const denominator = summary.validAnswers || 0;
  const sources = summary.sourceSummary || {};
  const accountLine = summary.experimentType === "doubao_account_ab"
    ? `<span class="trend-account-ab">账号 A/B：${esc(summary.experimentArm || "")} · ${esc(summary.accountLabel || "")}</span>`
    : "";
  const sourceLine = Number.isFinite(sources.totalCitations)
    ? `<span>品牌相关引用：${sources.brandRelatedCitationCount || 0}（覆盖题数 ${sources.brandRelatedCitationQuestions || 0}）· 唯一域名：${sources.uniqueDomains || 0}</span>`
    : "";
  const diagnosticLine = summary.geoDropDiagnostics?.triggered
    ? `<span class="trend-alert-line">⚠ 可见度显著下降 · 点击数据点查看诊断</span>`
    : "";
  return `<b>${esc(trendDate(summary.completedAt || summary.startedAt))}</b>${accountLine}<span>测试题数：${summary.totalQuestions}</span><span>有效回答：${denominator}</span><span><i class="trend-dot mention"></i>品牌提及率：${trendRate(summary.mentionRate)}（${summary.mentionedCount}/${denominator}）</span><span><i class="trend-dot priority"></i>优先推荐率：${trendRate(summary.priorityRate)}（${summary.priorityCount}/${denominator}）</span>${sourceLine}${diagnosticLine}`;
}
function visibilityTrendChart() {
  const summaries = visibleTrendSummaries();
  const rangeLabels = { "7": "最近 7 天", "30": "最近 30 天", all: "全部" };
  const controls = ["7", "30", "all"].map((range) => `<button class="tiny ${state.trendRange === range ? "active" : ""}" data-trend-range="${range}" aria-pressed="${state.trendRange === range}">${rangeLabels[range]}</button>`).join("");
  if (!summaries.length) return `<section class="card visibility-trend-card"><div class="section-head"><div><h2>品牌可见度趋势</h2><p>按每轮 30 题测试结果展示品牌提及率与优先推荐率变化</p></div><div class="trend-range" aria-label="趋势时间范围">${controls}</div></div><div class="visibility-trend-empty">所选时间范围内暂无已完成的 30 题豆包网页端测试，因此不会生成虚构趋势数据。</div></section>`;
  const width = 840; const height = 286; const left = 50; const right = 20; const top = 24; const bottom = 52;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (index) => summaries.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index / (summaries.length - 1));
  const y = (rate) => top + (1 - rate) * plotHeight;
  const segments = (key) => {
    // Keep one continuous line through every plotted point.  A record can be
    // missing one metric, but that must not split the history on either side
    // of it: the adjacent valid observations still form a continuous trend.
    const points = summaries
      .map((summary, index) => typeof summary[key] === "number" ? `${x(index)},${y(summary[key])}` : null)
      .filter(Boolean);
    return points.length > 1
      ? `<polyline points="${points.join(" ")}" fill="none" stroke-linecap="round" stroke-linejoin="round" />`
      : "";
  };
  const grid = [1, .75, .5, .25, 0].map((rate) => `<g><line x1="${left}" x2="${width - right}" y1="${y(rate)}" y2="${y(rate)}" /><text x="${left - 10}" y="${y(rate) + 4}" text-anchor="end">${Math.round(rate * 100)}%</text></g>`).join("");
  const labelStep = Math.max(1, Math.ceil(summaries.length / 8));
  const labels = summaries.map((summary, index) => (index % labelStep === 0 || index === summaries.length - 1) ? `<text x="${x(index)}" y="${height - 18}" text-anchor="middle">${esc(trendDate(summary.completedAt || summary.startedAt).slice(5))}</text>` : "").join("");
  const points = summaries.map((summary, index) => {
    const circles = [];
    const anomaly = summary.geoDropDiagnostics?.triggered;
    if (typeof summary.mentionRate === "number") circles.push(`<circle class="trend-point mention${anomaly ? " anomaly" : ""}" data-trend-point="${index}" data-trend-metric="mention" cx="${x(index)}" cy="${y(summary.mentionRate)}" r="5" tabindex="0" role="button" aria-label="查看 ${trendDate(summary.completedAt || summary.startedAt)} 提及率详情${anomaly ? "，可见度显著下降" : ""}" />`);
    if (typeof summary.priorityRate === "number") circles.push(`<circle class="trend-point priority${anomaly ? " anomaly" : ""}" data-trend-point="${index}" data-trend-metric="priority" cx="${x(index)}" cy="${y(summary.priorityRate)}" r="5" tabindex="0" role="button" aria-label="查看 ${trendDate(summary.completedAt || summary.startedAt)} 优先推荐率详情${anomaly ? "，可见度显著下降" : ""}" />`);
    if (anomaly) circles.push(`<text class="trend-anomaly-marker" data-trend-point="${index}" data-trend-diagnostic="${index}" x="${x(index) + 8}" y="${Math.max(18, y(Math.max(summary.mentionRate || 0, summary.priorityRate || 0)) - 12)}" tabindex="0" role="button" aria-label="打开 ${trendDate(summary.completedAt || summary.startedAt)} GEO下降诊断">⚠</text>`);
    return circles.join("");
  }).join("");
  return `<section class="card visibility-trend-card" id="visibility-trend-card"><div class="section-head"><div><h2>品牌可见度趋势</h2><p>按每轮 30 题测试结果展示品牌提及率与优先推荐率变化</p></div><div class="trend-range" aria-label="趋势时间范围">${controls}</div></div><div class="trend-legend"><span><i class="trend-dot mention"></i>品牌提及率</span><span><i class="trend-dot priority"></i>优先推荐率</span></div><div class="visibility-trend-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="品牌提及率和优先推荐率趋势图"><g class="trend-grid">${grid}</g><g class="trend-axis-labels">${labels}</g><g class="trend-line mention">${segments("mentionRate")}</g><g class="trend-line priority">${segments("priorityRate")}</g><g>${points}</g></svg><div class="visibility-trend-tooltip" role="tooltip" aria-live="polite"></div></div></section>`;
}
function formalRunSlices(summary) {
  const total = Number(summary?.totalQuestions || 0);
  const successful = Number(summary?.successfulAnswers || 0);
  const valid = Number(summary?.validAnswers || 0);
  const mentioned = Number(summary?.mentionedCount || 0);
  const priority = Number(summary?.priorityCount || 0);
  return {
    visibility: [
      { label: "优先推荐", value: priority, color: "#3974e9" },
      { label: "仅提及", value: Math.max(0, mentioned - priority), color: "#26a879" },
      { label: "未提及", value: Math.max(0, valid - mentioned), color: "#bcc7d8" },
    ],
    completion: [
      { label: "有效完成", value: valid, color: "#3974e9" },
      { label: "无公司名作废", value: Math.max(0, successful - valid), color: "#f0a13b" },
      { label: "未测试", value: Math.max(0, total - successful), color: "#d7deea" },
    ],
  };
}
function formalRunSummaryCards(summary) {
  if (!summary) return `<div class="browser-summary-cards platform-no-data">${noDataMetric("正式完成")}${noDataMetric("品牌提及率")}${noDataMetric("优先推荐率")}</div>`;
  return `<div class="browser-summary-cards"><div><b>${summary.totalQuestions || 0}</b><small>一共问了多少题</small></div><div><b>${summary.validAnswers || 0}</b><small>有明确厂家回答</small></div><div><b>${browserRate(summary.mentionRate)}</b><small>回答里提到目标品牌</small></div><div><b>${browserRate(summary.priorityRate)}</b><small>排在推荐名单前 5 位</small></div></div>`;
}
// This chart intentionally accepts only complete, reportable run summaries.
// Aborted runs remain visible in the audit section, but must never become a
// data point or alter an official platform visibility rate.
function formalPlatformTrendChart(platform, summaries) {
  const platformName = platform.displayName;
  if (!summaries.length) return `<section class="card visibility-trend-card"><div class="section-head"><div><h2>品牌可见度趋势</h2><p>按完整 30 题正式测试展示品牌提及率与优先推荐率变化。</p></div></div><div class="visibility-trend-empty">${esc(platformName)} 暂无完整的 30 题正式测试，因此不会生成虚构趋势数据。</div></section>`;
  const width = 840; const height = 286; const left = 50; const right = 20; const top = 24; const bottom = 52;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (index) => summaries.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index / (summaries.length - 1));
  const y = (rate) => top + (1 - Math.max(0, Math.min(1, Number(rate || 0)))) * plotHeight;
  const line = (key) => {
    const points = summaries.map((summary, index) => typeof summary[key] === "number" ? `${x(index)},${y(summary[key])}` : null).filter(Boolean);
    return points.length > 1 ? `<polyline points="${points.join(" ")}" fill="none" stroke-linecap="round" stroke-linejoin="round" />` : "";
  };
  const grid = [1, .75, .5, .25, 0].map((rate) => `<g><line x1="${left}" x2="${width - right}" y1="${y(rate)}" y2="${y(rate)}" /><text x="${left - 10}" y="${y(rate) + 4}" text-anchor="end">${Math.round(rate * 100)}%</text></g>`).join("");
  const labelStep = Math.max(1, Math.ceil(summaries.length / 8));
  const labels = summaries.map((summary, index) => (index % labelStep === 0 || index === summaries.length - 1) ? `<text x="${x(index)}" y="${height - 18}" text-anchor="middle">${esc(trendDate(summary.completedAt || summary.startedAt).slice(5))}</text>` : "").join("");
  const points = summaries.map((summary, index) => `${typeof summary.mentionRate === "number" ? `<circle class="trend-point mention" cx="${x(index)}" cy="${y(summary.mentionRate)}" r="5" aria-label="${esc(trendDate(summary.completedAt || summary.startedAt))} 品牌提及率 ${browserRate(summary.mentionRate)}" />` : ""}${typeof summary.priorityRate === "number" ? `<circle class="trend-point priority" cx="${x(index)}" cy="${y(summary.priorityRate)}" r="5" aria-label="${esc(trendDate(summary.completedAt || summary.startedAt))} 优先推荐率 ${browserRate(summary.priorityRate)}" />` : ""}`).join("");
  return `<section class="card visibility-trend-card"><div class="section-head"><div><h2>品牌可见度趋势</h2><p>按完整 30 题 ${esc(platformName)} 正式测试展示品牌提及率与优先推荐率变化。</p></div></div><div class="trend-legend"><span><i class="trend-dot mention"></i>品牌提及率</span><span><i class="trend-dot priority"></i>优先推荐率</span></div><div class="visibility-trend-plot"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(platformName)}品牌提及率和优先推荐率趋势图"><g class="trend-grid">${grid}</g><g class="trend-axis-labels">${labels}</g><g class="trend-line mention">${line("mentionRate")}</g><g class="trend-line priority">${line("priorityRate")}</g><g>${points}</g></svg></div></section>`;
}
function formalRunPiePair(summary, visibilityTitle = "品牌可见情况", completionTitle = "答复完成情况") {
  const slices = formalRunSlices(summary);
  return `<div class="date-pies">${browserPie(visibilityTitle, slices.visibility)}${browserPie(completionTitle, slices.completion)}</div>`;
}
function incompleteRunStatusPie(run) {
  const total = Number(run?.totalQuestions || 0);
  const saved = Number(run?.savedAnswers || 0);
  const failed = Number(run?.failedAnswers || 0);
  const aborted = Number(run?.abortedQuestions || 0);
  const unclassified = Math.max(0, total - saved - failed - aborted);
  return browserPie("本次执行状态（审计）", [
    { label: "已保存", value: saved, color: "#3974e9" },
    { label: "失败", value: failed, color: "#e36b6b" },
    { label: "已中止", value: aborted, color: "#f0a13b" },
    { label: "待归档", value: unclassified, color: "#d7deea" },
  ]);
}
function formalRunBatchCard(summary, platform) {
  const evidence = state.browserEvidenceByRunId[`current:${summary.runId}`];
  const modeLabel = summary.platformMode === "web_search" ? "联网搜索" : "普通聊天";
  const source = summary.sourceSummary ? browserSourceSummary(summary.sourceSummary) : "";
  const evidenceNote = evidence ? `<div class="date-run-rule"><b>审计记录已加载</b> 当前平台的逐题原始回答以本地审计记录为准。</div>` : `<div class="date-run-rule"><b>统计口径</b> 只有完整 30 题、reportable=true 的正式测试会进入趋势和总览；展开会按需读取本地审计记录。</div>`;
  return `<details class="date-run" data-browser-run-id="${esc(summary.runId)}"><summary><div class="date-meta"><span class="date-badge">${esc(dateLabel(trendDate(summary.completedAt || summary.startedAt)))}</span><small class="date-time">完成时间<br><b>${esc(monitorTime(summary.completedAt || summary.startedAt))}</b></small></div><div class="date-run-title"><b>${esc(platform.displayName)} · ${modeLabel}</b><small>完整 30 题正式测试</small></div><div class="date-run-metrics">${formalRunSummaryCards(summary)}</div><span class="date-run-action">查看统计 <i>→</i></span></summary><div class="date-run-body">${formalRunPiePair(summary, "提及情况", "完成情况")}${source}${evidenceNote}</div></details>`;
}
function monitoringAnalysis(browser) {
  const recent = browser.recentSevenDays || browser.overall;
  const gaps = recent.highPriorityGaps || [];
  const intentPlainNames = {
    "品类推荐": "用户直接问“推荐哪家工厂”",
    "解决方案": "用户问打样、量产或定制该怎么做",
    "对比决策": "用户在比较工厂、想选更合适的一家",
    "购买转化": "用户已经接近下单、在找能合作的工厂",
  };
  const gapText = gaps.length ? gaps.slice(0, 3).map((item) => intentPlainNames[item.intent] || item.intent).join("；") : "暂时没有特别明显的薄弱问题";
  const signals = recent.strengthSignals || {};
  const strengthText = signals.product
    ? `最近的回答里，有 ${signals.product} 条是在问 IP 公仔、棉花娃、娃衣、挂件或文创这类具体产品时提到你们。`
    : `最近已有 ${recent.mentionCount} 条回答提到你们，说明豆包在一部分问题里已经能找到相关信息。`;
  return `<section class="overview-analysis"><div class="section-head"><div><h2>近 7 天测试小结</h2><p>汇总最近 ${recent.dateCount || 0} 次豆包网页端测试。这里看的是豆包当时怎么回答，不是实际销量或真实市场排名。</p></div><button class="secondary" data-view-link="monitoring">查看每次测试</button></div><div class="analysis-grid"><article class="analysis-card good"><span class="analysis-kicker">目前比较有机会被提到</span><h3>在一些具体问题里，模型会推荐目标对象</h3><p>${strengthText}</p><p>其中有 ${signals.recommendation || 0} 条回答把目标品牌放在推荐名单前 5 位，说明这类问题中的公开信息比较容易被模型找到并采用。</p></article><article class="analysis-card gap"><span class="analysis-kicker">还需要补强</span><h3>有些常见问题里，模型还不太会主动提到目标对象</h3><p>最近测试中，以下类型的问题出现时，模型较少提到目标对象：${esc(gapText)}。</p><p>简单说，就是用户问到这些事时，豆包常常只给通用建议，或优先提到其他对象。</p></article><article class="analysis-card action"><span class="analysis-kicker">接下来怎么做</span><h3>先把用户最常问的内容讲清楚</h3><ol><li><b>先做：</b>围绕高频问题整理解决方案、服务流程和可核验事实。</li><li><b>再统一：</b>统一名称、别名、官网地址和已经审核的事实，避免不同页面说法不一样。</li><li><b>持续补充：</b>持续补充可核实的案例、合作流程和服务能力，让豆包更容易引用真实、具体的信息。</li></ol></article></div></section>`;
}
function overviewV2() {
  const d = state.dashboard; const browser = d.browserMonitoring; const summary = browser.overall;
  const dateText = browser.latestDate || "尚无网页端记录";
  // A valid answer earns 0 points when unmentioned, 60 points when merely
  // mentioned, and 100 points when the brand is in the first five choices.
  // The card is therefore a score out of 100, not a percentage display.
  const visibilityScore = summary.validCompletedCount
    ? ((summary.mentionedOnlyCount * 60 + summary.directRecommendationCount * 100) / summary.validCompletedCount).toFixed(1)
    : "—";
  return `<div class="grid metrics"><div class="card score-card score-card-with-tip" tabindex="0" aria-label="公司整体可见度得分标准"><div class="card-label">公司整体可见度得分 <span class="badge">满分 100 分</span><span class="score-help" aria-hidden="true">?</span></div><div class="metric-value">${visibilityScore}${visibilityScore === "—" ? "" : " 分"}</div><div class="metric-note">${esc(dateText)} · 只按有效公司回答计算</div><div class="score-tooltip" role="tooltip"><b>评分标准（满分 100 分）</b><p>按每一道有效回答取分后求平均，不再把得分显示成百分比。</p><ul><li><b>优先推荐：100 分</b>——目标品牌在推荐名单前 5 位。</li><li><b>仅提及：60 分</b>——出现“目标品牌”“目标公司”或公司全称，但不在前 5 位推荐。</li><li><b>未提及：0 分</b>——有明确公司、品牌或工厂名称，但没有目标品牌。</li><li><b>作废：</b>回答没有任何明确公司、品牌或工厂名称，不计入平均分。</li></ul></div></div>
  <div class="card"><div class="card-label">有效完成</div><div class="metric-value">${summary.validCompletedCount}/${browser.totalQuestions}</div><div class="metric-note">无公司名回答不计入完成</div></div><div class="card"><div class="card-label">提及率</div><div class="metric-value">${browserRate(summary.mentionRate)}</div><div class="metric-note">${summary.mentionCount}/${summary.validCompletedCount} 有效题提及</div></div><div class="card"><div class="card-label">优先推荐率</div><div class="metric-value">${browserRate(summary.priorityRecommendationRate)}</div><div class="metric-note">目标品牌位于前 5 推荐位</div></div><div class="card"><div class="card-label">作废回答</div><div class="metric-value">${summary.invalidCompanyAnswerCount}</div><div class="metric-note">未出现任何公司、品牌或工厂名称</div></div></div>
  <div class="grid two browser-chart-grid"><div class="card"><div class="section-head"><div><h2>最新监测结果</h2><p>${esc(dateText)}；每题仅取当天最后一次网页端回答。</p></div></div>${browserPie("品牌可见情况", [{ label:"优先推荐", value:summary.directRecommendationCount, color:"#3974e9" }, { label:"仅提及", value:summary.mentionedOnlyCount, color:"#26a879" }, { label:"未提及", value:summary.unmentionedCount, color:"#bcc7d8" }])}</div><div class="card"><div class="section-head"><div><h2>答复有效性</h2><p>只有回答中出现明确公司、品牌或工厂名称，才会计入完成。</p></div></div>${browserPie("本轮完成情况", [{ label:"有效完成", value:summary.validCompletedCount, color:"#3974e9" }, { label:"无公司名作废", value:summary.invalidCompanyAnswerCount, color:"#f0a13b" }, { label:"未测试", value:summary.incompleteCount, color:"#d7deea" }])}</div></div>
  ${monitoringAnalysis(browser)}`;
}

function legacyOverview() { const d = state.dashboard; const metrics = d.evidenceMetrics; const percent = (value) => typeof value === "number" ? `${value.toFixed(1)}%` : "暂无数据"; const components = [
  { label: "提及率", value: metrics.mentionRate === null ? null : metrics.mentionRate * 100, detail: `${metrics.counts.mentionCount}/${metrics.sampleCount} 题提及` },
  { label: "优先推荐", value: metrics.recommendationRate === null ? null : metrics.recommendationRate * 100, detail: `${metrics.counts.recommendationCount}/${metrics.sampleCount} 题推荐` },
  { label: "官网引用率", value: metrics.ownedDomainCitationRate === null ? null : metrics.ownedDomainCitationRate * 100, detail: metrics.sourceReturnedSampleCount ? `有来源 ${metrics.sourceReturnedSampleCount} 题` : "当前未保存来源" },
  { label: "第三方来源", value: metrics.thirdPartyBrandCitationRate === null ? null : metrics.thirdPartyBrandCitationRate * 100, detail: metrics.sourceReturnedSampleCount ? `有来源 ${metrics.sourceReturnedSampleCount} 题` : "当前未保存来源" },
].filter((item) => item.value !== null); return `
  <div class="grid metrics"><div class="card score-card"><div class="card-label">GEO 可见性评分 <span class="badge">v1.0 可解释</span></div><div class="metric-value">${d.score.score}</div><div class="metric-note">${d.score.sampleSize} 个回答样本 · 权重与证据均可追溯</div></div>
  <div class="card"><div class="card-label">监测问题</div><div class="metric-value">${d.counts.prompts}</div><div class="metric-note">按意图和价值加权</div></div><div class="card"><div class="card-label">审批资料</div><div class="metric-value">${d.counts.approvedKnowledge}</div><div class="metric-note">只允许审核资料写作</div></div><div class="card"><div class="card-label">排期发布</div><div class="metric-value">${d.counts.scheduled}</div><div class="metric-note">平台日限额生效</div></div><div class="card"><div class="card-label">Codex 待执行</div><div class="metric-value">${d.counts.codexTasks}</div><div class="metric-note">提交后由 Codex 审核或写作</div></div></div>
  <div class="grid two"><div class="card"><div class="section-head"><div><h2>当前 30 题结果</h2><p>每题只取最新一次网页端回答；历史记录用于复测，不混入这里。</p></div><span class="chip">${metrics.sampleCount} 题样本</span></div>${components.map(({ label, value, detail }) => `<div class="bar-row"><span>${label}</span><div class="bar"><span style="width:${Math.min(Math.max(value, 0), 100)}%"></span></div><b>${percent(value)}<small>${esc(detail)}</small></b></div>`).join("")}${metrics.sourceReturnedSampleCount === 0 ? `<p class="metric-note">来源引用暂不评分：本轮网页端回答未保存可验证的来源链接。</p>` : ""}</div>
  <div class="card"><div class="section-head"><div><h2>闭环状态</h2><p>从问题机会到可验证的内容动作。</p></div></div><div class="rule-list"><div>① 监测<br><b>${d.surfaces.join("、")}</b></div><div>② 内容机会<br><b>${state.topics.filter(x=>x.status==='ready').length} 个待执行</b></div><div>③ 审稿与排期<br><b>ChatGPT 审稿闸门</b></div><div>④ 发布回流<br><b>发布后复测</b></div></div></div></div>
  <div class="section-head"><div><h2>最近监测证据</h2><p>原始回答和判定结果应作为分数依据保存。</p></div><button class="secondary" data-view-link="monitoring">查看全部</button></div><div class="card">${runsTable(d.latestRuns)}</div>`; }
function runsTable(runs) { if (!runs.length) return `<div class="empty">尚未运行监测。点击右上角“运行全量监测”。</div>`; return `<table><thead><tr><th>平台</th><th>问题</th><th>提及 / 推荐</th><th>准确性与情绪</th><th>原始回答</th></tr></thead><tbody>${runs.map(run => { const prompt=state.prompts.find(p=>p.id===run.promptId); return `<tr><td><b>${run.surface}</b><br><span class="mono">${fmt(run.createdAt)}</span></td><td>${esc(prompt?.text || run.promptId)}</td><td>${run.brandMentioned ? statusChip(run.recommendation) : `<span class="chip">未提及</span>`}</td><td>${run.accurate ? "准确" : "待纠正"} · ${esc(run.sentiment)}</td><td class="muted">${esc(run.rawAnswer)}</td></tr>`; }).join("")}</tbody></table>`; }
function metricRate(value) { return value === null || value === undefined ? "无法判断" : `${(value * 100).toFixed(1)}%`; }
function evidenceMetricCards(metrics, scope, title) {
  const cards = [
    ["mention", "提及率", metrics.mentionRate, `正式样本 ${metrics.sampleCount} · 命中 ${metrics.counts.mentionCount}`],
    ["recommendation", "推荐率", metrics.recommendationRate, `正式样本 ${metrics.sampleCount} · 命中 ${metrics.counts.recommendationCount}`],
    ["owned", "官网引用率", metrics.ownedDomainCitationRate, `有来源 ${metrics.sourceReturnedSampleCount} / 无来源 ${metrics.noSourceReturnedSampleCount} · 命中 ${metrics.counts.ownedCount}`],
    ["thirdParty", "第三方品牌来源引用率", metrics.thirdPartyBrandCitationRate, `有来源 ${metrics.sourceReturnedSampleCount} / 无来源 ${metrics.noSourceReturnedSampleCount} · 命中 ${metrics.counts.thirdPartyBrandCount}`],
  ];
  return `<section class="evidence-panel"><div class="section-head"><div><h2>${esc(title)}</h2><p>提及、推荐和两类来源引用分别判定。模拟、失败和历史未验证样本不进入正式报表。</p></div></div><div class="grid four">${cards.map(([filter, label, value, note]) => `<button class="stability-card ${state.evidenceScope===scope && state.evidenceFilter===filter ? "selected" : ""}" data-evidence-filter="${filter}" data-evidence-scope="${scope}"><span>${label}</span><b>${metricRate(value)}</b><small>${note}</small></button>`).join("")}</div></section>`;
}
function baseCitationList(run) {
  if (run.citationCaptureVersion === "v2") return renderReferenceSources(run);
  if (run.citationMode === "legacy_unverified") return `<span class="chip amber">历史未验证</span>`;
  if (run.citationMode === "no_source_returned") return `<span class="chip amber">未返回来源，无法判断引用</span>`;
  const citations = Array.isArray(run.browserCitations) ? run.browserCitations : (run.citations || []);
  if (run.citationCaptureStatus === "failed") return `<span class="chip amber">来源采集失败，回答仍有效</span>`;
  if (run.citationCaptureStatus === "not_available" && !citations.length) return `<span class="chip amber">未观察到可用引用区域</span>`;
  if (run.citationCaptureStatus === "empty" && !citations.length) return `<span class="chip">未观察到可见引用来源</span>`;
  if (!(citations || []).length) return `<span class="chip">无可用来源</span>`;
  return citations.map(citation => { const href = citation.resolvedUrl || citation.url; const link = /^https?:\/\//i.test(String(href || "")) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(citation.domain || href)}</a>` : esc(citation.domain || href || "未记录地址"); return `<div class="citation"><b>${esc(citation.title || citation.visibleText || "未标注来源")}</b><br>${link}<br><span class="chip">${esc(citation.brandRelatedCitation || citation.sourceType || "inline_link")}</span><br><span class="muted">${esc(citation.url || "")}</span></div>`; }).join("");
}
function citationList(run) {
  if (run?.citationCaptureStatus === "not_observed") return `<span class="chip amber">历史批次未采集结构化引用，无法判断是否有来源</span>`;
  return baseCitationList(run);
}
function evidenceDetails(scope) {
  const source = scope === "api" ? "doubao_api" : "browser_observed";
  const filter = state.evidenceScope === scope ? state.evidenceFilter : "all";
  const runs = state.probeRuns.filter(run => run.source === source && run.source !== "simulated_probe" && run.status === "success" && run.citationMode !== "legacy_unverified");
  const matches = (run) => ({ mention: run.brandMentioned, recommendation: run.recommendation !== "none", owned: (run.ownedDomainCitations || []).length > 0, thirdParty: (run.thirdPartyBrandCitations || []).length > 0 })[filter] ?? true;
  const rows = runs.filter(matches);
  const label = { all:"全部正式样本", mention:"提及命中问题", recommendation:"推荐命中问题", owned:"官网引用命中问题", thirdParty:"第三方品牌来源引用命中问题" }[filter];
  return `<div class="card evidence-detail"><div class="section-head"><div><h3>${scope === "api" ? "API" : "网页端"} · ${label}</h3><p>未命中的正式问题可通过“全部正式样本”查看；无来源样本不以正文提及冒充引用。</p></div><button class="tiny" data-evidence-filter="all" data-evidence-scope="${scope}">查看全部正式样本</button></div><table><thead><tr><th>问题 / 时间</th><th>品牌命中</th><th>推荐证据</th><th>来源与验证</th><th>原始回答</th></tr></thead><tbody>${rows.length ? rows.map(run => { const prompt = state.prompts.find(item => item.id === run.promptId); const recommended = ["first", "top3"].includes(run.recommendation); return `<tr><td><b>${esc(prompt?.text || run.promptId)}</b><br><span class="mono">${fmt(run.createdAt)} · ${esc(run.modelId || "未记录")}</span></td><td>${run.brandMentioned ? `<span class="chip green">提及</span><br>${esc((run.matchedBrandAliases || []).join("、"))}` : `<span class="chip">未提及</span>`}</td><td><span class="chip ${recommended ? "green" : ""}">${esc(recommendationLabel(run.recommendation))}</span>${run.position ? ` · 第 ${run.position} 位` : ""}${recommended ? `<br>${esc(run.recommendationEvidence || "未保存原文")}` : ""}</td><td>${citationList(run)}<br><span class="mono">${esc(run.citationMode || "未记录")}</span></td><td class="muted">${esc(run.rawAnswer)}</td></tr>`; }).join("") : `<tr><td colspan="5" class="empty">当前没有符合筛选条件的正式样本</td></tr>`}</tbody></table></div>`;
}
function monitoring() { const d = state.dashboard; const score = d.score; return `<div class="section-head"><div><h2>AI 可见性监测</h2><p>网页端与 API 回答分开统计；API 当前使用豆包 2.0 Lite，未启用联网搜索。</p></div><div class="actions"><button class="primary" id="run-doubao-api">豆包 API 连通性测试（1题）</button><button class="secondary" id="run-monitoring">运行模拟监测</button></div></div><div class="grid three">${d.surfaces.map(surface => { const runs=d.latestRuns.filter(r=>r.surface===surface); const mentions=runs.filter(r=>r.brandMentioned).length; return `<div class="card"><span class="chip">${surface}</span><div class="metric-value">${runs.length ? Math.round(mentions/runs.length*100) : "—"}${runs.length ? "%" : ""}</div><div class="metric-note">最近样本提及率</div></div>`; }).join("")}</div>${evidenceMetricCards(d.evidenceMetrics, "browser", "网页端正式证据指标")}${evidenceMetricCards(d.apiEvidenceMetrics, "api", "豆包 API 正式证据指标")}${evidenceDetails(state.evidenceScope)}<div class="section-head"><div><h2>网页端采样证据</h2><p>综合评分 ${score.score} · ${score.sampleSize} 个网页回答。</p></div><button class="secondary" id="add-prompt">新增监测问题</button></div><div class="card">${runsTable(d.latestRuns.concat([]))}</div>${stabilityPanel(d.score.stability, "网页端复测稳定性")}${stabilityPanel(d.apiScore.stability, "API 复测稳定性")}`; }
function stabilityPanel(stability, title = "复测稳定性") {
  const labels = { stable_visible:"稳定且可见", stable_invisible:"稳定但不可见", volatile:"结果波动", insufficient_data:"样本不足" };
  const order = ["stable_visible", "stable_invisible", "volatile", "insufficient_data"];
  const selected = state.stabilityFilter || "all";
  const groups = selected === "all" ? stability.groups : stability.groups.filter(group => group.status === selected);
  const overall = stability.stabilityRate === null ? "暂无可靠稳定性结论" : `总稳定性 ${(stability.stabilityRate * 100).toFixed(1)}%（仅统计样本数 ≥ 3 的分组）`;
  return `<section class="stability-panel"><div class="section-head"><div><h2>${esc(title)}</h2><p>${overall}。稳定性表示同一问题、模型和配置下结果是否一致，不表示品牌一定可见。</p></div></div><div class="grid four">${order.map(status => `<button class="stability-card ${selected===status?"selected":""}" data-stability-filter="${status}"><span>${labels[status]}</span><b>${stability.statusCounts[status] || 0}</b></button>`).join("")}</div><div class="actions"><button class="tiny" data-stability-filter="all">查看全部分组</button></div><div class="card"><table><thead><tr><th>问题 / 平台</th><th>模型与配置</th><th>提及率</th><th>稳定性</th><th>状态与明细</th></tr></thead><tbody>${groups.length ? groups.map(group => { const prompt = state.prompts.find(item => item.id === group.promptId); return `<tr><td><b>${esc(prompt?.text || group.promptId)}</b><br><span class="mono">${esc(group.surface)} · ${group.sampleSize} 次</span></td><td><span class="mono">${esc(group.modelId)}</span><br><span class="mono">${esc(group.configFingerprint)}</span></td><td>${(group.visibilityRate * 100).toFixed(1)}%</td><td>${group.stabilityRate === null ? "样本不足" : `${(group.stabilityRate * 100).toFixed(1)}%`}</td><td>${statusChip(group.status)}<details><summary>查看 ${group.runs.length} 次原始证据</summary><table><thead><tr><th>时间</th><th>模型</th><th>配置</th><th>提及</th><th>原始回答</th></tr></thead><tbody>${group.runs.map(run => `<tr><td class="mono">${fmt(run.createdAt)}</td><td class="mono">${esc(run.modelId || run.model || "未记录")}</td><td class="mono">${esc(run.configFingerprint || "未记录")}</td><td>${run.brandMentioned ? "提及" : "未提及"}</td><td class="muted">${esc(run.rawAnswer)}</td></tr>`).join("")}</tbody></table></details></td></tr>`; }).join("") : `<tr><td colspan="5" class="empty">当前筛选下没有分组</td></tr>`}</tbody></table></div></section>`;
}
function knowledge() { return `<div class="section-head"><div><h2>审批资料库</h2><p>只有“已审批”的资料可以进入写作 Brief 和 ChatGPT 事实核验。</p></div><button class="primary" id="add-knowledge">新增资料</button></div><div class="card"><table><thead><tr><th>资料</th><th>事实摘要</th><th>来源</th><th>状态</th><th></th></tr></thead><tbody>${state.knowledge.map(item=>`<tr><td><b>${esc(item.title)}</b><br><span class="mono">${esc(item.type)} · ${item.id}</span></td><td>${item.facts.map(esc).join("<br>")}</td><td class="muted">${item.sourceUrl ? `<a href="${esc(item.sourceUrl)}" target="_blank">资料链接</a>` : "未填写"}</td><td>${statusChip(item.status)}</td><td>${item.status!=="approved" ? `<button class="tiny" data-approve="${item.id}">审批通过</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`; }
function content() { return `<div class="section-head"><div><h2>选题与文章</h2><p>按平台规则生成不同稿件；WorkBuddy 写作优先，Codex 承接写作与审核，不需要 API Key。</p></div><button class="secondary" id="add-topic">新建选题</button></div><div class="grid two"><div class="card"><h3>内容机会</h3><div class="list">${state.topics.map(topic=>`<div class="topic"><b>${esc(topic.title)}</b><p>${esc(topic.opportunity)}</p><div class="actions">${topic.platforms.map(platform=>`<button class="tiny" data-generate="${topic.id}" data-platform="${platform}" data-writer="workbuddy">WorkBuddy · ${platform}</button><button class="tiny" data-generate="${topic.id}" data-platform="${platform}" data-writer="codex">Codex 写作 · ${platform}</button>`).join("")}</div></div>`).join("")}</div></div><div class="card"><h3>Codex 队列</h3><div class="metric-value">${state.codexTasks.length}</div><div class="metric-note">在 Codex 中执行后，系统自动保存结论与版本。</div><div class="rule-list"><div>待写作 ${state.codexTasks.filter(t=>t.type==='write_article').length}</div><div>待审核 ${state.codexTasks.filter(t=>t.type==='review_article').length}</div><div>草稿 ${state.articles.filter(a=>a.status==='draft').length}</div><div>已通过 ${state.articles.filter(a=>a.status==='approved').length}</div></div></div></div><div class="section-head"><div><h2>稿件队列</h2><p>每篇文章展示引用资料、审核结果和平台规则版本。</p></div></div><div class="card">${articlesTable()}</div>${codexTaskPanel()}`; }
function codexTaskPanel() { if (!state.codexTasks.length) return ""; return `<div class="section-head"><div><h2>待 Codex 执行</h2><p>在 Codex 中打开项目后，告诉它“执行 GEO Codex 队列”。</p></div></div><div class="card"><table><thead><tr><th>任务</th><th>对象</th><th>状态</th><th>执行提示</th></tr></thead><tbody>${state.codexTasks.map(t=>`<tr><td><b>${t.type==='review_article'?'发布前审核':'平台化写作'}</b><br><span class="mono">${t.id}</span></td><td>${esc(t.platform)}</td><td>${statusChip(t.status)}</td><td><button class="tiny" data-copy-task="${t.id}">复制 Codex 指令</button></td></tr>`).join("")}</tbody></table></div>`; }
function articlesTable() { if (!state.articles.length) return `<div class="empty">还没有稿件。从左侧选题开始生成平台稿。</div>`; return `<table><thead><tr><th>文章</th><th>平台 / 规则</th><th>资料与版本</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.articles.map(article=>`<tr><td><b>${esc(article.title)}</b><br><span class="mono">${esc(article.generationProvider)} · 重写 ${article.revisionCount}/2</span></td><td>${esc(article.platform)}<br><span class="mono">${esc(article.ruleVersion)}</span></td><td>${article.citationFactIds.map(id=>`<span class="chip">${id}</span>`).join(" ")}</td><td>${statusChip(article.status)}</td><td><div class="actions"><button class="tiny" data-preview="${article.id}">预览</button>${article.status==='draft'||article.status==='needs_revision' ? `<button class="tiny" data-review="${article.id}">提交 Codex 审核</button>` : ""}${article.status==='approved' ? `<button class="tiny" data-schedule="${article.id}">排期</button>` : ""}</div></td></tr>`).join("")}</tbody></table>`; }
function rules() { return `<div class="section-head"><div><h2>平台规则</h2><p>规则按版本执行；生成、审核、渲染和发布使用同一条规则记录。</p></div></div><div class="grid three">${state.rules.filter(r=>r.active).map(rule=>`<div class="card"><span class="chip">${esc(rule.platform)}</span><h2 style="margin-top:10px">${esc(rule.version)}</h2><p class="muted">${esc(rule.notes)}</p><div class="rule-list"><div>标题 ${rule.titleMin}-${rule.titleMax}</div><div>正文 ${rule.bodyMin}-${rule.bodyMax}</div><div>日发布 ${rule.dailyLimit} 篇</div><div>摘要 ${rule.requireSummary?"必填":"可选"}</div><div>AI 声明 ${rule.requireAigcDisclosure?"必填":"可选"}</div></div><details><summary>查看发布要求</summary><p class="muted">结构：${esc(rule.layout)}</p><p class="muted">链接：${esc(rule.linkPolicy||"按审核资料执行")}</p><p class="muted">标签：${esc(rule.tagPolicy||"与正文相关")}</p><p class="muted">图片：${esc(rule.imagePolicy||"仅使用已审核素材")}</p><p class="muted">宣传：${esc(rule.advertisingPolicy||"避免夸大宣传")}</p></details><p class="muted">禁用：${rule.forbiddenPhrases.map(esc).join("、")}</p></div>`).join("")}</div>`; }
function publishing() { return `<div class="section-head"><div><h2>发布日历</h2><p>仅 ChatGPT 审核通过的文章能进入排期；验证码、登录失效等异常会自动暂停。</p></div></div><div class="card">${state.jobs.length ? `<table><thead><tr><th>文章</th><th>平台</th><th>排期</th><th>状态</th><th>回执 / 操作</th></tr></thead><tbody>${state.jobs.map(job=>{const article=state.articles.find(a=>a.id===job.articleId);return `<tr><td>${esc(article?.title||job.articleId)}</td><td>${esc(job.platform)}</td><td>${fmt(job.scheduledAt)}</td><td>${statusChip(job.status)}</td><td>${job.status==='scheduled'?`<button class="tiny" data-publish="${job.id}">模拟成功回执</button><button class="tiny" data-pause="${job.id}">模拟验证码暂停</button>`:job.receiptUrl?`<a href="${esc(job.receiptUrl)}" target="_blank">查看回执</a>`:esc(job.pauseReason||"—")}</td></tr>`}).join("")}</tbody></table>`:`<div class="empty">没有排期任务。审核通过后可从文章队列进入排期。</div>`}</div>`; }
function settings() { const brand = state.brands?.[0] || {}; return `<div class="section-head"><div><h2>系统设置</h2><p>先设置要监测的名称；提及率、推荐率和引用分析都会使用这里的配置。</p></div></div><div class="card"><h3>监测对象</h3><form id="brand-settings-form" class="form-grid"><label>名称<input name="name" value="${esc(brand.name || "")}" required placeholder="输入朋友要测试的品牌或机构名称"></label><label>全称（可选）<input name="legalName" value="${esc(brand.legalName || "")}"></label><label>别名（每行或逗号分隔）<textarea name="aliases">${esc((brand.aliases || []).join("\n"))}</textarea></label><label>官网（可选）<input name="domain" type="url" value="${esc(brand.domain || "")}" placeholder="https://example.com"></label><label>行业（可选）<input name="industry" value="${esc(brand.industry || "")}"></label><label>地区（可选）<input name="location" value="${esc(brand.location || "")}"></label><div class="form-actions"><button class="primary" type="submit">保存监测对象</button></div></form></div><div class="card"><span class="chip green">网页端实测模式</span><h3 style="margin-top:10px">平台设置</h3><p class="muted">当前使用豆包网页端客户端实测，不通过 API 发起搜索。</p></div>`; }
function legacyClearLocalMonitoringPanel(local) {
  const regionNames = { chashan: "茶山镇", dongguan: "东莞市", national: "全国" };
  const selected = new Set(local.config.selectedRegions || []);
  const counts = local.prompts.reduce((all, prompt) => ({ ...all, [prompt.region]: (all[prompt.region] || 0) + 1 }), {});
  const localIds = new Set(local.prompts.map(prompt => prompt.id));
  const latestClientRuns = new Map();
  for (const run of state.probeRuns.filter(run => localIds.has(run.promptId) && run.source === "browser_observed" && run.status === "success")) {
    const previous = latestClientRuns.get(run.promptId);
    if (!previous || new Date(run.createdAt) > new Date(previous.createdAt)) latestClientRuns.set(run.promptId, run);
  }
  const clientRuns = [...latestClientRuns.values()];
  const mentioned = clientRuns.filter(run => run.brandMentioned).length;
  const unmentioned = clientRuns.filter(run => !run.brandMentioned).length;
  return `<section class="monitor-hero simple-monitor-hero"><div class="monitor-hero-copy"><span class="chip green">豆包网页版客户端实测</span><h2>30 题检测结果</h2><p>每道题使用独立新对话完成。页面只展示网页端实测结果，不使用 API 对照数据。</p></div><div class="monitor-summary"><div><b>${clientRuns.length}/${local.prompts.length}</b><small>已完成</small></div><div><b>${mentioned}</b><small>提及品牌</small></div><div><b>${unmentioned}</b><small>未提及</small></div></div></section><section class="monitor-section results-intro"><div><h3>按题查看结果</h3><p>先点“提及品牌”查看命中题；需要完整内容时，点击任意题目右侧的“展开”。</p></div><div class="actions result-filters"><button class="tiny ${state.localEvidenceFilter === "all" ? "selected" : ""}" data-local-evidence-filter="all">全部 ${local.prompts.length}</button><button class="tiny ${state.localEvidenceFilter === "mentioned" ? "selected" : ""}" data-local-evidence-filter="mentioned">提及品牌 ${mentioned}</button><button class="tiny ${state.localEvidenceFilter === "unmentioned" ? "selected" : ""}" data-local-evidence-filter="unmentioned">未提及 ${unmentioned}</button></div></section><details class="monitor-disclosure"><summary>当前题库与地域范围</summary><div class="monitor-settings"><div><b>当前题库</b><p>东莞市 ${counts.dongguan || 0} 题 · 茶山镇 ${counts.chashan || 0} 题 · 全国 ${counts.national || 0} 题</p></div><div class="actions"><button class="secondary" id="save-local-regions">更新问题库</button></div></div><div class="region-options"><label class="region-option"><input type="checkbox" name="local-region" value="dongguan" ${selected.has("dongguan") ? "checked" : ""}><span>东莞市</span><small>${counts.dongguan || 0} 题</small></label><label class="region-option"><input type="checkbox" name="local-region" value="chashan" ${selected.has("chashan") ? "checked" : ""}><span>茶山镇</span><small>${counts.chashan || 0} 题</small></label><label class="region-option"><input type="checkbox" name="local-region" value="national" ${selected.has("national") ? "checked" : ""}><span>全国</span><small>${counts.national || 0} 题</small></label></div><details><summary>查看当前 30 条地域问题</summary><div class="question-columns">${local.prompts.map(prompt => `<div><span class="chip">${regionNames[prompt.region] || prompt.region}</span>${esc(prompt.text)}</div>`).join("")}</div></details></details>`;
}

function legacyClearLocalEvidence(local) {
  const ids = new Set(local.prompts.map(prompt => prompt.id));
  const runsByPrompt = new Map(local.prompts.map(prompt => [prompt.id, []]));
  const latestRuns = new Map();
  for (const run of state.probeRuns.filter(run => ids.has(run.promptId) && run.status === "success" && run.source === "browser_observed")) {
    const previous = latestRuns.get(run.promptId);
    if (!previous || new Date(run.createdAt) > new Date(previous.createdAt)) latestRuns.set(run.promptId, run);
  }
  const runs = [...latestRuns.values()];

  for (const run of runs) runsByPrompt.get(run.promptId).push(run);
  for (const promptRuns of runsByPrompt.values()) promptRuns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const browserCount = runs.filter(run => run.source === "browser_observed").length;
  const regionNames = { chashan: "茶山镇", dongguan: "东莞市", national: "全国" };
  const sourceName = () => "豆包网页版客户端实测";
  const resultText = (run) => run.brandMentioned ? "已提及目标品牌" : "未提及目标品牌";
  const resultClass = (run) => run.brandMentioned ? "hit" : "";
  const primaryRunFor = (prompt) => {
    const promptRuns = runsByPrompt.get(prompt.id) || [];
    return promptRuns[0];
  };
  const visiblePrompts = local.prompts.filter(prompt => {
    const primaryRun = primaryRunFor(prompt);
    if (state.localEvidenceFilter === "mentioned") return primaryRun?.brandMentioned;
    if (state.localEvidenceFilter === "unmentioned") return primaryRun && !primaryRun.brandMentioned;
    return true;
  });

  return `<section class="monitor-section result-list-section"><div class="monitor-section-title"><div><h3>检测明细</h3><p>仅显示豆包网页版客户端的独立新对话实测回答。点击任意题目展开完整内容。</p></div><span class="chip">显示 ${visiblePrompts.length} 题</span></div><div class="evidence-stack">${visiblePrompts.map(prompt => {
    const index = local.prompts.indexOf(prompt);
    const promptRuns = runsByPrompt.get(prompt.id) || [];
    const primaryRun = promptRuns[0];
    const summary = primaryRun ? resultText(primaryRun) : "尚无结果";
    return `<details class="evidence-item"><summary><span class="chip">${regionNames[prompt.region] || "未记录"}</span><b>Q${index + 1}. ${esc(prompt.text)}</b><span class="evidence-result ${primaryRun ? resultClass(primaryRun) : ""}">${summary}</span></summary>${promptRuns.length ? `<div class="evidence-body">${promptRuns.map(run => `<section class="result-source"><div class="result-source-head"><b>${sourceName()}</b><span class="chip ${run.brandMentioned ? "green" : ""}">${resultText(run)}</span><span class="chip ${run.recommendation === "first" || run.recommendation === "top3" ? "green" : ""}">${esc(recommendationLabel(run.recommendation))}</span></div><p>${["first", "top3"].includes(run.recommendation) ? `推荐依据：${esc(run.recommendationEvidence || "已保存原文证据")}` : "未直接推荐"}</p><p class="mono">${fmt(run.createdAt)} · ${esc(run.modelId || "未记录模型")}</p><p class="muted">客户端页面未采集可点击来源链接，已保留回答正文。</p><div class="raw-answer"><b>原始回答</b><p>${esc(run.rawAnswer)}</p></div></section>`).join("")}</div>` : `<div class="empty compact-empty">这道题尚未保存检测结果。</div>`}</details>`;
  }).join("")}</div></section>`;
}

function legacyRegionalMonitoring() { const local = state.dashboard.localMonitoring; const stableText = local.stability.stabilityRate === null ? "样本不足：同一题、同一配置至少复测 3 次才会计算稳定性。" : `当前稳定性 ${(local.stability.stabilityRate * 100).toFixed(1)}%。`; return `${legacyClearLocalMonitoringPanel(local)}${legacyClearLocalEvidence(local)}<details class="monitor-disclosure"><summary>复测稳定性说明</summary><p>${stableText}</p></details>`; }

function dateLabel(date) { return date && date !== "未记录日期" ? date.replaceAll("-", " 年 ").replace(/ 年 (\d{2})$/, " 月 $1 日") : "未记录日期"; }
function monitorTime(value) { return value ? new Date(value).toLocaleTimeString("zh-CN", { hour12:false, timeZone:"Asia/Shanghai", hour:"2-digit", minute:"2-digit", second:"2-digit" }) : "未记录"; }
function browserCitationRecords(run) { return Array.isArray(run?.browserCitations) ? run.browserCitations : (Array.isArray(run?.citations) ? run.citations : []); }
function baseBrowserCitationEvidence(run) {
  if (run.citationCaptureVersion === "v2") return renderReferenceSources(run);
  const citations = browserCitationRecords(run);
  const status = run?.citationCaptureStatus || (citations.length ? "success" : "not_available");
  if (status === "failed") return `<div class="citation-evidence"><b>豆包引用资料</b><p class="invalid-note">来源信息采集异常，本回答正文仍然有效。${run.citationCaptureError ? ` ${esc(run.citationCaptureError)}` : ""}</p></div>`;
  if (status === "not_available") return `<div class="citation-evidence"><b>豆包引用资料</b><p class="muted">当前回答没有可用的引用采集区域。</p></div>`;
  if (!citations.length) return `<div class="citation-evidence"><b>豆包引用资料（0）</b><p class="muted">本回答未观察到可见引用来源。</p></div>`;
  const statusNote = status === "partial" ? `<p class="invalid-note">来源信息部分采集，回答正文仍然有效。${run.citationCaptureError ? ` ${esc(run.citationCaptureError)}` : ""}</p>` : "";
  return `<div class="citation-evidence"><b>豆包引用资料（${citations.length}）</b>${statusNote}<ol>${citations.map((citation) => { const href = citation.resolvedUrl || citation.url; const link = /^https?:\/\//i.test(String(href || "")) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>` : `<span class="muted">${esc(href || "未记录 URL")}</span>`; return `<li><b>${esc(citation.title || citation.visibleText || "未标注标题")}</b><br><span class="muted">${esc(citation.domain || "未记录域名")}</span><br>${link}${citation.brandRelatedCitation ? `<br><span class="chip">品牌信源：${esc(citation.brandRelatedCitation)}</span>` : ""}</li>`; }).join("")}</ol></div>`;
}
function browserCitationEvidence(run) {
  if (run?.citationCaptureStatus === "not_observed") return `<div class="citation-evidence"><b>豆包引用资料</b><p class="invalid-note">历史批次未采集结构化引用来源，无法判断当时是否存在引用。没有历史 Citation 数据不代表历史豆包没有 Citation。</p></div>`;
  return baseBrowserCitationEvidence(run);
}
function baseBrowserSourceSummary(summary) {
  if (!summary) return "";
  const freshness = Number.isFinite(summary.citationsWithPublishedAt) ? `<span>24小时内 ${summary.citationsWithin24h || 0}</span><span>3天内 ${summary.citationsWithin3d || 0}</span><span>7天内 ${summary.citationsWithin7d || 0}</span><span>30天内 ${summary.citationsWithin30d || 0}</span>` : "";
  return `<div class="citation-source-summary"><b>本轮来源汇总</b><span>引用 ${summary.totalCitations || 0}</span><span>唯一 URL ${summary.uniqueUrls || 0}</span><span>唯一域名 ${summary.uniqueDomains || 0}</span><span>含引用题数 ${summary.questionsWithCitations || 0}</span><span>采集失败 ${summary.citationCaptureFailures || 0}</span>${freshness}</div>`;
}
function browserSourceSummary(summary) {
  const html = baseBrowserSourceSummary(summary);
  if (!summary || summary.citationObservationStatus !== "not_observed") return html;
  return `${html}<div class="citation-history-warning">历史批次未采集结构化引用来源，无法进行信源变化比较；这不代表历史豆包没有 Citation。</div>`;
}
function browserObservabilitySummary(observability) {
  if (!observability) return "";
  const readiness = observability.diagnosticReadiness || "low";
  const readinessLabel = { high: "较可靠", medium: "基本可靠", low: "仅供参考" }[readiness] || "仅供参考";
  const total = observability.totalQuestions || 0;
  const processRecords = Math.min(observability.conversationAuditCoverage || 0, observability.workerAuditCoverage || 0);
  const reason = readiness === "high"
    ? "本次回答、引用来源和检测过程均有完整记录，原因分析比较可靠。"
    : readiness === "medium"
      ? "本次回答记录完整，但部分引用来源或检测过程缺少记录，原因分析仅作参考。"
      : "本次缺少较多回答、引用来源或检测过程记录，目前只能看评分，原因分析仅作参考。";
  return `<div class="observability-summary"><b>本次数据是否够用</b><span class="chip ${readiness === "high" ? "green" : readiness === "medium" ? "amber" : "red"}">原因分析：${readinessLabel}</span><span>${observability.geoResultTrustworthy ? "评分数据完整" : "评分数据不完整"}</span><span>回答记录 ${observability.answersCaptured || 0}/${total}</span><span>引用来源记录 ${observability.citationsCapturedQuestions || 0}/${total}</span><span>检测过程记录 ${processRecords}/${total}</span><small>${reason}</small></div>`;
}
function baseBrowserDropDiagnostics(diagnostics) {
  if (!diagnostics) return `<div class="geo-drop-diagnostics muted">历史可比完整轮次不足，暂不生成 GEO 下降诊断。</div>`;
  const comparison = diagnostics.comparison || {};
  const metric = (item, label) => item?.current === null || item?.current === undefined
    ? `<span>${label}：无法计算</span>`
    : `<span>${label}：${trendRate(item.current)}（基准 ${trendRate(item.baseline)}，变化 ${item.absoluteDelta === null ? "—" : `${(item.absoluteDelta * 100).toFixed(1)} 个百分点`}）</span>`;
  const reasons = diagnostics.triggered && diagnostics.triggerReasons?.length
    ? `<ul>${diagnostics.triggerReasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>`
    : `<p>本轮未达到配置的下降阈值（基准 ${diagnostics.baselineSampleSize || 0} 轮；绝对阈值 ${(Number(diagnostics.thresholds?.absolute || 0) * 100).toFixed(1)} 个百分点，相对阈值 ${(Number(diagnostics.thresholds?.relative || 0) * 100).toFixed(1)}%）。</p>`;
  const lost = diagnostics.promptMatrix?.lostVisibilityPrompts || [];
  return `<section class="geo-drop-diagnostics ${diagnostics.triggered ? "triggered" : "stable"}"><div class="geo-drop-head"><b>GEO 下降诊断</b><span class="chip ${diagnostics.triggered ? "amber" : "green"}">${diagnostics.triggered ? "已触发" : "未触发"}</span></div><div class="geo-drop-metrics">${metric(comparison.mentionRate, "提及率")}${metric(comparison.priorityRate, "优先推荐率")}</div><small>比较最近 ${diagnostics.baselineSampleSize || 0} 个可比完整 Run（请求 ${diagnostics.baselineRequested || 0} 个）。</small>${reasons}${lost.length ? `<div><b>以前高频出现、现在消失的问题</b><ul>${lost.slice(0, 8).map((item) => `<li>${esc(item.questionText || item.promptId)}（基准 ${(Number(item.baselineRate || 0) * 100).toFixed(1)}% → 当前 ${(Number(item.currentRate || 0) * 100).toFixed(1)}%）</li>`).join("")}</ul></div>` : ""}</section>`;
}
function browserDropDiagnostics(diagnostics) {
  const html = baseBrowserDropDiagnostics(diagnostics);
  const observability = diagnostics?.observability;
  if (!html || !html.endsWith("</section>")) return html;
  const panel = observability ? browserObservabilitySummary(observability) : "";
  const citation = diagnostics?.citationChanges;
  const citationPanel = citation?.available === false ? `<div class="citation-history-warning">${esc(citation.reason || "历史批次未采集结构化引用来源，无法进行信源变化比较。")}</div>` : "";
  return `${html.slice(0, -"</section>".length)}${citationPanel}${panel}</section>`;
}
function browserRunDetail(run, prompt) {
  const outcome = browserOutcome(run);
  return `<section class="result-source"><div class="result-source-head"><b>豆包网页版独立新对话</b><span class="browser-status ${outcome.tone}">${esc(outcome.text)}</span></div><p class="mono">${fmt(run.createdAt)} · ${esc(run.modelId || "网页端未记录模型")}</p><p><b>Prompt</b><br>${esc(prompt?.text || run.promptId || "未记录")}</p>${outcome.tone === "invalid" ? `<p class="invalid-note">审计保留：未按“至少 2 家公司、逐家单独分点并说明”的标准作答；不计入完成数、提及率或优先推荐率。</p>` : ""}${outcome.tone === "direct" ? `<p>推荐依据：${esc(run.recommendationEvidence || "目标品牌出现在有效公司推荐项中")}</p>` : ""}<div class="raw-answer"><b>豆包完整回答</b><p>${esc(run.rawAnswer)}</p></div>${browserCitationEvidence(run)}</section>`;
}
function browserDateGroup(group, prompts, source = "current") {
  const evidenceKey = group.monitorRunId ? `${source}:${group.monitorRunId}` : null;
  const evidence = evidenceKey ? state.browserEvidenceByRunId[evidenceKey] : null;
  const timeRange = group.monitoredStartedAt === group.monitoredEndedAt
    ? monitorTime(group.monitoredStartedAt)
    : `${monitorTime(group.monitoredStartedAt)} — ${monitorTime(group.monitoredEndedAt)}`;
  const evidenceBody = evidence
    ? `<div class="evidence-stack">${prompts.map((prompt, index) => { const history = evidence.historyByPrompt?.[prompt.id] || []; const run = history[0]; const outcome = browserOutcome(run); return `<details class="evidence-item"><summary><span class="chip">${prompt.region === "chashan" ? "茶山镇" : prompt.region === "dongguan" ? "东莞市" : "全国"}</span><b>Q${index + 1}. ${esc(prompt.text)}</b><span class="browser-status ${outcome.tone}">${esc(outcome.text)}</span></summary>${run ? `<div class="evidence-body">${browserRunDetail(run, prompt)}${history.length > 1 ? `<details class="run-history"><summary>查看本日 ${history.length - 1} 条更早记录</summary>${history.slice(1).map((item) => browserRunDetail(item, prompt)).join("")}</details>` : ""}</div>` : `<div class="empty compact-empty">本次监测尚未测试这道题。</div>`}</details>`; }).join("")}</div>`
    : `<div class="empty compact-empty">${group.monitorRunId ? "正在按需加载本批次的逐题原始回答…" : "该历史批次暂只保留汇总；原始数据仍在本地审计记录中。"}</div>`;
  return `<details class="date-run"${group.monitorRunId ? ` data-browser-run-id="${esc(group.monitorRunId)}" data-browser-run-source="${esc(source)}"` : ""}><summary><div class="date-meta"><span class="date-badge">${esc(dateLabel(group.date))}</span><small class="date-time">监测时间<br><b>${esc(timeRange)}</b></small></div><div class="date-run-title"><b>${esc(group.questionSetName || "本次监测")}</b><small>${source === "archive" ? "归档记录，点开后按需读取完整证据" : "查看逐题原始回答与审计记录"}</small></div><div class="date-run-metrics">${browserSummaryCards(group)}</div><span class="date-run-action">查看完整证据 <i>→</i></span></summary><div class="date-run-body"><div class="date-pies">${browserPie("提及情况", [{ label:"优先推荐", value:group.directRecommendationCount, color:"#3974e9" }, { label:"仅提及", value:group.mentionedOnlyCount, color:"#26a879" }, { label:"未提及", value:group.unmentionedCount, color:"#bcc7d8" }])}${browserPie("完成情况", [{ label:"有效完成", value:group.validCompletedCount, color:"#3974e9" }, { label:"无效回答", value:group.invalidCompanyAnswerCount, color:"#f0a13b" }, { label:"未测试", value:group.incompleteCount, color:"#d7deea" }])}</div>${browserSourceSummary(group.sourceSummary)}${evidence ? browserDropDiagnostics(evidence.geoDropDiagnostics) : ""}${evidenceBody}</div></details>`;
}

function archivedHistoryPanel(local, selectedBank) {
  const questionSet = selectedBank?.id || local.config.selectedQuestionSet || "dongguan_local";
  const history = state.archiveHistoryByQuestionSet[questionSet];
  const loading = state.archiveHistoryLoading.has(questionSet);
  if (!history) return `<section class="monitor-section"><div class="monitor-section-title"><div><h3>历史测试记录</h3><p>较早记录已安全归档，以保证系统启动和测试更快。需要时再读取，不影响当前测试。</p></div><button class="secondary" data-load-archive-history="${esc(questionSet)}" ${loading ? "disabled" : ""}>${loading ? "正在读取历史记录…" : "查看历史测试记录"}</button></div><div class="empty compact-empty">点击后可查看这个题库已归档的完整 30 题测试，并可展开查看每题回答和引用。</div></section>`;
  const summaries = history.summaries || [];
  return `<section class="monitor-section"><div class="monitor-section-title"><div><h3>历史测试记录</h3><p>已按需读取 ${history.archiveFileCount || 0} 份归档文件。这里的记录不参与当前页面的启动加载。</p></div><span class="chip">${summaries.length} 次监测</span></div><div class="date-run-stack">${summaries.length ? summaries.slice().reverse().map((group) => browserDateGroup(group, local.prompts, "archive")).join("") : `<div class="empty">“${esc(selectedBank?.name || "当前题库")}”没有可显示的归档测试。</div>`}</div></section>`;
}
function latestAccountAbExperiment() { return state.accountAbExperiments?.[0] || null; }
function accountAbComparisonDialog(experiment) {
  const comparison = experiment?.comparison;
  if (!comparison) return;
  const pct = (value) => value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
  dialog(`<h2>豆包账号 A/B 分析</h2><p class="muted">实验 ${esc(experiment.experimentId)} · A 新账号：${esc(experiment.runAId || "—")} · B 旧账号：${esc(experiment.runBId || "—")}</p><div class="diagnostic-metric-grid"><div><b>提及率</b><strong>${pct(comparison.armA?.mentionRate)} → ${pct(comparison.armB?.mentionRate)}</strong><small>旧账号 - 新账号：${pct(comparison.deltas?.mentionRateDelta)}</small></div><div><b>优先推荐率</b><strong>${pct(comparison.armA?.priorityRate)} → ${pct(comparison.armB?.priorityRate)}</strong><small>旧账号 - 新账号：${pct(comparison.deltas?.priorityRateDelta)}</small></div></div><p>Account Effect：<b>${esc(comparison.effectStrength || "inconclusive")}</b> · 置信度：${esc(comparison.confidence || "low")}</p><p>old_only：${comparison.promptCounts?.oldOnlyQuestionCount || 0} · new_only：${comparison.promptCounts?.newOnlyQuestionCount || 0} · both_visible：${comparison.promptCounts?.bothVisibleQuestionCount || 0} · both_invisible：${comparison.promptCounts?.bothInvisibleQuestionCount || 0}</p><p class="muted">${esc(comparison.conclusion || "")}</p><div class="form-actions"><button value="cancel" class="secondary">关闭</button></div>`, async () => {});
}
function accountAbPanel() {
  return "";
  /* Account A/B controls remain disabled until explicitly reintroduced. */
  const experiment = latestAccountAbExperiment();
  if (!experiment) return `<section class="monitor-section account-ab-panel"><div class="monitor-section-title"><div><h3>豆包账号 A/B 对照测试</h3><p>先使用新账号完成 30 题，再由你人工切换旧账号；系统不会自动切换账号或启动第二个 Profile。</p></div><button class="primary" id="start-account-ab">开始账号 A/B 实验</button></div></section>`;
  const runA = experiment.runA;
  const runB = experiment.runB;
  const statusText = { running_a: "正在测试新账号 A", waiting_for_account_switch: "新账号测试已完成，等待人工切换", preflight_b: "正在检查旧账号环境", running_b: "正在测试旧账号 B", completed: "账号 A/B 测试已完成", aborted: "账号 A/B 测试已终止" }[experiment.status] || experiment.status;
  const progress = experiment.status === "running_b" ? runB : runA;
  const waiting = experiment.status === "waiting_for_account_switch";
  const action = waiting ? `<button class="primary" id="confirm-account-switch" data-experiment-id="${esc(experiment.experimentId)}">我已切换到旧账号</button>` : experiment.status === "completed" ? `<button class="secondary" id="view-account-ab" data-experiment-id="${esc(experiment.experimentId)}">查看账号 A/B 分析</button>` : "";
  return `<section class="monitor-section account-ab-panel"><div class="monitor-section-title"><div><h3>豆包账号 A/B 对照测试</h3><p>${esc(statusText)} · 实验 ${esc(experiment.experimentId)}</p></div><span class="chip ${experiment.status === "completed" ? "green" : experiment.status === "aborted" ? "red" : "amber"}">${esc(experiment.status)}</span></div><div class="account-ab-flow"><span>A 新账号：${esc(experiment.runAId || "—")}</span><span>B 旧账号：${esc(experiment.runBId || "等待切换")}</span><span>间隔：${experiment.timeGapMinutes == null ? "—" : `${experiment.timeGapMinutes} 分钟`}</span>${action}</div>${waiting ? `<div class="account-ab-human-step"><b>请现在在可见豆包 Chromium 中退出新账号并登录旧账号。</b><small>系统不会输入手机号、验证码、Cookie 或 Token。完成后点击上面的确认按钮，系统会逐个检查 4 个 Worker Page，并清理为独立新对话。</small></div>` : ""}${progress ? `<div class="account-ab-progress">当前轮次：${progress.completed || 0} / ${progress.total || 30} · 状态：${esc(progress.status || "")}</div>` : ""}</section>`;
}
async function startAccountAbExperiment() {
  const button = $("#start-account-ab");
  if (button) button.disabled = true;
  try {
    requestVerificationNotificationPermission();
    prepareVerificationAudio();
    const result = await api("/doubao-account-ab/start", { method: "POST", body: "{}" });
    watchMonitorRun(result.run, "账号 A/B 实验已开始：当前为新账号 A，完成后会自动暂停等待你切换账号。");
    await refresh();
  } catch (error) { flash(error.message || "无法开始账号 A/B 实验", true); }
  finally { if (button) button.disabled = false; }
}
async function confirmAccountAbSwitch(experimentId) {
  const button = $("#confirm-account-switch");
  if (button) { button.disabled = true; button.textContent = "正在检查旧账号环境…"; }
  try {
    const result = await api(`/doubao-account-ab/${encodeURIComponent(experimentId)}/confirm-switch`, { method: "POST", body: JSON.stringify({ userConfirmedAccountLabel: "old_account" }) });
    watchMonitorRun(result.run, "旧账号环境检查通过，已开始 B 轮 30 题测试。");
    await refresh();
  } catch (error) { flash(error.message || "旧账号环境检查未通过，A/B 实验仍在等待", true); await refresh(); }
}
function bindAccountAbActions() {
  $("#start-account-ab")?.addEventListener("click", startAccountAbExperiment);
  $("#confirm-account-switch")?.addEventListener("click", (event) => confirmAccountAbSwitch(event.currentTarget.dataset.experimentId));
  $("#view-account-ab")?.addEventListener("click", () => accountAbComparisonDialog(latestAccountAbExperiment()));
}
function localQuestionBankPanel(local) {
  const selectedQuestionSet = local.config.selectedQuestionSet || "dongguan_local";
  const questionBanks = local.config.questionBanks || [];
  const selectedBank = questionBanks.find((bank) => bank.id === selectedQuestionSet) || questionBanks[0] || { name: "原有题库", promptCount: local.prompts.length };
  const selectedRegions = new Set(local.config.selectedRegions || []);
  const counts = local.config.regionPromptCounts || {};
  const activeRun = monitorRunIsActive(currentMonitorRun());
  const regionNames = { chashan: "茶山镇", dongguan: "东莞市", national: "全国" };
  return `<details class="monitor-disclosure question-bank-panel" open><summary>当前题库与地域范围</summary><div class="monitor-settings"><div class="question-bank-picker"><label for="local-question-bank">当前题库</label><select id="local-question-bank" ${activeRun ? "disabled" : ""}>${questionBanks.map((bank) => `<option value="${esc(bank.id)}" ${bank.id === selectedQuestionSet ? "selected" : ""}>${esc(bank.name)}（${bank.promptCount}题）</option>`).join("")}</select><p>${esc(selectedBank.description || "")} · 本次测试 ${selectedBank.promptCount || local.prompts.length} 题</p></div><div class="actions"><button class="secondary" id="save-local-regions">更新问题库</button></div></div><div class="region-update-note">以下三个选项只用于更新原有题库，不限制下拉框所选题库的测试范围。</div><div class="region-options"><label class="region-option"><input type="checkbox" name="local-region" value="dongguan" ${selectedRegions.has("dongguan") ? "checked" : ""}><span>东莞市</span><small>${counts.dongguan || 0} 题</small></label><label class="region-option"><input type="checkbox" name="local-region" value="chashan" ${selectedRegions.has("chashan") ? "checked" : ""}><span>茶山镇</span><small>${counts.chashan || 0} 题</small></label><label class="region-option"><input type="checkbox" name="local-region" value="national" ${selectedRegions.has("national") ? "checked" : ""}><span>全国</span><small>${counts.national || 0} 题</small></label></div><details><summary>查看“${esc(selectedBank.name)}”的当前 ${local.prompts.length} 道题</summary><div class="question-columns">${local.prompts.map((prompt, index) => `<div><span class="chip">Q${index + 1}</span><span><small>${esc(regionNames[prompt.region] || prompt.region || "其他")}</small>${esc(prompt.text)}</span></div>`).join("")}</div></details></details>`;
}

function doubaoRegionalMonitoring() {
  const local = state.dashboard.localMonitoring;
  const browser = state.dashboard.browserMonitoring;
  const summary = browser.overall;
  const selectedBank = (local.config.questionBanks || []).find((bank) => bank.id === local.config.selectedQuestionSet);
  return `${localQuestionBankPanel(local)}<section class="monitor-hero simple-monitor-hero"><div class="monitor-hero-copy"><span class="chip green">豆包网页版客户端实测</span><h2>按日期查看 ${local.prompts.length} 题监测</h2><p>当前题库：${esc(selectedBank?.name || "原有题库")}。每个日期是一轮独立新对话测试。</p></div>${browserSummaryCards(summary)}</section>
   ${accountAbPanel()}
   ${visibilityTrendChart()}
  <section class="monitor-section browser-overall"><div class="monitor-section-title"><div><h3>公司整体可见度</h3><p>最新一次监测：${esc(browser.latestDate || "尚无结果")}。提及即算提及；只有目标品牌处于前 5 个推荐位才算优先推荐。</p></div><span class="chip">有效完成 ${summary.validCompletedCount}/${browser.totalQuestions}</span></div><div class="date-pies">${browserPie("品牌可见情况", [{ label:"优先推荐", value:summary.directRecommendationCount, color:"#3974e9" }, { label:"仅提及", value:summary.mentionedOnlyCount, color:"#26a879" }, { label:"未提及", value:summary.unmentionedCount, color:"#bcc7d8" }])}${browserPie("答复完成情况", [{ label:"有效完成", value:summary.validCompletedCount, color:"#3974e9" }, { label:"无公司名作废", value:summary.invalidCompanyAnswerCount, color:"#f0a13b" }, { label:"未测试", value:summary.incompleteCount, color:"#d7deea" }])}</div></section>
  <section class="monitor-section"><div class="monitor-section-title"><div><h3>按监测批次查看</h3><p>每次完整测试单独显示；同一天多轮测试也会分别保留，并记录使用的题库。</p></div><span class="chip">${browser.dates.length} 次监测</span></div><div class="date-run-stack">${browser.dates.length ? browser.dates.map((group) => browserDateGroup(group, local.prompts)).join("") : `<div class="empty">“${esc(selectedBank?.name || "当前题库")}”尚未保存豆包网页端测试记录。</div>`}</div></section>${archivedHistoryPanel(local, selectedBank)}`;
}

function currentPlatform() {
  return state.platforms.find((platform) => platform.id === state.selectedPlatform) || { id: "doubao_web", displayName: "豆包", implemented: true, supportedModes: ["chat"], defaultMode: "chat" };
}
function platformTabs() {
  return `<section class="platform-selector" aria-label="AI 平台选择"><div><small>监测平台</small><div class="platform-tabs">${state.platforms.map((platform) => `<button type="button" class="platform-tab ${platform.id === state.selectedPlatform ? "active" : ""}" data-platform-tab="${esc(platform.id)}" aria-pressed="${platform.id === state.selectedPlatform}">${esc(platform.displayName)}</button>`).join("")}</div></div></section>`;
}
function noDataMetric(label) { return `<div><b>暂无数据</b><small>${esc(label)}</small></div>`; }
function futurePlatformMonitoring(platform) {
  const mode = state.selectedPlatformMode;
  const browserSmokeEnabled = Boolean(platform.capabilities?.browserSmoke);
  const modes = platform.supportedModes.length > 1 ? `<section class="platform-mode-selector"><small>${esc(platform.displayName)} 测试模式</small><div class="platform-mode-tabs">${platform.supportedModes.map((item) => `<button type="button" class="tiny ${mode === item ? "selected" : ""}" data-platform-mode="${esc(item)}">${item === "web_search" ? "联网搜索" : "普通聊天"}</button>`).join("")}</div></section>` : "";
  const browserText = browserSmokeEnabled ? `${esc(platform.displayName)} 浏览器自动化已接入。选择模式后点击顶部连接检查，会使用独立 Chromium、Profile 与 Worker 页面；不会发送 Prompt。` : `${esc(platform.displayName)} 网页自动化尚未完成接入。完成连接验证后才能开始 30 题实测。`;
  return `${platformTabs()}${modes}<section class="monitor-hero simple-monitor-hero platform-empty-hero"><div class="monitor-hero-copy"><span class="chip ${browserSmokeEnabled ? "green" : "amber"}">${browserSmokeEnabled ? "浏览器接入已启用" : "平台接入中"}</span><h2>当前平台：${esc(platform.displayName)}</h2><p>${browserText}</p></div>${formalRunSummaryCards(null)}</section><section class="monitor-section"><div class="monitor-section-title"><div><h3>${esc(platform.displayName)}浏览器连接检查</h3><p>${browserSmokeEnabled ? "Smoke 会真实检查登录、Persistent Context、4 个 Worker、Composer 与当前模式。" : "当前 Runtime 尚未初始化。"}</p></div><span class="chip ${browserSmokeEnabled ? "green" : "amber"}">${browserSmokeEnabled ? "可检查" : "尚未接入"}</span></div><div class="empty">${browserSmokeEnabled ? `请选择${platformModeLabel(mode)}并点击顶部“${esc(platform.displayName)}浏览器连接检查”。` : `${esc(platform.displayName)} 浏览器 Runtime 尚未初始化，完成平台接入后可查看 Worker 状态、PageId 与 Preview。`}</div></section>${formalPlatformTrendChart(platform, [])}<section class="monitor-section browser-overall"><div class="monitor-section-title"><div><h3>公司整体可见度</h3><p>正式测试完成后会按当前平台独立汇总；现在不显示任何虚构数据。</p></div><span class="chip">暂无完整批次</span></div>${formalRunPiePair(null)}</section><section class="monitor-section"><div class="monitor-section-title"><div><h3>历史测试批次</h3><p>未来完整 30 题正式 Run 会按平台与测试模式自动归档，并显示批次饼图。</p></div></div><div class="empty">暂无历史测试批次</div></section>`;
}
function deepseekFormalMonitoring(platform) {
  const mode = state.selectedPlatformMode;
  const key = `${platform.id}:${mode}`;
  const historyPayload = state.platformHistory[key] || {};
  const summaries = historyPayload.summaries || [];
  const incompleteRuns = historyPayload.incompleteRuns || [];
  const latest = summaries.at(-1) || null;
  const pct = (value) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
  const modeTabs = `<section class="platform-mode-selector"><small>DeepSeek 测试模式</small><div class="platform-mode-tabs">${platform.supportedModes.map((item) => `<button type="button" class="tiny ${mode === item ? "selected" : ""}" data-platform-mode="${esc(item)}">${item === "web_search" ? "联网搜索" : "普通聊天"}</button>`).join("")}</div></section>`;
  const history = summaries.length ? summaries.slice().reverse().map((item) => formalRunBatchCard(item, platform)).join("") : `<div class="empty">尚无 DeepSeek ${mode === "web_search" ? "联网搜索" : "普通聊天"}正式测试。Canary 不会显示在这里。</div>`;
  const incompleteHistory = incompleteRuns.length ? incompleteRuns.map((item) => `<details class="date-run incomplete-run" data-browser-run-id="${esc(item.runId)}"><summary><b>DeepSeek · ${esc(item.platformMode === "web_search" ? "联网搜索" : "普通聊天")}</b><span>${esc(trendDate(item.endedAt || item.startedAt))}</span><span>已中止 · 已保存 ${item.savedAnswers || 0}/${item.totalQuestions || 30}</span></summary><div class="date-run-body"><div class="date-pies">${incompleteRunStatusPie(item)}</div><p>已保存回答 ${item.savedAnswers || 0} · 失败 ${item.failedAnswers || 0} · 未执行（已中止）${item.abortedQuestions || 0}${item.unresolvedQuestions ? ` · 旧记录待归档 ${item.unresolvedQuestions}` : ""}</p><p class="muted">中止原因：${esc(item.stopReason || "未记录")}</p><small>该批次只保留审计状态，不会进入正式趋势与可见度统计。</small></div></details>`).join("") : `<div class="empty">尚无 DeepSeek ${mode === "web_search" ? "联网搜索" : "普通聊天"}中止或未完成记录。</div>`;
  return `${platformTabs()}${modeTabs}<section class="monitor-hero simple-monitor-hero"><div class="monitor-hero-copy"><span class="chip green">DeepSeek 正式网页监测</span><h2>30 题独立新对话测试</h2><p>每题都会在提交前重新确认当前模式；联网搜索模式必须读取到智能搜索 aria-pressed=true。</p></div>${formalRunSummaryCards(latest)}</section><section class="monitor-section"><div class="monitor-section-title"><div><h3>浏览器连接检查</h3><p>选择模式后点击顶部“DeepSeek浏览器连接检查”；不会发送 Prompt。</p></div><span class="chip green">4 Worker</span></div><div class="empty">当前模式：${esc(mode === "web_search" ? "联网搜索" : "普通聊天")}。通过 4/4 Ready 后，可点击顶部“开始 30 题实测”。</div></section>${formalPlatformTrendChart(platform, summaries)}<section class="monitor-section browser-overall"><div class="monitor-section-title"><div><h3>公司整体可见度</h3><p>最新一次完整正式测试：${esc(latest ? trendDate(latest.completedAt || latest.startedAt) : "暂无结果")}。只统计完整 30 题批次。</p></div><span class="chip">有效完成 ${latest ? `${latest.validAnswers || 0}/${latest.totalQuestions || 30}` : "—"}</span></div>${formalRunPiePair(latest)}</section><section class="monitor-section"><div class="monitor-section-title"><div><h3>正式历史批次</h3><p>仅显示完整 30 题、reportable=true 的 DeepSeek 正式 Run；每批次保留独立饼图，用于趋势与可见度统计。</p></div><span class="chip">${summaries.length} 次</span></div><div class="date-run-stack">${history}</div></section><section class="monitor-section"><div class="monitor-section-title"><div><h3>中止 / 未完成记录</h3><p>保留每次已保存回答与中止原因，仅供审计，不计入正式趋势与可见度统计。</p></div><span class="chip amber">${incompleteRuns.length} 次</span></div><div class="date-run-stack">${incompleteHistory}</div></section>`;
}
function regionalMonitoring() {
  const platform = currentPlatform();
  if (!platform.capabilities?.monitorRun) return futurePlatformMonitoring(platform);
  return platform.id === "deepseek_web" ? deepseekFormalMonitoring(platform) : `${platformTabs()}${doubaoRegionalMonitoring()}`;
}
async function selectMonitoringPlatform(platformId) {
  const platform = state.platforms.find((item) => item.id === platformId);
  if (!platform) return;
  state.selectedPlatform = platform.id;
  state.selectedPlatformMode = state.platformModes[platform.id] || platform.defaultMode;
  state.platformBrowserState[platform.id] ||= platform.capabilities?.browserSmoke ? {} : { status: "not_initialized" };
  try {
    const key = `${platform.id}:${state.selectedPlatformMode}`;
    state.platformHistory[key] = await api(`/browser-monitor-runs/history?platform=${encodeURIComponent(platform.id)}&platformMode=${encodeURIComponent(state.selectedPlatformMode)}`);
  } catch (error) {
    if (!platform.capabilities?.monitorRun) {
      recordPlatformTechnicalError(platform, error);
    } else {
      flash(`无法读取${platform.displayName}正式历史：${error.message}`, true);
    }
  }
  try {
    const active = await api(`/browser-monitor-runs/active?platform=${encodeURIComponent(platform.id)}&platformMode=${encodeURIComponent(state.selectedPlatformMode)}`);
    if (active.run) {
      state.platformRunState[platform.id] = active.run;
      state.monitorRun = active.run;
      state.monitorRunId = active.run.runId;
      if (monitorRunIsActive(active.run)) {
        startMonitorLiveClock();
        startMonitorProgressStream(active.run.runId);
        void pollMonitorRun(active.run.runId);
      }
    } else {
      const latestTerminalRun = active.latestTerminalRun;
      state.monitorRun = latestTerminalRun?.failed ? latestTerminalRun : null;
      state.monitorRunId = null;
      renderMonitorRunProgress();
    }
  } catch (error) { recordPlatformTechnicalError(platform, error); }
  render();
}
function recordPlatformTechnicalError(platform, error) {
  state.platformTechnicalErrors.unshift({ platform: platform.id, platformMode: state.selectedPlatformMode, errorCode: error.error || error.code || "PLATFORM_ERROR", message: error.message || "平台请求失败", timestamp: new Date().toISOString() });
  state.platformTechnicalErrors.splice(12);
  console.warn("平台自动化请求失败", state.platformTechnicalErrors[0]);
}
function bindPlatformMonitoringActions() {
  document.querySelectorAll("[data-platform-tab]").forEach((button) => button.addEventListener("click", () => void selectMonitoringPlatform(button.dataset.platformTab)));
  document.querySelectorAll("[data-platform-mode]").forEach((button) => button.addEventListener("click", () => {
    state.selectedPlatformMode = button.dataset.platformMode;
    state.platformModes[state.selectedPlatform] = button.dataset.platformMode;
    void selectMonitoringPlatform(state.selectedPlatform);
  }));
}
function syncMonitoringHeader() {
  $(".header-actions")?.classList.toggle("hidden", ["competitors", "publisher"].includes(state.view));
  if (state.view === "publisher") $("#doubao-monitor-progress")?.classList.add("hidden");
  const controls = [$("#doubao-browser-smoke"), $("#full-doubao-monitor"), $("#probe-button")];
  const stopButton = $("#stop-browser-monitor");
  if (state.view !== "monitoring") {
    controls.forEach((button) => { if (button) button.disabled = false; });
    stopButton?.classList.add("hidden");
    return;
  }
  const platform = currentPlatform();
  const activeRun = currentMonitorRun();
  const hasActiveRun = monitorRunIsActive(activeRun);
  const runBlocksNewStart = hasActiveRun && activeRun.status !== "paused";
  const prefix = platform.displayName;
  const questionCount = state.dashboard?.localMonitoring?.prompts?.length || 30;
  $(".header-actions .badge")?.remove();
  $("#doubao-browser-smoke").textContent = `${prefix}浏览器连接检查`;
  $("#full-doubao-monitor").textContent = activeRun?.status === "paused" ? `继续 ${questionCount} 题实测` : hasActiveRun ? "当前任务运行中" : `开始 ${questionCount} 题实测`;
  $("#probe-button").textContent = platform.capabilities?.monitorRun ? "补测作废回答" : "请先完成单题验证";
  $("#full-doubao-monitor").disabled = !platform.capabilities?.monitorRun || runBlocksNewStart;
  $("#probe-button").disabled = !platform.capabilities?.monitorRun || platform.id !== "doubao_web";
  if (stopButton) {
    stopButton.classList.remove("hidden");
    stopButton.disabled = !hasActiveRun;
    stopButton.textContent = hasActiveRun ? "停止当前测试" : "暂无可停止任务";
    stopButton.title = hasActiveRun ? `停止当前${prefix}网页测试；不会关闭浏览器或清除登录状态。` : `当前${prefix}没有正在运行的网页测试任务。`;
  }
}

const overview = overviewV2;
const views = { overview, monitoring: regionalMonitoring, competitors: competitorsView, publisher: publisherView, knowledge, content, rules, publishing, settings };
function restoreOpenedBrowserEvidence(runId, source = "current") {
  const item = [...document.querySelectorAll("[data-browser-run-id]")].find((node) => node.dataset.browserRunId === runId && (node.dataset.browserRunSource || "current") === source);
  if (item) item.open = true;
}
async function loadBrowserEvidence(runId, source = "current") {
  const evidenceKey = `${source}:${runId}`;
  if (!runId || state.browserEvidenceByRunId[evidenceKey] || state.browserEvidenceLoading.has(evidenceKey)) return;
  state.browserEvidenceLoading.add(evidenceKey);
  try {
    const sourceParam = source === "archive" ? "&source=archive" : "";
    const questionSetParam = source === "archive" ? `&questionSet=${encodeURIComponent(state.dashboard?.localMonitoring?.config?.selectedQuestionSet || "dongguan_local")}` : "";
    state.browserEvidenceByRunId[evidenceKey] = await api(`/browser-monitor-runs/${encodeURIComponent(runId)}/evidence?platform=${encodeURIComponent(state.selectedPlatform)}&platformMode=${encodeURIComponent(state.selectedPlatformMode)}${sourceParam}${questionSetParam}`);
    render();
    restoreOpenedBrowserEvidence(runId, source);
  } catch (error) {
    flash(`无法加载本批次原始回答：${error.message}`, true);
  } finally {
    state.browserEvidenceLoading.delete(evidenceKey);
  }
}
function bindBrowserEvidenceInteractions() {
  document.querySelectorAll("[data-browser-run-id]").forEach((item) => item.addEventListener("toggle", () => {
    if (item.open) void loadBrowserEvidence(item.dataset.browserRunId, item.dataset.browserRunSource || "current");
  }));
}
function render() { $("#page-title").textContent = ({overview:"品牌可见性概览", monitoring:"AI 可见性监测", competitors:"同行可见度对比", publisher:"发布", knowledge:"审批资料库", content:"选题与文章", rules:"平台规则", publishing:"发布日历", settings:"系统设置"})[state.view]; $("#view").innerHTML = views[state.view](); syncMonitoringHeader(); bindPlatformMonitoringActions(); bindVisibilityTrendInteractions(); bindBrowserEvidenceInteractions(); bindViewActions(); bindBrandSettings(); bindAccountAbActions(); if (state.view === "competitors") mountCompetitors(); if (state.view === "publisher") mountPublisher(); }
function dialog(html, onSubmit) { $("#dialog-content").innerHTML = html; const form=$("#dialog-form"); form.onsubmit=async(event)=>{event.preventDefault(); try{await onSubmit(new FormData(form)); $("#dialog").close(); await refresh();}catch(error){flash(error.message,true)}}; $("#dialog").showModal(); }
async function refresh() { await load(); render(); }
function bindBrandSettings() {
  const form = $("#brand-settings-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/brands", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      flash("监测对象已保存，之后的结果会按新名称计算。");
      await refresh();
    } catch (error) {
      flash(error.message, true);
    }
  });
}
function diagnosticPercent(value) { return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—"; }
function diagnosticDelta(item) {
  if (!item || typeof item.absoluteDelta !== "number") return "—";
  const absolute = `${item.absoluteDelta >= 0 ? "+" : ""}${(item.absoluteDelta * 100).toFixed(1)} 个百分点`;
  const relative = typeof item.relativeDelta === "number" ? `；${item.relativeDelta >= 0 ? "+" : ""}${(item.relativeDelta * 100).toFixed(1)}%` : "";
  return `${absolute}${relative}`;
}
function trendDiagnosticPanel(summary, diagnostics) {
  if (!diagnostics) return `<div class="trend-diagnostic-panel"><h2>GEO 下降诊断</h2><p class="muted">该 Run 没有可用的下降诊断数据。只有完整可比 Run 才会生成诊断。</p></div>`;
  const comparison = diagnostics.comparison || {};
  const quality = diagnostics.dataQuality || {};
  const mention = comparison.mentionRate || {};
  const priority = comparison.priorityRate || {};
  const qualityCitation = quality.citationCapture || {};
  const citationSuccess = qualityCitation.success || 0;
  const total = summary.totalQuestions || quality.promptConsistency?.totalQuestions || 0;
  const lost = diagnostics.promptMatrix?.lostVisibilityPrompts || [];
  const retainedScenes = (diagnostics.sceneClusters || []).filter((scene) => Number(scene.currentMentionRate) > 0 && !scene.lostVisibilityCount).slice(0, 8);
  const replacements = diagnostics.competitorChanges?.replacingCompetitors || [];
  const citation = diagnostics.citationChanges || {};
  const sourceNames = (list) => (list || []).filter(Boolean).slice(0, 10).map((value) => `<span>${esc(String(value))}</span>`).join("") || `<span class="muted">暂无</span>`;
  const promptText = (id) => state.prompts.find((prompt) => prompt.id === id)?.text || id;
  const opportunities = diagnostics.opportunities || [];
  const opportunitySection = ["P0", "P1", "P2"].map((level) => {
    const items = opportunities.filter((item) => item.priority === level);
    if (!items.length) return "";
    return `<div class="trend-opportunity-group"><h4>${level}</h4>${items.slice(0, 12).map((item) => `<article><b>${esc(item.prompt || item.promptId)}</b><small>历史：${esc(item.historicalPerformance)} · 当前：${esc(item.currentPerformance)} · 诊断：${esc(item.diagnosisType)} · ${esc(item.confidence || "low")}</small><span>替代企业：${esc((item.currentCompetitors || []).join("、") || "未观察到")}；主要来源：${esc((item.currentSources || []).join("、") || "未观察到")}</span><p>${esc(item.suggestedAction || "继续观察并复测")}</p></article>`).join("")}</div>`;
  }).join("") || `<p class="muted">当前没有满足 P0/P1/P2 条件的机会项。</p>`;
  const conclusion = diagnostics.conclusion || { summary: "当前数据不足以确认主要下降阶段", evidence: [] };
  return `<div class="trend-diagnostic-panel"><div class="trend-diagnostic-title"><div><h2>GEO 下降诊断</h2><p>${esc(trendDate(summary.completedAt || summary.startedAt))} · ${esc(summary.runId || "当前 Run")}</p></div><span class="chip ${diagnostics.triggered ? "amber" : "green"}">${diagnostics.triggered ? "⚠ 可见度显著下降" : "未触发下降阈值"}</span></div><section><h3>1. 总体变化</h3><div class="diagnostic-metric-grid"><div><b>品牌提及率</b><strong>${diagnosticPercent(mention.current)}</strong><small>历史基准 ${diagnosticPercent(mention.baseline)} · ${esc(diagnosticDelta(mention))}</small></div><div><b>优先推荐率</b><strong>${diagnosticPercent(priority.current)}</strong><small>历史基准 ${diagnosticPercent(priority.baseline)} · ${esc(diagnosticDelta(priority))}</small></div></div></section><section><h3>2. 数据可信度</h3><div class="diagnostic-facts"><span>完整回答：${quality.completeAnswers || 0}/${total}</span><span>Prompt 一致：${quality.promptConsistency?.consistent ? "正常" : `${quality.promptConsistency?.uniquePromptIds || 0}/${total}`}</span><span>会话隔离：${quality.conversationIsolation?.isolated ? "正常" : "需检查"}</span><span>Worker 异常：${(diagnostics.workerConsistency || []).some((worker) => worker.failed || worker.retries) ? "发现失败/重试" : "未发现"}</span><span>Citation 采集：${citationSuccess}/${total} 成功</span></div></section><section><h3>3. 消失最严重的 Prompt</h3>${lost.length ? `<ol class="diagnostic-prompt-list">${lost.slice(0, 10).map((item) => `<li><b>${esc(item.questionText || item.promptId)}</b><span>${item.baselineVisibleRuns || 0}/${item.baselineSampleSize || 0} 次出现 → ${item.currentVisibleRuns || 0}/${item.currentSampleSize || 0}</span></li>`).join("")}</ol>` : `<p class="muted">没有发现满足阈值的高频消失 Prompt。</p>`}</section><section><h3>4. 仍然保留的场景</h3><div class="diagnostic-tags">${retainedScenes.map((scene) => `<span>${esc(scene.scene)} · 当前 ${diagnosticPercent(scene.currentMentionRate)}</span>`).join("") || `<span class="muted">暂无稳定保留场景</span>`}</div></section><section><h3>5. 当前主要替代企业</h3>${replacements.length ? `<div class="diagnostic-table">${replacements.slice(0, 10).map((item) => `<div><b>${esc(item.company)}</b><span>当前 ${item.current.mentionCount || 0} · 历史 ${item.baseline.mentionCount || 0} · 变化 ${item.mentionDelta >= 0 ? "+" : ""}${item.mentionDelta}</span><small>主要 Prompt：${esc((item.current.promptIds || []).map(promptText).slice(0, 3).join("；") || "未记录")}</small></div>`).join("")}</div>` : `<p class="muted">没有观察到明显增加的替代企业。</p>`}</section><section><h3>6. Citation / 信源变化</h3><div class="diagnostic-source-grid"><div><b>历史主要来源</b>${sourceNames(citation.baseline?.topDomains)}</div><div><b>当前主要来源</b>${sourceNames(citation.current?.topDomains?.map((item) => item.domain))}</div><div><b>新增来源</b>${sourceNames(citation.sourceAdded)}</div><div><b>消失来源</b>${sourceNames(citation.sourceRemoved)}</div></div><p class="muted">品牌相关来源覆盖：历史 ${diagnosticPercent(citation.brandRelatedSourceCoverage?.baseline)} → 当前 ${diagnosticPercent(citation.brandRelatedSourceCoverage?.current)}；竞争企业相关来源覆盖：历史 ${diagnosticPercent(citation.competitorRelatedSourceCoverage?.baseline)} → 当前 ${diagnosticPercent(citation.competitorRelatedSourceCoverage?.current)}；竞争企业相关新增来源域名：${esc((citation.competitorSourceGained || []).join("、") || "暂无")}</p></section><section><h3>7. 诊断结论</h3><div class="diagnostic-conclusion"><b>${esc(conclusion.summary)}</b><small>诊断类型：${esc(conclusion.diagnosisType || "unknown")} · 置信度：${esc(conclusion.confidence || "low")}</small><ul>${(conclusion.evidence || []).map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div></section><section><h3>8. GEO 机会清单</h3>${opportunitySection}</section></div>`;
}
function appendObservabilityQualityPanel(diagnostics) {
  const observability = diagnostics?.observability;
  if (!observability) return;
  const readiness = observability.diagnosticReadiness || "low";
  const readinessLabel = { high: "高", medium: "中", low: "低" }[readiness] || readiness;
  const panel = document.createElement("section");
  panel.className = "diagnostic-observability-panel";
  panel.innerHTML = `<h3>可观测性质量</h3><div class="diagnostic-facts"><span>GEO 数值数据：${observability.geoResultTrustworthy ? "完整，可单独信任" : "不完整，需谨慎解释"}</span><span>根因诊断准备度：${readinessLabel}</span><span>完整回答：${observability.answersCaptured || 0}/${observability.totalQuestions || 0}</span><span>Citation 覆盖：${observability.citationsCapturedQuestions || 0}/${observability.totalQuestions || 0}</span><span>会话审计：${observability.conversationAuditCoverage || 0}/${observability.totalQuestions || 0}</span><span>Worker 审计：${observability.workerAuditCoverage || 0}/${observability.totalQuestions || 0}</span></div><p class="muted">${esc(observability.readinessReason || "")}</p>`;
  const anchor = document.querySelector("#dialog-content section:nth-of-type(2)");
  if (anchor) anchor.insertAdjacentElement("afterend", panel);
  else document.querySelector("#dialog-content")?.prepend(panel);
}
function appendCitationCompatibilityPanel(diagnostics) {
  const citation = diagnostics?.citationChanges;
  if (!citation || citation.available !== false) return;
  const panel = document.createElement("div");
  panel.className = "citation-history-warning";
  panel.textContent = citation.reason || "历史批次未采集结构化引用来源，无法进行信源变化比较。";
  document.querySelector("#dialog-content")?.append(panel);
}
async function openTrendDiagnostic(summary) {
  let diagnostics = summary?.geoDropDiagnostics || null;
  if (summary?.runId) {
    try { diagnostics = await api(`/browser-monitor-runs/${encodeURIComponent(summary.runId)}/diagnostics`); } catch (error) { flash(`无法加载 GEO 下降诊断：${error.message}`, true); }
  }
  $("#dialog-content").innerHTML = trendDiagnosticPanel(summary, diagnostics);
  appendObservabilityQualityPanel(diagnostics);
  appendCitationCompatibilityPanel(diagnostics);
  $("#dialog-form").onsubmit = null;
  $("#dialog").showModal();
}
function bindVisibilityTrendInteractions() {
  const card = $("#visibility-trend-card");
  if (!card) return;
  const plot = card.querySelector(".visibility-trend-plot");
  const tooltip = card.querySelector(".visibility-trend-tooltip");
  const showTooltip = (target) => {
    const summary = visibleTrendSummaries()[Number(target.dataset.trendPoint)];
    if (!summary || !plot || !tooltip) return;
    tooltip.innerHTML = visibilityTrendTooltip(summary);
    const plotBox = plot.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(plotBox.width - 238, targetBox.left - plotBox.left - 104))}px`;
    tooltip.style.top = `${Math.max(8, targetBox.top - plotBox.top - 126)}px`;
    tooltip.classList.add("visible");
  };
  const hideTooltip = () => tooltip?.classList.remove("visible");
  card.querySelectorAll("[data-trend-point]").forEach((point) => {
    point.addEventListener("pointerenter", () => showTooltip(point));
    point.addEventListener("pointerleave", hideTooltip);
    point.addEventListener("focus", () => showTooltip(point));
    point.addEventListener("blur", hideTooltip);
    point.addEventListener("click", () => { const summary = visibleTrendSummaries()[Number(point.dataset.trendPoint)]; if (summary) void openTrendDiagnostic(summary); });
    point.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); const summary = visibleTrendSummaries()[Number(point.dataset.trendPoint)]; if (summary) void openTrendDiagnostic(summary); } });
  });
  card.querySelectorAll("[data-trend-diagnostic]").forEach((marker) => {
    const open = () => { const summary = visibleTrendSummaries()[Number(marker.dataset.trendDiagnostic)]; if (summary) void openTrendDiagnostic(summary); };
    marker.addEventListener("click", open);
    marker.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  card.querySelectorAll("[data-trend-range]").forEach((button) => button.addEventListener("click", () => {
    state.trendRange = button.dataset.trendRange;
    render();
  }));
}
function bindViewActions() { document.querySelectorAll("[data-view-link]").forEach(b=>b.onclick=()=>{state.view=b.dataset.viewLink; render();}); $("#configure-doubao")?.addEventListener("click",()=>dialog(`<h2>填写豆包 API Key</h2><p class="muted">粘贴火山方舟创建的 API Key。保存后不会再次显示，且仅加密保存在本机 Windows 用户下。</p><div class="form-grid"><label>API Key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" required></label></div><div class="form-actions"><button class="primary">加密保存到本机</button></div>`, async fd=>api("/settings/providers/doubao",{method:"POST",body:JSON.stringify({apiKey:fd.get("apiKey")})}))); $("#run-monitoring")?.addEventListener("click",runProbe); $("#add-prompt")?.addEventListener("click",()=>dialog(`<h2>新增监测问题</h2><div class="form-grid"><label>问题<input name="text" required placeholder="例如：某品类推荐哪家？"></label><label>意图<select name="intent"><option>品类推荐</option><option>解决方案</option><option>对比决策</option><option>购买转化</option></select></label><label>业务权重（1-5）<input type="number" name="weight" value="3" min="1" max="5"></label></div><div class="form-actions"><button class="primary">保存</button></div>`, async fd=>api("/prompts",{method:"POST",body:JSON.stringify(Object.fromEntries(fd))}))); $("#add-knowledge")?.addEventListener("click",()=>dialog(`<h2>新增审批资料</h2><div class="form-grid"><label>标题<input name="title" required></label><label>资料类型<select name="type"><option>产品资料</option><option>案例</option><option>资质</option><option>价格规则</option></select></label><label>已核验事实（每行一条）<textarea name="facts" required></textarea></label><label>来源链接<input name="sourceUrl" type="url"></label><label>状态<select name="status"><option value="pending">待审批</option><option value="approved">直接审批</option></select></label></div><div class="form-actions"><button class="primary">保存资料</button></div>`, async fd=>{const x=Object.fromEntries(fd); x.facts=x.facts.split("\n").map(s=>s.trim()).filter(Boolean); return api("/knowledge",{method:"POST",body:JSON.stringify(x)})})); document.querySelectorAll("[data-approve]").forEach(b=>b.onclick=async()=>{await api("/knowledge/approve",{method:"POST",body:JSON.stringify({id:b.dataset.approve})});flash("资料已审批，可用于写作。");await refresh();}); document.querySelectorAll("[data-generate]").forEach(b=>b.onclick=async()=>{const data=await api(`/topics/${b.dataset.generate}/generate`,{method:"POST",body:JSON.stringify({platform:b.dataset.platform,writer:b.dataset.writer})});flash(data.message||"已创建 Codex / WorkBuddy 任务。");await refresh();}); document.querySelectorAll("[data-review]").forEach(b=>b.onclick=async()=>{await api(`/articles/${b.dataset.review}/review`,{method:"POST",body:"{}"});flash("已提交 Codex 审核队列。请在 Codex 中执行任务。 ");await refresh();}); document.querySelectorAll("[data-copy-task]").forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(`请在项目目录中执行 GEO Codex 队列，先运行：node scripts/codex-task.mjs show ${b.dataset.copyTask}`);flash("已复制 Codex 执行指令。");}); document.querySelectorAll("[data-preview]").forEach(b=>{const a=state.articles.find(x=>x.id===b.dataset.preview);b.onclick=()=>dialog(`<h2>${esc(a.title)}</h2><p class="muted">${esc(a.summary)}</p><pre class="article">${esc(a.body)}</pre><div class="form-actions"><button value="cancel" class="secondary">关闭</button></div>`,async()=>{});}); document.querySelectorAll("[data-schedule]").forEach(b=>b.onclick=()=>dialog(`<h2>安排定时发布</h2><div class="form-grid"><label>发布时间<input name="scheduledAt" type="datetime-local" required value="${new Date(Date.now()+3600000).toISOString().slice(0,16)}"></label></div><div class="form-actions"><button class="primary">进入排期</button></div>`,async fd=>api(`/articles/${b.dataset.schedule}/schedule`,{method:"POST",body:JSON.stringify(Object.fromEntries(fd))}))); document.querySelectorAll("[data-publish]").forEach(b=>b.onclick=async()=>{await api(`/publications/${b.dataset.publish}/execute`,{method:"POST",body:JSON.stringify({})});flash("已保存发布回执，并可进入下轮复测。");await refresh();}); document.querySelectorAll("[data-pause]").forEach(b=>b.onclick=async()=>{await api(`/publications/${b.dataset.pause}/execute`,{method:"POST",body:JSON.stringify({attentionRequired:"平台要求验证码或重新登录"})});flash("任务已暂停，未尝试绕过平台验证。",true);await refresh();}); }
function hasConfiguredTarget() { return Boolean(state.brands?.[0]?.name?.trim()); }
function requireConfiguredTarget() { if (hasConfiguredTarget()) return true; state.view = "settings"; render(); flash("请先在系统设置中填写要监测的名称。", true); return false; }
async function runProbe(){ if (!requireConfiguredTarget()) return; try{const result=await api("/probes/run",{method:"POST",body:"{}"});flash(`已保存 ${result.runs.length} 条监测证据。`);await refresh();}catch(error){flash(error.message,true)} }
async function runDoubaoMonitor(mode = "replace_invalid_answer", triggerButton = null){
  if (!requireConfiguredTarget()) return;
  const platform = currentPlatform();
  if (!platform.capabilities?.monitorRun) {
    const error = { error: "PLATFORM_NOT_IMPLEMENTED", message: `${platform.displayName} 网页自动化尚未完成接入。` };
    recordPlatformTechnicalError(platform, error);
    flash(error.message, true);
    return;
  }
  requestVerificationNotificationPermission();
  prepareVerificationAudio();
  const button = triggerButton || (mode === "full_daily" ? $("#full-doubao-monitor") : $("#probe-button"));
  const originalLabel = button?.textContent || "";
  if (!button) { flash("未找到正式测试启动控件，请刷新页面后重试。", true); return; }
  button.disabled = true;
  const local = state.dashboard?.localMonitoring;
  const questionCount = local?.prompts?.length || 30;
  button.textContent = mode === "full_daily" ? `正在创建 ${questionCount} 题任务…` : "正在启动补测…";
  try {
    const existingPlatformRun = state.platformRunState[platform.id] || null;
    if (["queued", "preparing_browser", "waiting_for_login", "running", "needs_human_action"].includes(existingPlatformRun?.status)) {
      watchMonitorRun(existingPlatformRun, `当前${platform.displayName}任务仍在运行；可点击“停止${platform.displayName}测试”结束本轮。`);
      return;
    }
    if (existingPlatformRun?.status === "paused") {
      const run = await api(`/browser-monitor-runs/${existingPlatformRun.runId}/resume`, { method: "POST", body: "{}" });
      watchMonitorRun(run, "已继续网页端监测任务。");
      return;
    }
    const payload = { platform: platform.id, platformMode: state.selectedPlatformMode, questionSet: local?.config?.selectedQuestionSet || "dongguan_local" };
    if (mode === "full_daily") payload.mode = mode;
    if (mode === "retry_failed_questions") {
      payload.mode = mode;
      payload.sourceRunId = state.monitorRun?.runId || null;
    }
    const run = await api("/browser-monitor-runs", { method: "POST", body: JSON.stringify(payload) });
    watchMonitorRun(run, mode === "full_daily" ? `已使用“${local?.config?.questionBanks?.find((bank) => bank.id === payload.questionSet)?.name || "当前题库"}”创建 ${run.total || questionCount} 题${platform.displayName}网页端实测任务。` : mode === "retry_failed_questions" ? `已创建 ${run.total || 0} 道失败题补测任务。` : "已创建作废回答补测任务。");
  } catch (error) {
    if (error.status === 409 && error.existingRunId) {
      watchMonitorRun({ runId: error.existingRunId, status: "running", total: 0, completed: 0, success: 0, failed: 0, questions: [] }, "检测到已有网页端监测任务，正在恢复进度。");
    } else if (["NO_INVALID_BROWSER_ANSWER_TO_REPLACE", "NO_FAILED_BROWSER_QUESTION_TO_RETRY"].includes(error.error)) {
      delete state.platformRunState[platform.id]; state.monitorRun = null;
      renderMonitorRunProgress();
      flash(error.message || "当前一轮没有可补测题目。");
    } else {
      delete state.platformRunState[platform.id]; state.monitorRun = null;
      renderMonitorRunProgress();
      flash("无法创建网页端监测任务，请稍后重试。", true);
    }
  } finally {
    // A successful run is then controlled by the real-time progress panel;
    // otherwise return the exact button the operator clicked to its prior
    // readable state instead of silently leaving a different control changed.
    if (!monitorRunIsActive(state.platformRunState[platform.id])) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}
async function runDoubaoApiProbe(){ try{const result=await api("/probes/doubao/run",{method:"POST",body:"{}"});flash(`豆包 API 已保存 ${result.runs.length} 条真实回答。`);await refresh();}catch(error){flash(error.message,true)} }
$("#nav").addEventListener("click", event=>{const button=event.target.closest("[data-view]");if(!button)return;state.view=button.dataset.view;document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active",n===button));render();}); $("#probe-button").addEventListener("click",event=>{ const run=currentMonitorRun(); const mode=Number(run?.failed || 0)>0 || Number(run?.invalid || 0)>0 ? "retry_failed_questions" : "replace_invalid_answer"; runDoubaoMonitor(mode, event.currentTarget); }); $("#full-doubao-monitor").addEventListener("click",event=>runDoubaoMonitor("full_daily", event.currentTarget));

async function stopCurrentBrowserMonitor(button) {
  const run = currentMonitorRun();
  if (!monitorRunIsActive(run) || !run?.runId) { flash("当前没有可停止的网页端测试任务。", true); return; }
  const platformName = monitorPlatformName(run);
  button.disabled = true;
  button.textContent = "正在停止…";
  try {
    const stopped = await api(`/browser-monitor-runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST", body: JSON.stringify({ reason: "operator_one_click_stop" }) });
    state.platformRunState[monitorPlatformId(stopped)] = stopped;
    state.monitorRun = stopped;
    state.monitorRunId = stopped.runId;
    stopMonitorPolling();
    stopMonitorProgressStream();
    stopMonitorLiveClock();
    renderMonitorRunProgress();
    syncMonitoringHeader();
    flash(`${platformName}本轮测试已停止；不会再提交新的题目。`);
  } catch (error) {
    flash(`停止${platformName}测试失败：${error.message}`, true);
  } finally {
    if (monitorRunIsActive(currentMonitorRun())) { button.disabled = false; button.textContent = `停止${platformName}测试`; }
  }
}
$("#stop-browser-monitor").addEventListener("click", event => void stopCurrentBrowserMonitor(event.currentTarget));
document.addEventListener("click", event => {
  const button = event.target.closest("[data-stop-browser-monitor]");
  if (button) void stopCurrentBrowserMonitor(button);
});

async function runBrowserSmokeCheck(button) {
  const platform = currentPlatform();
  const platformMode = state.selectedPlatformMode;
  const browserState = state.platformBrowserState[platform.id] || state.browserSmoke;
  if (browserState.phase === "preparing") return;
  state.browserSmoke = transitionBrowserSmoke(state.browserSmoke, { type: "START" });
  state.platformBrowserState[platform.id] = state.browserSmoke;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "正在检查…";
  let run = null;
  try { run = (await api(`/browser-monitor-runs/active?platform=${encodeURIComponent(platform.id)}&platformMode=${encodeURIComponent(platformMode)}`)).run; } catch {}
  run ||= state.platformRunState[platform.id] || null;
  if (platform.capabilities?.browserSmoke) showBrowserWorkspace({ status: "checking", topology: state.browserTopology, runtime: state.runtime }, run);
  try {
    // Deliberately await the authoritative server operation. There is no
    // client-side Promise.race that can discard a still-running Smoke result.
    const result = await api(`/platforms/${encodeURIComponent(platform.id)}/browser/smoke`, { method: "POST", body: JSON.stringify({ platformMode }) });
    state.browserSmoke = transitionBrowserSmoke(state.browserSmoke, { type: "RESULT", result });
    state.platformBrowserState[platform.id] = state.browserSmoke;
    state.browserTopology = result.browserTopology || state.browserTopology;
    if (platform.capabilities?.browserSmoke) showBrowserWorkspace(result, run);
    if (result.status === "ready") flash(`${platform.displayName}浏览器已准备：1 个 Persistent Context，${result.workerCount || 4}/4 Worker 页面；未发送题目。`);
    else if (result.status === "waiting_for_login") flash(`浏览器和 4 个 Worker 页面均已准备；请在可见${platform.displayName}窗口中人工登录后再次检查。`, true);
    else if (result.status === "verification_required") flash(`浏览器和 4 个 Worker 页面均已准备，但${platform.displayName}需要人工处理。`, true);
    else flash("浏览器页面已准备，但登录状态仍待确认；未发送题目。", true);
  } catch (error) {
    state.browserSmoke = transitionBrowserSmoke(state.browserSmoke, { type: "FAIL", error: error.message });
    state.platformBrowserState[platform.id] = state.browserSmoke;
    recordPlatformTechnicalError(platform, error);
    if (error.error === "PLATFORM_NOT_IMPLEMENTED") flash(`${platform.displayName} 网页自动化尚未完成接入。`, true);
    else flash(`${platform.displayName} 浏览器连接检查失败：${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

$("#doubao-browser-smoke").addEventListener("click", event => runBrowserSmokeCheck(event.currentTarget));
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-browser-workspace-focus]");
  if (!button) return;
  button.disabled = true;
  try {
    const platform = currentPlatform();
    const result = await api(`/platforms/${encodeURIComponent(platform.id)}/browser/workers/${encodeURIComponent(button.dataset.workerId)}/focus`, { method: "POST", body: "{}" });
    if (!result.focused) flash(`当前 Worker 没有可显示的${platform.displayName}页面。`, true);
  } catch (error) { flash(`无法切换到${currentPlatform().displayName}页面：${error.message}`, true); }
  finally { button.disabled = false; }
});
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-browser-worker-focus]");
  if (!button) return;
  button.disabled = true;
  try {
    const platform = currentPlatform();
    const result = await api(`/platforms/${encodeURIComponent(platform.id)}/browser/workers/${encodeURIComponent(button.dataset.workerId)}/focus`, { method: "POST", body: "{}" });
    if (result.focused) flash(`已切换到 Worker ${result.pageIndex} 的真实${platform.displayName}页面。`);
    else flash(`当前 Worker 没有可显示的${platform.displayName}页面。`, true);
  } catch (error) { flash(`无法切换到页面：${error.message}`, true); }
  finally { button.disabled = false; }
});
 document.addEventListener("click", async event => {
  const button = event.target.closest("[data-verification-focus]");
  if (!button) return;
 const verificationEventId = button.dataset.verificationEventId;
  state.view = "monitoring";
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === "monitoring"));
  render();
  requestAnimationFrame(() => $("#doubao-monitor-progress")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  const run = currentMonitorRun();
  if (monitorPlatformId(run) !== "doubao_web") {
    flash(`请直接在对应的${monitorPlatformName(run)}页面完成人工处理；系统不会切换到豆包页面。`, true);
    return;
  }
  if (!state.monitorRunId || !verificationEventId) return;
  try {
    const result = await api(`/browser-monitor-runs/${encodeURIComponent(state.monitorRunId)}/verification/${encodeURIComponent(verificationEventId)}/focus`, { method: "POST", body: "{}" });
    if (result.focused) flash(`已切换到 Worker ${result.pageIndex} 的豆包页面，请完成人工验证。`);
    else flash(result.message || "该人工验证事件已失效，当前没有对应的豆包测试页面。", true);
  } catch (error) {
    // Page selection is a convenience only; the persistent alert already
    // contains an exact Worker/Page/Q reference for manual handling.
    flash(`无法定位人工验证页面：${error.message || "事件已失效"}`, true);
  }
});
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-worker-focus]");
  const run = currentMonitorRun();
  if (!button || !run?.runId) return;
  const workerId = button.dataset.workerId;
  if (!workerId) return;
  button.disabled = true;
  try {
    const platform = monitorPlatformId(run);
    const platformName = monitorPlatformName(run);
    const result = await api(`/platforms/${encodeURIComponent(platform)}/browser/workers/${encodeURIComponent(workerId)}/focus`, { method: "POST", body: "{}" });
    if (result.focused) {
      const page = result.pageIndex || workerId;
      const previewUrl = `/api/platforms/${encodeURIComponent(platform)}/browser/workers/${encodeURIComponent(workerId)}/preview?at=${Date.now()}`;
      $("#dialog-content").innerHTML = `<h2>Worker ${esc(String(page))} 的${esc(platformName)}页面</h2><p class="muted">实时页面预览，仅供查看；未提交问题、未刷新页面，也不会恢复暂停的测试。</p><div class="worker-page-preview"><img src="${previewUrl}" alt="Worker ${esc(String(page))} 的${esc(platformName)}实时页面预览" /></div><div class="form-actions"><button value="cancel" class="secondary">关闭</button></div>`;
      $("#dialog-form").onsubmit = null;
      $("#dialog").showModal();
      flash(result.openedForViewing ? `已打开 Worker ${page} 的页面预览；未提交任何问题。` : `已显示 Worker ${page} 的真实${platformName}页面预览。`);
    }
    else flash(`该 Worker 当前没有可显示的${monitorPlatformName(run)}页面；不会重启或干扰测试。`, true);
  } catch (error) {
    flash(`无法显示该 Worker 页面：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-doubao-login-page]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/doubao-browser/login", { method: "POST", body: "{}" });
    flash(result.state === "logged_in" ? "已切换到 GEO 专用豆包页面，登录状态有效。" : "已切换到 GEO 专用豆包登录页面；完成登录后测试会自动继续。");
  } catch (error) { flash(`无法显示豆包登录页面：${error.message}`, true); }
  finally { button.disabled = false; }
});
 document.addEventListener("click", event=>{ if(event.target.closest("#run-doubao-api")) runDoubaoApiProbe(); });
document.addEventListener("click", event=>{ const button = event.target.closest("[data-stability-filter]"); if (!button) return; state.stabilityFilter = button.dataset.stabilityFilter; state.view = "monitoring"; render(); });
document.addEventListener("click", event=>{ const button = event.target.closest("[data-evidence-filter]"); if (!button) return; state.evidenceFilter = button.dataset.evidenceFilter; state.evidenceScope = button.dataset.evidenceScope || state.evidenceScope; state.view = "monitoring"; render(); });
document.addEventListener("click", event=>{ const button = event.target.closest("[data-local-evidence-filter]"); if (!button) return; state.localEvidenceFilter = button.dataset.localEvidenceFilter; state.view = "monitoring"; render(); });
document.addEventListener("change", async event => {
  const select = event.target.closest("#local-question-bank");
  if (!select) return;
  select.disabled = true;
  try {
    const result = await api("/local-monitoring/question-bank", { method: "POST", body: JSON.stringify({ questionSet: select.value }) });
    flash(`已选择“${result.questionBank.name}”，下一次测试将运行 ${result.questionBank.promptCount} 道题。`);
    state.browserEvidenceByRunId = {};
    await refresh();
  } catch (error) {
    flash(error.message || "无法切换题库", true);
    await refresh();
  }
});
document.addEventListener("click", async event => { const button = event.target.closest("#save-local-regions"); if (!button) return; const selectedRegions = [...document.querySelectorAll("input[name='local-region']:checked")].map(input => input.value); try { const result = await api("/local-monitoring/config", { method: "POST", body: JSON.stringify({ selectedRegions }) }); flash(`已生成 ${result.prompts.length} 条地域问题，并保留旧问题为历史记录。`); await refresh(); } catch (error) { flash(error.message, true); } });
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-load-archive-history]");
  if (!button) return;
  const questionSet = button.dataset.loadArchiveHistory;
  if (!questionSet || state.archiveHistoryByQuestionSet[questionSet] || state.archiveHistoryLoading.has(questionSet)) return;
  state.archiveHistoryLoading.add(questionSet);
  render();
  try {
    state.archiveHistoryByQuestionSet[questionSet] = await api(`/browser-monitor-runs/archive-history?questionSet=${encodeURIComponent(questionSet)}`);
    flash("历史测试记录已按需读取，可展开查看完整证据。");
  } catch (error) {
    flash(`无法读取历史测试记录：${error.message}`, true);
  } finally {
    state.archiveHistoryLoading.delete(questionSet);
    render();
  }
});
const backToTop = $("#back-to-top");
function updateBackToTop() { backToTop.classList.toggle("visible", window.scrollY > 260); }
backToTop.addEventListener("click", () => window.scrollTo({ top:0, behavior:"smooth" }));
window.addEventListener("scroll", updateBackToTop, { passive:true });
updateBackToTop();
await refresh();
async function restoreBrowserMonitorProgress() {
  const platform = state.selectedPlatform || "doubao_web";
  const savedMonitorRunId = localStorage.getItem(monitorStorageKey(platform)) || (platform === "doubao_web" ? localStorage.getItem(ACTIVE_DOUBAO_MONITOR_RUN_KEY) : null);
  try {
    const restored = savedMonitorRunId
      ? await api(`/browser-monitor-runs/${savedMonitorRunId}`)
      : (await api(`/browser-monitor-runs/active?platform=${encodeURIComponent(platform)}&platformMode=${encodeURIComponent(state.selectedPlatformMode)}`)).run;
    if (!restored) return;
    if (monitorPlatformId(restored) !== platform) return;
    state.platformRunState[platform] = restored;
    state.monitorRun = restored;
    state.monitorRunId = restored.runId;
    if (monitorRunIsActive(restored)) {
      localStorage.setItem(monitorStorageKey(platform), restored.runId);
      if (platform === "doubao_web") localStorage.setItem(ACTIVE_DOUBAO_MONITOR_RUN_KEY, restored.runId);
      renderMonitorRunProgress();
      startMonitorLiveClock();
      startMonitorProgressStream(restored.runId);
      return;
    }
    clearActiveMonitorRun(platform);
  } catch (error) {
    if (savedMonitorRunId && error.status === 404) clearActiveMonitorRun(platform);
  }
}
void restoreBrowserMonitorProgress();
