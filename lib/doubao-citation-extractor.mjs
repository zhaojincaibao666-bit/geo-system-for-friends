/**
 * Citation extraction for the final, completed Doubao answer.
 *
 * This module intentionally knows nothing about GEO scoring. It only reads
 * source evidence that is already exposed by the answer DOM. Browser-facing
 * locators are supplied by createDoubaoLocators() so a Doubao UI change has a
 * single maintenance point.
 */

export const CITATION_CAPTURE_STATUS = Object.freeze({
  SUCCESS: "success",
  EMPTY: "empty",
  PARTIAL: "partial",
  FAILED: "failed",
  NOT_AVAILABLE: "not_available",
  // Historical records created before structured citation capture. This is
  // never emitted by the live extractor; it only preserves uncertainty.
  NOT_OBSERVED: "not_observed",
});

const TRACKING_PARAMETER_NAMES = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "spm",
]);

function asNullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function parseUrl(value, baseUrl = "") {
  const raw = asNullableString(value);
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl || undefined);
  } catch {
    return null;
  }
}

/** Accept only a parseable publication timestamp that is not in the future
 * relative to capture time. Dates are never inferred from title, URL, or age. */
export function normalizeReliablePublishedAt(value, capturedAt = new Date().toISOString()) {
  const raw = asNullableString(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const publishedMs = Date.parse(raw);
  const capturedMs = Date.parse(capturedAt || "");
  if (!Number.isFinite(publishedMs) || !Number.isFinite(capturedMs) || publishedMs > capturedMs) return null;
  return new Date(publishedMs).toISOString();
}

export function calculateSourceAgeHours(publishedAt, capturedAt = new Date().toISOString()) {
  const publishedMs = Date.parse(publishedAt || "");
  const capturedMs = Date.parse(capturedAt || "");
  if (!Number.isFinite(publishedMs) || !Number.isFinite(capturedMs) || publishedMs > capturedMs) return null;
  return Math.round(((capturedMs - publishedMs) / 3_600_000) * 100) / 100;
}

/**
 * Conservatively normalise a real href for aggregation. The original href is
 * never replaced and no URL is inferred from a title or a displayed domain.
 */
export function normalizeCitationUrl(value, baseUrl = "") {
  const parsed = parseUrl(value, baseUrl);
  if (!parsed) return asNullableString(value);
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETER_NAMES.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  let normalized = parsed.toString();
  if (parsed.pathname !== "/") normalized = normalized.replace(/\/$/, "");
  return normalized;
}

export function citationDomain(value, baseUrl = "") {
  return parseUrl(value, baseUrl)?.hostname || null;
}

export function citationIdFor({ questionId = null, position = 1 } = {}) {
  const questionPart = String(questionId || "question").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `citation-${questionPart}-${Number(position) || 1}`;
}

export function normalizeCitation(raw = {}, context = {}, position = 1) {
  const url = asNullableString(raw.url ?? raw.href);
  const resolvedUrl = asNullableString(raw.resolvedUrl ?? raw.resolved_url);
  const capturedAt = asNullableString(raw.capturedAt ?? context.capturedAt) || new Date().toISOString();
  const publishedAt = normalizeReliablePublishedAt(raw.publishedAt ?? raw.published_at, capturedAt);
  return {
    citationId: asNullableString(raw.citationId) || citationIdFor({ questionId: context.questionId, position }),
    questionId: asNullableString(raw.questionId ?? context.questionId),
    runId: asNullableString(raw.runId ?? context.runId),
    workerId: asNullableString(raw.workerId ?? context.workerId),
    conversationId: asNullableString(raw.conversationId ?? context.conversationId),
    position: Number(raw.position || position) || position,
    title: asNullableString(raw.title),
    url,
    resolvedUrl,
    normalizedUrl: asNullableString(raw.normalizedUrl ?? raw.normalized_url)
      || normalizeCitationUrl(resolvedUrl || url, context.pageUrl || ""),
    domain: asNullableString(raw.domain) || citationDomain(resolvedUrl || url, context.pageUrl || ""),
    visibleText: asNullableString(raw.visibleText ?? raw.visible_text),
    sourceType: asNullableString(raw.sourceType ?? raw.source_type) || "inline_link",
    publishedAt,
    capturedAt,
    sourceAgeHours: calculateSourceAgeHours(publishedAt, capturedAt),
  };
}

function extractionError(error) {
  return String(error?.message || error || "citation extraction failed").slice(0, 500);
}

/**
 * Extract source links from the final assistant message. A missing citation
 * surface is a data state, not a failed GEO answer. Selector/evaluation
 * errors are reported separately so callers can retain the answer.
 */
export async function extractCitationCapture({
  message,
  locators,
  context = {},
  pageUrl = "",
  capturedAt = new Date().toISOString(),
} = {}) {
  const baseContext = { ...context, pageUrl, capturedAt };
  // This is intentionally opt-in. A caller may provide an independently
  // verified signal that a visible source surface exists; the extractor must
  // never infer that from a title/domain or from an empty link list.
  const visibleCitationSurface = context.visibleCitationSurface === true;
  const mismatch = (citations, status) => ({
    citationVisibilityMismatch: visibleCitationSurface && !citations.length ? true : null,
    citations,
    status,
  });
  if (!message || !locators || typeof locators.citationLinks !== "function") {
    return { ...mismatch([], CITATION_CAPTURE_STATUS.NOT_AVAILABLE), error: null, sourceType: null, capturedAt };
  }
  let rawLinks;
  try {
    const links = locators.citationLinks(message);
    if (!links || typeof links.evaluateAll !== "function") {
      return { ...mismatch([], CITATION_CAPTURE_STATUS.NOT_AVAILABLE), error: null, sourceType: null, capturedAt };
    }
    rawLinks = await links.evaluateAll((nodes) => nodes.map((link) => {
      const time = link.querySelector?.("time[datetime]");
      return {
        // getAttribute is the href Doubao actually exposed. link.href is only
        // a fallback for DOM implementations that expose property-only links.
        url: link.getAttribute("href") || link.href || null,
        resolvedUrl: link.getAttribute("data-resolved-url") || link.getAttribute("data-final-url") || null,
        title: link.getAttribute("title") || link.getAttribute("data-title") || null,
        visibleText: (link.textContent || "").trim() || null,
        sourceType: link.getAttribute("data-source-type") || "inline_link",
        publishedAt: link.getAttribute("data-published-at") || time?.getAttribute?.("datetime") || null,
      };
    }));
  } catch (error) {
    return { ...mismatch([], CITATION_CAPTURE_STATUS.FAILED), error: extractionError(error), sourceType: "inline_link", capturedAt };
  }

  const citations = (Array.isArray(rawLinks) ? rawLinks : []).map((raw, index) => normalizeCitation(raw, baseContext, index + 1));
  if (!citations.length) return { ...mismatch(citations, CITATION_CAPTURE_STATUS.EMPTY), error: null, sourceType: "inline_link", capturedAt };
  const missingUrl = citations.some((citation) => !citation.url);
  return {
    ...mismatch(citations, missingUrl ? CITATION_CAPTURE_STATUS.PARTIAL : CITATION_CAPTURE_STATUS.SUCCESS),
    error: missingUrl ? "one or more citation links had no href" : null,
    sourceType: "inline_link",
    capturedAt,
  };
}
