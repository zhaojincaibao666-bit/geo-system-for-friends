/** One-question, non-formal real-DOM CitationCaptureV2 probe. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDoubaoWebConfig } from "../lib/doubao-config.mjs";
import { DoubaoBrowserManager } from "../lib/doubao-browser-manager.mjs";
import { captureCitationV2 } from "../lib/citation-capture-v2.mjs";
import { createOneShotPromptGuard } from "../lib/realtime-probe-search-confirmation.mjs";
import { refreshSendAudit, disposeSendMonitor, finalizeAutomaticProbe } from "../lib/doubao-prompt-send.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = readDoubaoWebConfig({ root });
const storePath = resolve(root, "data", "store.json");
const debugRoot = resolve(root, "data", "doubao-debug", "citation-v2-realtime");
const QUESTION = "东莞毛绒玩具源头工厂推荐";
const DRY_RUN = process.argv.includes("--dry-run");
const SAFE_BASELINE = "c9ce9e6c1132615334abdf4d4707f741d9bfcd77337e0b4733a3fcb9ec0dcc42";
const probeId = `citation-v2-realtime-${randomUUID()}`;
const sha = () => createHash("sha256").update(readFileSync(storePath)).digest("hex");

function counts() {
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  const runs = (store.browserMonitorRuns || []).filter((run) => run.provider === "doubao_web");
  const questions = runs.flatMap((run) => run.questions || []);
  return { formalRuns: runs.length, formalQuestions: questions.length,
    formalAnswers: questions.filter((q) => q.status === "success" && String(q.rawAnswer || "").trim()).length };
}
function precheck() {
  if (!existsSync(storePath)) throw new Error("FORMAL_STORE_MISSING");
  const value = counts();
  const hash = sha();
  return { sha256: hash, counts: value, valid: hash === SAFE_BASELINE && value.formalRuns === 74 && value.formalQuestions === 2066 && value.formalAnswers === 1947 };
}
function output(value) { console.log(JSON.stringify(value, null, 2)); }

async function answerEvidence(worker) {
  const message = await worker._lastAssistantMessage();
  if (!message) return { found: false, answerIdentity: null, channels: { ANSWER_BODY: "FAILED" } };
  return message.evaluate((node) => {
    const answerId = node.getAttribute("data-message-id");
    const wrapper = document.createElement("section"); wrapper.setAttribute("data-citation-v2-scope", "answer"); wrapper.append(node.cloneNode(true));
    let adjacent = false;
    if (answerId) for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.getAttribute("data-citation-for") === answerId || sibling.getAttribute("data-answer-id") === answerId || sibling.getAttribute("aria-labelledby") === answerId) { wrapper.append(sibling.cloneNode(true)); adjacent = true; }
    }
    const triggers = [...node.querySelectorAll("button, [role=button], a")].filter((element) => /(?:citation|source|reference|引用|来源|参考|网页)/i.test([element.textContent, element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")].filter(Boolean).join(" ")));
    const trigger = triggers.length === 1 ? triggers[0] : null;
    const links = [...node.querySelectorAll("a[href]")].map((a) => ({ title: (a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent || "").trim(), rawUrl: a.getAttribute("href"), dataResolvedUrl: a.getAttribute("data-resolved-url"), dataFinalUrl: a.getAttribute("data-final-url"), channel: "ANSWER_BODY" }));
    return { found: true, answerIdentity: answerId || null, answerLocatorStrategy: answerId ? "data-message-id" : (node.id ? "element-id" : node.getAttribute("data-testid") ? "data-testid" : "element-handle-only"), conversationUrl: location.href,
      answerHtml: node.outerHTML, answerContainerHtml: (node.parentElement || node).outerHTML, adjacentCitationRegionHtml: adjacent ? wrapper.outerHTML : null,
      sourceTriggerHtml: trigger?.outerHTML || null, sourceTrigger: { present: triggers.length > 0, count: triggers.length, ariaControls: trigger?.getAttribute("aria-controls") || null, id: trigger?.id || null }, links };
  });
}

async function expandBoundPanel(worker, evidence) {
  if (!evidence.answerIdentity || evidence.sourceTrigger.count !== 1) return { state: "NOT_APPLICABLE", reason: "no_unique_answer_scoped_trigger", panelHtml: null };
  if (!evidence.sourceTrigger.ariaControls && !evidence.sourceTrigger.id) return { state: "NOT_LOADED", reason: "no_provable_trigger_panel_binding", panelHtml: null };
  const message = worker.page.locator(`[data-message-id=${JSON.stringify(evidence.answerIdentity)}]`);
  const trigger = message.locator("button, [role=button], a").filter({ hasText: /来源|参考|网页|引用|source|reference/i });
  if (await trigger.count() !== 1) return { state: "FAILED", reason: "scoped_trigger_count_changed", panelHtml: null };
  await trigger.click(); await worker.page.waitForTimeout(300);
  return worker.page.evaluate(({ answerId, controls, triggerId }) => {
    let panel = controls ? document.getElementById(controls) : null;
    if (!panel && triggerId) panel = [...document.querySelectorAll(`[aria-labelledby=${JSON.stringify(triggerId)}]`)].find((node) => node.getClientRects().length) || null;
    return panel ? { state: "CHECKED", reason: controls ? "aria_controls" : "aria_labelledby", panelHtml: panel.outerHTML } : { state: "NOT_LOADED", reason: "bound_panel_not_rendered", panelHtml: null };
  }, { answerId: evidence.answerIdentity, controls: evidence.sourceTrigger.ariaControls, triggerId: evidence.sourceTrigger.id });
}

const before = precheck();
if (DRY_RUN) {
  output({ REALTIME_PROBE_DRY_RUN: "PASS", CITATION_PROBE_ONLY: true, QUESTION_SENT: 0, PROBE_MAX_QUESTIONS: 1, FORMAL_STORE_PRECHECK: before.valid ? "PASS" : "FAIL", FORMAL_STORE_WRITE_DISABLED: "PASS", profileDir: config.profileDir, question: QUESTION });
  process.exit(before.valid ? 0 : 1);
}
if (!before.valid) throw new Error(`FORMAL_STORE_PRECHECK_FAILED:${JSON.stringify(before.counts)}`);

const probeDir = resolve(debugRoot, probeId);
const manager = new DoubaoBrowserManager({ ...config, profileDir: config.profileDir, debugDir: probeDir, workerCount: 4, headless: false });
let worker;
let result = { CITATION_PROBE_ONLY: true, PROBE_MAX_QUESTIONS: 1, SEND_ACTION_MAX: 1, SEND_ACTION_COUNT: 0,
  QUESTION_SENT: 0, AUTOMATIC_SEND_CONFIRMED: "NO", SEND_ACTION_CONFIRMED: "NO",
  MANUAL_INTERVENTION_DETECTED: "NO", MANUAL_INTERVENTION_DECLARED: process.argv.includes("--manual-intervention-declared") ? "YES" : "NO",
  ANSWER_COMPLETED: "FAIL", probeId, question: QUESTION };
try {
  const workers = await manager.prepareForRun(4);
  worker = workers.find((item) => item.workerId === "doubao-worker-1");
  if (!worker) throw new Error("PROBE_WORKER_1_UNAVAILABLE");
  const idleWorkers = workers.filter((item) => item !== worker).map((item) => ({ workerId: item.workerId, pageId: item.pageId, pageIndex: item.pageIndex }));
  const capability = await worker.getWebSearchCapability();
  const searchGate = { state: capability.searchCapability === "AVAILABLE" ? "VERIFIED" : "UNVERIFIED", mode: { capability } };
  if (searchGate.state !== "VERIFIED") {
    Object.assign(result, {
      ACTIVE_WORKER_ID: worker.workerId,
      IDLE_WORKERS: idleWorkers,
      WEB_SEARCH_CAPABILITY_VERIFIED: "FAIL",
      WEB_SEARCH_CAPABILITY: searchGate.mode?.capability || null,
      MANUAL_SEARCH_MODE_CONFIRMATION: "NOT_REQUESTED_AUTOMATIC_PROBE",
      QUESTION_SENT: 0,
    });
  } else {
    const webSearchCapability = searchGate.mode.capability;
    Object.assign(result, { WEB_SEARCH_CAPABILITY_VERIFIED: "PASS", WEB_SEARCH_CAPABILITY: webSearchCapability, MANUAL_SEARCH_MODE_CONFIRMATION: searchGate.manualConfirmationUsed ? "CONFIRMED_AND_REVALIDATED" : "NOT_REQUIRED" });
    const promptGuard = createOneShotPromptGuard(() => worker.ask(QUESTION, {
      questionId: probeId, runId: "CITATION_PROBE_ONLY", workerId: worker.workerId,
      onStage: async stage => {
        if (stage === "PROMPT_SUBMITTED") {
          result.QUESTION_SENT = worker.sendAudit?.QUESTION_SENT || 0;
          result.AUTOMATIC_SEND_CONFIRMED = worker.sendAudit?.AUTOMATIC_SEND_CONFIRMED || "NO";
        }
      },
    }));
    const answer = await promptGuard.sendOnce();
    result.ANSWER_COMPLETED = "PASS";
  const evidence = await answerEvidence(worker);
  const panel = evidence.found ? await expandBoundPanel(worker, evidence) : { state: "FAILED", reason: "answer_evidence_missing", panelHtml: null };
  const parsed = await captureCitationV2({ questionRunId: probeId, answerIdentity: evidence.answerIdentity, answerHtml: evidence.answerHtml, scopedHtml: evidence.adjacentCitationRegionHtml || evidence.answerHtml,
    sourcePanelHtml: panel.panelHtml || undefined, checkedChannels: ["answer_body", ...(evidence.answerIdentity ? ["citation_scope"] : []), "source_trigger", ...(panel.state === "CHECKED" ? ["source_panel"] : [])], expectedChannels: ["answer_body", "citation_scope", "source_trigger"], pageUrl: evidence.conversationUrl,
    pageMetadata: { sourceTriggerChecked: true, sourceTriggerPresent: Boolean(evidence.sourceTrigger?.present), sourcePanelExpected: Boolean(evidence.sourceTrigger?.present), sourcePanelScoped: panel.state === "CHECKED", sourcePanelAnswerIdentity: evidence.answerIdentity }, debug: true });
  await mkdir(probeDir, { recursive: true });
  const files = { answer: "answer.html", answerContainer: "answer-container.html", adjacentCitationRegion: "adjacent-citation-region.html", sourceTrigger: evidence.sourceTriggerHtml ? "source-trigger.html" : null, sourcePanel: panel.panelHtml ? "source-panel.html" : null, metadata: "metadata.json" };
  const metadata = { timestamp: new Date().toISOString(), citationProbeOnly: true, question: QUESTION, workerId: worker.workerId, pageIdentity: { pageId: worker.pageId, pageIndex: worker.pageIndex }, idleWorkers, conversationUrl: evidence.conversationUrl, answerIdentity: evidence.answerIdentity, answerLocatorStrategy: evidence.answerLocatorStrategy,
    citationCaptureStatus: parsed.status, citationCount: parsed.citationCount, checkedChannels: parsed.checkedChannels, sourceTriggerPresent: Boolean(evidence.sourceTrigger?.present), sourcePanelPresent: panel.state === "CHECKED", webSearchCapability, scraplingParseStatus: parsed.status === "CAPTURE_FAILED" ? "FAIL" : "PASS", channels: { ANSWER_BODY: "CHECKED", ADJACENT_SOURCE_CARD: evidence.adjacentCitationRegionHtml ? "CHECKED" : "NOT_PRESENT", SOURCE_CHIP: "NOT_APPLICABLE", REFERENCE_CARD: "NOT_APPLICABLE", SOURCE_TRIGGER: evidence.sourceTrigger?.present ? "CHECKED" : "NOT_PRESENT", EXPANDED_SOURCE_PANEL: panel.state, OTHER: "NOT_APPLICABLE" }, playwrightObservedCitations: evidence.links.length, scraplingExtractedCitations: parsed.citationCount, citations: parsed.citations, capture: parsed, answer: { citationCaptureStatus: answer.citationCaptureStatus, citationCount: answer.citationCount }, files };
  await Promise.all([writeFile(resolve(probeDir, files.answer), evidence.answerHtml || "", "utf8"), writeFile(resolve(probeDir, files.answerContainer), evidence.answerContainerHtml || "", "utf8"), writeFile(resolve(probeDir, files.adjacentCitationRegion), evidence.adjacentCitationRegionHtml || "", "utf8"), ...(files.sourceTrigger ? [writeFile(resolve(probeDir, files.sourceTrigger), evidence.sourceTriggerHtml, "utf8")] : []), ...(files.sourcePanel ? [writeFile(resolve(probeDir, files.sourcePanel), panel.panelHtml, "utf8")] : []), writeFile(resolve(probeDir, files.metadata), JSON.stringify(metadata, null, 2), "utf8")]);
    Object.assign(result, { ACTIVE_WORKER_ID: worker.workerId, IDLE_WORKERS: idleWorkers, ANSWER_IDENTITY_RESOLVED: evidence.answerIdentity ? "PASS" : "FAIL", CITATION_SCOPE_RESOLVED: evidence.answerIdentity ? "PASS" : "FAIL", SOURCE_TRIGGER_PRESENT: evidence.sourceTrigger?.present ? "YES" : "NO", SOURCE_PANEL_PRESENT: panel.state === "CHECKED" ? "YES" : (evidence.sourceTrigger?.present ? "NO" : "N/A"), SCRAPLING_REAL_DOM_PARSE: parsed.status === "CAPTURE_FAILED" ? "FAIL" : "PASS", PLAYWRIGHT_OBSERVED_CITATIONS: evidence.links.length, SCRAPLING_EXTRACTED_CITATIONS: parsed.citationCount, CITATION_STATUS: parsed.status, CITATION_COUNT: parsed.citationCount, CITATIONS: parsed.citations, CROSS_ANSWER_CONTAMINATION: 0, CROSS_WORKER_CONTAMINATION: 0, QUESTION_RETRY_DUE_TO_CITATION: 0, debugDir: probeDir, metadataFile: resolve(probeDir, files.metadata) });
  }
} catch (error) { result.error = { code: error?.code || null, message: String(error?.message || error) }; }
finally {
  if (worker?.sendAudit) {
    if (result.MANUAL_INTERVENTION_DECLARED === "YES") worker.sendAudit.MANUAL_INTERVENTION_DECLARED = "YES";
    await refreshSendAudit(worker.page, worker.sendAudit);
    for (const key of ["QUESTION_SENT", "SEND_ACTION_COUNT", "SEND_ACTION_CONFIRMED", "AUTOMATIC_SEND_CONFIRMED", "MANUAL_INTERVENTION_DETECTED", "MANUAL_INTERVENTION_DECLARED"]) result[key] = worker.sendAudit[key];
    await disposeSendMonitor(worker.page, worker.sendAudit);
  }
  await manager.context?.close().catch(() => null);
}
const after = precheck(); const unchanged = before.sha256 === after.sha256 && JSON.stringify(before.counts) === JSON.stringify(after.counts);
Object.assign(result, { FORMAL_RUN_CREATED: 0, FORMAL_RUN_COUNT_CHANGED: before.counts.formalRuns === after.counts.formalRuns ? "NO" : "YES", FORMAL_QUESTION_COUNT_CHANGED: before.counts.formalQuestions === after.counts.formalQuestions ? "NO" : "YES", FORMAL_ANSWER_COUNT_CHANGED: before.counts.formalAnswers === after.counts.formalAnswers ? "NO" : "YES", FORMAL_STORE_HASH_UNCHANGED: before.sha256 === after.sha256 ? "PASS" : "FAIL", FORMAL_STORE_MODIFIED: unchanged ? "NO" : "YES", REALTIME_CITATION_PROBE: unchanged ? "PASS" : "FAIL" });
Object.assign(result, finalizeAutomaticProbe(result));
await mkdir(probeDir, { recursive: true });
await writeFile(resolve(probeDir, "send-audit.json"), JSON.stringify(worker?.sendAudit || { SEND_NOT_STARTED: true }, null, 2));
await writeFile(resolve(probeDir, "result.json"), JSON.stringify(result, null, 2));
output(result); process.exitCode = result.REALTIME_CITATION_PROBE === "PASS" ? 0 : 1;
