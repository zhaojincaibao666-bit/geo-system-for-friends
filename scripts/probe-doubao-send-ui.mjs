/** Read-only send-control inspection: never type, click Send, or create a run. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDoubaoWebConfig } from '../lib/doubao-config.mjs';
import { DoubaoBrowserManager } from '../lib/doubao-browser-manager.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = () => createHash('sha256').update(readFileSync(resolve(root, 'data/store.json'))).digest('hex');
const before = hash();
if (before !== 'c9ce9e6c1132615334abdf4d4707f741d9bfcd77337e0b4733a3fcb9ec0dcc42') throw new Error('BASELINE_MISMATCH');
const dir = resolve(root, 'data/doubao-debug/send-ui', new Date().toISOString().replace(/[:.]/g, '-'));
const manager = new DoubaoBrowserManager({ ...readDoubaoWebConfig({ root }), debugDir: dir, workerCount: 4 });
try {
  const workers = await manager.ensureWorkerPages(4);
  const worker = workers.find(w => w.workerId === 'doubao-worker-1');
  const conversationUrl = process.argv.find(arg => arg.startsWith('--conversation-url='))?.split('=').slice(1).join('=');
  if (conversationUrl) {
    if (!/^https:\/\/www\.doubao\.com\/chat\/\d+$/.test(conversationUrl)) throw new Error('INVALID_CONVERSATION_URL');
    await worker.page.goto(conversationUrl, { waitUntil: 'domcontentloaded' });
    await worker.page.locator('[data-message-id]').waitFor({ state: 'attached', timeout: 12000 }).catch(() => null);
  }
  const composer = await worker._inspectComposer({ timeoutMs: 3000 });
  if (!composer.locator) throw new Error('COMPOSER_UNAVAILABLE');
  const evidence = await composer.locator.evaluate(node => {
    const attrs = n => Object.fromEntries([...n.attributes].map(a => [a.name, a.value]));
    const ancestors = [];
    for (let n = node.parentElement, depth = 1; n && n !== document.body && depth <= 9; n = n.parentElement, depth++) {
      const hasHistory = Boolean(n.querySelector('[data-message-id]'));
      ancestors.push({ depth, tag: n.tagName, attrs: attrs(n), hasHistory,
        controls: hasHistory ? [] : [...n.querySelectorAll('button, [role=button], #flow-end-msg-send')].map(c => ({tag: c.tagName, attrs: attrs(c), visible: Boolean(c.getClientRects().length), html: c.outerHTML})) });
      if (hasHistory) break;
    }
    const scope = node.closest('.guidance-input-content');
    return { composerHtml: node.outerHTML, containerHtml: scope && !scope.querySelector('[data-message-id]') ? scope.outerHTML : null, ancestors, userMessageCandidates: [...document.querySelectorAll('[data-message-id]')].filter(n => n.textContent.trim() === '东莞毛绒玩具源头工厂推荐').map(n => ({html:n.outerHTML})), oldSend: [...document.querySelectorAll('#flow-end-msg-send')].map(n => ({tag:n.tagName, html:n.outerHTML, parentHtml:n.parentElement.outerHTML})), pageUrl:location.href };
  });
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'metadata.json'), JSON.stringify({ capturedAt:new Date().toISOString(), workerCount:workers.length, ...evidence }, null, 2));
  console.log(JSON.stringify({dir, userMessageCandidates:evidence.userMessageCandidates, pageUrl:evidence.pageUrl}, null, 2));
} finally {
  await manager.shutdown();
  console.log(JSON.stringify({ QUESTION_SENT:0, FORMAL_RUN_CREATED:0, HASH_BEFORE:before, HASH_AFTER:hash(), FORMAL_STORE_MODIFIED:hash() === before ? 'NO':'YES' }));
}
