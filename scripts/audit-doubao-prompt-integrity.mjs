import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { sentPromptTextEquivalent } from "../lib/doubao-prompt-send.mjs";

const root = join(import.meta.dirname, "..");
const storePath = join(root, "data", "store.json");
const profileDir = join(root, "data", "doubao-profile");
const runId = process.argv.find((argument) => /^GEO_RUN_/i.test(argument));
const apply = process.argv.includes("--apply");
if (!runId) throw new Error("Usage: node scripts/audit-doubao-prompt-integrity.mjs GEO_RUN_NNN [--apply]");

const store = JSON.parse(await readFile(storePath, "utf8"));
const run = (store.browserMonitorRuns || []).find((item) => item.id === runId);
if (!run) throw new Error(`Run not found: ${runId}`);

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1440, height: 1000 },
});
const pages = context.pages();
const page = pages[0] || await context.newPage();
const records = [];
try {
  for (const [index, question] of (run.questions || []).entries()) {
    const expectedText = String(question.questionText || question.question || "").trim();
    const conversationId = String(question.conversationId || question.job?.conversation_id || "").trim();
    const base = { number: index + 1, promptId: question.promptId, conversationId: conversationId || null, expectedText };
    if (!conversationId || !expectedText) {
      records.push({ ...base, status: "unavailable", observedText: null, reason: "missing_conversation_or_expected_text" });
      continue;
    }
    const url = `https://www.doubao.com/chat/${encodeURIComponent(conversationId)}`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const messages = page.locator("[data-message-id].justify-end");
      await messages.first().waitFor({ state: "visible", timeout: 20_000 });
      const observed = await messages.evaluateAll((nodes) => nodes
        .filter((node) => node.getClientRects().length)
        .map((node) => ({
          id: node.getAttribute("data-message-id"),
          text: String(node.innerText || node.textContent || "").trim(),
        })));
      const exact = observed.find((item) => item.text === expectedText);
      const equivalent = exact || observed.find((item) => sentPromptTextEquivalent(item.text, expectedText));
      const selected = equivalent || observed.at(-1) || null;
      records.push({
        ...base,
        url,
        status: equivalent ? "verified" : selected ? "mismatch" : "unavailable",
        observedText: selected?.text || null,
        userMessageId: selected?.id || null,
        matchMode: exact ? "exact" : equivalent ? "whitespace_normalized" : null,
        observedMessageCount: observed.length,
        reason: equivalent ? null : selected ? "sent_user_message_differs_from_question_bank" : "no_visible_user_message",
      });
    } catch (error) {
      records.push({ ...base, url, status: "unavailable", observedText: null, reason: String(error?.message || error).slice(0, 500) });
    }
  }
} finally {
  await context.close();
}

const auditedAt = new Date().toISOString();
for (const record of records) record.auditedAt = auditedAt;
const counts = records.reduce((result, item) => ({ ...result, [item.status]: (result[item.status] || 0) + 1 }), {});
const summary = {
  schemaVersion: 1,
  runId,
  auditedAt,
  status: counts.mismatch || counts.unavailable ? "failed" : "verified",
  total: records.length,
  verified: counts.verified || 0,
  mismatch: counts.mismatch || 0,
  unavailable: counts.unavailable || 0,
  method: "historical_conversation_user_bubble_exact_match",
};

await mkdir(join(root, "reports"), { recursive: true });
const reportPath = join(root, "reports", `prompt-integrity-audit-${runId}.json`);
await writeFile(reportPath, JSON.stringify({ summary, records }, null, 2));

if (apply) {
  run.promptIntegrityAudit = summary;
  if (summary.status !== "verified") run.reportable = false;
  const byPrompt = new Map(records.map((record) => [record.promptId, record]));
  for (const question of run.questions || []) {
    const record = byPrompt.get(question.promptId);
    if (!record) continue;
    question.promptIntegrity = record;
    question.job ||= {};
    question.job.prompt_integrity = record;
  }
  for (const probe of store.probeRuns || []) {
    if (probe.browserMonitorRunId !== runId) continue;
    const record = byPrompt.get(probe.promptId);
    if (!record) continue;
    const previousAudit = probe.promptIntegrity;
    probe.promptIntegrity = record;
    if (probe.browserConversation) probe.browserConversation.promptIntegrity = record;
    if (record.status !== "verified") probe.reportable = false;
    else if (probe.reportable === false && previousAudit?.auditedAt && previousAudit?.reason === "sent_user_message_differs_from_question_bank") delete probe.reportable;
  }
  // Match the service's durable-store format so a later restart does not
  // rewrite hundreds of megabytes solely to remove indentation.
  await writeFile(storePath, JSON.stringify(store));
}

console.log(JSON.stringify({ summary, reportPath, applied: apply }, null, 2));
