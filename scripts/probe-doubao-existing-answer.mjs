/**
 * Read-only CitationCaptureV2 DOM probe.
 *
 * It deliberately never invokes new-chat, input, send, a monitor run, or the
 * persistence layer.  It opens the existing Playwright persistent profile,
 * inspects a completed assistant message if one is already rendered, writes
 * only minimal local debug artifacts, and then closes the temporary context.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDoubaoWebConfig } from "../lib/doubao-config.mjs";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
const config = readDoubaoWebConfig({ root });
const probeDir = resolve(root, "data", "doubao-debug", "citation-v2-real");

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function minimalNeighborHtml(element) {
  const wrapper = document.createElement("section");
  wrapper.setAttribute("data-citation-probe-scope", "adjacent");
  if (element.previousElementSibling) wrapper.append(element.previousElementSibling.cloneNode(true));
  wrapper.append(element.cloneNode(true));
  if (element.nextElementSibling) wrapper.append(element.nextElementSibling.cloneNode(true));
  return wrapper.outerHTML;
}

let context;
try {
  context = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
    locale: "zh-CN",
  });
  let pages = context.pages().filter((page) => !page.isClosed());
  let page = pages.find((candidate) => /doubao\.com/i.test(candidate.url())) || pages[0];
  if (!page) page = await context.newPage();
  if (!/doubao\.com/i.test(page.url())) await page.goto(config.url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded").catch(() => null);

  const discovery = await page.evaluate(() => {
    const describe = (node) => ({
      tag: node.tagName,
      id: node.id || null,
      role: node.getAttribute("role"),
      ariaLabel: node.getAttribute("aria-label"),
      ariaLabelledBy: node.getAttribute("aria-labelledby"),
      dataMessageId: node.getAttribute("data-message-id"),
      dataStreaming: node.getAttribute("data-streaming"),
      dataContainerType: node.getAttribute("data-container-type"),
      className: String(node.className || "").slice(0, 400),
      visible: Boolean(node.getClientRects().length),
    });
    const blocks = [...document.querySelectorAll('[data-container-type="block-v2"]')]
      .filter((node) => node.getClientRects().length);
    const assistants = blocks.map((block) => {
      const message = block.closest("[data-message-id]") || block.parentElement || block;
      return { block, message, text: (message.innerText || "").trim() };
    }).filter(({ message, text }) => text && !message.classList.contains("justify-end"));
    const target = assistants.at(-1) || null;
    if (!target) {
      return {
        found: false,
        url: location.href,
        title: document.title,
        renderedBlockCount: blocks.length,
        visibleMessages: [...document.querySelectorAll("[data-message-id]")].filter((node) => node.getClientRects().length).slice(-8).map(describe),
      };
    }
    const { message, block, text } = target;
    const parent = message.parentElement || message;
    const triggerCandidates = [...message.querySelectorAll("button, [role=button], a")]
      .filter((node) => /来源|参考|网页|搜索|引用|source|reference/i.test((node.innerText || node.getAttribute("aria-label") || "").trim()))
      .map((node) => ({ tag: node.tagName, text: (node.innerText || node.getAttribute("aria-label") || "").trim(), html: node.outerHTML.slice(0, 500) }));
    return {
      found: true,
      url: location.href,
      title: document.title,
      answerTextLength: text.length,
      answerIdentity: describe(message),
      blockIdentity: describe(block),
      conversationIdentity: location.pathname.match(/\/chat\/([^/?#]+)/)?.[1] || null,
      answerHtml: message.outerHTML,
      containerHtml: parent.outerHTML,
      adjacentHtml: minimalNeighborHtml(message),
      triggerCandidates,
      bodyLinks: [...message.querySelectorAll("a[href]")].map((a) => ({
        text: (a.innerText || a.textContent || "").trim(), href: a.getAttribute("href"),
        title: a.getAttribute("title"), dataResolvedUrl: a.getAttribute("data-resolved-url"),
        dataFinalUrl: a.getAttribute("data-final-url"),
      })),
    };
  });

  // The manual runbook needs an unambiguous, machine-readable handoff: only
  // this outcome authorizes the separate single-answer probe script. It does
  // not create a run, submit a prompt, or write formal GEO data.
  const result = {
    citationProbeOnly: true,
    outcome: discovery.found ? "USABLE_EXISTING_ANSWER_FOUND" : "NO_USABLE_EXISTING_ANSWER",
    timestamp: new Date().toISOString(),
    pages: pages.map((item) => item.url()),
    ...discovery,
  };
  if (discovery.found) {
    await mkdir(probeDir, { recursive: true });
    const prefix = `existing-${stamp()}`;
    await Promise.all([
      writeFile(resolve(probeDir, `${prefix}-answer.html`), discovery.answerHtml, "utf8"),
      writeFile(resolve(probeDir, `${prefix}-container.html`), discovery.containerHtml, "utf8"),
      writeFile(resolve(probeDir, `${prefix}-adjacent.html`), discovery.adjacentHtml, "utf8"),
      writeFile(resolve(probeDir, `${prefix}-metadata.json`), JSON.stringify({ ...result, answerHtml: undefined, containerHtml: undefined, adjacentHtml: undefined }, null, 2), "utf8"),
    ]);
    result.artifactPrefix = prefix;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close().catch(() => null);
}
