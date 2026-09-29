import { createServer } from "node:http";
import { readFile, mkdtemp, copyFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createCompetitorService } from "../lib/competitor-service.mjs";
import { researchCompany } from "../lib/competitor-research.mjs";
const root = fileURLToPath(new URL("../",import.meta.url));
const source = JSON.parse(await readFile(join(root,"data/store.json"),"utf8"));
const temp = await mkdtemp(join(tmpdir(),"report-v2-"));
await copyFile(join(root,"data/competitors.json"),join(temp,"competitors.json"));
const live = process.argv.includes("--live");
const service = await createCompetitorService({path:join(temp,"competitors.json"),getSource:()=>source,research:live?researchCompany:async()=>({sources:[],attempts:[{channel:"界面验证",status:"failed",error:"本次只验证图表和交互，没有调用公开检索"}]})});
const server = createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  const json=(_res,status,data)=>{res.writeHead(status,{"content-type":"application/json; charset=utf-8"});res.end(JSON.stringify(data));};
  try {
    if(await service.handle(req,res,url,async()=>{let raw="";for await(const chunk of req)raw+=chunk;return JSON.parse(raw||"{}");},json))return;
    if(url.pathname.startsWith("/api/")){
      if(req.method!=="GET")return json(res,403,{error:"隔离验证只允许读取原系统"});
      const response=await fetch(`http://127.0.0.1:4318${req.url}`);res.writeHead(response.status,{"content-type":response.headers.get("content-type")});res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const path=join(root,"public",url.pathname==="/"?"index.html":url.pathname.slice(1));
    res.writeHead(200,{"content-type":{".js":"text/javascript",".mjs":"text/javascript",".css":"text/css",".html":"text/html"}[extname(path)]||"application/octet-stream"});res.end(await readFile(path));
  }catch(error){json(res,500,{error:error.message});}
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1485,height:1050}});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
const output=join(root,"../output");await mkdir(output,{recursive:true});
try{
  await page.goto(base,{waitUntil:"networkidle"});
  await page.locator('[data-view="competitors"]').click();
  await page.locator("#peer-search").waitFor({timeout:30000});
  assert.ok(await page.locator("#peer-from").inputValue());
  const filters={from:await page.locator("#peer-from").inputValue(),to:await page.locator("#peer-to").inputValue(),runId:""};
  const before=await(await fetch(base+"/api/competitors?"+new URLSearchParams(filters))).json();
  const peers=before.confirmed.filter(c=>!c.own&&c.mentions>0).slice(0,2);
  for(const peer of peers)await page.locator(`[data-peer-select="${peer.id}"]`).check();
  await page.locator('[data-peer="analyze"]').click();
  await page.locator(".report-v2").waitFor({timeout:30000});
  let report;
  for(let i=0;i<240;i++){
    const summaries=await(await fetch(base+"/api/competitors/reports")).json();
    report=await(await fetch(base+"/api/competitors/reports/"+summaries.reports[0].id)).json();
    if(!["queued","running"].includes(report.status))break;
    if(i%10===0)console.log(report.message);
    await new Promise(r=>setTimeout(r,1000));
  }
  assert.ok(["completed","partial"].includes(report.status),report.message);
  await page.locator('[data-peer="back-reports"]').click();
  await page.locator(`[data-peer="report"][data-id="${report.id}"]`).click();
  await page.locator(".report-v2").waitFor();
  assert.equal(await page.locator(".report-bar-row").count(),3);
  await page.locator('[data-peer="chart-evidence"][data-scope="overview"]').first().click();
  await page.locator('#peer-dialog [data-peer="answer"]').first().click();
  await page.locator(".peer-raw").waitFor();
  await page.locator('#peer-dialog [data-peer="close"]').click();
  await page.locator('[data-peer="report-dimension"][data-key="need"]').click();
  assert.ok((await page.locator(".report-heatmap").innerText()).includes("小单起订"));
  await page.locator('[data-peer="report-dimension"][data-key="region"]').click();
  assert.ok((await page.locator(".report-heatmap").innerText()).includes("茶山"));
  await page.locator('[data-peer="report-trend"][data-key="mentionRate"]').click();
  await page.locator('.report-trend [data-peer="chart-evidence"]').first().click();
  await page.locator("#peer-dialog h2").waitFor();await page.locator('#peer-dialog [data-peer="close"]').click();
  await page.locator("#report-company").selectOption(peers[1].id);
  await page.locator('[data-peer="chart-evidence"][data-scope="reason"]').first().click();
  await page.locator("#peer-dialog h2").waitFor();await page.locator('#peer-dialog [data-peer="close"]').click();
  await page.locator(".report-cover").scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,"report-v2-overview.png")});
  await page.locator(".report-heatmap").scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,"report-v2-differences.png")});
  if(await page.locator(".report-advice").count()) {await page.locator(".report-advice").first().scrollIntoViewIfNeeded();await page.screenshot({path:join(output,"report-v2-actions.png")});}
  await page.setViewportSize({width:780,height:1000});await page.locator(".report-cover").scrollIntoViewIfNeeded();
  await page.screenshot({path:join(output,"report-v2-narrow.png")});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),"page overflows viewport");
  assert.deepEqual(errors,[]);
  assert.equal(report.answerSnapshots,undefined);
  const disk=JSON.parse(await readFile(join(temp,"competitors.json"),"utf8"));
  assert.equal(disk.reports.find(r=>r.id===report.id).answerSnapshots.length,report.answerCount);
  console.log(JSON.stringify({status:report.status,answers:report.answerCount,companies:report.dashboard.companies.length,days:report.dashboard.trend.length,advice:report.results.map(r=>({name:r.name,count:r.advice.length,readSources:r.sources.filter(s=>s.state==="read").length})),browserErrors:errors,isolatedDatabase:temp}));
}catch(error){ console.log("UI errors:",errors); console.log((await page.locator("body").textContent()).slice(0,5000)); await page.screenshot({path:join(output,"report-v2-debug.png")});throw error;
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
