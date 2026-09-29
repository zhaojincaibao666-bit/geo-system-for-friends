import { normalizeReliablePublishedAt } from "./doubao-citation-extractor.mjs";

export const PUBLISHED_CONTENT_PLATFORMS = Object.freeze(["official_site", "wechat", "douyin", "xiaohongshu", "baijiahao", "other"]);

export function normalizePublishedContent(input = {}, { contentId, brand = null, createdAt = new Date().toISOString() } = {}) {
  const publishedAt = normalizeReliablePublishedAt(input.publishedAt, input.capturedAt || createdAt);
  const brandValue = input.brand || brand;
  return {
    contentId: String(input.contentId || contentId || "").trim() || null,
    platform: String(input.platform || "other").trim() || "other",
    title: String(input.title || "").trim() || null,
    url: String(input.url || "").trim() || null,
    publishedAt,
    topic: String(input.topic || "").trim() || null,
    brand: brandValue && typeof brandValue === "object" ? (brandValue.id || brandValue.name || brandValue.legalName || null) : brandValue || null,
    createdAt,
    source: "manual_record",
  };
}

export function validatePublishedContent(content = {}) {
  const errors = [];
  if (!content.contentId) errors.push("contentId is required");
  if (!content.platform) errors.push("platform is required");
  if (!content.title) errors.push("title is required");
  if (!content.url) errors.push("url is required");
  try { if (content.url) new URL(content.url); } catch { errors.push("url must be an absolute URL"); }
  if (!PUBLISHED_CONTENT_PLATFORMS.includes(content.platform)) errors.push("unsupported platform");
  return { valid: errors.length === 0, errors };
}
