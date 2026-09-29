/** Inspect one existing answer; never create a conversation or submit text. */
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { DoubaoBrowserManager } from '../lib/doubao-browser-manager.mjs';
import { readDoubaoWebConfig } from '../lib/doubao-config.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = resolve(root, 'data/doubao-debug/reference-list', new Date().toISOString().replace(/[:.]/g, '-'));
const hash = () => createHash('sha256').update(readFileSync(resolve(root,'data/store.json'))).digest('hex');
const before = hash();
if (before !== 'c9ce9e6c1132615334abdf4d4707f741d9bfcd77337e0b4733a3fcb9ec0dcc42') throw new Error('BASELINE_MISMATCH');
const manager = new DoubaoBrowserManager({ ...readDoubaoWebConfig({root}), debugDir:dir, workerCount:4 });
try {
  const workers = await manager.ensureWorkerPages(4);
  const worker = workers[0];
  await worker.page.goto('https://www.doubao.com/chat/38440614026208258', {waitUntil:'domcontentloaded'});
  const message = worker.page.locator('[data-message-id="54818070489573122"]');
  await message.waitFor({state:'visible',timeout:20000});
  const block = message.locator('[data-plugin-identifier*="search_query_result_block"]');
  await block.waitFor({state:'visible',timeout:10000});
  await mkdir(dir,{recursive:true});
  const beforeHtml = await block.evaluate(n=>n.outerHTML);
  await writeFile(resolve(dir,'before.html'),beforeHtml);
  const capture = await worker.getCitationCapture({ questionId:'existing-answer-validation', runId:'READ_ONLY_VALIDATION' });
  if (capture.status !== 'CAPTURED' || capture.citationCount !== 24) throw new Error(`CAPTURE_VALIDATION_FAILED:${JSON.stringify(capture)}`);
  const html = await block.evaluate(n=>n.outerHTML);
  const links = await block.locator('a[href]').evaluateAll(nodes=>nodes.map(n=>({title:n.textContent.trim(),href:n.getAttribute('href'),visible:Boolean(n.getClientRects().length)})));
  await writeFile(resolve(dir,'expanded.html'),html);
  await writeFile(resolve(dir,'metadata.json'),JSON.stringify({url:worker.page.url(),answerIdentity:'54818070489573122',workerCount:workers.length,links,capture},null,2));
  console.log(JSON.stringify({dir,count:links.length,status:capture.status,citationCount:capture.citationCount,first:capture.citations[0],last:capture.citations.at(-1)},null,2));
} finally {
  await manager.shutdown();
  console.log(JSON.stringify({PROMPTS_SENT:0,hashBefore:before,hashAfter:hash()}));
}
