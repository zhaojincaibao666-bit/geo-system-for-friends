// This module deliberately starts with semantic selectors only. The exact
// DeepSeek controls are added only after inspection of the current official
// webpage; no class-name or another platform's selector is used as a proxy.
export const DEEPSEEK_LOCATORS = Object.freeze({
  composer: ["textarea[placeholder*='给 DeepSeek 发送消息']", "textarea", "[contenteditable='true'][role='textbox']", "[contenteditable='true']", "[role='textbox']"],
  newConversationText: "开启新对话",
  webSearchText: "智能搜索",
  loginText: ["登录", "Log in", "Sign in"],
  verificationText: ["验证码", "安全验证", "滑动验证", "验证", "CAPTCHA"],
  blockingText: ["访问频繁", "请求过于频繁", "服务繁忙", "网络错误", "系统异常"],
  assistantAnswer: [
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-testid*='assistant']",
    ".ds-markdown",
    "[class*='message'] [class*='markdown']",
    "article",
  ],
  generatingText: ["停止生成", "Stop generating", "生成中"],
  citationContainer: [
    "[class*='citation']",
    "[class*='source']",
    "[class*='reference']",
    "[data-testid*='citation']",
    "[data-testid*='source']",
  ],
  citationPanelText: ["来源", "参考资料", "引用", "Sources"],
});

// Keep only fields that the DeepSeek DOM actually exposes. A title or domain
// must never be used to fabricate a URL or a redirect target.
export function normalizeDeepSeekCitationCandidates(candidates = []) {
  const seen = new Set();
  return candidates
    .map((candidate) => ({
      title: String(candidate?.title || "").trim(),
      url: String(candidate?.url || "").trim(),
      resolvedUrl: candidate?.resolvedUrl ? String(candidate.resolvedUrl).trim() : null,
      sourceName: String(candidate?.sourceName || "").trim(),
      sourceMethod: String(candidate?.sourceMethod || "deepseek_dom").trim(),
    }))
    .filter((candidate) => candidate.url && !seen.has(candidate.url) && Boolean(seen.add(candidate.url)));
}

export async function inspectDeepSeekDom(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || "").slice(0, 12000),
    candidates: [...document.querySelectorAll("textarea, input, [contenteditable='true'], button, [role='button'], [role='textbox'], [aria-pressed], [data-state]")]
      .slice(0, 240)
      .map((element) => ({
        tag: element.tagName,
        text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 240),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        placeholder: element.getAttribute("placeholder"),
        ariaPressed: element.getAttribute("aria-pressed"),
        dataState: element.getAttribute("data-state"),
        dataActive: element.getAttribute("data-active"),
        ariaChecked: element.getAttribute("aria-checked"),
        contentEditable: element.getAttribute("contenteditable"),
        className: String(element.className || "").slice(0, 240),
        parentText: (element.parentElement?.innerText || "").trim().slice(0, 240),
      })),
  }));
}
