import { renderReportV2, chartEvidence, reportViewState } from "./competitor-report.js";
const esc = (v = "") => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = v => v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未记录时间";
const pct = v => `${(Number(v || 0) * 100).toFixed(1)}%`;
const position = v => v === null || v === undefined ? "未标明" : `第 ${v} 位`;
const safeUrl = v => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? esc(u.href) : ""; } catch { return ""; } };
const api = async (path, body) => {
  const response = await fetch(`/api/competitors${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!response.headers.get("content-type")?.includes("application/json") || (response.status === 404 && (path === "" || path.startsWith("?")))) throw new Error("新模块尚未加载。请重新启动星图 GEO，再刷新页面。");
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "操作未完成"); return data;
};
function recentFilters() {
  const day = time => new Date(time + 8 * 3600000).toISOString().slice(0,10), now = Date.now();
  return { runId:"", from:day(now - 29 * 86400000), to:day(now) };
}
const ui = { tab: "ranking", data: null, filters: recentFilters(), query: "", page: 0, selected: new Set(), report: null, error: "", loading: false, timer: null, version: 0 };
const tabs = { ranking: "可见度对比", manage: "已确认名单", reports: "分析报告" };
const statuses = { queued: "等待分析", running: "分析中", completed: "分析完成", partial: "已完成 · 部分资料待核实", interrupted: "分析已中断", failed: "分析未完成" };
const qs = () => new URLSearchParams(ui.filters).toString();
const root = () => document.querySelector("#competitor-root");
const allCompanies = () => ui.data ? [...ui.data.confirmed] : [];

export function competitorsView() { return '<section id="competitor-root" class="peer-module"><div class="card">正在整理豆包历史回答中的公司名称…</div></section>'; }

function flash(text, bad = false) { const target = document.querySelector("#peer-message"); if (target) { target.textContent = text; target.className = `peer-message ${bad ? "bad" : ""}`; } }
function toolbar() {
  return `<div class="peer-filters"><label>测试批次<select id="peer-run"><option value="">全部测试</option>${ui.data.runs.map(r => `<option value="${esc(r.id)}" ${ui.filters.runId === r.id ? "selected" : ""}>${esc(date(r.date))} · ${esc(r.id)}${["completed", "completed_with_errors"].includes(r.status) ? "" : "（含已保存回答）"}</option>`).join("")}</select></label><label>开始日期<input id="peer-from" type="date" value="${esc(ui.filters.from)}"></label><label>结束日期<input id="peer-to" type="date" value="${esc(ui.filters.to)}"></label><button class="secondary" data-peer="filter">应用范围</button><button class="secondary" data-peer="recent-filter">最近30天</button><button class="secondary" data-peer="reset-filter">全部时间</button></div>`;
}
function rowsForTab() {
  const rows = ui.data.confirmed;
  return rows.filter(c => !ui.query || c.aliases.some(a => a.toLowerCase().includes(ui.query.toLowerCase())));
}
function companyTable() {
  const rows = rowsForTab();
  const page = Math.min(ui.page, Math.max(0, Math.ceil(rows.length / 30) - 1)); ui.page = page;
  const shown = rows.slice(page * 30, page * 30 + 30);
  const heading = ui.tab === "ranking" ? "我们与同行的表现" : "已确认同行名单";
  return `<div class="section-head"><div><h2>${heading}</h2><p>${ui.tab === "ranking" ? "仅以已确认同行为准，不会从新回答中新增公司。" : "把同一公司的别名合并到现有已确认名单中。"}</p></div><input id="peer-search" type="search" placeholder="搜索公司或别名" aria-label="搜索公司或别名" value="${esc(ui.query)}"></div>
    <div class="peer-batch"><span id="peer-selected-count">已选 ${ui.selected.size} 家</span>${ui.tab === "ranking" ? '<button class="primary" data-peer="analyze">分析选中的同行</button>' : '<button class="danger" data-peer="exclude">移出名单</button>'}<button class="secondary" data-peer="clear-selection">清空选择</button><span class="muted">每条回答对同一公司只计一次</span></div>
    <div class="card peer-table"><table><thead><tr><th><input type="checkbox" id="peer-select-page" aria-label="选择本页公司"></th><th>公司名称</th><th>提及次数</th><th>推荐前五</th><th>平均位置</th><th>操作</th></tr></thead><tbody>${shown.length ? shown.map(c => `<tr data-company-row="${esc(c.id)}" class="${c.own ? "peer-own" : ""}"><td>${c.own ? "" : `<input type="checkbox" data-peer-select="${esc(c.id)}" aria-label="选择${esc(c.name)}" ${ui.selected.has(c.id) ? "checked" : ""}>`}</td><td><button class="peer-name" ${!c.own ? 'draggable="true"' : ""} data-company-drag="${esc(c.id)}" data-peer="evidence" data-id="${esc(c.id)}">${esc(c.name)}</button><span class="chip ${c.own ? "green" : ""}">${c.own ? "我们公司" : "已确认"}</span>${c.aliases.length > 1 ? `<small>${c.aliases.length} 个名称已合并 <button class="peer-text-button" data-peer="aliases" data-id="${esc(c.id)}">查看</button></small>` : ""}${c.similar?.length ? `<small>可能与 ${c.similar.map(s => esc(s.name)).join("、")} 是同一家 <button class="peer-text-button" data-peer="merge-dialog" data-id="${esc(c.id)}">合并</button></small>` : ""}</td><td><strong>${c.mentions}</strong><small>${pct(c.mentionRate)} 的回答</small></td><td>${c.topFive}<small>次</small></td><td>${position(c.averagePosition)}<small>${c.rankedAnswers} 条有明确排名</small></td><td><div class="peer-row-actions">${!c.own ? `<button class="tiny" data-peer="exclude" data-id="${esc(c.id)}">移出名单</button><button class="tiny" data-peer="merge-dialog" data-id="${esc(c.id)}">合并</button>` : ""}<button class="tiny" data-peer="evidence" data-id="${esc(c.id)}">查看回答</button></div></td></tr>`).join("") : `<tr><td colspan="6" class="empty">当前没有匹配的已确认公司。</td></tr>`}</tbody></table></div>
    <div class="peer-pagination"><span>共 ${rows.length} 个名称 · 第 ${page + 1}/${Math.max(1, Math.ceil(rows.length / 30))} 页</span><button class="secondary" data-peer="prev" ${page === 0 ? "disabled" : ""}>上一页</button><button class="secondary" data-peer="next" ${(page + 1) * 30 >= rows.length ? "disabled" : ""}>下一页</button></div>`;
}
function reportList() {
  return `<div class="section-head"><div><h2>每次分析都保存在这里</h2><p>点击报告查看原因、原文依据、公开来源和改进建议。重新分析会保留旧报告。</p></div></div><div id="peer-report-list">${reportCards()}</div>`;
}
function reportCards() {
  return ui.data.reports.length ? ui.data.reports.map(r => `<article class="card peer-report-card"><div><span class="chip ${r.status === "completed" ? "green" : ""}">${statuses[r.status] || "待查看"}</span><h3>${esc(r.title)}</h3><p>${date(r.createdAt)} · ${r.answerCount} 条回答 · ${r.runCount} 次测试</p><p>${esc(r.message)}</p>${["queued", "running"].includes(r.status) ? `<progress value="${r.progress}" max="100"></progress>` : ""}</div><button class="primary" data-peer="report" data-id="${esc(r.id)}">查看详情</button></article>`).join("") : '<div class="card empty">还没有分析报告。先确认公司，再到“可见度对比”中选中同行，点击“分析选中的同行”。</div>';
}
function evidenceButton(id, answerId, label = "查看完整回答") { return `<button class="tiny" data-peer="answer" data-id="${esc(id)}" data-answer="${esc(answerId)}">${label}</button>`; }
function sourceCard(source) {
  const url = safeUrl(source.url);
  return `<li><span class="chip">${esc(source.channel)}</span><b>${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>` : esc(source.title)}</b><small>${{ read: "已读取正文并核对名称", snippet_only: "只有检索线索", identity_unconfirmed: "公司身份待核对" }[source.state] || "待核实"} · ${date(source.fetchedAt)}</small><p>${esc(source.excerpt || source.snippet || "暂无可读取正文")}</p><small>${esc(source.note || "仅为搜索结果线索，未据此判断实际做法。")}</small></li>`;
}
function practiceSection(c) {
  return `<section class="card"><h3>公开资料里，哪些做法值得参考</h3>${c.practices?.length ? c.practices.map(p => `<div class="peer-finding"><h3>${esc(p.title)}</h3><p><b>实际读到：</b>${esc(p.observed)}</p><p><b>可能的作用：</b>${esc(p.meaning)}</p><p class="peer-action"><b>我们可以做：</b>${esc(p.action)}</p>${p.competitorSources.map(s => `<p><a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">同行：${esc(s.title)}</a></p>`).join("")}${p.ourSources.map(s => `<p><a href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">我们：${esc(s.title)}</a></p>`).join("")}</div>`).join("") : '<p>这次获取的公开正文不足以核实同行的内容做法，暂不把搜索摘要当作结论。</p>'}</section><details class="card"><summary>同时检索到的本公司资料</summary><ul class="peer-sources">${(c.ourSources || []).map(sourceCard).join("") || "<li>本次没有读到可核对的本公司页面，不代表公司没有公开资料。</li>"}</ul></details>`;
}
function reportDetail(r) {
  if (r.version === 2 && r.dashboard) return renderReportV2(r);
  return `<div class="section-head"><div><button class="secondary" data-peer="back-reports">← 返回报告列表</button><h2>${esc(r.title)}</h2><p>${date(r.createdAt)} · ${r.answerCount} 条豆包回答 · ${r.runCount} 次测试</p></div><button class="primary" data-peer="reanalyze" data-id="${esc(r.id)}">重新分析并保存新报告</button></div><div class="peer-report-status"><span class="chip">${statuses[r.status]}</span> ${esc(r.message)}${["queued", "running"].includes(r.status) ? `<progress value="${r.progress}" max="100"></progress>` : ""}</div>${r.changedSinceReport ? '<p class="peer-note">名单已发生变化。这份报告保留分析当时的结果；重新分析可使用最新名单。</p>' : ""}
    ${(r.results || []).map(c => `<article class="peer-report-detail"><div class="peer-report-lead"><span class="chip">${esc(c.name)}</span><h2>${esc(c.headline)}</h2><p>${esc(c.takeaway)}</p></div><div class="card peer-table"><table><thead><tr><th>公司</th><th>提及次数</th><th>推荐前五次数</th><th>平均推荐位置</th></tr></thead><tbody><tr class="peer-own"><td>${esc(c.ourMetrics.name)}（我们）</td><td>${c.ourMetrics.mentions}</td><td>${c.ourMetrics.topFive}</td><td>${position(c.ourMetrics.averagePosition)}</td></tr><tr><td>${esc(c.name)}</td><td>${c.metrics.mentions}</td><td>${c.metrics.topFive}</td><td>${position(c.metrics.averagePosition)}</td></tr></tbody></table></div>
    <section class="card"><h3>哪些问题里，它比我们表现好</h3>${c.gaps.length ? c.gaps.map(g => `<details class="peer-report-evidence"><summary>${esc(g.question)} <span class="chip">${g.times} 次</span></summary><p class="peer-quote">${esc(g.evidence.snippet)}</p>${evidenceButton(c.companyId, g.evidence.answerId)}</details>`).join("") : '<p>这次选择的回答中，没有发现它比我们表现更好的问题。</p>'}</section>
    <section class="card"><h3>为什么可能更容易被推荐，以及我们该做什么</h3>${c.patterns.length ? c.patterns.map((p, i) => `<div class="peer-finding"><h3>${i + 1}. ${esc(p.title)}</h3><p><b>看到的依据：</b>${esc(p.explanation)}</p><p class="muted">${esc(p.inference)}</p><div class="peer-action"><b>我们先做：</b>${esc(p.action)}</div><details><summary>查看原文与来源</summary>${p.examples.map(e => `<p class="peer-quote">${esc(e.snippet)}</p>${evidenceButton(c.companyId, e.answerId)}`).join("")}${p.sourceUrls.map(u => safeUrl(u) ? `<p><a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">查看相关公开来源</a></p>` : "").join("")}</details></div>`).join("") : '<p>证据不足，暂时无法给出有针对性的原因判断。</p>'}</section>
    ${practiceSection(c)}<section class="card"><h3>公开资料与引用来源</h3><p>点击标题打开原网页，核对内容是否属于这家公司。</p><ul class="peer-sources">${c.sources.map(sourceCard).join("") || "<li>本次没有获取到可核实的公开资料，不能确定同行实际采取了哪些内容做法。</li>"}</ul></section>
    <details class="card"><summary>检索情况和目前还不能确定的事</summary><ul>${c.limitations.map(l => `<li>${esc(l)}</li>`).join("")}</ul>${c.searchAttempts.map(a => `<p>${esc(a.channel)} · ${esc(a.engine || "")} · ${esc(a.query || "")}：${a.status === "found" ? `找到 ${a.count} 条相关线索` : a.status === "empty" ? "未找到相关结果" : esc(a.error || "暂时无法检索")}</p>`).join("")}</details></article>`).join("")}`;
}
function paint() {
  const el = root(); if (!el) return;
  if (!ui.data) { el.innerHTML = `<div class="card">${ui.error ? `加载失败：${esc(ui.error)} <button data-peer="refresh" class="secondary">重试</button>` : "正在整理历史回答，请稍候…"}</div>`; return; }
  el.innerHTML = `<div class="peer-hero"><div><span class="chip">豆包 · 公司对比</span><h2>看清同行的可见度，找到我们能改进的地方</h2><p>以当前已确认同行名单为准；新回答只更新这些公司的出现数据，不会新增公司。</p></div><button class="secondary" data-peer="refresh">${ui.loading ? "正在更新…" : "更新回答数据"}</button></div><div id="peer-message" role="status" class="peer-message${ui.error ? " bad" : ""}">${esc(ui.error)}</div><div class="peer-tabs">${Object.entries(tabs).map(([key, label]) => `<button data-peer-tab="${key}" class="${ui.tab === key ? "active" : ""}">${label}${key === "reports" ? ` <span>${ui.data.reports.length}</span>` : ""}</button>`).join("")}</div>${ui.tab !== "reports" ? `${toolbar()}<div class="peer-summary"><span>当前范围：<b>${ui.data.totalAnswers}</b> 条已保存回答 / <b>${ui.data.totalRuns}</b> 次测试</span><span>已确认同行 <b>${ui.data.confirmed.filter(c => !c.own).length}</b> 家</span></div><p class="peer-note">提及次数按回答去重；前五和平均位置仅计算原文中明确标明的公司推荐序号，不把“仅提到”当成排名。</p>${companyTable()}` : ui.report ? reportDetail(ui.report) : reportList()}`;
}
async function load() {
  const version = ++ui.version; ui.loading = true; ui.error = "";
  try { const data = await api(`?${qs()}`); if (version !== ui.version) return; ui.data = data; ui.selected = new Set([...ui.selected].filter(id => allCompanies().some(c => c.id === id))); }
  catch (e) { ui.error = e.message; }
  finally { if (version === ui.version) { ui.loading = false; paint(); } }
}
function modal(content) {
  let d = document.querySelector("#peer-dialog"); if (d) d.remove();
  d = document.createElement("dialog"); d.id = "peer-dialog"; d.className = "peer-dialog";
  d.innerHTML = `<button class="secondary peer-close" data-peer="close">关闭</button><div>${content}</div>`;
  document.body.append(d); d.addEventListener("click", handleClick); d.addEventListener("close", () => d.remove()); d.showModal();
}
async function decision(action, ids, extra = {}) {
  if (!ids.length) return flash("请先勾选公司名称。", true);
  await api("/decisions", { action, ids, ...extra }); ids.forEach(id => ui.selected.delete(id));
  await load(); flash({ confirm: "已确认，历史对比已更新。", exclude: "已永久排除这些名称。以后不再出现，可在名单管理中恢复。", restore: "已恢复到待确认名单。", merge: "已合并为同一家公司，别名和历史记录已归并。", split: "已拆分到待确认名单。" }[action]);
}
async function createReport(ids, filters = ui.filters) {
  if (ui.data?.reportFormatVersion !== 2) throw new Error("新版图表报告尚未加载，请重新启动星图 GEO 后刷新页面。");
  reportViewState.companyId = null; reportViewState.hidden.clear();
  const report = await api("/reports", { companyIds: ids, filters }); ui.tab = "reports"; ui.report = report; ui.selected.clear(); await load();
}
async function handleClick(event) {
  const tab = event.target.closest("[data-peer-tab]");
  if (tab) { ui.tab = tab.dataset.peerTab; ui.page = 0; ui.query = ""; ui.selected.clear(); ui.report = null; paint(); return; }
  const b = event.target.closest("[data-peer]"); if (!b) return;
  const action = b.dataset.peer, id = b.dataset.id;
  if (action.startsWith("report-") || action === "chart-evidence") event.preventDefault();
  b.disabled = true;
  try {
    if (action === "refresh") await load();
    if (action === "recent-filter") { ui.filters = recentFilters(); ui.page = 0; ui.selected.clear(); await load(); }
    if (action === "report-dimension") { reportViewState.dimension = b.dataset.key; paint(); }
    if (action === "report-trend") { reportViewState.trendMetric = b.dataset.key; paint(); }
    if (action === "report-series") { reportViewState.hidden.has(id) ? reportViewState.hidden.delete(id) : reportViewState.hidden.add(id); paint(); }
    if (action === "chart-evidence") modal(chartEvidence(ui.report, b));
    if (action === "filter") { ui.filters = { runId: document.querySelector("#peer-run").value, from: document.querySelector("#peer-from").value, to: document.querySelector("#peer-to").value }; ui.page = 0; ui.selected.clear(); await load(); }
    if (action === "reset-filter") { ui.filters = { runId: "", from: "", to: "" }; ui.page = 0; ui.selected.clear(); await load(); }
    if (action === "prev" || action === "next") { ui.page += action === "next" ? 1 : -1; paint(); }
    if (action === "clear-selection") { ui.selected.clear(); paint(); }
    if (["confirm", "exclude", "restore"].includes(action)) await decision(action, id ? [id] : [...ui.selected]);
    if (action === "analyze") await createReport([...ui.selected]);
    if (action === "report") { reportViewState.companyId = null; reportViewState.hidden.clear(); ui.report = await api(`/reports/${encodeURIComponent(id)}`); ui.tab = "reports"; paint(); }
    if (action === "back-reports") { ui.report = null; paint(); }
    if (action === "reanalyze") await createReport(ui.report.companyIds, ui.report.filters);
    if (action === "close") b.closest("dialog").close();
    if (action === "merge-dialog") {
      const source = allCompanies().find(c => c.id === id);
      modal(`<h2>将 ${esc(source.name)} 合并到</h2><p>确认是同一家后合并，出现次数按回答去重。合并后可以拆开别名。</p><label>目标公司<select id="peer-merge-target">${allCompanies().filter(c => c.id !== id && c.status !== "excluded").map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.own ? "（我们公司）" : ""}</option>`).join("")}</select></label><button class="primary" data-peer="merge" data-id="${esc(id)}">合并为同一家公司</button>`);
    }
    if (action === "merge") { const targetId = document.querySelector("#peer-merge-target").value; await decision("merge", [id], { targetId }); document.querySelector("#peer-dialog")?.close(); }
    if (action === "aliases") {
      const c = allCompanies().find(c => c.id === id);
      modal(`<h2>${esc(c.name)} 的所有名称</h2><p>固定名单模式下，别名会继续归入当前已确认公司。</p>${c.aliases.map(a => `<div class="peer-alias"><span>${esc(a)}</span>${a === c.name ? "主名称" : "已合并别名"}</div>`).join("")}`);
    }
    if (action === "split") { await decision("split", [id], { alias: b.dataset.alias }); document.querySelector("#peer-dialog")?.close(); }
    if (action === "evidence") {
      const offset = Number(b.dataset.offset || 0);
      const data = await api(`/evidence?${qs()}&companyId=${encodeURIComponent(id)}&offset=${offset}`);
      modal(`<h2>${esc(data.name)} · 出现记录</h2><p>共 ${data.total} 条，当前显示 ${offset + 1}—${Math.min(offset + 30, data.total)} 条。</p>${data.items.map(e => `<article class="peer-report-evidence"><b>${esc(e.question)}</b><small>${date(e.date)} · ${position(e.position)}</small><p class="peer-quote">${esc(e.snippet)}</p>${evidenceButton(id, e.answerId)}</article>`).join("")}${offset > 0 ? `<button class="secondary" data-peer="evidence" data-id="${esc(id)}" data-offset="${Math.max(0,offset-30)}">上一页</button>` : ""}${offset + 30 < data.total ? `<button class="secondary" data-peer="evidence" data-id="${esc(id)}" data-offset="${offset+30}">下一页</button>` : ""}`);
    }
    if (action === "answer") {
      const path = ui.tab === "reports" && ui.report ? `/reports/${encodeURIComponent(ui.report.id)}/answer?answerId=${encodeURIComponent(b.dataset.answer)}` : `/evidence?companyId=${encodeURIComponent(id)}&answerId=${encodeURIComponent(b.dataset.answer)}`;
      const data = await api(path);
      modal(`<h2>${esc(data.answer.question)}</h2><p>${date(data.answer.date)} · 豆包原始回答</p><pre class="peer-raw">${esc(data.answer.raw)}</pre>`);
    }
  } catch (e) { flash(e.message, true); const d = document.querySelector("#peer-dialog"); if (d) { const error = document.createElement("p"); error.className = "peer-message bad"; error.textContent = e.message; d.append(error); } }
  finally { b.disabled = false; }
}

export function mountCompetitors() {
  const el = root(); if (!el) return;
  clearInterval(ui.timer);
  el.addEventListener("click", handleClick);
  el.addEventListener("input", event => {
    if (event.target.id === "peer-search") {
      const at = event.target.selectionStart; ui.query = event.target.value; ui.page = 0; paint(); const input = document.querySelector("#peer-search"); input?.focus(); try { input?.setSelectionRange(at, at); } catch {}
    }
  });
  el.addEventListener("change", event => {
    if (event.target.id === "report-company") { reportViewState.companyId = event.target.value; paint(); return; }
    const id = event.target.dataset.peerSelect;
    if (id) { if (event.target.checked) ui.selected.add(id); else ui.selected.delete(id); }
    if (event.target.id === "peer-select-page") el.querySelectorAll("[data-peer-select]").forEach(cb => { cb.checked = event.target.checked; if (cb.checked) ui.selected.add(cb.dataset.peerSelect); else ui.selected.delete(cb.dataset.peerSelect); });
    const count = document.querySelector("#peer-selected-count"); if (count) count.textContent = `已选 ${ui.selected.size} 家`;
  });
  el.addEventListener("dragstart", event => { const item = event.target.closest("[data-company-drag]"); if (item) { event.dataTransfer.setData("text/peer-company", item.dataset.companyDrag); event.dataTransfer.effectAllowed = "move"; } });
  el.addEventListener("dragover", event => { const row = event.target.closest("[data-company-row]"); if (row && event.dataTransfer.types.includes("text/peer-company")) { event.preventDefault(); row.classList.add("peer-drop"); } });
  el.addEventListener("dragleave", event => event.target.closest("[data-company-row]")?.classList.remove("peer-drop"));
  el.addEventListener("dragend", () => el.querySelectorAll(".peer-drop").forEach(e => e.classList.remove("peer-drop")));
  el.addEventListener("drop", async event => {
    const row = event.target.closest("[data-company-row]"); if (!row) return; event.preventDefault(); row.classList.remove("peer-drop");
    const sourceId = event.dataTransfer.getData("text/peer-company"); if (!sourceId || sourceId === row.dataset.companyRow) return;
    try { await decision("merge", [sourceId], { targetId: row.dataset.companyRow }); } catch (e) { flash(e.message, true); }
  });
  paint(); void load();
  let ticks = 0, polling = false;
  ui.timer = setInterval(async () => {
    if (!root()) { clearInterval(ui.timer); return; }
    if (polling || document.hidden) return; polling = true;
    try {
      const { reports } = await api("/reports");
      if (ui.data) ui.data.reports = reports;
      if (ui.tab === "reports") {
        if (ui.report && ["queued", "running"].includes(ui.report.status)) { ui.report = await api(`/reports/${encodeURIComponent(ui.report.id)}`); paint(); }
        else if (!ui.report) { const list = document.querySelector("#peer-report-list"); if (list) list.innerHTML = reportCards(); }
      }
      ticks++;
      if (ticks % 10 === 0 && ui.tab !== "reports" && !ui.selected.size && !document.querySelector("#peer-dialog") && !el.contains(document.activeElement)) await load();
    } catch (e) { flash(`更新暂未完成：${e.message}`, true); }
    finally { polling = false; }
  }, 3000);
}
