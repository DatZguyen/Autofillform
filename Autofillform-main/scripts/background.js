/* ============================================================================
 * background.js — Service Worker (BỘ NÃO)
 * - Queue Manager: tối đa 10 tab ẩn cùng lúc (chống Race Condition)
 * - Hỗ trợ Multi-page Google Forms: Khi bấm "Tiếp" hoặc "Submit" làm trang
 *   reload sang URL .../formResponse, background gửi lại payload để content.js
 *   điền tiếp trang 2, 3... hoặc xác nhận chính xác trang Cảm Ơn trước khi đóng tab.
 * ========================================================================== */

const MAX_CONCURRENT_TABS = 10;
const TAB_TIMEOUT_MS = 35 * 1000;
const DEFAULT_GRID_ROWS = 40;

const state = {
  isRunning: false,
  isPumping: false,
  nextIndex: 0,
  runId: null,
  formUrl: null,
  queue: [],
  questionsMeta: {},
  gridBasePools: new Map(),
  gridRowDecks: new Map(),
  textLineDecks: new Map(),
  activeTabs: new Map(),  // tabId -> { timeoutId, index, submitted }
  tabJobs: new Map(),     // tabId -> { payload, runId, index }
  stats: { total: 0, success: 0, failed: 0 },
  errorLog: [],
  delayMin: 3,
  delayMax: 5,
  abortReason: null,
};

/* ------------------------------------------------------------------
 * TIỆN ÍCH & THUẬT TOÁN TRÁO BÀI ĐỒNG ĐỀU (FISHER-YATES SHUFFLE)
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function randomDelayMs() {
  const lo = Math.max(0, Number(state.delayMin) || 0);
  const hi = Math.max(lo, Number(state.delayMax) || lo);
  return rand(lo, hi) * 1000;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function logError(index, error) {
  state.errorLog.push({
    index,
    error: String(error || 'Không rõ lỗi'),
    time: new Date().toLocaleTimeString('vi-VN'),
  });
  if (state.errorLog.length > 500) {
    state.errorLog.splice(0, state.errorLog.length - 500);
  }
}

function statsPayload() {
  return {
    ...state.stats,
    active: state.activeTabs.size,
    isRunning: state.isRunning,
    abortReason: state.abortReason,
    errorLog: state.errorLog,
  };
}

async function persistStats(extra = {}) {
  await chrome.storage.local.set({ runStats: { ...statsPayload(), ...extra } });
  try {
    await chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats: statsPayload() });
  } catch { /* popup đang đóng -> bỏ qua */ }
}

/* ------------------------------------------------------------------
 * SPINTAX & MULTI-LINE UNIFORM POOL
 * ------------------------------------------------------------------ */
function parseSpintax(text) {
  let out = String(text ?? '');
  const re = /(?<!\{)\{([^{}]*)\}(?!\})/g;
  let guard = 0;
  while (re.test(out) && guard++ < 20) {
    out = out.replace(/(?<!\{)\{([^{}]*)\}(?!\})/g, (_m, inner) => {
      const parts = String(inner).split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  }
  return out;
}

function pickUniformLine(deckKey, rawTextOrLines) {
  const lines = Array.isArray(rawTextOrLines)
    ? rawTextOrLines.map((s) => String(s).trim()).filter(Boolean)
    : String(rawTextOrLines ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  if (lines.length === 0) return '';
  if (lines.length === 1) return parseSpintax(lines[0]);

  let deck = state.textLineDecks.get(deckKey);
  if (!deck || deck.length === 0) {
    deck = shuffleArray(lines);
    state.textLineDecks.set(deckKey, deck);
  }
  const chosen = deck.pop();
  return parseSpintax(chosen);
}

/* ------------------------------------------------------------------
 * PHÂN BỔ TỶ LỆ CHUNG CHO CÂU HỎI GRID NHIỀU DÒNG CON
 * ------------------------------------------------------------------ */
function buildGridBasePools(payloads) {
  state.gridBasePools.clear();
  state.gridRowDecks.clear();
  state.textLineDecks.clear();

  for (const rawPayload of payloads) {
    if (!rawPayload || typeof rawPayload !== 'object') continue;
    for (const [qid, spec] of Object.entries(rawPayload)) {
      if (!spec || spec.value === undefined || spec.value === null) continue;
      if (!state.gridBasePools.has(qid)) {
        state.gridBasePools.set(qid, []);
      }
      state.gridBasePools.get(qid).push(spec.value);
    }
  }
}

function drawGridRowAnswers(qid, fallbackValue, rowCount) {
  const basePool = state.gridBasePools.get(qid);
  if (!basePool || basePool.length === 0) {
    return Array(rowCount).fill(fallbackValue);
  }

  const rowAnswers = [];
  for (let r = 0; r < rowCount; r++) {
    const deckKey = `${qid}_row_${r}`;
    let deck = state.gridRowDecks.get(deckKey);
    if (!deck || deck.length === 0) {
      deck = shuffleArray(basePool);
      state.gridRowDecks.set(deckKey, deck);
    }
    rowAnswers.push(deck.pop());
  }
  return rowAnswers;
}

function resolvePayload(rawPayload) {
  const items = [];
  for (const [qid, spec] of Object.entries(rawPayload)) {
    const meta = state.questionsMeta[qid] || { title: qid, type: 'TEXT' };
    const qType = meta.type || 'TEXT';

    if (qType === 'GRID') {
      if (spec.value && typeof spec.value === 'object' && !Array.isArray(spec.value) && !spec.value.other) {
        items.push({ questionId: qid, title: meta.title, type: qType, answer: spec.value });
      } else {
        const rowCount = Number(meta.rowCount) || (Array.isArray(meta.gridRows) && meta.gridRows.length) || DEFAULT_GRID_ROWS;
        const rowAnswers = drawGridRowAnswers(qid, spec.value, rowCount);
        items.push({ questionId: qid, title: meta.title, type: 'GRID', answer: rowAnswers });
      }
      continue;
    }

    if (spec.kind === 'ai' || spec.kind === 'pool' || qType === 'TEXT' || qType === 'PARAGRAPH') {
      const rawLines = spec.lines || spec.prompt || spec.value || '';
      const answer = pickUniformLine(`text_${qid}`, rawLines);
      items.push({ questionId: qid, title: meta.title, type: qType, answer });
      continue;
    }

    if (spec.value && typeof spec.value === 'object' && spec.value.other) {
      const otherText = pickUniformLine(`other_${qid}`, spec.value.text || '');
      items.push({
        questionId: qid,
        title: meta.title,
        type: qType,
        answer: { other: true, text: otherText }
      });
      continue;
    }

    if (Array.isArray(spec.value)) {
      const resolvedArr = spec.value.map((v, idx) => {
        if (v && typeof v === 'object' && v.other) {
          return { other: true, text: pickUniformLine(`other_${qid}_${idx}`, v.text || '') };
        }
        return v;
      });
      items.push({ questionId: qid, title: meta.title, type: qType, answer: resolvedArr });
      continue;
    }

    items.push({ questionId: qid, title: meta.title, type: qType, answer: spec.value });
  }
  return items;
}

/* ------------------------------------------------------------------
 * QUEUE MANAGER (Tối đa 10 tab ẩn + Hỗ trợ Multi-page Reload)
 * ------------------------------------------------------------------ */
async function pump() {
  if (!state.isRunning || state.isPumping) return;
  state.isPumping = true;

  try {
    while (
      state.isRunning &&
      state.activeTabs.size < MAX_CONCURRENT_TABS &&
      state.queue.length > 0
    ) {
      const rawPayload = state.queue.shift();
      const index = ++state.nextIndex;
      const resolved = resolvePayload(rawPayload);
      await openTabForPayload(resolved, index);
    }
  } finally {
    state.isPumping = false;
    checkFinished();
  }
}

async function openTabForPayload(resolvedPayload, index) {
  const tab = await chrome.tabs.create({ url: state.formUrl, active: false });
  const tabId = tab.id;
  state.tabJobs.set(tabId, { payload: resolvedPayload, runId: state.runId, index });

  armTabTimeout(tabId, index);
  await persistStats();
}

function armTabTimeout(tabId, index) {
  const old = state.activeTabs.get(tabId);
  if (old) clearTimeout(old.timeoutId);
  const timeoutId = setTimeout(async () => {
    const cur = state.activeTabs.get(tabId);
    if (!cur) return;
    const wasSubmitted = !!cur.submitted;
    state.activeTabs.delete(tabId);
    state.tabJobs.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch { /* tab đã đóng */ }
    if (state.isRunning) {
      state.stats.failed++;
      const msg = wasSubmitted
        ? `Form #${index} đã bấm Submit nhưng hết thời gian chờ vẫn chưa thấy trang cảm ơn (nghi dính captcha/câu bắt buộc), đã bỏ qua.`
        : `Form #${index} timeout 35s (kẹt câu hỏi hoặc mất mạng), đã bỏ qua.`;
      logError(index, msg);
      await persistStats({ lastError: msg });
      await sleep(Math.min(randomDelayMs(), 10 * 1000));
      pump();
    }
  }, TAB_TIMEOUT_MS);

  const meta = state.activeTabs.get(tabId) || {};
  state.activeTabs.set(tabId, { ...meta, timeoutId, index });
}

// Khi tab tải xong (Trang 1, hoặc sau khi bấm "Tiếp" tải sang Trang 2, Trang 3, hoặc trang Cảm ơn sau khi bấm "Gửi")
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;

  const meta = state.activeTabs.get(tabId);
  if (!meta) return;

  const job = state.tabJobs.get(tabId);
  if (!job || job.runId !== state.runId) return;

  // Reset timeout mỗi khi tải xong trang mới
  armTabTimeout(tabId, job.index);

  // Luôn giao cho content.js kiểm tra DOM thực tế:
  // - Nếu là trang Cảm Ơn thật sự (không còn câu hỏi, không còn nút Tiếp/Gửi) -> content.js gửi FORM_DONE
  // - Nếu là Trang 1, Trang 2, Trang 3... -> content.js điền tiếp và bấm Tiếp/Gửi
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'FILL_FORM',
      payload: job.payload,
      runId: job.runId
    });
  } catch {
    await sleep(600);
    if (!state.activeTabs.has(tabId)) return;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'FILL_FORM',
        payload: job.payload,
        runId: job.runId
      });
    } catch {
      const curMeta = state.activeTabs.get(tabId);
      if (curMeta) {
        clearTimeout(curMeta.timeoutId);
        state.activeTabs.delete(tabId);
      }
      state.tabJobs.delete(tabId);
      try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
      if (state.isRunning) {
        state.stats.failed++;
        const msg = `Form #${job.index ?? '?'}: không gửi được kịch bản tới tab, đã bỏ qua.`;
        logError(job.index ?? '?', msg);
        await persistStats({ lastError: msg });
        pump();
      }
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.activeTabs.has(tabId)) {
    const meta = state.activeTabs.get(tabId);
    clearTimeout(meta.timeoutId);
    state.activeTabs.delete(tabId);
    state.tabJobs.delete(tabId);
    if (state.isRunning) {
      state.stats.failed++;
      const msg = `Form #${meta.index}: Tab bị đóng đột ngột trước khi hoàn tất.`;
      logError(meta.index, msg);
      await persistStats({ lastError: msg });
      pump();
      checkFinished();
    } else {
      await persistStats();
    }
  }
});

async function finalizeTab(tabId, ok, error) {
  const meta = state.activeTabs.get(tabId);
  if (!meta) return false;
  clearTimeout(meta.timeoutId);
  state.activeTabs.delete(tabId);
  state.tabJobs.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
  if (!state.isRunning) { await persistStats(); return true; }

  if (ok) state.stats.success++;
  else {
    state.stats.failed++;
    logError(meta.index, `Form #${meta.index}: ` + error);
  }
  await persistStats(ok ? {} : { lastError: `Form #${meta.index}: ` + error });

  checkFinished();
  if (state.isRunning && state.queue.length > 0) {
    const d = randomDelayMs();
    await sleep(d);
    pump();
  }
  return true;
}

function checkFinished() {
  if (!state.isRunning) return;
  if (state.queue.length === 0 && state.activeTabs.size === 0) {
    state.isRunning = false;
    persistStats({ finishedAt: Date.now() });
  }
}

async function abortAll(reason) {
  state.isRunning = false;
  state.isPumping = false;
  state.abortReason = reason || 'Người dùng dừng khẩn cấp.';
  state.queue = [];
  state.tabJobs.clear();
  const tabs = [...state.activeTabs.keys()];
  for (const [, meta] of state.activeTabs) clearTimeout(meta.timeoutId);
  state.activeTabs.clear();
  for (const tabId of tabs) {
    try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
  }
  await persistStats();
}

/* ------------------------------------------------------------------
 * MESSAGE ROUTER (popup <-> background <-> content)
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'START_RUN': {
        if (state.isRunning) {
          sendResponse({ ok: false, error: 'Đang có phiên chạy, hãy dừng trước.' });
          return;
        }
        const rawPayloads = msg.payloads || [];
        state.isRunning = true;
        state.isPumping = false;
        state.nextIndex = 0;
        state.runId = 'run_' + Date.now();
        state.formUrl = msg.formUrl;
        state.queue = [...rawPayloads];
        state.questionsMeta = msg.questionsMeta || {};
        state.stats = { total: state.queue.length, success: 0, failed: 0 };
        state.errorLog = [];
        state.abortReason = null;
        state.delayMin = msg.delayMin;
        state.delayMax = msg.delayMax;

        buildGridBasePools(rawPayloads);

        await persistStats({ total: state.stats.total });
        sendResponse({ ok: true, runId: state.runId });
        pump();
        break;
      }
      case 'STOP_RUN': {
        await abortAll('Người dùng bấm Dừng khẩn cấp.');
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({ ok: true, stats: statsPayload() });
        break;
      }
      case 'FORM_DONE': {
        if (msg.runId !== state.runId || !sender.tab) { sendResponse({ ack: true }); return; }
        await finalizeTab(sender.tab.id, true, null);
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_SUBMITTED': {
        if (msg.runId !== state.runId || !sender.tab) { sendResponse({ ack: true }); return; }
        const meta = state.activeTabs.get(sender.tab.id);
        if (meta && state.isRunning) {
          meta.submitted = true;
          armTabTimeout(sender.tab.id, meta.index);
        }
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_NEXT_PAGE':
      case 'FORM_HEARTBEAT': {
        if (msg.runId !== state.runId || !sender.tab) { sendResponse({ ack: true }); return; }
        const meta = state.activeTabs.get(sender.tab.id);
        if (meta && state.isRunning) armTabTimeout(sender.tab.id, meta.index);
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_ERROR': {
        if (msg.runId !== state.runId || !sender.tab) { sendResponse({ ack: true }); return; }
        await finalizeTab(sender.tab.id, false, msg.error);
        sendResponse({ ack: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true;
});