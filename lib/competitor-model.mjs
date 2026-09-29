import { createHash, randomUUID } from "node:crypto";
import { effectivePlatform } from "./platform.mjs";

export const nameKey = (name) => String(name || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 20);
const clock = () => new Date().toISOString();
const ownId = "our-company";
const clean = (s) => String(s || "").replace(/\*\*|__|`/g, "").replace(/^\s*(?:#{1,6}\s*)?/, "").trim();
const numbered = /^(?:(\d{1,2})|([一二三四五六七八九十]{1,3}))\s*[.、．)）]\s*/;
const generic = /^(?:定制能力|核心优势|适合订单|推荐理由|注意事项|采购建议|公司名称|工厂名称|厂家名称|毛绒玩具|源头工厂|玩具工厂|定制工厂|生产工厂|推荐工厂|厂家|公司|名称|地区|排名|序号|企业名称|参考资料|联系方式)$/;
const signal = /公司|工厂|玩具|制品|实业|文化|动漫|服饰|礼品|科技|供应链|工作室|绒艺|玩偶/;
const genericWords = /^(?:(?:广东省?|东莞市?|茶山镇?|全国|本地|当地|专业|中小|大型|小型|中型|源头|工厂|工艺|尺寸|数量|交期|面料|大厂|胶脸|棉花娃娃?|娃衣|挂件|毛绒|玩具|定制|产品|潮玩|IP|形象|设计|起订|打样|生产|企业|礼品|文创|厂家|推荐|区域|渠道|出口|外贸|内销|能力|配件|包装|合规|流程|重点|说明|适合|需求|预算|是否需要|质量|优势|服务|产能|价位|价格|采购|资质|认证|地址|位置|联系方式|规模|案例|还原度|注意事项|绣花|刺绣|检针|品控|报价|合同|大货|小单|小批量|合作|交付|周期|信息|标准|支持|来图来样|来图|来样|抱枕|公仔|玩偶|棉花娃|人偶服|吉祥物|证据|地域|品类|IP周边|选择|方案|风格|领域|订单|实力|综合|品牌|渠道|细节|清单|建议|方式|供应商|选型|快速|参考|明确|项目|经验|偏好|石排镇|寮步镇|厚街镇|头部|精品|灵活|中端|高端|ODM|OEM|大规模|厂|向|型|类|和|与|的|等|及|一站式|年|万元|米|天|家|个|件|只|[\d+ /（）()·—-])+)$ /i;
const genericName = new RegExp(genericWords.source.replace("$ ", "$"), "i");

function candidateName(text) {
  const n = clean(text).replace(/^(?:备选|推荐|首选)[：:]\s*/, "").replace(/^我们是/, "").split(/[：:，,；;｜|]/)[0].replace(/\s+[—–-].*$/, "").trim();
  const full = n.match(/^(.{2,45}?(?:有限公司|股份公司|有限责任公司))/)?.[1];
  const value = full || n.replace(/[（(].*$/, "").trim();
  return value.length >= 2 && value.length <= 45 && !generic.test(value) && !genericName.test(value.replace(/[、，]/g, "")) && !/[。？！?！]|如何|建议|注意|告诉|可以|优先选择|推荐以下|搜索|参考\s*\d/.test(value) ? value : null;
}

// A clear company name is enough to include it in the competitor list. This is
// deliberately not a claim that the name has been verified in a registry.
const explicitCompanyName = (name) => /公司/.test(String(name || ""));
const companyStem = (name) => nameKey(name)
  .replace(/^(?:广东省?|东莞市?|茶山镇?)/, "")
  .replace(/(?:有限责任公司|股份有限公司|股份公司|有限公司|公司|玩具厂|加工厂|工厂|加工店)+$/, "")
  .replace(/(?:毛绒|玩具|制品|制造|科技|实业|文化|传播|发展|产业|动漫|服饰|制衣|礼品|工艺|婴童|用品|供应链)+$/, "");
function confirmedDuplicate(name, companies) {
  const stem = companyStem(name);
  if (stem.length < 2) return null;
  return companies.find((company) => company.status === "confirmed" && company.aliases.some((alias) => {
    const other = companyStem(alias);
    return other.length >= 2 && (other === stem || (Math.min(other.length, stem.length) >= 4 && (other.includes(stem) || stem.includes(other))));
  })) || null;
}

// Extract candidates, not verified identities. Human decisions are kept separately.
export function extractCompanyNames(answer) {
  const found = new Map();
  const add = (name) => { if (name && !found.has(nameKey(name))) found.set(nameKey(name), name); };
  for (const raw of String(answer).split(/\r?\n/)) {
    const line = clean(raw);
    const head = line.match(numbered);
    const bullet = line.match(/^[-•*]\s+(.+)$/);
    if (head || (bullet && signal.test(bullet[1])) || /^备选[：:]/.test(line)) {
      const name = candidateName(head ? line.slice(head[0].length) : bullet ? bullet[1] : line);
      // Names without an industry suffix may still be real brands; require a short heading.
      if (name && (signal.test(name) || name.length <= 10)) add(name);
    }
    if (line.startsWith("|")) for (const cell of line.split("|").slice(1, 4)) {
      if (signal.test(cell)) add(candidateName(cell.replace(/^\d+[.、]?\s*/, "")));
    }
    for (const match of line.matchAll(/[\p{Script=Han}A-Za-z0-9（）()·]{2,42}?(?:有限责任公司|股份有限公司|有限公司|玩具厂|加工厂)/gu)) {
      add(candidateName(match[0].replace(/^(?:今天我们来到|推荐|首选|备选|例如|包括|以及|还有|选择|可选|优先|是|为)/, "")));
    }
  }
  return [...found.values()];
}

export function collectDoubaoAnswers(source) {
  const prompts = new Map((source.prompts || []).map(p => [p.id, p.text]));
  const answers = new Map();
  const includedRuns = new Set();
  for (const run of source.browserMonitorRuns || []) {
    if (effectivePlatform(run) !== "doubao_web" || run.reportable === false || /simulation|canary/.test(run.mode || "")) continue;
    includedRuns.add(run.id);
    for (const q of run.questions || []) {
      const raw = q.rawAnswer || q.job?.raw_answer;
      if (!raw?.trim() || q.status !== "success") continue;
      const id = `${run.id}:${q.promptId || q.questionId || hash(raw)}`;
      answers.set(id, { id, runId: run.id, runStatus: run.status, date: q.savedAt || q.completedAt || run.completedAt || run.startedAt || run.createdAt,
        question: q.questionText || q.question || prompts.get(q.promptId) || "未记录问题", raw,
        citations: q.browserCitations?.length ? q.browserCitations : q.citations?.length ? q.citations : q.job?.citations || [] });
    }
  }
  for (const p of source.probeRuns || []) {
    if (effectivePlatform(p) !== "doubao_web" || p.reportable === false || p.status !== "success" || !p.rawAnswer?.trim() || /simulat|api/.test(p.source || "")) continue;
    const id = p.browserMonitorRunId ? `${p.browserMonitorRunId}:${p.promptId}` : `probe:${p.id}`;
    // Projections are copies of the same run/question, including interrupted attempts.
    if (answers.has(id) || includedRuns.has(p.browserMonitorRunId)) continue;
    answers.set(id, { id, runId: p.browserMonitorRunId || `probe:${p.id}`, runStatus: "saved", date: p.createdAt,
      question: p.questionText || prompts.get(p.promptId) || "未记录问题", raw: p.rawAnswer,
      citations: p.browserCitations?.length ? p.browserCitations : p.citations || [] });
  }
  return [...answers.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// The competitor list is deliberately opt-in for discovery. Production uses
// the already confirmed roster as a fixed comparison baseline; new answer
// text must not silently add companies to that roster.
export function newCompetitorDb() { return { version: 1, revision: 0, companyDiscoveryEnabled: false, companies: [], reports: [], decisions: [], suppressedNameKeys: [], updatedAt: null }; }

export function syncCompanies(db, answers, brand) {
  let changed = false;
  const suppressed = new Set(db.suppressedNameKeys || []);
  let own = db.companies.find(c => c.id === ownId);
  if (!own) { own = { id: ownId, name: brand.name, aliases: [], status: "confirmed", own: true, createdAt: clock() }; db.companies.unshift(own); changed = true; }
  for (const name of [brand.name, brand.legalName, ...(brand.aliases || [])].filter(Boolean)) {
    if (!own.aliases.some(a => nameKey(a) === nameKey(name)) && !db.companies.some(c => c.id !== ownId && c.aliases.some(a => nameKey(a) === nameKey(name)))) { own.aliases.push(name); changed = true; }
  }
  const known = new Map(db.companies.flatMap(c => c.aliases.map(a => [nameKey(a), c])));
  for (const answer of answers) for (const name of answer.names || extractCompanyNames(answer.raw)) {
    if (suppressed.has(nameKey(name))) continue;
    if (known.has(nameKey(name))) continue;
    if (nameKey(brand.name).length >= 4 && nameKey(name).includes(nameKey(brand.name))) { own.aliases.push(name); known.set(nameKey(name), own); changed = true; continue; }
    // Only explicit "简称/又名" declarations justify automatic aliases, never fuzzy similarity.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const short = answer.raw.match(new RegExp(`${escaped}\\s*[（(]\\s*(?:简称|又名)[：:\\s]*([^）)]+)[）)]`))?.[1];
    const target = short && known.get(nameKey(short));
    if (target && target.status !== "excluded") { target.aliases.push(name); known.set(nameKey(name), target); changed = true; continue; }
    // A name containing “公司” is treated as a company immediately. Before adding
    // it, fold regional/full-name variants into an already confirmed company.
    const duplicate = explicitCompanyName(name) && confirmedDuplicate(name, db.companies);
    if (duplicate) { duplicate.aliases.push(name); known.set(nameKey(name), duplicate); changed = true; continue; }
    const item = { id: `company_${hash(nameKey(name))}`, name, aliases: [name], status: explicitCompanyName(name) ? "confirmed" : "pending", own: false, createdAt: clock() };
    db.companies.push(item); known.set(nameKey(name), item); changed = true;
    if (short && candidateName(short) && !known.has(nameKey(short))) { item.aliases.push(short); known.set(nameKey(short), item); }
  }
  return changed;
}

export function changeCompanies(db, input) {
  const ids = [...new Set(input.ids || [])];
  const selected = ids.map(id => db.companies.find(c => c.id === id));
  if (!ids.length || selected.some(c => !c)) throw new Error("请选择现有公司名称。");
  const before = structuredClone(selected);
  if (["confirm", "exclude", "restore"].includes(input.action)) {
    if (selected.some(c => c.own)) throw new Error("本公司需要保留在对比中。");
    selected.forEach(c => { c.status = { confirm: "confirmed", exclude: "excluded", restore: "pending" }[input.action]; });
  } else if (input.action === "merge") {
    const target = db.companies.find(c => c.id === input.targetId);
    if (!target || target.status === "excluded" || ids.includes(target.id) || selected.some(c => c.own || c.status === "excluded")) throw new Error("请选择两个不同的、未排除的公司；本公司只能作为合并目标。");
    before.push(structuredClone(target));
    target.aliases = [...new Set([...target.aliases, ...selected.flatMap(c => c.aliases)])];
    if (selected.some(c => c.status === "confirmed")) target.status = "confirmed";
    db.companies = db.companies.filter(c => !ids.includes(c.id));
  } else if (input.action === "split") {
    const company = selected[0];
    const alias = company.aliases.find(a => a === input.alias);
    if (ids.length !== 1 || !alias || company.aliases.length < 2 || alias === company.name) throw new Error("请选择一个非主名称的别名拆开。");
    company.aliases = company.aliases.filter(a => a !== alias);
    db.companies.push({ id: `company_${randomUUID()}`, name: alias, aliases: [alias], status: "pending", own: false, createdAt: clock() });
  } else throw new Error("不支持的名单操作。");
  db.decisions.push({ id: randomUUID(), at: clock(), action: input.action, before, targetId: input.targetId || null });
  db.revision += 1;
  db.updatedAt = clock();
}

function chineseNumber(s) {
  const digits = "零一二三四五六七八九";
  if (s === "十") return 10;
  if (s?.includes("十")) { const [a,b] = s.split("十"); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
  return digits.indexOf(s);
}

export function companyEvidence(answer, companies) {
  const answerKey = nameKey(answer.raw);
  const aliases = companies.flatMap(c => c.aliases.map(a => ({ c, key: nameKey(a), alias: a }))).filter(a => a.key.length >= 2 && answerKey.includes(a.key)).sort((a,b) => b.key.length - a.key.length);
  const result = new Map();
  const lines = answer.raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    const key = nameKey(line);
    const spans = [];
    for (const { c, key: aliasKey, alias } of aliases) {
      let start = key.indexOf(aliasKey);
      while (start >= 0) {
        const end = start + aliasKey.length;
        if (!spans.some(s => start < s.end && end > s.start)) {
          spans.push({ start, end });
          if (c.status !== "excluded") {
            const head = line.match(numbered);
            const headingName = head ? candidateName(line.slice(head[0].length)) : null;
            // A company mentioned in another company's explanation has no recommendation position.
            const inHeading = headingName && nameKey(headingName).includes(aliasKey) && !/不推荐|不建议|避雷|黑名单/.test(line);
            let position = inHeading ? (head[1] ? Number(head[1]) : chineseNumber(head[2])) : null;
            if (!position && line.startsWith("|")) {
              const cells = line.split("|").map(v => v.trim()).filter(Boolean);
              if (/^\d{1,2}$/.test(cells[0] || "") && nameKey(cells[1]).includes(aliasKey)) position = Number(cells[0]);
            }
            const existing = result.get(c.id);
            if (!existing || (position && (!existing.position || position < existing.position))) {
              const following = [];
              if (inHeading) for (let n = i + 1; n < Math.min(lines.length, i + 16); n++) {
                if (numbered.test(clean(lines[n])) || /^备选[：:]/.test(clean(lines[n]))) break;
                following.push(lines[n]);
              }
              result.set(c.id, { companyId: c.id, alias, position: position > 0 ? position : null, snippet: [line, ...following].join("\n").slice(0, 1800), answerId: answer.id });
            }
          }
        }
        start = key.indexOf(aliasKey, end);
      }
    }
  }
  return result;
}

export function filterAnswers(answers, filters = {}) {
  const { runId, from, to } = filters;
  return answers.filter(a => {
    const date = a.date ? new Date(a.date).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }) : "";
    return (!runId || a.runId === runId) && (!from || date >= from) && (!to || date <= to);
  });
}

export function buildComparison(db, answers, filters = {}) {
  const selected = filterAnswers(answers, filters);
  const stats = new Map(db.companies.map(c => [c.id, { ...c, mentions: 0, topFive: 0, rankedAnswers: 0, positionTotal: 0, samples: [], evidence: [] }]));
  for (const answer of selected) for (const [id, evidence] of companyEvidence(answer, db.companies)) {
    const c = stats.get(id);
    c.mentions++;
    if (evidence.position) { c.rankedAnswers++; c.positionTotal += evidence.position; if (evidence.position <= 5) c.topFive++; }
    const sample = { ...evidence, question: answer.question, date: answer.date, runId: answer.runId };
    c.evidence.push(sample);
    if (c.samples.length < 3) c.samples.push(sample);
  }
  const companies = [...stats.values()].map(c => ({ ...c, averagePosition: c.rankedAnswers ? Math.round(c.positionTotal / c.rankedAnswers * 100) / 100 : null, mentionRate: selected.length ? c.mentions / selected.length : 0 }));
  const byMentions = (a,b) => b.mentions - a.mentions || b.topFive - a.topFive || a.name.localeCompare(b.name, "zh");
  const runs = [...new Map(answers.map(a => [a.runId, { id: a.runId, date: a.date, status: a.runStatus }])).values()].sort((a,b) => String(b.date).localeCompare(String(a.date)));
  return { totalAnswers: selected.length, totalRuns: new Set(selected.map(a => a.runId)).size, filters, runs, revision: db.revision,
    confirmed: companies.filter(c => c.status === "confirmed").sort(byMentions), pending: companies.filter(c => c.status === "pending").sort(byMentions), excluded: companies.filter(c => c.status === "excluded"), updatedAt: db.updatedAt };
}

export function similarCompanies(company, companies) {
  const stem = s => nameKey(s).replace(/^(?:广东省?|东莞市?|深圳市?|广州市?|茶山镇)/, "").replace(/(?:有限责任公司|有限公司|股份公司|工厂|工艺品|制品|玩具厂|玩具|文化传播|文化发展|公司)$/g, "");
  const key = stem(company.name);
  if (key.length < 2) return [];
  return companies.filter(c => c.id !== company.id && c.status !== "excluded" && c.aliases.some(a => {
    const other = stem(a); return other.length >= 2 && (other === key || (Math.min(other.length, key.length) >= 4 && (other.includes(key) || key.includes(other))));
  })).slice(0, 3).map(c => ({ id: c.id, name: c.name }));
}
