const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function referenceSourceLabel(record = {}) {
  const status = record.citationCaptureStatus;
  if (['CAPTURE_FAILED','CITATION_REGION_NOT_LOADED'].includes(status)) return '来源采集失败';
  if (status === 'CAPTURED_PARTIAL') return '来源部分采集';
  if (status === 'NO_CITATION_CONFIRMED') return '本次无来源';
  if (status === 'CAPTURED') return `参考资料 ${record.citationCount ?? record.citations?.length ?? 0} 条`;
  return '历史来源未采集';
}
export function renderReferenceSources(record = {}) {
  const citations = record.browserCitations || record.citations || [];
  const capture = record.citationCaptureV2 || record.citationCapture || {};
  const expected = capture.expectedSourceCount;
  const label = referenceSourceLabel(record);
  const failed = ['CAPTURE_FAILED','CITATION_REGION_NOT_LOADED','CAPTURED_PARTIAL'].includes(record.citationCaptureStatus);
  const note = failed ? `<p class="invalid-note">${esc(label)}${Number.isInteger(expected) ? `：已保存 ${citations.length} / ${expected} 条` : ''}。回答和品牌监测结果已保留。</p>` : '';
  return `<details class="citation-evidence"><summary>${esc(label)}</summary>${note}<ol>${citations.map(source => {
    const url = source.url || source.rawUrl || '';
    const title = source.title || source.visibleText || '未标注标题';
    const link = /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : esc(title);
    return `<li>${link}<br><span class="muted">${esc(source.domain || '')}</span><br><span class="muted" style="overflow-wrap:anywhere">${esc(url)}</span></li>`;
  }).join('')}</ol></details>`;
}
