import { createHash } from 'node:crypto';
import { collectDoubaoAnswers, buildComparison, filterAnswers } from './competitor-model.mjs';
import { buildReportDashboard, shanghaiDay } from './competitor-report.mjs';
import { readPublicPage, plainText } from './competitor-research.mjs';

export const COMPANY = process.env.GEO_PUBLISH_COMPANY_NAME || '目标公司';
export const ACCOUNT = process.env.GEO_PUBLISH_ACCOUNT || '';
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const recentTenDays = (now = Date.now()) => ({ from: shanghaiDay(now - 9 * 86400000), to: shanghaiDay(now) });
// Hard publication rule: these decoration/Markdown/currency characters must
// never reach either platform's title, body or keyword fields.
const cleanPublishPunctuation = value => String(value ?? '').replace(/[\\{}｛｝【】\[\]［］*＊￥¥]/g,'');

export const NEW_BUSINESS_CATEGORIES = Object.freeze([
  { id:'brand_intro', label:'品牌介绍', from:1, to:8 },
  { id:'product_education', label:'产品与服务', from:9, to:16 },
  { id:'customer_cases', label:'客户案例', from:17, to:22 },
  { id:'buyer_guidance', label:'采购指南', from:23, to:30 },
]);

export const cleanPublishedText = value => cleanPublishPunctuation(value)
  .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();

export function sanitizePublishedCopy(copy = {}) {
  const title=cleanPublishedText(String(copy.title??'').replace(/^【封面[：:]\s*(.*?)】$/s,'$1'));
  const douyinTitle=cleanPublishedText(copy.douyinTitle);
  const body=cleanPublishedText(copy.body);
  const tags=Array.isArray(copy.tags)?copy.tags.map(tag=>typeof tag==='string'?cleanPublishedText(tag):tag):copy.tags;
  return {...copy,title,douyinTitle,body,tags};
}

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const companyStem = value => cleanPublishedText(value)
  .replace(/^(?:广东省?|东莞市?|深圳市?|广州市?|北京市?|上海市?)/,'')
  .replace(/(?:有限责任公司|股份有限公司|有限公司|公司|玩具厂|加工厂|工厂)$/,'')
  .trim();

export function redactForbiddenCompanyNames(value, names = []) {
  let text = String(value ?? '');
  for (const rawName of names) {
    const name = cleanPublishedText(rawName);
    const stem = companyStem(name);
    for (const token of [name, stem].filter(token => token.length >= 4)) {
      text = text.replace(new RegExp(escapeRegExp(token), 'g'), '其他主体');
    }
  }
  return text;
}

function forbiddenCompanyLeak(value, names = []) {
  const text = String(value ?? '');
  for (const rawName of names) {
    const name = cleanPublishedText(rawName);
    const stem = companyStem(name);
    if (name && text.includes(name)) return name;
    if (stem.length >= 4 && text.includes(stem)) return name || stem;
  }
  return null;
}

const promptNumber = question => Number(String(question?.promptId || '').match(/_(\d+)$/)?.[1] || 0);
export const newBusinessCategory = question => NEW_BUSINESS_CATEGORIES.find(item => {
  const number=promptNumber(question);return number>=item.from && number<=item.to;
}) || null;

const sourceMatches = (url, platform) => {
  let host='';try{host=new URL(url).hostname.toLowerCase();}catch{return false;}
  return platform==='sohu' ? host.endsWith('sohu.com') : host.endsWith('douyin.com') || host.endsWith('iesdouyin.com');
};

export function analyzeNewBusinessEvidence(source, history = [], { categoryId = null, platform = 'douyin' } = {}) {
  const runs=(source?.browserMonitorRuns || []).filter(run=>run.questionSet==='new_business_expansion'
    && ['completed','completed_with_errors'].includes(run.status))
    .sort((a,b)=>Date.parse(b.completedAt || b.createdAt || 0)-Date.parse(a.completedAt || a.createdAt || 0)).slice(0,5);
  const usable=runs.filter(run=>(run.questions || []).some(q=>q.status==='success' && String(q.rawAnswer || '').trim()));
  if(!usable.length) throw new Error('最近5次新题库测试没有有效回答，暂时无法推荐补强主题。');
  const stats=NEW_BUSINESS_CATEGORIES.map(category=>{
    const questions=usable.flatMap(run=>(run.questions || []).filter(q=>q.status==='success' && String(q.rawAnswer || '').trim() && newBusinessCategory(q)?.id===category.id));
    const mentioned=questions.filter(q=>q.mentionResult?.brandMentioned).length;
    const priority=questions.filter(q=>q.recommendationResult?.recommendation && q.recommendationResult.recommendation!=='none').length;
    return {...category,validAnswers:questions.length,mentioned,priority,mentionRate:questions.length?mentioned/questions.length:null,priorityRate:questions.length?priority/questions.length:null};
  });
  const manual=categoryId && stats.find(item=>item.id===categoryId);
  if(categoryId && !manual) throw new Error('请选择有效的新业务类型。');
  const focus=manual || [...stats].filter(item=>item.validAnswers).sort((a,b)=>a.priorityRate-b.priorityRate || a.mentionRate-b.mentionRate || b.validAnswers-a.validAnswers)[0];
  const categoryQuestions=usable.flatMap(run=>(run.questions || []).filter(q=>q.status==='success' && String(q.rawAnswer || '').trim() && newBusinessCategory(q)?.id===focus.id)
    .map(q=>({...q,runId:run.id,date:run.completedAt || run.createdAt})));
  const perPrompt=new Map();
  for(const question of categoryQuestions) {
    const key=question.promptId.replace(/_v\d+_/,'_vX_');
    const current=perPrompt.get(key) || {key,promptId:question.promptId,question:question.questionText || question.question,number:promptNumber(question),valid:0,priority:0,mentioned:0,latest:question};
    current.valid++;current.priority+=Number(question.recommendationResult?.recommendation && question.recommendationResult.recommendation!=='none');current.mentioned+=Number(question.mentionResult?.brandMentioned);
    if(Date.parse(question.date || 0)>Date.parse(current.latest.date || 0))current.latest=question;
    perPrompt.set(key,current);
  }
  const used=new Map();
  for(const draft of history.filter(d=>d.contentType==='new_business' && d.businessCategory===focus.id)) used.set(draft.topicPromptKey || draft.topicPromptId,(used.get(draft.topicPromptKey || draft.topicPromptId)||0)+1);
  const promptStats=[...perPrompt.values()].sort((a,b)=>(used.get(a.key)||0)-(used.get(b.key)||0) || a.priority/a.valid-b.priority/b.valid || a.mentioned/a.valid-b.mentioned/b.valid || a.number-b.number);
  const topic=promptStats[0];
  const selectedQuestions=categoryQuestions.filter(q=>q.promptId.replace(/_v\d+_/,'_vX_')===topic?.key);
  const citations=new Map();
  for(const question of selectedQuestions) for(const citation of (question.citations || question.browserCitations || [])) {
    const raw=citation.resolvedUrl || citation.url || citation.href;if(!sourceMatches(raw,platform))continue;
    let url;try{url=new URL(raw);url.hash='';}catch{continue;}
    const item=citations.get(url.href) || {url:url.href,title:citation.title || citation.sourceTitle || url.hostname,count:0,questions:[]};
    item.count++;if(!item.questions.includes(question.questionText || question.question))item.questions.push(question.questionText || question.question);citations.set(url.href,item);
  }
  const sources=[...citations.values()].sort((a,b)=>b.count-a.count).slice(0,8);
  return {
    kind:'new_business', platform, latestRunCount:runs.length, usableRunCount:usable.length,
    latestRuns:runs.map(run=>({id:run.id,status:run.status,completedAt:run.completedAt || run.createdAt,validAnswers:(run.questions||[]).filter(q=>q.status==='success'&&String(q.rawAnswer||'').trim()).length})),
    focus:{...focus,reason:manual?'由你手动选择的补强业务。':`最近5次有效测试中，该类优先推荐率最低，应先补齐内容信号。`},
    categoryStats:stats, topicPromptId:topic?.promptId || null, topicPromptKey:topic?.key || null,
    topicQuestion:topic?.question || focus.label, sources,
    examples:selectedQuestions.slice(0,5).map(q=>({id:`${q.runId}:${q.promptId}`,question:q.questionText || q.question,date:q.date,answer:String(q.rawAnswer).slice(0,4500)})),
    totalAnswers:categoryQuestions.length,totalRuns:usable.length,
    caveat:`只基于最近5次已结束新题库测试的有效回答。${platform==='sohu'?'只参考这些回答实际引用的搜狐内容。':'只参考这些回答实际引用的抖音内容。'}引用与推荐是观察结果，不代表收录或推荐保证。`,
  };
}

export function analyzePublishEvidence(source, roster, history = [], now = Date.now()) {
  const range = recentTenDays(now);
  const answers = filterAnswers(collectDoubaoAnswers(source), range);
  if (!answers.length) throw new Error('最近 10 天没有已保存的豆包正式测试回答，请先完成测试。');
  const comparison = buildComparison(roster, answers);
  const own = comparison.confirmed.find(c => c.own);
  if (!own) throw new Error('已确认名单中缺少本公司，请先检查公司资料。');
  const companies = [own, ...comparison.confirmed.filter(c => !c.own)];
  const dashboard = buildReportDashboard(companies, answers);
  const recentTopics = history.filter(d=>d.body).slice(0, 10).map(d => d.analysis?.focus?.label);
  const seen = new Set();
  const gaps = dashboard.opportunities.filter(g => g.dimension !== 'region').filter(g => {
    if (seen.has(g.label)) return false; seen.add(g.label); return true;
  }).map(g => ({ ...g, companyName: companies.find(c => c.id === g.companyId)?.name,
    recentlyUsed: recentTopics.includes(g.label) }));
  gaps.sort((a,b) => Number(a.recentlyUsed)-Number(b.recentlyUsed) || b.delta-a.delta || b.total-a.total);
  const focus = gaps[0] || { label: '毛绒定制采购问答', total: answers.length, delta: 0, answerIds: answers.map(a => a.id), reason: '当前样本未显示明确的同行领先差距，按采购问题轮换补充。' };
  const focusIds = new Set(focus.answerIds);
  const citations = new Map();
  for (const answer of answers) {
    const once = new Set();
    for (const c of answer.citations) {
      const rawUrl = c.resolvedUrl || c.url || c.href;
      let url; try { url = new URL(rawUrl); if (!['http:', 'https:'].includes(url.protocol)) continue; } catch { continue; }
      url.hash = '';
      if (once.has(url.href)) continue; once.add(url.href);
      const entry = citations.get(url.href) || { url: url.href, title: c.title || c.sourceTitle || url.hostname, count: 0, focusCount: 0, answerIds: [], questions: [] };
      entry.count++; entry.focusCount += Number(focusIds.has(answer.id)); entry.answerIds.push(answer.id);
      if (!entry.questions.includes(answer.question)) entry.questions.push(answer.question);
      citations.set(url.href, entry);
    }
  }
  const sources = [...citations.values()].sort((a,b) => b.focusCount-a.focusCount || b.count-a.count).slice(0, 8);
  return { range, totalAnswers: answers.length, totalRuns: new Set(answers.map(a=>a.runId)).size,
    focus, gaps: gaps.slice(0,8), sources,
    examples: answers.filter(a=>focusIds.has(a.id)).slice(0,5).map(a=>({ id:a.id, question:a.question, date:a.date, answer:a.raw.slice(0,4500) })),
    caveat: '引用次数是已观察事实；写法与引用之间的关系是分析推断，不表示豆包的收录规则或效果保证。' };
}

export async function enrichPublishSources(analysis, read = readPublicPage) {
  await Promise.all(analysis.sources.map(async source => {
    try {
      const page = await read(source.url);
      const text = plainText(page.html);
      if (text.length < 150 || /captcha|验证|登录/.test(page.url) || /验证后继续|请完成安全验证/.test(text)) throw new Error('正文需要登录或验证');
      source.finalUrl = page.url;
      source.excerpt = text.slice(0, 2200);
      source.readStatus = 'read';
    } catch (error) { source.readStatus = 'unavailable'; source.readNote = error.message; }
  }));
  return analysis;
}

export function validateCopy(copy) {
  copy=sanitizePublishedCopy(copy);
  if (typeof copy.title !== 'string' || !copy.title.trim() || [...copy.title].length > 30) throw new Error('草稿主题须为 1–30 字。');
  const douyinTitle=typeof copy.douyinTitle === 'string' ? copy.douyinTitle.trim() : '';
  if ([...douyinTitle].length > 20) throw new Error('抖音单独标题最多 20 字；不需要时请留空。');
  const body=typeof copy.body === 'string' ? copy.body.trim() : '';
  const rawTags=Array.isArray(copy.tags)?copy.tags.map(tag=>typeof tag==='string'?tag.trim():tag):copy.tags;
  if (body.length < 50 || body.length > 900) throw new Error('正文须为 50–900 字。');
  if (!Array.isArray(rawTags) || rawTags.length < 3 || rawTags.length > 5 || rawTags.some(t=>typeof t !== 'string' || !/^[\p{L}\p{N}_]{1,24}$/u.test(t))) throw new Error('请设置 3–5 个有效话题标签（不带 #）。');
  if (/保证收录|一定.{0,6}引用|行业第一|全国第一|全网最低|最好/.test(body)) throw new Error('文案包含未确认或夸大的承诺，请修改后继续。');
  const tags=[...new Set(rawTags)];
  if(tags.length<3) throw new Error('至少需要 3 个不重复的话题标签。');
  return { title:copy.title.trim(), douyinTitle, body, tags };
}

export function validateSohuArticle(copy) {
  copy=sanitizePublishedCopy(copy);
  const title=copy?.title;
  const body=copy?.body;
  const tags=Array.isArray(copy?.tags)?[...new Set(copy.tags.filter(Boolean))].slice(0,5):[];
  const caseIds=Array.isArray(copy?.caseIds)?[...new Set(copy.caseIds.map(value=>cleanPublishedText(value)).filter(Boolean))].slice(0,2):[];
  if(!title || [...title].length>60) throw new Error('搜狐文章标题须为 1–60 字。');
  if(body.length<100 || body.length>8000) throw new Error('搜狐文章正文须为 100–8000 字。');
  if(COMPANY !== '目标公司' && !body.includes(COMPANY)) throw new Error('文章需要包含系统设置中的目标公司名称。');
  const publicText=[title,body,...tags].join('\n');
  const withoutOwn=publicText.split(COMPANY).join('').split('目标品牌').join('');
  if(/有限责任公司|股份有限公司|有限公司/.test(withoutOwn)) throw new Error('搜狐文章只能出现目标品牌，不得出现其他公司名称。');
  const forbidden=(copy?.forbiddenCompanyNames||[]).map(cleanPublishedText).filter(name=>name&&name!==COMPANY&&name!=='目标品牌');
  const leaked=forbiddenCompanyLeak(publicText,forbidden);
  if(leaked)throw new Error(`搜狐文章只能出现目标品牌，不得出现其他企业名称：${leaked}`);
  if(/保证收录|一定.{0,6}引用|行业第一|全国第一|全网最低|最好/.test(body)) throw new Error('文章包含未确认或夸大的承诺，请修改后继续。');
  return {title,body,tags,caseIds};
}

export function publicationSnapshot(draft, assets) {
  if(draft.platform==='sohu') return {platform:'sohu',title:draft.title,body:draft.body,tags:draft.tags || [],images:draft.imageIds.map(id=>({id,hash:assets.find(a=>a.id===id)?.hash})),imagePlacements:draft.imagePlacements || [],accountId:draft.accountId || null,visibility:'public'};
  return { douyinTitle:draft.douyinTitle || '', body:draft.body, tags:draft.tags, images:draft.imageIds.map(id=>({ id, hash:assets.find(a=>a.id===id)?.hash })),
    music:draft.music, location:draft.location, declaration:{label:'无需添加自主声明'}, topics:draft.topics, accountId:draft.accountId, visibility:'public' };
}
