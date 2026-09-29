// Report snapshots use the same question cohort for every company. No external
// page count is treated as a complete inventory or as proof of AI causation.
export const shanghaiDay = date => new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function recentReportFilters(now = new Date()) {
  return { runId: "", from: shanghaiDay(new Date(now).getTime() - 29 * 86400000), to: shanghaiDay(now) };
}
const groups = {
  product: [["棉花娃娃", /棉花娃/], ["胶脸毛绒", /胶脸|搪胶/], ["毛绒挂件", /挂件|包挂|钥匙扣/], ["娃衣", /娃衣|玩偶服|娃娃服/], ["吉祥物", /吉祥物/], ["毛绒公仔", /公仔|毛绒玩具/]],
  need: [["小单起订", /小单|小批量|起订|MOQ|试单/i], ["来图定制", /来图|来样|定制/], ["打样还原", /打样|还原|打版|开版/], ["交期与量产", /交期|交付|产能|量产|大货/], ["质量与资质", /质量|资质|认证|验厂|质检|安全/]],
  region: [["茶山", /茶山/], ["东莞", /东莞/], ["全国", /全国|中国|国内/]],
};
export const reasonThemes = [
  { id: "small", label: "小单与起订条件", match: /小批量|小单|起订|MOQ|试单/i },
  { id: "craft", label: "打样与还原能力", match: /还原|打版|开版|刺绣|电绣|打样|版型/ },
  { id: "delivery", label: "交期与生产能力", match: /产能|日产|月产|交期|交付|量产|车间/ },
  { id: "product", label: "产品与使用场景", match: /棉花娃|娃衣|挂件|吉祥物|文创|IP|潮玩/i },
  { id: "quality", label: "质量与资质", match: /认证|资质|验厂|检针|质检|EN71|BSCI|ISO/i },
];
const rate = (count, total) => total ? count / total : null;
function metric(company, ids) {
  const evidence = company.evidence.filter(e => ids.has(e.answerId));
  const top = evidence.filter(e => e.position > 0 && e.position <= 5);
  const ranked = evidence.filter(e => e.position > 0);
  return { companyId: company.id, total: ids.size, mentions: evidence.length, topFive: top.length,
    mentionRate: rate(evidence.length, ids.size), priorityRate: rate(top.length, ids.size),
    rankedAnswers: ranked.length, averagePosition: ranked.length ? ranked.reduce((n,e) => n+e.position,0)/ranked.length : null,
    answerIds: [...ids], mentionIds: evidence.map(e => e.answerId), priorityIds: top.map(e => e.answerId) };
}
export function buildReportDashboard(companies, answers) {
  const all = new Set(answers.map(a => a.id));
  const dimensions = Object.entries(groups).map(([id, definitions]) => ({ id, rows: definitions.map(([label, match]) => {
    const selected = answers.filter(a => match.test(a.question) && !(id === "region" && label === "东莞" && /茶山/.test(a.question)));
    const ids = new Set(selected.map(a => a.id));
    return { id: `${id}:${label}`, label, total: ids.size, cells: companies.map(c => metric(c, ids)) };
  }) }));
  const days = [...new Set(answers.filter(a=>a.date && Number.isFinite(Date.parse(a.date))).map(a=>shanghaiDay(a.date)))].sort();
  const trend = days.map(day => { const ids = new Set(answers.filter(a => a.date && Number.isFinite(Date.parse(a.date)) && shanghaiDay(a.date) === day).map(a=>a.id)); return { day, cells: companies.map(c=>metric(c,ids)) }; });
  const opportunities = [];
  for (const dimension of dimensions) for (const row of dimension.rows) {
    const own = row.cells[0];
    for (const cell of row.cells.slice(1)) if (row.total && cell.priorityRate > own.priorityRate) {
      opportunities.push({ dimension: dimension.id, rowId: row.id, label: row.label, companyId: cell.companyId, total: row.total,
        ourRate: own.priorityRate, theirRate: cell.priorityRate, delta: cell.priorityRate-own.priorityRate,
        difference: cell.topFive-own.topFive, answerIds: cell.priorityIds });
    }
  }
  opportunities.sort((a,b)=>b.delta-a.delta || b.total-a.total || a.rowId.localeCompare(b.rowId));
  return { companies: companies.map(c=>({ id:c.id, name:c.name, own:!!c.own })), totalAnswers: all.size,
    questions: answers.map(a=>({answerId:a.id, question:a.question, date:a.date})),
    overview: companies.map(c=>metric(c,all)), dimensions, trend, opportunities,
    evidence: companies.map(c=>({ companyId:c.id, items:c.evidence.map(e=>({ answerId:e.answerId, question:e.question, date:e.date, position:e.position, snippet:e.snippet })) })) };
}
const pct = n => `${(n*100).toFixed(1)}%`;
const materialByLabel = {
  "棉花娃娃": ["用一个真实案例说明脸型比例、五官绣花和发型还原的取舍", "对照原图、初样和修改后成品，标明尺寸、面料与填充材料", "列出该类订单实际起订量、打样费用，以及是否涉及骨架或特殊结构"],
  "胶脸毛绒": ["说明客户需要提供哪些脸部设计资料，区分脸部制作与毛绒身体制作", "展示一个真实项目中脸部与身体的连接、配色和尺寸调整过程", "分别列出模具、脸部打样、身体打样的真实费用与周期条件"],
  "毛绒挂件": ["展示成品尺寸、重量、挂绳或五金连接方式，解释使用场景", "用真实小尺寸样品说明五官、刺绣与印花的细节取舍", "列出包装、数量梯度、起订条件与实际交期"],
  "娃衣": ["提供娃体尺寸测量表，说明不同娃体比例怎样影响版型", "展示纸样、面料选择、缝制与试穿效果，写清易卡住或不贴合的位置", "说明单做衣服与娃体衣服配套的下单资料、打样次数和价格条件"],
  "吉祥物": ["写清案例的活动、文旅或企业使用场景，以及设计授权范围", "展示平面形象到立体公仔的比例和结构调整过程", "分别说明礼赠、展示等用途的材料选择、数量与包装条件"],
  "毛绒公仔": ["选择一件真实公仔，列出尺寸、面料、填充和关键工艺", "用原图和样品对照说明哪些设计能还原、哪些需要调整", "列出打样、客户确认、量产检验与发货各环节所需资料"],
  "来图定制": ["列清客户需要提供的正侧背视图、尺寸、颜色和使用场景", "用真实案例展示设计评估、报价、初样与修改确认过程", "写清哪些设计需要开模或额外工艺，以及费用和交期的计算条件"],
  "小单起订": ["按产品和工艺列出真实起订量，说明可以小单试做的条件", "写明打样费、样品修改和退抵规则", "放一个可公开的小单案例，说明数量、尺寸、材料及限制"],
  "打样还原": ["用同一项目对照原图、初样、修改稿与成品", "写清难点和每次修改的理由", "说明真实打样周期、费用及需要客户提供的资料"],
  "交期与量产": ["分开写样品制作、客户确认、量产与发货时间", "用实际订单说明数量和工艺怎样影响交期", "提供可公开的车间及交付记录，写明适用条件"],
  "质量与资质": ["展示本公司的实际检验步骤与抽检记录", "只列真实有效的资质，并注明适用产品和日期", "说明出现质量问题时如何复检与处理"],
};
export function buildTargetedFindings(company, own, research, answers, ownResearch, dashboard) {
  const readSources = research.sources.filter(s=>s.state === "read");
  const oursRead = ownResearch.sources.filter(s=>s.state === "read");
  const reasons = reasonThemes.map(theme => {
    const theirs = company.evidence.filter(e=>theme.match.test(e.snippet));
    const ours = own.evidence.filter(e=>theme.match.test(e.snippet));
    return { id:theme.id, label:theme.label, theirs:theirs.length, ours:ours.length, theirTotal:company.evidence.length, ourTotal:own.evidence.length,
      theirRate:rate(theirs.length, company.evidence.length), ourRate:rate(ours.length, own.evidence.length),
      theirIds:theirs.map(e=>e.answerId), ourIds:ours.map(e=>e.answerId),
      sources:readSources.filter(s=>theme.match.test(`${s.title} ${s.excerpt || ""}`)),
      ourSources:oursRead.filter(s=>theme.match.test(`${s.title} ${s.excerpt || ""}`)) };
  });
  // Pick distinct, question-grounded gaps. Prefer concrete needs/products over
  // duplicating the same recommendation once again under a geographic label.
  const allGaps = dashboard.opportunities.filter(g=>g.companyId === company.id);
  const gapChoices = [...allGaps.filter(g=>g.dimension !== "region"), ...allGaps.filter(g=>g.dimension === "region")];
  const advice = [];
  for (const gap of gapChoices) {
    if (advice.length >= 3) break;
    if (advice.some(a=>a.label === gap.label || (a.answerIds.length === gap.answerIds.length && a.answerIds.every(id=>gap.answerIds.includes(id))))) continue;
    const evidence = company.evidence.find(e=>gap.answerIds.includes(e.answerId));
    const cohort = new Set(dashboard.dimensions.flatMap(d=>d.rows).find(r=>r.id===gap.rowId).cells[0].answerIds);
    const scopedTheirs = company.evidence.filter(e=>cohort.has(e.answerId)), scopedOurs = own.evidence.filter(e=>cohort.has(e.answerId));
    const scopedReasons = reasonThemes.map(theme=>({ ...reasons.find(r=>r.id===theme.id),
      theirRate:rate(scopedTheirs.filter(e=>theme.match.test(e.snippet)).length,scopedTheirs.length),
      ourRate:rate(scopedOurs.filter(e=>theme.match.test(e.snippet)).length,scopedOurs.length) }));
    const matchingReason = scopedReasons.filter(r=>r.ourRate !== null && r.theirRate > r.ourRate).sort((a,b)=>(b.theirRate-b.ourRate)-(a.theirRate-a.ourRate))[0];
    const topicMatch = groups[gap.dimension].find(([label])=>label===gap.label)[1];
    const sources = readSources.filter(s => topicMatch.test(`${s.title} ${s.excerpt || ""}`)).slice(0,2);
    const ours = oursRead.filter(s=>topicMatch.test(`${s.title} ${s.excerpt || ""}`)).slice(0,2);
    const question = evidence?.question || gap.label;
    const title = `${own.name}｜${gap.label}${gap.dimension === "region" ? "毛绒定制" : ""}：${gap.dimension === "need" ? "条件、流程与真实案例" : "怎么选工艺、打样与下单"}`;
    advice.push({ label:gap.label, question, title, answerIds:gap.answerIds, rowId:gap.rowId,
      fact:`在 ${gap.total} 条“${gap.label}”相关回答中，${company.name}进入推荐前五的比例为 ${pct(gap.theirRate)}，我们为 ${pct(gap.ourRate)}，相差 ${(gap.delta*100).toFixed(1)} 个百分点。`,
      observed: sources.length ? `本次核对到《${sources[0].title}》，可参考的原文是：“${(sources[0].excerpt || "").slice(0,180)}”。` : "本次未取得能核对这一差距的同行公开正文，当前依据是豆包回答中的表现。",
      inference:matchingReason ? `在“${gap.label}”相关回答里，提及对方时更常强调“${matchingReason.label}”（${pct(matchingReason.theirRate)}，我们为 ${pct(matchingReason.ourRate)}）。这可能与用户需求匹配有关，尚不能证明是推荐原因。` : "当前只能确认推荐表现有差距，还不能确定造成差距的原因。",
      action:`先围绕买家实际问过的“${question}”补一篇${gap.label}说明或真实案例，优先回答订单条件和选择依据。`,
      outline:materialByLabel[gap.label] || [`开头直接回答“${question}”，写清我们能承接哪些需求`, `围绕${gap.label}选一个真实项目，展示材料、工艺、设计图与成品`, "列出真实起订量、打样流程、交期和不适用情况，附可核实图片"],
      sources, ourSources:ours, evidence: evidence ? { answerId:evidence.answerId, snippet:evidence.snippet } : null,
      limitation:gap.total < 10 ? `目前只有 ${gap.total} 条相关回答，先作为小样本线索。` : "建议用于补充买家需要的信息，实施后仍需继续测试验证效果。" });
  }
  return { companyId:company.id, name:company.name, reasons, advice, sources:research.sources, ourSources:ownResearch.sources,
    searchAttempts:research.attempts, ourSearchAttempts:ownResearch.attempts,
    limitations:["公开资料是本次实际读取的样本，不是全网发布总量；未找到不代表没有。", "豆包回答里的宣传描述不等于已经核实的公司能力。", "事实和推测分开展示，现有证据无法直接证明 AI 内部的推荐原因。"] };
}
