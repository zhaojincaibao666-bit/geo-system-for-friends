import { captureCitationV2 } from './citation-capture-v2.mjs';

// Actual answer header observed 2026-09-08. The clickable header is a DIV,
// and its expanded anchors are descendants of this answer-owned plugin block.
export const REFERENCE_BLOCK = '[data-plugin-identifier*="search_query_result_block"]';
export const REFERENCE_HEADER = /搜索\s*\d+\s*个关键词[，,]\s*参考\s*(\d+)\s*篇资料/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function failedReferenceCapture(error, context = {}) {
  const message = String(error?.message || error).slice(0, 500);
  return { captureVersion:'v2', status:'CAPTURE_FAILED', legacyStatus:'failed',
    citationCount:0, citations:[], errors:[message], error:message,
    checkedChannels:[], expectedChannels:['source_trigger','source_panel'], missingChannels:['source_panel'],
    capturedAt:new Date().toISOString(), ...context };
}

/** Only called after the answer is complete. Failures are data, never retries
 * of the already answered question. No link destination is visited. */
export async function captureDoubaoReferenceList({ message, pageUrl = '', questionRunId = null, timeoutMs = 10000, parse = captureCitationV2 } = {}) {
  let answerIdentity = null;
  try {
    if (!message || await message.count() !== 1) throw new Error('REFERENCE_ANSWER_NOT_FOUND');
    answerIdentity = await message.getAttribute('data-message-id');
    if (!answerIdentity) throw new Error('REFERENCE_ANSWER_ID_MISSING');
    const blocks = message.locator(REFERENCE_BLOCK);
    const blockCount = await blocks.count();
    // If the UI advertises references in a changed layout, report a failure
    // instead of interpreting an unrecognised region as an empty answer.
    if (!blockCount && /参考\s*\d+\s*篇资料/.test(await message.innerText())) throw new Error('REFERENCE_LAYOUT_UNRECOGNISED');
    let expectedSourceCount = 0;
    let observedSourceCount = 0;
    const fragments = [];
    for (let i = 0; i < blockCount; i++) {
      const block = blocks.nth(i);
      const header = block.getByText(REFERENCE_HEADER);
      if (await header.count() !== 1) throw new Error('REFERENCE_HEADER_AMBIGUOUS');
      const count = Number((await header.innerText()).match(REFERENCE_HEADER)?.[1]);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('REFERENCE_COUNT_UNKNOWN');
      expectedSourceCount += count;
      const links = block.locator('a[href]');
      const visibleCount = () => links.evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).length);
      let seen = await visibleCount();
      if (count > 0 && !seen) await header.click({ timeout:timeoutMs });
      const deadline = Date.now() + timeoutMs;
      while (count > 0 && (seen = await visibleCount()) < count && Date.now() < deadline) await pause(100);
      observedSourceCount += seen;
      // Snapshot only the visible source anchors, in the UI's original order.
      fragments.push(await links.evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => n.outerHTML).join('\n')));
    }
    const complete = observedSourceCount === expectedSourceCount;
    const result = await parse({
      questionRunId, answerIdentity, pageUrl,
      sourcePanelHtml: `<section data-citation-channel="reference_list">${fragments.join('\n')}</section>`,
      checkedChannels:['source_trigger', ...(complete ? ['source_panel'] : [])],
      expectedChannels:['source_trigger','source_panel'],
      pageMetadata:{ sourcePanelScoped:true, sourcePanelAnswerIdentity:answerIdentity, sourcePanelExpected:true,
        referenceList:true, expectedSourceCount },
    });
    // Completeness is measured against the count printed by Doubao, not just
    // the number of DOM anchors (invalid hrefs must not silently disappear).
    if (result.citationCount !== expectedSourceCount && result.status !== 'CAPTURE_FAILED') {
      result.status = result.citationCount ? 'CAPTURED_PARTIAL' : 'CITATION_REGION_NOT_LOADED';
      result.legacyStatus = result.citationCount ? 'partial' : 'not_available';
      result.errors = [...(result.errors || []), `REFERENCE_COUNT_MISMATCH: expected=${expectedSourceCount}, captured=${result.citationCount}`];
    }
    return { ...result, expectedSourceCount, observedSourceCount, referenceBlockCount:blockCount,
      sourceType:'reference_list', error:result.errors?.join('; ') || null, citationVisibilityMismatch:!complete || result.citationCount !== expectedSourceCount };
  } catch (error) { return failedReferenceCapture(error, {answerIdentity, questionRunId}); }
}
