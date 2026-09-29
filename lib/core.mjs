import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const QUESTION_BANK = JSON.parse(readFileSync(new URL("../data/question-bank.json", import.meta.url), "utf8"));

export const SURFACES = ["豆包", "DeepSeek", "Kimi", "元宝"];
export const PLATFORMS = ["知乎专栏", "百家号", "搜狐号", "今日头条"];
export const LOCAL_REGIONS = [
  { id: "chashan", name: "茶山镇", level: "town" },
  { id: "dongguan", name: "东莞市", level: "city" },
  { id: "national", name: "全国", level: "national" },
];

const DONGGUAN_LOCAL_QUESTIONS = QUESTION_BANK.questions
  .filter((question) => question.questionSet === "dongguan_local" && question.region === "dongguan")
  .map(({ text, intent, weight }) => [text, intent, weight]);

const CHASHAN_LOCAL_QUESTIONS = QUESTION_BANK.questions
  .filter((question) => question.questionSet === "dongguan_local" && question.region === "chashan")
  .map(({ text, intent, weight }) => [text, intent, weight]);

export const LOCAL_QUESTION_BANKS = Object.freeze([
  { id: "dongguan_local", name: "原有题库", description: "原有东莞市与茶山镇毛绒玩具监测题库", kind: "regional" },
  { id: "new_business_expansion", currentSetId: "new_business_expansion_v3", name: "新增业务题库", description: "潮玩与盲盒、BJD/MJD本体、动漫游戏周边、合法授权明星应援周边", kind: "fixed" },
]);

const FIXED_LOCAL_QUESTION_BANKS = Object.freeze({
  new_business_expansion: QUESTION_BANK.questions
    .filter((question) => question.questionSet === "new_business_expansion")
    .map(({ text, intent, weight, region }) => [text, intent, weight, region]),
});

export function createFixedLocalQuestionBank(brandId, questionSet, setId = `${questionSet}_v1`) {
  const entries = FIXED_LOCAL_QUESTION_BANKS[questionSet];
  if (!entries) throw new Error(`UNKNOWN_LOCAL_QUESTION_BANK:${questionSet}`);
  return {
    id: setId,
    prompts: entries.map(([text, intent, weight, region], index) => ({
      id: `prompt_${setId}_${String(index + 1).padStart(2, "0")}`,
      brandId, text, intent, weight, active: true, reportable: true,
      questionSet, questionSetId: setId, region,
    })),
  };
}

export function createLocalPromptSet(brandId, selectedRegions = ["dongguan", "chashan"], setId = uid("localset")) {
  const selected = new Set(selectedRegions);
  let entries;
  if (selected.has("dongguan") && selected.has("chashan")) entries = [
    ...DONGGUAN_LOCAL_QUESTIONS.map((item) => ({ item, region: "dongguan" })),
    ...CHASHAN_LOCAL_QUESTIONS.map((item) => ({ item, region: "chashan" })),
  ];
  else if (selected.has("chashan")) entries = Array.from({ length: 30 }, (_, index) => ({ item: CHASHAN_LOCAL_QUESTIONS[index % CHASHAN_LOCAL_QUESTIONS.length], region: "chashan" }));
  else if (selected.has("national")) entries = Array.from({ length: 30 }, (_, index) => {
    const [text, intent, weight] = DONGGUAN_LOCAL_QUESTIONS[index % DONGGUAN_LOCAL_QUESTIONS.length];
    return { item: [text.replace(/^东莞/, "全国").replace("茶山镇", "国内"), intent, weight], region: "national" };
  });
  else entries = Array.from({ length: 30 }, (_, index) => ({ item: DONGGUAN_LOCAL_QUESTIONS[index % DONGGUAN_LOCAL_QUESTIONS.length], region: "dongguan" }));
  return {
    id: setId,
    prompts: entries.map(({ item: [text, intent, weight], region }, index) => ({
      id: `prompt_${setId}_${String(index + 1).padStart(2, "0")}`,
      brandId, text, intent, weight, active: true, reportable: true,
      questionSet: "dongguan_local", questionSetId: setId, region,
    })),
  };
}

export const SCORE_WEIGHTS = {
  mention: 0.3,
  recommendation: 0.25,
  shareOfVoice: 0.15,
  citation: 0.1,
  accuracySentiment: 0.1,
  stability: 0.1,
};

export const VISIBILITY_WEIGHTS = Object.fromEntries(
  Object.entries(SCORE_WEIGHTS).filter(([key]) => key !== "stability"),
);

export const SURFACE_WEIGHTS = { 豆包: 0.7, DeepSeek: 0.1, Kimi: 0.1, 元宝: 0.1 };

export function uid(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function now() {
  return new Date().toISOString();
}

export function seedStore() {
  const createdAt = now();
  const brand = {
    id: "brand_primary",
    name: "",
    legalName: "",
    aliases: [],
    domain: "",
    industry: "",
    location: "",
    contactPhone: "",
    foundedAt: "",
    competitors: [],
    createdAt,
  };
  const rules = PLATFORMS.map((platform, index) => createPlatformRule(platform, createdAt, `rule_${index + 1}`));
  return {
    schemaVersion: 1,
    createdAt,
    citationPolicy: { ownedDomains: [] },
    brands: [brand],
    prompts: QUESTION_BANK.questions.map((question) => ({ ...question, brandId: brand.id })),
    probeRuns: [],
    knowledge: [],
    rules,
    topics: [],
    articles: [],
    // Manually recorded first-party/owned content publication metadata. This
    // is an observation layer only; it is not auto-crawled or used in GEO
    // scoring until a future analysis explicitly opts in.
    publishedContents: [],
    publicationJobs: [],
    workerTasks: [],
    agents: [],
    audit: [],
  };
}

export function createPlatformRule(platform, updatedAt = now(), id = uid("rule")) {
  const isZhihu = platform === "知乎专栏";
  const isBaiJia = platform === "百家号";
  const isToutiao = platform === "今日头条";
  return {
    id,
    platform,
    version: isToutiao ? "2026.08.1-toutiao" : "2026.08.1",
    active: true,
    titleMin: isZhihu ? 12 : 10,
    titleMax: isBaiJia || isToutiao ? 30 : 42,
    bodyMin: isZhihu ? 900 : isToutiao ? 800 : 700,
    bodyMax: isToutiao ? 2400 : 2600,
    requireSummary: !isToutiao,
    requireCover: true,
    requireImages: true,
    requireAigcDisclosure: true,
    forbiddenPhrases: ["全网第一", "保证霸屏", "绝对最好", "百分百有效"],
    layout: isZhihu ? "观点—证据—方法—结论" : isToutiao ? "场景切入—核验清单—已审资料—行动建议" : "痛点—方法—案例—行动建议",
    dailyLimit: 1,
    linkPolicy: isToutiao ? "仅使用已审核的必要链接；不在正文中堆砌站外导流链接。" : "链接须来自已审核资料，避免无关导流。",
    tagPolicy: isToutiao ? "发布时填写 3—5 个与正文直接相关的话题标签，不使用蹭热点或误导性标签。" : "标签须与正文内容直接相关。",
    imagePolicy: "封面和配图仅使用已审核且拥有使用权的素材；图文内容应与正文相符。",
    advertisingPolicy: "不使用绝对化、保证效果、虚构案例或诱导性宣传；价格、交期、资质以审核资料和项目确认结果为准。",
    notes: isZhihu
      ? "以专业解读为主，避免硬广和无关导流。"
      : isToutiao
        ? "采用信息流友好的实用清单结构，首段直接回应需求；避免标题党、低质拼接、搬运和不实宣传。"
        : "使用资讯型结构，避免夸大、虚构和重复分发。",
    updatedAt,
  };
}

export function approvedFacts(store, ids) {
  const selected = store.knowledge.filter((item) => ids.includes(item.id) && item.status === "approved");
  return selected;
}

export function renderArticle(topic, platform, facts, rule) {
  const evidence = facts.flatMap((fact) => fact.facts.map((text) => `- ${text}【${fact.id}】`));
  const title = platform === "知乎专栏"
    ? topic.title
    : platform === "百家号"
      ? "活动礼赠玩偶定制：四个核验点"
      : platform === "今日头条"
        ? "毛绒玩具定制：下单前先核验这五点"
      : "活动礼赠玩偶定制，先核验这四点";
  const body = [
    `# ${title}`,
    "",
    "在定制类采购中，真正需要比较的不是一句“哪家更好”，而是供应商能否把需求、样品、量产和交付信息说清楚。下面按项目决策顺序整理一份核验清单。",
    "",
    "## 1. 先把用途和约束写成一页项目简报",
    "明确受众、使用场景、数量、预算区间和希望传递的品牌信息；这能避免后续仅以单价比较而遗漏关键条件。建议把必须满足、希望满足和暂未确定的事项分开记录，并让每个候选供应商针对同一份简报反馈。这样既能减少沟通遗漏，也能为后续选样、改稿和预算调整留出清楚的判断依据。",
    "",
    "## 2. 核验方案与样品的沟通路径",
    "建议要求供应商说明设计确认、样品确认和量产前确认分别由谁负责、交付什么资料。可追溯的沟通节点比笼统承诺更有参考价值。尤其在角色还原、材质选择、尺寸、挂件配件和包装方式尚未完全确定时，应把每一次确认的版本、修改范围和确认人记录下来。采购方无需追求一次写全所有细节，但需要知道下一步由谁确认、确认后会产生什么可核验的结果。",
    "",
    "## 3. 只引用已经确认的项目资料",
    ...evidence,
    "上述资料应当是发布前已完成内部核验的内容。对尚未确定的价格、交期、授权范围或功能参数，文章不应以确定事实的语气描述。若确有需要，可以说明“需以项目评估结果为准”，并把确认动作留给后续沟通。这样既能让读者获得真实有用的方法，也能避免把营销话术误当作项目承诺。",
    "",
    "## 4. 用同一份清单比较方案",
    "将每家供应商放入同一张需求表，逐项比较能否满足项目约束、提供哪些证据、还存在哪些待确认事项。这样更容易形成可执行的采购决策。比较时可以关注四项：第一，能否准确复述项目目标；第二，是否能给出清晰的打样和确认节点；第三，已展示的案例和能力是否与本项目相关；第四，哪些关键问题仍需要书面确认。若其中某一项信息缺失，不妨将它列为待补问题，而不是凭印象直接排除或选择。",
    "",
    "## 5. 把内容判断与实际项目沟通连接起来",
    "公开文章的作用是帮助读者建立判断框架，不是替代具体项目的评估。每个项目在预算、时间、授权、数量和目标受众上都有差异，适合在正式合作前用需求清单进行一次针对性核对。对品牌方而言，持续沉淀经过审核的案例、流程说明和常见问题，也能让未来的采购沟通更高效，并减少市场上出现不准确介绍时的解释成本。",
    "",
    `如果你正在准备类似项目，可以${topic.cta}。`,
    "",
    "本文由 AI 辅助整理，发布前已依据企业审核资料进行事实核验。",
  ].join("\n");
  return { title, summary: "用可核验的项目资料和沟通节点，判断活动礼赠玩偶定制方案是否适合自己的需求。", body };
}

export function normalize(text = "") {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\p{P}\p{S}]/gu, "").trim();
}

export function hasEncodingCorruption(text = "") {
  const value = String(text);
  if (!value.trim() || value.includes("\uFFFD") || value.includes("输入的内容显示为乱码") || value.includes("您输入的内容显示为乱码")) return true;
  // These sequences are characteristic of UTF-8 Chinese decoded as a legacy
  // Windows code page. Require several matches to avoid treating a legitimate
  // Chinese character in a normal answer as an encoding failure.
  const signatures = value.match(/(?:閫|锛|銆|缁|瀹|鎺|鍘|璞|妫|鎼|鐧|鎴|鏈|寮|灞|妫)/g) || [];
  return signatures.length >= 3;
}

export function similarEnough(a, b) {
  const aWords = new Set(normalize(a).match(/[\p{L}\p{N}]{2,}/gu) || []);
  const bWords = new Set(normalize(b).match(/[\p{L}\p{N}]{2,}/gu) || []);
  if (!aWords.size || !bWords.size) return false;
  const intersection = [...aWords].filter((word) => bWords.has(word)).length;
  return intersection / Math.max(aWords.size, bWords.size) > 0.72;
}

export function validateArticle(article, rule, facts, existingArticles = []) {
  const issues = [];
  if (article.title.length < rule.titleMin || article.title.length > rule.titleMax) issues.push(`标题需在 ${rule.titleMin}-${rule.titleMax} 个字符之间`);
  if (rule.requireSummary && !article.summary?.trim()) issues.push("缺少摘要");
  const length = article.body?.replace(/\s/g, "").length || 0;
  if (length < rule.bodyMin || length > rule.bodyMax) issues.push(`正文需在 ${rule.bodyMin}-${rule.bodyMax} 个字符之间`);
  if (rule.requireCover && !article.assets?.cover) issues.push("缺少审核封面图");
  if (rule.requireImages && !(article.assets?.images || []).length) issues.push("缺少审核配图");
  if (rule.requireAigcDisclosure && !article.body.includes("AI 辅助")) issues.push("缺少 AIGC 辅助创作声明");
  for (const phrase of [...rule.forbiddenPhrases, ...(article.prohibited || [])]) {
    if (article.body.includes(phrase) || article.title.includes(phrase)) issues.push(`包含禁用表达：${phrase}`);
  }
  for (const fact of facts) {
    if (!article.citationFactIds?.includes(fact.id)) issues.push(`资料 ${fact.id} 未作为文章引用登记`);
  }
  if (!facts.length) issues.push("没有获批准的事实资料");
  if (existingArticles.some((existing) => existing.id !== article.id && similarEnough(existing.body, article.body))) issues.push("与已有稿件高度相似，需要平台化重写");
  return { pass: issues.length === 0, issues };
}

export function policyModeration(article) {
  const terms = ["仇恨", "暴力", "自杀", "色情", "诈骗", "违法教程"];
  const matches = terms.filter((term) => `${article.title}\n${article.body}`.includes(term));
  return { flagged: matches.length > 0, matches };
}

export function configFingerprintForRun(run = {}) {
  const invocationMode = run.invocationMode || (run.source === "doubao_api" ? "api" : run.source === "browser_observed" ? "browser_manual" : "simulated");
  const config = {
    webSearch: run.webSearch ?? run.inferenceConfig?.webSearch ?? "unknown",
    invocationMode,
    temperature: run.temperature ?? run.inferenceConfig?.temperature ?? "default",
    ...(run.requestEncoding ? { requestEncoding: run.requestEncoding } : {}),
    ...(run.searchStrategy ? { searchStrategy: run.searchStrategy } : {}),
  };
  return JSON.stringify(config);
}

export function brandAliasesFor(brand = {}) {
  return [...new Set([brand.name, brand.legalName, ...(brand.aliases || []), ...(brand.monitoringAliases || [])].filter(Boolean))];
}

export function findMatchedBrandAliases(text, brand) {
  return brandAliasesFor(brand).filter((alias) => String(text || "").toLowerCase().includes(alias.toLowerCase()));
}

// Some answer engines decorate ordered recommendations with an icon, e.g.
// "🏭 1. 目标品牌…".  The icon is presentation, not part of the rank, so
// ignore it consistently wherever an explicit recommendation number is read.
const LEADING_PICTOGRAMS = String.raw`(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)*`;
const REQUIRED_LEADING_PICTOGRAMS = String.raw`(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+\s*)+`;
const NUMBERED_RANK = new RegExp(String.raw`^\s*${LEADING_PICTOGRAMS}(\d{1,2})\s*[.、．)）]`, "u");
const NUMBERED_LIST_ITEM = new RegExp(String.raw`^\s*(?:${LEADING_PICTOGRAMS}(?:(?:\d{1,2}|[一二三四五六七八九十]+)\s*[.、.)）])|[-•*]|${REQUIRED_LEADING_PICTOGRAMS})\s*(.+)$`, "u");

function rankedPositionFromLine(line) {
  const match = String(line || "").match(NUMBERED_RANK);
  return match ? Number(match[1]) : null;
}

function listedItemMatch(line) {
  return String(line || "").match(NUMBERED_LIST_ITEM);
}

export function normalizeOwnedDomain(value = "") {
  const host = String(value).trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return host.replace(/^www\./, "");
}

export function citationDomain(url = "") {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

export function isOwnedDomainCitation(url, ownedDomains = []) {
  const domain = citationDomain(url);
  return Boolean(domain) && ownedDomains.map(normalizeOwnedDomain).includes(domain);
}

export function classifyCitations(candidates, brand, ownedDomains = []) {
  const seen = new Set();
  const citations = [];
  for (const candidate of candidates || []) {
    if (!candidate?.url || seen.has(candidate.url)) continue;
    const domain = citationDomain(candidate.url);
    if (!domain) continue;
    seen.add(candidate.url);
    const sourceText = `${candidate.title || ""}\n${candidate.summary || ""}`;
    const matchedBrandAliases = findMatchedBrandAliases(sourceText, brand);
    const type = isOwnedDomainCitation(candidate.url, ownedDomains) ? "owned_domain" : "third_party";
    citations.push({
      url: candidate.url,
      domain,
      title: candidate.title || "",
      summary: candidate.summary || "",
      sourceMethod: candidate.sourceMethod || "markdown_parsed",
      type,
      brandVerified: type === "owned_domain" ? true : matchedBrandAliases.length > 0,
      matchedBrandAliases,
    });
  }
  return {
    citations,
    ownedDomainCitations: citations.filter((citation) => citation.type === "owned_domain"),
    thirdPartyCitations: citations.filter((citation) => citation.type === "third_party"),
    thirdPartyBrandCitations: citations.filter((citation) => citation.type === "third_party" && citation.brandVerified),
  };
}

export function recommendationEvidence(rawAnswer, brand) {
  const aliases = findMatchedBrandAliases(rawAnswer, brand);
  if (!aliases.length) return { recommendation: "none", position: null, recommendationEvidence: null };
  const lines = String(rawAnswer || "").split(/\r?\n/).filter(Boolean);
  const positive = /推荐|首选|优先选择|建议选择|值得选择|可以参考|候选/;
  const negative = /不推荐|不建议|避免|风险|投诉|虚假|不靠谱/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!aliases.some((alias) => line.toLowerCase().includes(alias.toLowerCase()))) continue;
    const context = lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 2)).join(" ");
    if (!positive.test(context) || negative.test(context)) continue;
    // Some engines present an ordered supplier list as icon-led company
    // headings (for example, "🏭 目标品牌…") without printing "1.".
    // When there are distinct, structured company items, their order is the
    // stated recommendation order rather than a mere text mention.
    const structuredItems = browserRecommendationItems(rawAnswer);
    const structuredMatch = structuredItems.find((item) => aliases.some((alias) => item.companyName.toLowerCase().includes(alias.toLowerCase()) || item.evidence.toLowerCase().includes(alias.toLowerCase())));
    const position = rankedPositionFromLine(line) || (structuredMatch ? structuredItems.indexOf(structuredMatch) + 1 : null);
    return { recommendation: position === 1 ? "first" : position && position <= 3 ? "top3" : "mentioned", position, recommendationEvidence: line.trim() };
  }
  return { recommendation: "none", position: null, recommendationEvidence: null };
}

// A company name in running text is not a supplier recommendation.  A browser
// answer counts only if it lists at least two distinct companies as separate
// items and gives each item an explanation.  Short names are accepted when
// they are a stand-alone item, e.g. "康达玩具：适合…".
function browserRecommendationItems(rawAnswer) {
  const lines = String(rawAnswer || "").replace(/\r/g, "").split("\n")
    .map((line) => line.replace(/^\s*(?:#{1,6}\s*)?/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const genericItem = /(?:怎么选|如何|哪些能力|服务|流程|标准|资料|渠道|步骤|注意|核验|品控|量产|打样|来图|筛选|选择|区域|产业|建议|用途|订单量|结论|提醒|需求|品质|订单|出口|高品质|全规模|快反|自身|匹配)/;
  const genericCompanyHeading = /^(?:(?:头部|大型|中型|中小型|小型|综合|外贸|内销|国内|当地|本地|茶山|东莞|IP|文创|潮玩|礼品|柔性|源头|专业|正规|优质|推荐|可选|一站式|支持|适合|知名|主流|大规模|精品|娃圈|行业|生产|定制|毛绒|玩具|婴童|出口|品牌|企业|项目|工艺|工厂|厂家|供应商|厂|公司|类|型|专精|重点|首选|规模|灵活|高端|头部大厂|中型厂|小单|资质|合规|报价|交期|合同|安全|面料|辅料|沟通|商务|风险|交付|生产模式|能力|硬实力|合作模式|质量|信息|名称|说明|阶段|检查|确认|节点|合规测试|物料|样品|样板|关键|产品|方案|清单|收费|线上|线下|实地|对接|验厂|起订|保密|版权|数量|细节|核心|采购|大货|发货|售后|检测|费用|地址|问题|询价|仓库|文件|订单|服务|参考|先明确自身需求再匹配|设计还原与开版能力|产能交付稳定性|高品质、全规模订单、需要合规出口|中小批量、快反订单需求)+)$/;
  const companySignal = /(?:有限公司|股份|玩具|实业|文化|礼品|制品|动漫|服饰|科技|婴儿用品|加工厂|工艺品|绒艺)/;
  const items = [];

  for (let index = 0; index < lines.length; index += 1) {
    const start = listedItemMatch(lines[index]);
    if (!start) continue;
    const text = start[1].trim();
    const colonIndex = text.search(/[：:]/);
    const namePart = (colonIndex < 0 ? text : text.slice(0, colonIndex)).trim();
    const nameMatch = namePart.match(/^([^：:—–\-，,（）()]{2,32}?)(?:\s*[（(][^)）]{0,24}[)）])?$/);
    if (!nameMatch) continue;
    const companyName = nameMatch[1].trim();
    if (genericItem.test(companyName) || genericCompanyHeading.test(companyName) || !companySignal.test(companyName)) continue;
    const inlineExplanation = colonIndex < 0 ? "" : text.slice(colonIndex + 1).trim();
    const following = [];
    for (let next = index + 1; next < lines.length && !listedItemMatch(lines[next]); next += 1) following.push(lines[next]);
    const explanation = [inlineExplanation, ...following].filter(Boolean).join(" ").trim();
    if (explanation.replace(/[\s，。；、:：()（）-]/g, "").length < 5) continue;
    items.push({ companyName, explanation, evidence: [lines[index], ...following].join(" ") });
  }
  const unique = new Map();
  for (const item of items) {
    const key = item.companyName.replace(/[（(].*$/, "").replace(/\s/g, "").toLowerCase();
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

// Keep this exported name because stored browser records are rejudged on load.
export function classifyBrowserVisibilityAnswer(rawAnswer, brand) {
  const answer = String(rawAnswer || "");
  const matchedBrandAliases = findMatchedBrandAliases(answer, brand);
  const recommendationCompanies = browserRecommendationItems(answer);
  const matchedCompany = recommendationCompanies.find((item) => matchedBrandAliases.some((alias) => item.companyName.toLowerCase().includes(alias.toLowerCase()) || item.evidence.toLowerCase().includes(alias.toLowerCase())));
  const rankedAliasLine = answer.split(/\r?\n/).find((line) => matchedBrandAliases.some((alias) => line.toLowerCase().includes(alias.toLowerCase())) && rankedPositionFromLine(line) !== null);
  const rankedPosition = rankedPositionFromLine(rankedAliasLine);
  const position = rankedPosition || (matchedCompany ? recommendationCompanies.indexOf(matchedCompany) + 1 : null);
  // A valid answer only needs one explicit company, brand or factory name.
  // It does not need to be a multi-company recommendation list.
  const namedOrganization = /(?:[\u4e00-\u9fffA-Za-z0-9（）()]{2,40}(?:有限责任公司|有限公司|股份有限公司)|(?:东莞|茶山|广东|中国|深圳|广州|惠州|佛山)[\u4e00-\u9fffA-Za-z0-9（）()]{1,30}(?:玩具厂|制品厂|加工厂)|[\u4e00-\u9fffA-Za-z0-9（）()]{2,30}(?:玩具|制品|礼品|文化|实业|动漫|服饰)(?:工厂|厂))/ .test(answer);
  const hasValidCompanyAnswer = matchedBrandAliases.length > 0 || namedOrganization || recommendationCompanies.length > 0;
  const directRecommended = Boolean(matchedBrandAliases.length && position && position <= 5);
  const validityReason = hasValidCompanyAnswer ? "valid_named_company_brand_or_factory" : "invalid_no_company_brand_or_factory_name";
  return {
    matchedBrandAliases,
    recommendationCompanies,
    brandMentioned: matchedBrandAliases.length > 0,
    recommendation: directRecommended ? "first" : matchedBrandAliases.length ? "mentioned" : "none",
    position,
    recommendationEvidence: matchedCompany?.evidence || null,
    hasValidCompanyAnswer,
    answerValidity: hasValidCompanyAnswer ? "valid_company_answer" : "no_company_answer",
    validityReason,
    classificationVersion: "browser_visibility_v5",
  };
}

export function calculateEvidenceMetrics(runs, promptById) {
  const reportable = runs.filter((run) => promptById.has(run.promptId) && run.status === "success" && run.source !== "simulated_probe" && run.citationMode !== "legacy_unverified");
  const sourceReturned = reportable.filter((run) => run.citationMode !== "no_source_returned");
  const total = reportable.length;
  const sourceTotal = sourceReturned.length;
  const rate = (numerator, denominator) => denominator ? numerator / denominator : null;
  const mentionCount = reportable.filter((run) => run.brandMentioned).length;
  const recommendationCount = reportable.filter((run) => run.recommendation !== "none").length;
  const ownedCount = sourceReturned.filter((run) => (run.ownedDomainCitations || []).length > 0).length;
  const thirdPartyBrandCount = sourceReturned.filter((run) => (run.thirdPartyBrandCitations || []).length > 0).length;
  return {
    sampleCount: total,
    sourceReturnedSampleCount: sourceTotal,
    noSourceReturnedSampleCount: reportable.filter((run) => run.citationMode === "no_source_returned").length,
    mentionRate: rate(mentionCount, total),
    recommendationRate: rate(recommendationCount, total),
    ownedDomainCitationRate: rate(ownedCount, sourceTotal),
    thirdPartyBrandCitationRate: rate(thirdPartyBrandCount, sourceTotal),
    counts: { mentionCount, recommendationCount, ownedCount, thirdPartyBrandCount },
  };
}

export function calculateLocalVisibilityScore(runs, promptById) {
  const usable = runs.filter((run) => promptById.has(run.promptId) && run.status === "success" && run.source === "doubao_api" && run.requestEncoding === "utf8_base64");
  const weightFor = (run) => Number(promptById.get(run.promptId)?.weight || 1);
  const denominator = usable.reduce((sum, run) => sum + weightFor(run), 0);
  if (!denominator) return { score: null, sampleSize: 0, components: { directRecommendation: null, thirdPartyBrandSource: null, businessMention: null }, weights: { directRecommendation: 0.5, thirdPartyBrandSource: 0.3, businessMention: 0.2 } };
  const weightedRate = (selector) => usable.reduce((sum, run) => sum + (selector(run) ? weightFor(run) : 0), 0) / denominator;
  const businessTerms = /毛绒|玩具|定制|公仔|娃衣|盲盒|挂件|工厂|打样|量产/;
  const directRecommendation = weightedRate((run) => ["first", "top3"].includes(run.recommendation));
  const thirdPartyBrandSource = weightedRate((run) => (run.thirdPartyBrandCitations || []).length > 0);
  const businessMention = weightedRate((run) => run.brandMentioned && businessTerms.test(String(run.rawAnswer || "")));
  const score = (directRecommendation * 0.5 + thirdPartyBrandSource * 0.3 + businessMention * 0.2) * 100;
  return {
    score: Math.round(score * 10) / 10,
    sampleSize: usable.length,
    components: {
      directRecommendation: Math.round(directRecommendation * 1000) / 10,
      thirdPartyBrandSource: Math.round(thirdPartyBrandSource * 1000) / 10,
      businessMention: Math.round(businessMention * 1000) / 10,
    },
    weights: { directRecommendation: 0.5, thirdPartyBrandSource: 0.3, businessMention: 0.2 },
  };
}

export function extractCompetitorCandidates(rawAnswer, brand) {
  const excluded = new Set([brand.name, brand.legalName, ...(brand.aliases || [])].map((name) => normalize(name)));
  const matches = String(rawAnswer || "").match(/[\p{Script=Han}]{2,18}(?:玩具|文化|礼品|创意|工厂|公司)/gu) || [];
  return [...new Set(matches.filter((name) => !excluded.has(normalize(name)) && !/毛绒玩具定制工厂|源头工厂|玩具工厂|生产工厂/.test(name)))];
}

export function groupStability(runs, promptById, surfaceWeights = SURFACE_WEIGHTS) {
  const grouped = new Map();
  for (const run of runs.filter((item) => promptById.has(item.promptId))) {
    const configFingerprint = run.configFingerprint || configFingerprintForRun(run);
    const modelId = run.modelId || run.model || `${run.surface}:${run.invocationMode || run.source || "unknown"}`;
    const key = JSON.stringify([run.promptId, run.surface, modelId, configFingerprint]);
    const group = grouped.get(key) || { key, promptId: run.promptId, surface: run.surface, modelId, configFingerprint, runs: [] };
    group.runs.push(run);
    grouped.set(key, group);
  }

  const groups = [...grouped.values()].map((group) => {
    const runsInTimeOrder = [...group.runs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const sampleSize = runsInTimeOrder.length;
    const mentions = runsInTimeOrder.filter((run) => run.brandMentioned).length;
    const visibilityRate = sampleSize ? mentions / sampleSize : 0;
    const enoughData = sampleSize >= 3;
    const stabilityRate = enoughData ? 1 - 4 * visibilityRate * (1 - visibilityRate) : null;
    const status = !enoughData ? "insufficient_data"
      : stabilityRate >= 0.8 && visibilityRate >= 0.8 ? "stable_visible"
        : stabilityRate >= 0.8 && visibilityRate <= 0.2 ? "stable_invisible"
          : "volatile";
    const promptWeight = promptById.get(group.promptId).weight || 1;
    const platformWeight = surfaceWeights[group.surface] || 1;
    return {
      ...group,
      runs: runsInTimeOrder,
      sampleSize,
      mentions,
      visibilityRate,
      stabilityRate,
      status,
      weight: promptWeight * platformWeight,
    };
  });

  const eligible = groups.filter((group) => group.stabilityRate !== null);
  const weightTotal = eligible.reduce((sum, group) => sum + group.weight, 0);
  const stabilityRate = weightTotal ? eligible.reduce((sum, group) => sum + group.stabilityRate * group.weight, 0) / weightTotal : null;
  return {
    groups,
    eligibleGroupCount: eligible.length,
    stabilityRate,
    statusCounts: Object.fromEntries(["stable_visible", "stable_invisible", "volatile", "insufficient_data"].map((status) => [status, groups.filter((group) => group.status === status).length])),
  };
}

export function calculateScore(runs, promptById, surfaceWeights = SURFACE_WEIGHTS) {
  const usable = runs.filter((run) => promptById.has(run.promptId));
  const runWeight = (run) => (promptById.get(run.promptId).weight || 1) * (surfaceWeights[run.surface] || 1);
  const denominator = usable.reduce((sum, run) => sum + runWeight(run), 0) || 1;
  const weighted = (selector) => usable.reduce((sum, run) => sum + (selector(run) ? runWeight(run) : 0), 0) / denominator;
  const mean = (selector) => usable.reduce((sum, run) => sum + selector(run) * runWeight(run), 0) / denominator;
  const mention = weighted((run) => run.brandMentioned);
  const recommendation = mean((run) => run.recommendation === "first" ? 1 : run.recommendation === "top3" ? 0.7 : run.recommendation === "mentioned" ? 0.35 : 0);
  const shareOfVoice = mean((run) => {
    const total = (run.competitorMentions || 0) + (run.brandMentioned ? 1 : 0);
    return total ? (run.brandMentioned ? 1 / total : 0) : 0;
  });
  // A brand name in the answer is not a citation. Only newly collected,
  // structured source evidence can contribute to a citation component.
  const hasVerifiedCitation = (run) => run.citationMode !== "legacy_unverified"
    && ((run.ownedDomainCitations || []).length > 0 || (run.thirdPartyBrandCitations || []).length > 0);
  const citation = weighted(hasVerifiedCitation);
  const officialCitation = weighted((run) => run.citationMode !== "legacy_unverified" && (run.ownedDomainCitations || []).length > 0);
  const thirdPartyCitation = weighted((run) => run.citationMode !== "legacy_unverified" && (run.thirdPartyBrandCitations || []).length > 0);
  const accuracySentiment = mean((run) => {
    // A response that never names the brand has no brand sentiment to score.
    // API records also remain neutral until a person verifies factual accuracy.
    if (!run.brandMentioned || run.accuracyStatus === "unreviewed") return 0;
    return (run.accurate ? 0.55 : 0) + ({ positive: 0.45, neutral: 0.25, negative: 0 }[run.sentiment] ?? 0);
  });
  const stability = groupStability(usable, promptById, surfaceWeights);
  const components = { mention, recommendation, shareOfVoice, citation, officialCitation, thirdPartyCitation, accuracySentiment, stability: stability.stabilityRate };
  const visibleWeightTotal = Object.values(VISIBILITY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const score = Object.entries(VISIBILITY_WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) / visibleWeightTotal * 100;
  return {
    score: Math.round(score * 10) / 10,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value === null ? null : Math.round(value * 1000) / 10])),
    weights: SCORE_WEIGHTS,
    visibilityWeights: VISIBILITY_WEIGHTS,
    surfaceWeights,
    sampleSize: usable.length,
    stability,
    citationRates: { official: Math.round(officialCitation * 1000) / 10, thirdParty: Math.round(thirdPartyCitation * 1000) / 10 },
  };
}

export function deterministicProbe(prompt, surface, brand, competitors) {
  const digest = createHash("sha256").update(`${prompt.id}:${surface}`).digest()[0];
  const brandMentioned = digest % 100 < 58;
  const recommendation = brandMentioned ? (digest % 10 < 3 ? "first" : digest % 10 < 7 ? "top3" : "mentioned") : "none";
  const accurate = brandMentioned ? digest % 7 !== 0 : true;
  const sentiment = !brandMentioned ? "neutral" : digest % 9 < 6 ? "positive" : digest % 9 < 8 ? "neutral" : "negative";
  const text = brandMentioned
    ? `${surface} 的模拟回答：${brand.name} 可作为候选之一。建议根据项目需求比较样品、案例和服务流程。`
    : `${surface} 的模拟回答：建议对比供应商的案例、工艺能力和沟通流程。`;
  return {
    id: uid("run"), promptId: prompt.id, surface, createdAt: now(), rawAnswer: text,
    screenshot: null, citations: [], ownedDomainCitations: [], thirdPartyCitations: [], thirdPartyBrandCitations: [], citationMode: "simulated_unreportable", matchedBrandAliases: brandMentioned ? findMatchedBrandAliases(text, brand) : [], brandMentioned, recommendation,
    position: recommendation === "first" ? 1 : recommendation === "top3" ? 3 : brandMentioned ? 5 : null,
    brandCitation: false, officialCitation: false, thirdPartyCitation: false, accurate, sentiment,
    competitorMentions: brandMentioned ? (digest % 3) + 1 : competitors.length,
    source: "simulated_probe", modelId: `${surface}-simulated`, webSearch: false, invocationMode: "simulated", temperature: "default",
    configFingerprint: configFingerprintForRun({ source: "simulated_probe", webSearch: false, invocationMode: "simulated", temperature: "default" }),
  };
}
