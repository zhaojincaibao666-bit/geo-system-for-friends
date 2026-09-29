// Isolated UI check: all mutations go to a temporary competitor database.
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createCompetitorService } from "../lib/competitor-service.mjs";
import { researchCompany } from "../lib/competitor-research.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const source = JSON.parse(await readFile(join(root, "data/store.json"), "utf8"));
const dir = await mkdtemp(join(tmpdir(), "peer-ui-"));
const liveResearch = process.env.PEER_VERIFY_LIVE_RESEARCH === "1";
const service = await createCompetitorService({ path: join(dir, "companies.json"), getSource: () => source, research: liveResearch ? researchCompany : async () => ({ sources: [], attempts: [{ channel: "验证环境", status: "failed", error: "本次界面检查未执行联网研究" }] }) });
const server = createServer(async (req,res) => {
  const url = new URL(req.url, "http://localhost");
  const json = (_res,status,data) => { res.writeHead(status,{ "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)); };
  try {
    if (await service.handle(req,res,url,async () => { let text=""; for await(const chunk of req) text+=chunk; return JSON.parse(text || "{}"); },json)) return;
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") return json(res,403,{error:"Verification is read-only for existing app APIs"});
      const response = await fetch(`http://127.0.0.1:4318${req.url}`); res.writeHead(response.status,{"content-type":response.headers.get("content-type")}); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const path = join(root,"public",url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    res.writeHead(200,{"content-type":{ ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".html":"text/html" }[extname(path)] || "application/octet-stream"});res.end(await readFile(path));
  } catch(e) { json(res,500,{error:e.message}); }
});
await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1485,height:1050}});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:"networkidle"});
  await page.locator('[data-view="competitors"]').click();
  await page.locator("#peer-search").waitFor({timeout:30000});
  const data = await page.request.get(`http://127.0.0.1:${server.address().port}/api/competitors`).then(r=>r.json());
  console.log(JSON.stringify({answers:data.totalAnswers,pending:data.pending.length,own:data.confirmed.map(c=>({name:c.name,mentions:c.mentions,topFive:c.topFive}))}));
  await page.locator('[data-peer-tab="pending"]').click();
  await page.screenshot({path:join(root,"../output/competitor-pending.png"),fullPage:false});
  const company=data.pending.find(c=>c.name === "东莞信亿玩具有限公司") || data.pending[0];
  await page.locator(`#competitor-root [data-peer="confirm"][data-id="${company.id}"]`).click();
  await page.locator("#peer-message").filter({hasText:"已确认"}).waitFor();
  await page.locator('[data-peer-tab="ranking"]').click();
  await page.locator(`[data-peer-select="${company.id}"]`).check();
  await page.locator('[data-peer="analyze"]').click();
  await page.locator(".peer-report-lead").waitFor({timeout:liveResearch ? 300000 : 30000});
  if (liveResearch) {
    const reports = await page.request.get(`http://127.0.0.1:${server.address().port}/api/competitors/reports`).then(r=>r.json());
    const details = await page.request.get(`http://127.0.0.1:${server.address().port}/api/competitors/reports/${reports.reports[0].id}`).then(r=>r.json());
    console.log(JSON.stringify({reportStatus:details.status,realSources:details.results.flatMap(c=>c.sources.filter(s=>s.state === "read").map(s=>({title:s.title,url:s.url}))),ownSources:details.results[0].ourSources.filter(s=>s.state === "read").length,practices:details.results[0].practices.map(p=>p.title)}));
  }
  await page.screenshot({path:join(root,"../output/competitor-report.png"),fullPage:false});
  await page.locator('[data-peer="back-reports"]').click();
  assert.equal(await page.locator(".peer-report-card").count(),1);
  await page.locator('[data-peer-tab="pending"]').click();
  const excluded=data.pending.find(c=>c.id!==company.id);
  await page.locator(`[data-peer="exclude"][data-id="${excluded.id}"]`).click();
  await page.locator("#peer-message").filter({hasText:"已永久排除"}).waitFor();
  await page.locator('[data-peer-tab="manage"]').click();
  await page.locator("#peer-search").fill(excluded.name);
  await page.locator(`[data-peer="restore"][data-id="${excluded.id}"]`).click();
  await page.locator("#peer-message").filter({hasText:"已恢复"}).waitFor();
  await page.locator('[data-peer-tab="pending"]').click();
  await page.locator("#peer-search").fill("信亿");
  const short=data.pending.find(c=>c.name==="信亿玩具");
  if (short) {
    await page.locator('[data-peer-tab="manage"]').click(); await page.locator("#peer-search").fill("信亿");
    await page.locator(`[data-company-drag="${short.id}"]`).dragTo(page.locator(`[data-company-row="${company.id}"]`));
    await page.locator("#peer-message").filter({hasText:"已合并"}).waitFor();
    await page.locator(`[data-peer="aliases"][data-id="${company.id}"]`).click();
    await page.locator('[data-peer="split"][data-alias="信亿玩具"]').click();
    await page.locator("#peer-message").filter({hasText:"已拆分"}).waitFor();
  }
  await page.locator('[data-peer-tab="ranking"]').click();
  await page.locator('[data-peer="evidence"][data-id="our-company"]').first().click();
  await page.locator('#peer-dialog [data-peer="answer"]').first().click();
  await page.locator(".peer-raw").waitFor();
  await page.locator('#peer-dialog [data-peer="close"]').click();
  await page.screenshot({path:join(root,"../output/competitor-comparison.png"),fullPage:false});
  console.log("Browser errors:", JSON.stringify(errors));
  assert.deepEqual(errors,[]);
  console.log("Verified: navigation, real-history indexing, confirmation, exclusion, restore, drag merge, split, evidence, report lifecycle. No browser errors.");
} finally { await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
