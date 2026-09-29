/**
 * Thin Node boundary around the isolated Scrapling parser. Playwright keeps
 * ownership of the authenticated browser; Python only receives scoped HTML.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PYTHON = resolve(ROOT, ".venv-citation-v2", "Scripts", "python.exe");
const PARSER = resolve(ROOT, "citation_capture_v2", "parser.py");

export const CITATION_V2_STATUS = Object.freeze({
  CAPTURED: "CAPTURED",
  NO_CITATION_CONFIRMED: "NO_CITATION_CONFIRMED",
  CAPTURED_PARTIAL: "CAPTURED_PARTIAL",
  CITATION_REGION_NOT_LOADED: "CITATION_REGION_NOT_LOADED",
  CAPTURE_FAILED: "CAPTURE_FAILED",
});

function failedCapture(error) {
  return {
    captureVersion: "v2", parserVersion: "citation-capture-v2/1.0.0",
    status: CITATION_V2_STATUS.CAPTURE_FAILED, legacyStatus: "failed",
    citationCount: 0, citations: [], checkedChannels: [], expectedChannels: [], missingChannels: [],
    errors: [String(error?.message || error || "CitationCaptureV2 failed").slice(0, 500)],
    capturedAt: new Date().toISOString(), answerIdentity: null, questionRunId: null, unscopedCandidates: [],
  };
}

export async function captureCitationV2(payload = {}) {
  const python = process.env.CITATION_V2_PYTHON || DEFAULT_PYTHON;
  if (!existsSync(python)) return failedCapture(`CitationCaptureV2 Python environment missing: ${python}`);
  return new Promise((resolveCapture) => {
    const child = spawn(python, [PARSER], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timeout = setTimeout(() => { child.kill(); resolveCapture(failedCapture("CitationCaptureV2 timed out")); }, 15000);
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); resolveCapture(failedCapture(error)); });
    child.stdin.on("error", (error) => { clearTimeout(timeout); child.kill(); resolveCapture(failedCapture(error)); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return resolveCapture(failedCapture(errorOutput || `CitationCaptureV2 exited ${code}`));
      try {
        const result = JSON.parse(output);
        if (!result?.status || !Array.isArray(result.citations)) throw new Error("CitationCaptureV2 returned an invalid payload");
        resolveCapture(result);
      } catch (error) { resolveCapture(failedCapture(error)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
