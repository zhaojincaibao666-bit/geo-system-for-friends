import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nameKey } from "./competitor-model.mjs";

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  // Restrict IPv6 to global unicast; IPv4-mapped, loopback and private IPs are excluded.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

export async function readPublicPage(input, redirects = 0) {
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("来源不是可读取的公开网页。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const records = await Promise.race([lookup(hostname, { all: true }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("域名查询超时")), 8000); timer.unref(); })]);
  if (!records.length || records.some(r => !publicAddress(r.address))) throw new Error("来源地址不属于公开互联网。");
  const record = records.find(r => r.family === 4) || records[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get(url, {
      lookup: (_host, opts, cb) => opts.all ? cb(null, [record]) : cb(null, record.address, record.family),
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36", "accept-language": "zh-CN,zh;q=0.9", accept: "text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 4) return reject(new Error("网页跳转次数过多。"));
        readPublicPage(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error(`网页暂时无法访问（${res.statusCode}）。`)); }
      if (!/text\/|xml|json/i.test(res.headers["content-type"] || "")) { res.resume(); return reject(new Error("该来源不是文字网页。")); }
      const chunks = []; let size = 0;
      res.on("data", chunk => { size += chunk.length; if (size > 1500000) request.destroy(new Error("网页内容过大。")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        const charset = /charset=([^; ]+)/i.exec(res.headers["content-type"] || "")?.[1] || "utf-8";
        let html; try { html = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { html = Buffer.concat(chunks).toString("utf8"); }
        // Search engines sometimes publish a literal client-side redirect. Read the
        // literal URL only; never evaluate page JavaScript. Revalidate every hop.
        const literalRedirect = html.length < 12000 && html.match(/(?:window\.)?location\.(?:replace|assign)\(\s*["'](https?:\/\/[^"']+)["']\s*\)/)?.[1];
        if (literalRedirect) {
          if (redirects >= 4) return reject(new Error("网页跳转次数过多。"));
          readPublicPage(literalRedirect, redirects + 1).then(resolve, reject); return;
        }
        resolve({ url: url.href, html });
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("网页读取超时。")), 12000);
    request.on("close", () => clearTimeout(deadline)); request.on("error", reject);
  });
}

const decode = text => String(text || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(x[0-9a-f]+|\d+);/gi, (_,v) => { const n = v[0].toLowerCase() === "x" ? parseInt(v.slice(1),16) : Number(v); return n <= 0x10ffff ? String.fromCodePoint(n) : ""; }).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&nbsp;/g, " ");
export const plainText = html => decode(String(html).replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<\/?(?:em|strong|b|span|i)\b[^>]*>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const rssField = (item, field) => decode(item.match(new RegExp(`<${field}[^>]*>([\\s\\S]*?)</${field}>`, "i"))?.[1] || "");
export function parseSearchRss(html) {
  return [...html.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => ({ title: plainText(rssField(m[1], "title")), url: rssField(m[1], "link"), snippet: plainText(rssField(m[1], "description")) })).filter(r => /^https?:\/\//.test(r.url));
}

export function parseSearchHtml(html, base) {
  const results = [];
  for (const m of html.matchAll(/<h[23]\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h[23]>/gi)) {
    const href = decode(m[1].match(/href=["']([^"']+)["']/i)?.[1]);
    if (!href) continue;
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol) || /\/(?:s|web|search)$/.test(url.pathname)) continue;
    const next = html.slice(m.index + m[0].length, m.index + m[0].length + 5000).split(/<h[23]\b|<div[^>]+class=["'][^"']*(?:ext_query|vrwrap|vr-wrap)/i)[0].replace(/<[^>]*$/, "");
    results.push({ title: plainText(m[2]), url: url.href, snippet: plainText(next).slice(0, 450) });
  }
  return results;
}

const channels = [
  { id: "website", label: "官网与产品资料", suffix: "官网 产品 案例" },
  { id: "news", label: "新闻与行业介绍", suffix: "新闻 玩具 定制" },
  { id: "video", label: "短视频与内容账号", suffix: "site:douyin.com" },
];
const identityKey = s => nameKey(s).replace(/东莞市/g, "东莞").replace(/深圳市/g, "深圳").replace(/广州市/g, "广州");
const relevant = (text, company) => company.aliases.some(a => identityKey(a).length >= 3 && identityKey(text).includes(identityKey(a)));
export function matchesToyCompanyPage(title, passages, company) {
  const industry = /毛绒|玩具|玩偶|公仔|娃衣|棉花娃/;
  return [title, ...passages].some(text => relevant(text,company) && industry.test(text));
}

export async function researchCompany(company, citations = [], onProgress = async () => {}, read = readPublicPage) {
  const sources = []; const attempts = []; const seen = new Set();
  for (const channel of channels) {
    await onProgress(`正在查找 ${company.name} 的${channel.label}`);
    const query = `${company.name} ${channel.id === "website" && company.researchTopics?.length ? company.researchTopics.join(" ") + " 案例" : channel.suffix}`;
    for (const engine of [
      { name: "搜狗", url: `https://www.sogou.com/web?query=${encodeURIComponent(query)}`, parser: parseSearchHtml },
      { name: "360搜索", url: `https://www.so.com/s?q=${encodeURIComponent(query)}`, parser: parseSearchHtml },
    ]) {
      try {
        const search = await read(engine.url);
        if (/captcha|antispider|wappass/i.test(search.url) || (/请输入验证码|完成验证|访问过于频繁/.test(plainText(search.html)) && !/<h3\b/i.test(search.html))) throw new Error("搜索网站要求验证，未继续读取。");
        const results = engine.parser(search.html, engine.url).filter(r => relevant(`${r.title} ${r.snippet}`, company) && (channel.id !== "video" || /抖音|快手|小红书|哔哩哔哩|douyin\.com|kuaishou\.com|bilibili\.com|xiaohongshu\.com/i.test(`${r.url} ${r.title} ${r.snippet}`))).slice(0, 3);
        attempts.push({ channel: channel.label, engine: engine.name, query, status: results.length ? "found" : "empty", count: results.length, at: new Date().toISOString() });
        for (const r of results) if (!seen.has(r.url)) { seen.add(r.url); sources.push({ ...r, channel: channel.label, origin: "public_search", state: "snippet_only", fetchedAt: new Date().toISOString() }); }
        if (results.length) break;
      } catch (error) { attempts.push({ channel: channel.label, engine: engine.name, query, status: "failed", error: error.message, at: new Date().toISOString() }); }
    }
  }
  for (const c of citations) {
    const url = c.resolvedUrl || c.url;
    if (/^https?:\/\//.test(url || "") && !seen.has(url)) { seen.add(url); sources.unshift({ title: c.title || "豆包回答中的引用来源", url, snippet: c.summary || "", channel: c.origin === "configured_website" ? "已配置官网" : "回答引用", origin: c.origin || "answer_citation", state: "snippet_only", fetchedAt: new Date().toISOString() }); }
    if (sources.filter(s => s.origin === "answer_citation").length >= 4) break;
  }
  // Bounded network work per company. A failed source stays visible as a limitation.
  for (const source of sources.slice(0, 10)) {
    await onProgress(`正在核对 ${company.name} 的公开资料（${sources.indexOf(source) + 1}/${Math.min(sources.length, 10)}）`);
    try {
      const page = await read(source.url);
      source.url = page.url;
      source.title = plainText(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) || source.title;
      // Keep a short company-specific passage, not a copy of the whole article.
      const contentHtml = page.html.replace(/<(?:header|nav|footer|head)\b[^>]*>[\s\S]*?<\/(?:header|nav|footer|head)>/gi, " ");
      const paragraphs = [...contentHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => plainText(m[1])).filter(t => t.length >= 45 && !/版权|Copyright|备案号|技术支持|隐私政策/i.test(t));
      if (!matchesToyCompanyPage(source.title, paragraphs, company)) { source.state = "identity_unconfirmed"; source.note = "未在页面标题或正文段落中同时核对到公司名称与毛绒玩具业务，可能是同名主体，暂不用于分析。"; continue; }
      const passages = paragraphs.filter(t => relevant(t, company));
      const passage = passages[0] || paragraphs.find(t => /定制|产品|工艺|案例|玩具|打样/.test(t)) || plainText(contentHtml);
      const alias = company.aliases.find(a => passage.includes(a));
      const at = alias ? passage.indexOf(alias) : 0;
      source.excerpt = passage.slice(Math.max(0, at - 40), at + 450);
      source.state = "read";
      source.note = "已读取正文并核对到公司名称；同名主体和页面中的宣传主张仍需人工核实。";
    } catch (error) { source.note = `正文未能读取：${error.message} 当前只保留检索线索。`; }
  }
  const unique = new Map();
  for (const source of sources) {
    const url = new URL(source.url); url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(spm|from)$/i.test(key)) url.searchParams.delete(key);
    const key = url.href;
    const existing = unique.get(key);
    if (!existing || (existing.state !== "read" && source.state === "read")) unique.set(key,source);
  }
  return { sources: [...unique.values()].slice(0, 14), attempts };
}

const themes = [
  { id: "small_order", title: "把起订量和小单条件说清楚", terms: /小批量|小单|起订|MOQ|试单/gi, action: "整理真实的起订量、打样费、试单条件和限制，做成一个常见问题页面，并配一条讲解视频。" },
  { id: "craft", title: "让买家看懂产品还原和打样能力", terms: /还原|打版|开版|刺绣|电绣|打样|版型/g, action: "选一个有公开授权的真实项目，展示原图、样品、修改过程和成品，说明解决了什么工艺问题。" },
  { id: "delivery", title: "给出能核实的交付信息", terms: /产能|日产|月产|交期|交付|量产|车间/g, action: "补充自有车间、生产流程、正常交期和适合承接的订单范围，用现场照片或视频作证。" },
  { id: "ip", title: "把擅长的产品和使用场景讲具体", terms: /棉花娃|娃衣|挂件|吉祥物|文创|IP|潮玩/gi, action: "按实际擅长的品类分别做案例页，写清用途、设计要求、材料、工艺和适合的客户。" },
  { id: "quality", title: "用可核实资料说明质量和资质", terms: /认证|资质|验厂|检针|质检|EN71|BSCI|ISO/gi, action: "整理本公司真实有效的质量流程和资质，写清适用范围与日期；没有的资质不要照抄。" },
];

export function buildCompanyFindings(company, own, research, answers, ownResearch = { sources: [], attempts: [] }) {
  const ownByAnswer = new Map(own.evidence.map(e => [e.answerId, e]));
  const answerById = new Map(answers.map(a => [a.id, a]));
  const gaps = company.evidence.filter(e => { const ours = ownByAnswer.get(e.answerId); return !ours || (e.position && (!ours.position || e.position < ours.position)); });
  const questionGroups = new Map();
  for (const e of gaps) { const item = questionGroups.get(e.question) || { question: e.question, times: 0, evidence: e }; item.times++; questionGroups.set(e.question, item); }
  const patterns = themes.map(theme => {
    const matches = company.evidence.filter(e => { theme.terms.lastIndex = 0; return theme.terms.test(e.snippet); });
    const ours = own.evidence.filter(e => { theme.terms.lastIndex = 0; return theme.terms.test(e.snippet); });
    const linked = research.sources.filter(s => { theme.terms.lastIndex = 0; return s.state === "read" && theme.terms.test(s.excerpt || ""); });
    return { id: theme.id, title: theme.title, answerCount: matches.length, ourAnswerCount: ours.length,
      explanation: matches.length ? `豆包介绍它时，有 ${matches.length} 条回答谈到了这方面；介绍我们时有 ${ours.length} 条。${linked.length ? `本次另有 ${linked.length} 个公开页面出现相近内容，可交叉核对。` : "本次尚未找到可交叉核对的公开正文，先视为豆包的推荐表述。"}` : "",
      inference: "这些信息可能让 AI 更容易判断它适合哪类订单，但不能据此确定 AI 的实际推荐原因。", action: theme.action,
      examples: matches.slice(0, 2), sourceUrls: linked.map(s => s.url) };
  }).filter(t => t.answerCount > 0).sort((a,b) => b.answerCount - a.answerCount).slice(0, 4);
  const quoteIds = new Set(company.evidence.map(e => e.answerId));
  const withCitations = [...quoteIds].filter(id => answerById.get(id)?.citations.length).length;
  const readCount = research.sources.filter(s => s.state === "read").length;
  const practiceTypes = [
    { title: "按具体产品或场景做内容", match: s => /棉花娃|吉祥物|挂件|定制|公仔|IP/.test(s.title), meaning: "具体产品和使用场景出现在页面标题中，可能更贴近买家提问，便于搜索与引用。", action: "先从上面我们落后的问题里选一个品类，补一篇对应的产品介绍或真实案例，写清适合谁、能做什么、如何下单。" },
    { title: "把常见问题单独讲清楚", match: s => /常见问题|问答|FAQ|起订|怎么|如何|打样/i.test(`${s.title} ${new URL(s.url).pathname}`), meaning: "把买家会直接提问的问题写成可访问页面，可能方便 AI 找到完整的回答依据。", action: "把真实的起订量、打样流程、交期、材料选择整理成简短问答，放到官网并在相关文章中链接。" },
    { title: "在站外平台留下可检索内容", match: s => /(?:toutiao|sohu|163|qq|ctoy|douyin|bilibili|xiaohongshu|kuaishou)\.com$/.test(new URL(s.url).hostname), meaning: "站外页面增加了可以找到这家公司介绍的入口；这些页面可能是企业自发内容，不自动代表独立媒体背书。", action: "把同一个真实项目整理为官网案例、行业平台介绍和短视频说明，统一公司名称，并附可核实的信息。" },
  ];
  const practices = practiceTypes.map(p => {
    const theirs = research.sources.filter(s => s.state === "read" && p.match(s));
    const ours = ownResearch.sources.filter(s => s.state === "read" && p.match(s));
    return { title: p.title, observed: theirs.length ? `本次读取到同行 ${theirs.length} 个相关页面；我们 ${ours.length} 个。${ours.length ? "可以对照双方标题与内容看差异。" : "本次没读到我们的同类页面，尚不能断定我们没有做。"}` : "", meaning: p.meaning, action: p.action, competitorSources: theirs.map(s => ({ title: s.title, url: s.url })), ourSources: ours.map(s => ({ title: s.title, url: s.url })) };
  }).filter(p => p.competitorSources.length);
  return {
    companyId: company.id, name: company.name, aliases: company.aliases,
    metrics: { mentions: company.mentions, topFive: company.topFive, averagePosition: company.averagePosition, rankedAnswers: company.rankedAnswers },
    ourMetrics: { name: own.name, mentions: own.mentions, topFive: own.topFive, averagePosition: own.averagePosition, rankedAnswers: own.rankedAnswers },
    headline: company.mentions > own.mentions ? `在选定回答中，${company.name}比我们多被提到 ${company.mentions - own.mentions} 次。` : `${company.name}在选定回答中的提及次数没有超过我们，仍可参考它表现较好的具体问题。`,
    takeaway: patterns.length ? `值得先看的是“${patterns[0].title}”。豆包介绍它时反复提到这方面，建议先核对相应原文和公开资料。` : "现有记录还不足以解释它为什么被推荐，请先看具体回答，补充可核实来源后再分析。",
    gaps: [...questionGroups.values()].sort((a,b) => b.times - a.times).slice(0, 8), patterns, practices,
    ourSources: ownResearch.sources, ourSearchAttempts: ownResearch.attempts,
    sources: research.sources, searchAttempts: research.attempts,
    limitations: [`本次 ${company.mentions} 条提及它的回答中，${withCitations} 条保留了引用链接。回答中的厂房、产能、资质等表述不自动视为公司事实。`,
      `公开检索读取并核对到名称的页面：${readCount} 个。检索结果摘要、无法读取的网页和同名待核对页面不用于证明同行的实际做法。`,
      "短视频研究只覆盖可访问的公开文字介绍，不表示已经观看视频或核实账号归属。", "本报告比较所选豆包回答中的表现；公开资料能提供可能的解释，无法直接证明 AI 的内部推荐原因。"]
  };
}
