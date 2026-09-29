/** Read-only, no-prompt inspection of the authenticated Doubao search UI. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDoubaoWebConfig } from "../lib/doubao-config.mjs";
import { DoubaoBrowserManager } from "../lib/doubao-browser-manager.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const config = readDoubaoWebConfig({ root });
const storePath = resolve(root, "data", "store.json");
const probeId = `search-ui-${randomUUID()}`;
const probeDir = resolve(root, "data", "doubao-debug", "search-ui", probeId);
const storeHash = () => createHash("sha256").update(readFileSync(storePath)).digest("hex");
const beforeHash = storeHash();

function output(value) { console.log(JSON.stringify(value, null, 2)); }

async function inspectSearchUi(worker) {
  const readiness = await worker.inspectDoubaoPageState();
  const ui = await worker.page.evaluate(() => {
    const visible = (node) => Boolean(node?.getClientRects?.().length);
    const text = (node) => [node.innerText, node.getAttribute?.("aria-label"), node.getAttribute?.("title"), node.getAttribute?.("data-testid")]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
    const describe = (node) => ({
      tag: node.tagName,
      id: node.id || null,
      role: node.getAttribute("role"),
      type: node.getAttribute("type"),
      ariaLabel: node.getAttribute("aria-label"),
      ariaPressed: node.getAttribute("aria-pressed"),
      ariaChecked: node.getAttribute("aria-checked"),
      dataState: node.getAttribute("data-state"),
      dataTestId: node.getAttribute("data-testid"),
      text: text(node),
      visible: visible(node),
    });
    const composer = [...document.querySelectorAll('[role="textbox"][contenteditable="true"], textarea, input[role="textbox"]')]
      .find((node) => visible(node) && !node.disabled && (node.isContentEditable || /^(TEXTAREA|INPUT)$/.test(node.tagName))) || null;
    const allControls = [...document.querySelectorAll("button, [role=button], [role=switch], input[type=checkbox], a")]
      .filter(visible)
      .map((node) => ({ node, details: describe(node) }));
    const nearComposer = (node) => {
      if (!composer) return false;
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) if (current === composer.parentElement || current === composer.parentElement?.parentElement || current === composer.parentElement?.parentElement?.parentElement) return true;
      return false;
    };
    const searchPattern = /联网|网页|搜索|search|online|web|深度思考|deep\s*think/i;
    const searchControls = allControls.filter(({ node, details }) => searchPattern.test(details.text) || nearComposer(node));
    const controlHtml = searchControls.map(({ node }) => node.outerHTML).join("\n");
    const composerHtml = composer?.outerHTML || "";
    const minimalContainer = `<section data-search-ui-probe="container">${composerHtml}${controlHtml}</section>`;
    return {
      composer: composer ? describe(composer) : null,
      controls: searchControls.map(({ details }) => details),
      searchControlCandidates: searchControls.filter(({ details }) => searchPattern.test(details.text)).map(({ details }) => details),
      composerHtml,
      controlsHtml: `<section data-search-ui-probe="controls">${controlHtml}</section>`,
      containerHtml: minimalContainer,
      pageUrl: location.href,
      pageTitle: document.title,
    };
  });
  return { readiness, ui };
}

const manager = new DoubaoBrowserManager({ ...config, profileDir: config.profileDir, debugDir: probeDir, workerCount: 4, headless: false });
const result = { SEARCH_UI_DOM_PROBE_ONLY: true, PROMPT_SENT: 0, FORMAL_RUN_CREATED: 0, probeId };
try {
  const workers = await manager.prepareForRun(4);
  const worker = workers.find((item) => item.workerId === "doubao-worker-1");
  if (!worker) throw new Error("PROBE_WORKER_1_UNAVAILABLE");
  await manager.bringWorkerToFront(worker.workerId);
  const { readiness, ui } = await inspectSearchUi(worker);
  const capability = await worker.getWebSearchCapability();
  await mkdir(probeDir, { recursive: true });
  const metadata = {
    timestamp: new Date().toISOString(),
    probeId,
    loggedIn: readiness.loginStatus === "logged_in",
    composerReady: Boolean(readiness.inputReady),
    searchControlPresent: ui.searchControlCandidates.length > 0,
    searchControlText: ui.searchControlCandidates.map((item) => item.text),
    searchControlState: ui.searchControlCandidates.map((item) => ({ ariaPressed: item.ariaPressed, ariaChecked: item.ariaChecked, dataState: item.dataState })),
    selectedStateEvidence: { readiness, composer: ui.composer, controls: ui.controls },
    webSearchCapability: capability,
    pageUrl: ui.pageUrl,
    pageTitle: ui.pageTitle,
    workerId: worker.workerId,
    workerCount: workers.length,
    artifacts: { searchUiContainer: "search-ui-container.html", searchControls: "search-controls.html", composer: "composer.html" },
  };
  await Promise.all([
    writeFile(resolve(probeDir, "search-ui-container.html"), ui.containerHtml, "utf8"),
    writeFile(resolve(probeDir, "search-controls.html"), ui.controlsHtml, "utf8"),
    writeFile(resolve(probeDir, "composer.html"), ui.composerHtml, "utf8"),
    writeFile(resolve(probeDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8"),
  ]);
  Object.assign(result, { DOM_PROBE: "PASS", loggedIn: metadata.loggedIn, composerReady: metadata.composerReady, searchControlPresent: metadata.searchControlPresent, searchControlText: metadata.searchControlText, searchControlState: metadata.searchControlState, selectedStateEvidence: metadata.selectedStateEvidence, webSearchCapability: capability, pageUrl: metadata.pageUrl, probeDir });
} catch (error) {
  result.DOM_PROBE = "FAIL";
  result.error = { code: error?.code || null, message: String(error?.message || error) };
} finally {
  await manager.context?.close().catch(() => null);
}
const afterHash = existsSync(storePath) ? storeHash() : null;
Object.assign(result, { FORMAL_STORE_HASH_BEFORE: beforeHash, FORMAL_STORE_HASH_AFTER: afterHash, FORMAL_STORE_HASH_UNCHANGED: beforeHash === afterHash ? "PASS" : "FAIL", FORMAL_STORE_MODIFIED: beforeHash === afterHash ? "NO" : "YES" });
output(result);
process.exitCode = result.DOM_PROBE === "PASS" && result.FORMAL_STORE_MODIFIED === "NO" ? 0 : 1;
