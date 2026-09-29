import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { newCompetitorDb, collectDoubaoAnswers, syncCompanies, changeCompanies, extractCompanyNames, buildComparison, filterAnswers, similarCompanies, nameKey } from "./competitor-model.mjs";
import { researchCompany } from "./competitor-research.mjs";
import { buildReportDashboard, buildTargetedFindings, recentReportFilters } from "./competitor-report.mjs";

export async function createCompetitorService({ path, getSource, research = researchCompany }) {
  let db;
  try { db = JSON.parse(await readFile(path, "utf8")); if (db.version !== 1 || !Array.isArray(db.companies) || !Array.isArray(db.reports)) throw new Error("同行数据格式不正确，请检查备份。"); if (!Array.isArray(db.suppressedNameKeys)) db.suppressedNameKeys = []; if (db.companyDiscoveryEnabled !== true) db.companyDiscoveryEnabled = false; }
  catch (error) { if (error.code !== "ENOENT") throw error; db = newCompetitorDb(); }
  let tail = Promise.resolve();
  let cacheKey = ""; let cache;
  const extractionCache = new Map();
  const transaction = (fn) => {
    const promise = tail.then(async () => {
      const before = structuredClone(db);
      try {
        const result = await fn();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(db), "utf8");
        await rename(`${path}.tmp`, path);
        return result;
      } catch (error) { db = before; cacheKey = ""; throw error; }
    });
    tail = promise.catch(() => {}); return promise;
  };
  if (db.reports.some(r => ["queued", "running"].includes(r.status))) await transaction(() => {
    for (const report of db.reports) if (["queued", "running"].includes(report.status)) {
      report.status = "interrupted"; report.message = "系统重启使分析中断，已保留完成的部分。可点击重新分析。"; report.finishedAt = new Date().toISOString();
    }
  });
  function readAnswers() {
    const answers = collectDoubaoAnswers(getSource());
    for (const answer of answers) {
      const hash = createHash("sha256").update(answer.raw).digest("hex");
      if (!extractionCache.has(hash)) extractionCache.set(hash, extractCompanyNames(answer.raw));
      answer.names = extractionCache.get(hash);
    }
    return answers;
  }
  async function applyStartupRetention() {
    const retentionPath = `${dirname(path)}/competitor-retention.json`;
    let request;
    try { request = JSON.parse(await readFile(retentionPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const keepFirst = Number(request.keepFirst);
    if (!Number.isInteger(keepFirst) || keepFirst < 1) throw new Error("同行名单保留数量无效。 ");
    const answers = readAnswers();
    await transaction(() => {
      if (db.companyDiscoveryEnabled && syncCompanies(db, answers, getSource().brands[0])) { db.revision += 1; db.updatedAt = new Date().toISOString(); }
      const comparison = buildComparison(db, answers);
      const ordered = [...comparison.confirmed, ...comparison.pending, ...comparison.excluded];
      const retained = new Set(ordered.slice(0, keepFirst).map(company => company.id));
      for (const company of db.companies) if (company.own) retained.add(company.id);
      const removed = db.companies.filter(company => !retained.has(company.id));
      db.suppressedNameKeys = [...new Set([...(db.suppressedNameKeys || []), ...removed.flatMap(company => company.aliases.map(nameKey))])];
      db.companies = db.companies.filter(company => retained.has(company.id));
      db.revision += 1;
      db.updatedAt = new Date().toISOString();
    });
    await unlink(retentionPath);
  }
  await applyStartupRetention();
  async function snapshot(filters = {}) {
    await tail;
    const answers = readAnswers();
    const key = createHash("sha256").update(JSON.stringify([db.revision, filters, answers.map(a => [a.id, a.date, a.raw])])).digest("hex");
    if (cache && cacheKey === key) return cache;
    await transaction(() => {
      if (db.companyDiscoveryEnabled && syncCompanies(db, answers, getSource().brands[0])) { db.revision++; db.updatedAt = new Date().toISOString(); }
    });
    const comparison = buildComparison(db, answers, filters);
    const all = [...comparison.confirmed, ...comparison.pending];
    comparison.pending.forEach(c => c.similar = similarCompanies(c, all));
    cache = { comparison, answers: filterAnswers(answers, filters) }; cacheKey = key;
    return cache;
  }
  function readFilters(search) {
    const f = Object.fromEntries(["runId", "from", "to"].map(k => [k, search.get(k) || ""]));
    if ((f.from && !/^\d{4}-\d{2}-\d{2}$/.test(f.from)) || (f.to && !/^\d{4}-\d{2}-\d{2}$/.test(f.to)) || (f.from && f.to && f.from > f.to)) throw new Error("请选择正确的起止日期。");
    return f;
  }
  const summaries = () => db.reports.map(({ results, answerSnapshots, dashboard, ...r }) => ({ ...r, resultCount: results?.length || 0, changedSinceReport: r.companyRevision !== db.revision }));
  async function performReport(id, companies, own, answers, dashboard) {
    const update = async patch => transaction(() => Object.assign(db.reports.find(r => r.id === id), patch));
    const results = []; let failed = 0;
    try {
      await update({ status: "running", progress: 3, message: "正在整理豆包推荐理由和引用来源" });
      const ownIds = new Set(own.evidence.map(e => e.answerId));
      const ownCitations = answers.filter(a => ownIds.has(a.id)).flatMap(a => a.citations);
      const ownWebsite = getSource().brands?.[0]?.domain;
      if (ownWebsite) ownCitations.unshift({ url: ownWebsite, title: `${own.name} · 已配置官网`, origin: "configured_website" });
      let ownResearch;
      try { ownResearch = await research(own, ownCitations, async message => update({ message, progress: 4 })); }
      catch (error) { ownResearch = { sources: [], attempts: [{ channel: "本公司公开资料", status: "failed", error: error.message }] }; failed++; }
      for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        company.researchTopics = [...new Set(dashboard.opportunities.filter(g=>g.companyId === company.id && g.dimension !== "region").map(g=>g.label))].slice(0,2);
        const answerIds = new Set(company.evidence.map(e => e.answerId));
        const citations = answers.filter(a => answerIds.has(a.id)).flatMap(a => a.citations);
        let external;
        try { external = await research(company, citations, async message => update({ message, progress: Math.round(5 + i / companies.length * 85) })); }
        catch (error) { failed++; external = { sources: [], attempts: [{ channel: "公开检索", status: "failed", error: error.message }] }; }
        results.push(buildTargetedFindings(company, own, external, answers, ownResearch, dashboard));
        await update({ results: structuredClone(results), progress: Math.round((i + 1) / companies.length * 95), message: `已整理 ${i + 1}/${companies.length} 家公司的分析` });
      }
      const incomplete = failed || results.some(r => r.searchAttempts.some(a => a.status === "failed") || !r.sources.some(s => s.state === "read"));
      await update({ status: incomplete ? "partial" : "completed", progress: 100, message: incomplete ? "回答分析已完成，部分公开资料未能核实，详情中已列明。" : "分析完成，点击查看详情。", finishedAt: new Date().toISOString() });
    } catch (error) {
      await update({ status: "failed", message: `分析未完成：${error.message}`, finishedAt: new Date().toISOString() }).catch(e => console.error("同行分析保存失败", e.message));
    }
  }
  return {
    async handle(req, res, url, bodyOf, json) {
      if (!url.pathname.startsWith("/api/competitors")) return false;
      try {
        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /api/competitors") {
          const { comparison } = await snapshot(readFilters(url.searchParams));
          const withoutEvidence = rows => rows.map(({ evidence, ...c }) => c);
          const fixedRoster = db.companyDiscoveryEnabled !== true;
          json(res, 200, { ...comparison, companyDiscoveryEnabled: !fixedRoster, reportFormatVersion: 2, confirmed: withoutEvidence(comparison.confirmed), pending: fixedRoster ? [] : withoutEvidence(comparison.pending), reports: summaries() });
        } else if (route === "POST /api/competitors/purge") {
          const input = await bodyOf(req);
          const ids = [...new Set(input.ids || [])];
          if (!ids.length) throw new Error("没有需要删除的公司。 ");
          await snapshot();
          await transaction(() => {
            const selected = ids.map(id => db.companies.find(c => c.id === id));
            if (selected.some(c => !c)) throw new Error("部分公司已不存在，请刷新后重试。 ");
            if (selected.some(c => c.own)) throw new Error("不能删除本公司。 ");
            db.suppressedNameKeys = [...new Set([...(db.suppressedNameKeys || []), ...selected.flatMap(c => c.aliases.map(nameKey))])];
            db.companies = db.companies.filter(c => !ids.includes(c.id));
            db.revision += 1;
            db.updatedAt = new Date().toISOString();
          });
          cacheKey = "";
          json(res, 200, { ok: true, deleted: ids.length, revision: db.revision });
        } else if (route === "POST /api/competitors/decisions/batch") {
          const input = await bodyOf(req);
          const actions = Array.isArray(input.actions) ? input.actions : [];
          if (!actions.length) throw new Error("没有需要保存的名单操作。 ");
          await snapshot();
          await transaction(() => {
            for (const action of actions) changeCompanies(db, action);
          });
          cacheKey = "";
          json(res, 200, { ok: true, revision: db.revision, applied: actions.length });
        } else if (route === "POST /api/competitors/decisions") {
          const input = await bodyOf(req);
          await snapshot();
          await transaction(() => changeCompanies(db, input)); cacheKey = "";
          json(res, 200, { ok: true, revision: db.revision });
        } else if (route === "GET /api/competitors/evidence") {
          const { comparison, answers } = await snapshot(readFilters(url.searchParams));
          const companies = db.companyDiscoveryEnabled ? [...comparison.confirmed, ...comparison.pending] : comparison.confirmed;
          const company = companies.find(c => c.id === url.searchParams.get("companyId"));
          if (!company) throw new Error("公司不存在或已被排除。");
          const answerId = url.searchParams.get("answerId");
          if (answerId) {
            const evidence = company.evidence.find(e => e.answerId === answerId);
            if (!evidence) throw new Error("找不到这条公司的回答记录。");
            json(res, 200, { company: company.name, evidence, answer: answers.find(a => a.id === answerId) });
          } else {
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            json(res, 200, { name: company.name, total: company.evidence.length, items: company.evidence.slice(offset, offset + 30) });
          }
        } else if (route === "POST /api/competitors/reports") {
          const input = await bodyOf(req);
          const filters = readFilters(new URLSearchParams(input.filters || recentReportFilters()));
          const { comparison, answers } = await snapshot(filters);
          const ids = [...new Set(input.companyIds || [])];
          if (!ids.length || ids.length > 10) throw new Error("每次请选择 1—10 家已确认的同行公司。");
          const companies = ids.map(id => comparison.confirmed.find(c => c.id === id && !c.own));
          if (companies.some(c => !c || !c.mentions)) throw new Error("所选公司尚未确认、已排除，或在当前范围内没有回答。");
          const own = comparison.confirmed.find(c => c.own);
          const dashboard = buildReportDashboard([own, ...companies], answers);
          const report = { id: `report_${randomUUID()}`, version: 2, dashboard, title: `${companies.map(c => c.name).join("、")} · 同行差距分析`, createdAt: new Date().toISOString(), status: "queued", progress: 0, message: "正在整理图表与公开资料", companyIds: ids, companyNames: companies.map(c => c.name), companyRevision: db.revision, filters, answerCount: answers.length, runCount: comparison.totalRuns, results: [], answerSnapshots: answers.map(({names,...a}) => a) };
          await transaction(() => {
            if (db.reports.some(r => ["queued", "running"].includes(r.status))) throw new Error("已有分析正在进行，请完成后再创建下一份报告。");
            db.reports.unshift(report);
          });
          const { answerSnapshots, ...response } = report;
          json(res, 202, response);
          void performReport(report.id, structuredClone(companies), structuredClone(own), structuredClone(answers), dashboard);
        } else if (route === "GET /api/competitors/reports") {
          await tail; json(res, 200, { reports: summaries() });
        } else if (req.method === "GET" && /^\/api\/competitors\/reports\/[^/]+\/answer$/.test(url.pathname)) {
          await tail;
          const report = db.reports.find(r => r.id === decodeURIComponent(url.pathname.split("/").at(-2)));
          const answer = report?.answerSnapshots?.find(a => a.id === url.searchParams.get("answerId"));
          json(res, answer ? 200 : 404, answer ? { answer } : { error: "这份报告未保留该条完整回答，可查看报告内的原文片段。" });
        } else if (req.method === "GET" && /^\/api\/competitors\/reports\/[^/]+$/.test(url.pathname)) {
          await tail;
          const report = db.reports.find(r => r.id === decodeURIComponent(url.pathname.split("/").at(-1)));
          if (!report) json(res, 404, { error: "找不到这份报告。" });
          else { const { answerSnapshots, ...response } = report; json(res, 200, { ...response, changedSinceReport: report.companyRevision !== db.revision }); }
        } else json(res, 404, { error: "同行模块接口不存在。" });
      } catch (error) { json(res, 400, { error: error.message }); }
      return true;
    },
    snapshot,
  };
}
