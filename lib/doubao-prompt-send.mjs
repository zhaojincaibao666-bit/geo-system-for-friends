import { randomUUID } from 'node:crypto';

// Observed in the formal profile on 2026-09-08; no position-based fallback.
export const SEND_CONTROL_SELECTOR = '.send-btn-wrapper > button#flow-end-msg-send';
export const USER_MESSAGE_SELECTOR = '[data-testid="send_message"][data-message-role="user"], [data-message-id].justify-end';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = code => { throw Object.assign(new Error(code), { code, stage: 'submit_prompt' }); };
export const readComposerText = composer => composer.evaluate(n => String('value' in n ? n.value : n.innerText || n.textContent || '').trim());

/**
 * Doubao's current ProseMirror composer may re-render while it receives
 * character-by-character keyboard events.  When that happens the caret can
 * jump to the beginning and rotate the end of a Chinese question in front of
 * its beginning.  `fill` applies the complete value as one edit and dispatches
 * the input event expected by both the current contenteditable and the legacy
 * textarea shell.  Always read the live DOM back before allowing a send.
 */
export async function fillDoubaoComposerExact(composer, question) {
  const expected = String(question || '').trim();
  if (!expected) fail('DOUBAO_EMPTY_PROMPT');
  await composer.fill(expected);
  const actual = await readComposerText(composer);
  if (actual !== expected) {
    const error = Object.assign(new Error('DOUBAO_QUESTION_TEXT_MISMATCH'), {
      code: 'DOUBAO_QUESTION_TEXT_MISMATCH',
      stage: 'submit_prompt',
      expectedText: expected,
      actualText: actual,
    });
    throw error;
  }
  return actual;
}

// Doubao may add presentation spaces around a Latin token such as "IP" when
// it renders the sent bubble. That does not change character order or intent.
// Pre-send checks remain byte-for-byte exact; this equivalence is only for the
// immutable post-send bubble.
export function sentPromptTextEquivalent(actual, expected) {
  return String(actual || '').replace(/\s+/gu, '') === String(expected || '').replace(/\s+/gu, '');
}

export function createSendAudit() {
  return { QUESTION_SENT: 0, SEND_ACTION_MAX: 1, SEND_ACTION_COUNT: 0,
    SEND_ACTION_CONFIRMED: 'NO', AUTOMATIC_SEND_CONFIRMED: 'NO',
    MANUAL_INTERVENTION_DETECTED: 'NO', MANUAL_INTERVENTION_DECLARED: 'NO',
    SEND_METHOD: 'CLICK', SEND_BUTTON_SELECTOR: SEND_CONTROL_SELECTOR, stages: [] };
}

function messageKey(message) {
  return message.id ? `id:${message.id}` : `text:${String(message.text || '').replace(/\s+/gu, '')}`;
}

export function findNewUserMessages(messages, baseline = []) {
  const baselineIds = new Set(baseline.filter(item => typeof item === 'string'));
  const baselineCounts = new Map();
  for (const item of baseline) {
    const key = typeof item === 'string' ? `id:${item}` : messageKey(item);
    baselineCounts.set(key, (baselineCounts.get(key) || 0) + 1);
  }
  const currentCounts = new Map();
  return messages.filter(message => {
    const key = messageKey(message);
    const occurrence = (currentCounts.get(key) || 0) + 1;
    currentCounts.set(key, occurrence);
    if (message.id && baselineIds.has(message.id)) return false;
    return occurrence > (baselineCounts.get(key) || 0);
  });
}

export function findNewUserMessage(messages, baseline, question, workerId, pageId) {
  return findNewUserMessages(messages, baseline).find(message => message.workerId === workerId && message.pageId === pageId
    && message.visible && sentPromptTextEquivalent(message.text, question)) || null;
}

/** Page-local monitor. DOM event provenance cannot identify a physical mouse
 * versus Playwright inside the same click window; extra/out-of-window sends
 * are detected, and user declarations independently invalidate automation. */
export async function refreshSendAudit(page, audit) {
  if (!audit.monitorKey) return audit;
  const observed = await page.evaluate(key => {
    const state = window[key];
    return state ? { clicks: state.clicks, manual: state.manual } : null;
  }, audit.monitorKey).catch(() => null);
  if (!observed) audit.MONITOR_AVAILABLE = 'NO';
  else {
    audit.MONITOR_AVAILABLE = 'YES';
    audit.OBSERVED_SEND_CLICKS = observed.clicks;
    if (observed.manual) audit.MANUAL_INTERVENTION_DETECTED = 'YES';
  }
  if (!observed || audit.MANUAL_INTERVENTION_DETECTED === 'YES' || audit.MANUAL_INTERVENTION_DECLARED === 'YES') audit.AUTOMATIC_SEND_CONFIRMED = 'NO';
  return audit;
}

export async function disposeSendMonitor(page, audit) {
  if (!audit?.monitorKey) return;
  await page.evaluate(key => {
    const state = window[key];
    if (state) for (const type of ['click', 'keydown']) document.removeEventListener(type, state.listener, true);
    delete window[key];
  }, audit.monitorKey).catch(() => null);
}

/** Fill once, perform one actionable click, then require a new matching user
 * message on this Page. No Enter, forced click, retry, or assistant-only proof. */
export async function sendDoubaoPrompt({ page, composer, question, workerId, pageId,
  ensureReady, audit, timeoutMs = 12000, typingDelayMs = 25, pollMs = 100 }) {
  if (audit.attemptStarted) fail('DOUBAO_SEND_ALREADY_ATTEMPTED');
  audit.attemptStarted = true;
  const stage = name => audit.stages.push({ name, at: new Date().toISOString() });
  const requireReady = async () => {
    await ensureReady();
    audit.LOGIN_READY = 'PASS';
    if (!composer || await composer.count() !== 1 || !await composer.isVisible() || !await composer.isEditable() || !await composer.isEnabled()) fail('DOUBAO_COMPOSER_NOT_READY');
    audit.COMPOSER_READY = 'PASS';
  };
  await requireReady();
  if (!question?.trim()) fail('DOUBAO_EMPTY_PROMPT');
  if (await readComposerText(composer)) fail('DOUBAO_COMPOSER_NOT_EMPTY');
  const scope = composer.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " guidance-input-content ")][1]');
  if (await scope.count() !== 1 || await scope.locator('[role="textbox"][contenteditable="true"], textarea, input[role="textbox"]').count() !== 1) fail('DOUBAO_COMPOSER_SCOPE_AMBIGUOUS');
  const messages = async () => (await page.locator(USER_MESSAGE_SELECTOR).evaluateAll(nodes => nodes.map(n => ({
    id:n.getAttribute('data-message-id'), text:(n.innerText || n.textContent || '').trim(),
    visible:Boolean(n.getClientRects().length), failed:Boolean(n.querySelector('[data-testid="message_box_failed_icon"]')),
  })))).map(m => ({ ...m, workerId, pageId }));
  const baselineMessages = await messages();
  audit.baselineUserMessageIds = baselineMessages.map(m => m.id).filter(Boolean);
  audit.baselineUserMessages = baselineMessages;
  audit.workerId = workerId; audit.pageId = pageId;
  audit.monitorKey = `__geoSend_${randomUUID().replaceAll('-', '')}`;
  await page.evaluate(({key, selector}) => {
    const state = { phase:'preparing', clicks:0, manual:false };
    state.listener = event => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.type === 'click' && target?.closest(selector)) {
        state.clicks++;
        if (state.phase !== 'clicking' || state.clicks !== 1) state.manual = true;
      }
      if (event.type === 'keydown' && event.key === 'Enter' && !event.shiftKey && target?.closest('.guidance-input-content')) state.manual = true;
    };
    window[key] = state;
    for (const type of ['click', 'keydown']) document.addEventListener(type, state.listener, true);
  }, {key:audit.monitorKey, selector:SEND_CONTROL_SELECTOR});
  stage('INPUT_STARTED');
  await fillDoubaoComposerExact(composer, question);
  const checkQuestion = async () => {
    const text = await readComposerText(composer);
    audit.QUESTION_PRESENT_IN_COMPOSER = text ? 'PASS':'FAIL';
    audit.QUESTION_TEXT_MATCH = text === question ? 'PASS':'FAIL';
    if (!text || text !== question) fail('DOUBAO_QUESTION_TEXT_MISMATCH');
  };
  await checkQuestion(); stage('QUESTION_TEXT_VERIFIED');
  const send = scope.locator(SEND_CONTROL_SELECTOR);
  const deadline = Date.now() + timeoutMs;
  let enabled = false;
  do {
    const count = await send.count();
    audit.SEND_CONTROL_PRESENT = count === 1 ? 'PASS':'FAIL';
    if (count > 1) fail('DOUBAO_SEND_CONTROL_AMBIGUOUS');
    audit.SEND_CONTROL_VISIBLE = count === 1 && await send.isVisible() ? 'PASS':'FAIL';
    enabled = count === 1 && await send.isEnabled() && await send.evaluate(n => !n.disabled && n.getAttribute('aria-disabled') !== 'true' && n.getAttribute('data-disabled') !== 'true' && n.getAttribute('data-loading') !== 'true');
    audit.SEND_CONTROL_ENABLED = enabled ? 'PASS':'FAIL';
    if (enabled && audit.SEND_CONTROL_VISIBLE === 'PASS') break;
    if (Date.now() < deadline) await sleep(pollMs);
  } while (Date.now() < deadline);
  if (!enabled || audit.SEND_CONTROL_VISIBLE !== 'PASS') fail('DOUBAO_SEND_UNAVAILABLE');
  // Playwright checks visibility, stability and hit-testing without dispatch.
  try { await send.click({ trial:true, timeout:timeoutMs }); }
  catch (error) { audit.SEND_CONTROL_ACTIONABLE = 'FAIL'; audit.actionabilityError = error.message; throw error; }
  audit.SEND_CONTROL_ACTIONABLE = 'PASS';
  audit.sendControlHtml = await send.evaluate(n => n.outerHTML);
  await requireReady(); await checkQuestion();
  if (!await send.isEnabled() || !await send.evaluate(n => !n.disabled && n.getAttribute('aria-disabled') !== 'true' && n.getAttribute('data-disabled') !== 'true' && n.getAttribute('data-loading') !== 'true')) fail('DOUBAO_SEND_BECAME_DISABLED');
  await refreshSendAudit(page, audit);
  if (audit.MONITOR_AVAILABLE !== 'YES' || audit.MANUAL_INTERVENTION_DETECTED === 'YES' || findNewUserMessages(await messages(), baselineMessages).length) fail('DOUBAO_MANUAL_OR_UNEXPECTED_SEND');
  audit.SEND_ACTION_COUNT = 1; stage('SEND_CLICK_STARTED');
  await page.evaluate(key => { window[key].phase = 'clicking'; }, audit.monitorKey);
  try { await send.click({ timeout:timeoutMs }); }
  finally { await page.evaluate(key => { if (window[key]) window[key].phase = 'confirming'; }, audit.monitorKey).catch(() => null); }
  stage('SEND_CLICK_RETURNED');
  const confirmationDeadline = Date.now() + timeoutMs;
  do {
    await refreshSendAudit(page, audit);
    const currentMessages = await messages();
    const freshMessages = findNewUserMessages(currentMessages, baselineMessages).filter(m => m.visible);
    if (freshMessages.some(m => m.failed)) fail('DOUBAO_SEND_REJECTED');
    const user = findNewUserMessage(currentMessages, baselineMessages, question, workerId, pageId);
    if (user) {
      audit.QUESTION_SENT = 1;
      audit.USER_MESSAGE_APPEARED = 'YES';
      audit.userMessageId = user.id;
      audit.userMessageText = user.text;
      audit.POST_SEND_MATCH_MODE = user.text === question ? 'exact' : 'whitespace_normalized';
      audit.COMPOSER_CLEARED = await readComposerText(composer).then(text => text === '').catch(() => false);
      audit.SEND_ACTION_CONFIRMED = 'YES';
      if (audit.MONITOR_AVAILABLE === 'YES' && audit.OBSERVED_SEND_CLICKS === 1 && audit.MANUAL_INTERVENTION_DETECTED === 'NO' && audit.MANUAL_INTERVENTION_DECLARED === 'NO') audit.AUTOMATIC_SEND_CONFIRMED = 'YES';
      if (audit.AUTOMATIC_SEND_CONFIRMED !== 'YES') fail('DOUBAO_SEND_AUTOMATION_UNCONFIRMED');
      audit.confirmedAt = new Date().toISOString(); stage('USER_MESSAGE_CONFIRMED');
      return audit.confirmedAt;
    }
    if (audit.MANUAL_INTERVENTION_DETECTED === 'YES' || audit.MONITOR_AVAILABLE !== 'YES') fail('DOUBAO_MANUAL_OR_UNEXPECTED_SEND');
    if (Date.now() < confirmationDeadline) await sleep(pollMs);
  } while (Date.now() < confirmationDeadline);
  fail('DOUBAO_SEND_NOT_CONFIRMED');
}

export function finalizeAutomaticProbe(result) {
  const pass = !result.error && result.QUESTION_SENT === 1 && result.SEND_ACTION_COUNT === 1 && result.AUTOMATIC_SEND_CONFIRMED === 'YES'
    && result.MANUAL_INTERVENTION_DETECTED === 'NO' && result.MANUAL_INTERVENTION_DECLARED === 'NO'
    && ['ANSWER_COMPLETED','ANSWER_IDENTITY_RESOLVED','CITATION_SCOPE_RESOLVED','SCRAPLING_REAL_DOM_PARSE'].every(key => result[key] === 'PASS')
    && result.FORMAL_STORE_MODIFIED === 'NO' && result.FORMAL_STORE_HASH_UNCHANGED === 'PASS' && result.FORMAL_RUN_CREATED === 0;
  return { REALTIME_CITATION_PROBE:pass ? 'PASS':'FAIL', END_TO_END_AUTOMATION_VALIDATED:pass ? 'YES':'NO' };
}
