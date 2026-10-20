/* ============================================================================
 * background.js — Service Worker (BỘ NÃO)
 * - Queue Manager: tối đa 10 tab ẩn cùng lúc (có khóa chống Race Condition)
 * - Resolve AI (Gemini 3.8 Flash) + Spintax cho câu hỏi text
 * - Hỗ trợ Multi-page Google Forms (không đóng nhầm tab khi qua trang mới)
 * - Fail-safe 1: timeout 30s / tab  |  Fail-safe 2: API lỗi 3 lần liên tiếp
 * - Delay ngẫu nhiên Min–Max (giây) giữa các lượt submit
 * ========================================================================== */

// --- Hằng số cấu hình ---
const MAX_CONCURRENT_TABS = 10;   // giới hạn đa nhiệm
const TAB_TIMEOUT_MS = 30 * 1000; // Fail-safe 1: 30 giây / tab không có heartbeat
const API_MAX_STRIKE = 3;         // Fail-safe 2: 3 lỗi liên tiếp -> dừng hệ thống
const GEMINI_MODEL = 'gemini-3.8-flash';
const GEMINI_TIMEOUT_MS = 25 * 1000;

// --- State toàn cục của 1 phiên chạy ---
const state = {
  isRunning: false,
  isPumping: false,       // Mutex chống chạy chồng chéo hàm pump()
  resolvingCount: 0,      // Số lượng form đang gọi AI (giữ chỗ trước khi mở tab)
  nextIndex: 0,           // Bộ đếm thứ tự form độc lập (không bị trùng khi chạy song song)
  runId: null,
  formUrl: null,
  queue: [],              // mảng payload thô chờ xử lý (mỗi phần tử = 1 form)
  questionsMeta: {},      // { qid: {title, type} }
  activeTabs: new Map(),  // tabId -> { timeoutId, index, submitted }
  pendingSend: new Map(), // tabId -> { payload, runId, index }
  stats: { total: 0, success: 0, failed: 0 },
  errorLog: [],           // nhật ký lỗi chi tiết [{index, error, time}]
  apiErrorCount: 0,
  delayMin: 3,            // GIÂY giữa các lượt submit
  delayMax: 5,
  apiKey: null,
  abortReason: null,
};

/* ------------------------------------------------------------------
 * TIỆN ÍCH
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function randomDelayMs() {
  const lo = Math.max(0, Number(state.delayMin) || 0);
  const hi = Math.max(lo, Number(state.delayMax) || lo);
  return rand(lo, hi) * 1000;
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
    active: state.activeTabs.size + state.resolvingCount,
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
 * SPINTAX: "{Vui vẻ|Buồn bã} trả lời: {{question}}" -> random 1 nhánh.
 * ------------------------------------------------------------------ */
function parseSpintax(text) {
  let out = String(text);
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

/* ------------------------------------------------------------------
 * GEMINI 3.8 FLASH (Fail-safe 2: 3-Strike)
 * ------------------------------------------------------------------ */
async function callGemini(prompt, apiKey) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('')?.trim();
    if (!text) throw new Error('Gemini trả về rỗng.');
    state.apiErrorCount = 0;
    return text;
  } catch (e) {
    state.apiErrorCount++;
    if (state.apiErrorCount >= API_MAX_STRIKE) {
      abortAll('Dừng khẩn cấp: Gemini API lỗi 3 lần liên tiếp (' + (e.message || e) + ')');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePayload(rawPayload) {
  const items = [];
  for (const [qid, spec] of Object.entries(rawPayload)) {
    const meta = state.questionsMeta[qid] || { title: qid, type: 'TEXT' };
    if (spec.kind === 'ai') {
      const spun = parseSpintax(spec.prompt || '');
      const finalPrompt = spun.split('{{question}}').join(meta.title);
      const answer = await callGemini(finalPrompt, state.apiKey);
      items.push({ questionId: qid, title: meta.title, type: meta.type, answer });
      if (!state.isRunning) throw new Error('Đã dừng (abort trong lúc gọi AI).');
    } else {
      items.push({ questionId: qid, title: meta.title, type: meta.type, answer: spec.value });
    }
  }
  return items;
}

/* ------------------------------------------------------------------
 * QUEUE MANAGER (Tối đa 10 tab ẩn + Chống Race Condition)
 * ------------------------------------------------------------------ */
async function pump() {
  if (!state.isRunning || state.isPumping) return;
  state.isPumping = true;

  try {
    while (
      state.isRunning &&
      (state.activeTabs.size + state.resolvingCount) < MAX_CONCURRENT_TABS &&
      state.queue.length > 0
    ) {
      const rawPayload = state.queue.shift();
      const index = ++state.nextIndex;
      state.resolvingCount++;
      await persistStats();

      let resolved;
      try {
        resolved = await resolvePayload(rawPayload);
      } catch (e) {
        state.resolvingCount = Math.max(0, state.resolvingCount - 1);
        if (!state.isRunning) return;
        state.stats.failed++;
        logError(index, 'Lỗi Gemini khi sinh câu trả lời: ' + (e.message || e));
        await persistStats();
        checkFinished();
        continue;
      }

      state.resolvingCount = Math.max(0, state.resolvingCount - 1);
      if (!state.isRunning) {
        state.queue.unshift(rawPayload);
        state.nextIndex--;
        return;
      }

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
  state.pendingSend.set(tabId, { payload: resolvedPayload, runId: state.runId, index });

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
    state.pendingSend.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch { /* tab đã đóng */ }
    if (state.isRunning) {
      state.stats.failed++;
      const msg = wasSubmitted
        ? `Form #${index} đã bấm Submit nhưng 30s vẫn chưa thấy trang cảm ơn (có thể dính captcha/xác minh), đã bỏ qua.`
        : `Form #${index} timeout 30s (kẹt/mạng, không phản hồi), đã bỏ qua.`;
      logError(index, msg);
      await persistStats({ lastError: msg });
      await sleep(Math.min(randomDelayMs(), 10 * 1000));
      pump();
    }
  }, TAB_TIMEOUT_MS);

  const meta = state.activeTabs.get(tabId) || {};
  state.activeTabs.set(tabId, { ...meta, timeoutId, index });
}

// Khi tab load xong -> gửi kịch bản cho content.js điền
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const meta = state.activeTabs.get(tabId);
  if (!meta) return;

  // QUAN TRỌNG: Chỉ chốt thành công qua URL "formResponse" NẾU tab đó ĐÃ bấm nút Submit (meta.submitted === true).
  // Vì ở Form nhiều trang (Multi-page), khi bấm "Tiếp" sang trang 2, URL cũng đổi thành .../formResponse.
  if (meta.submitted && (changeInfo.status === 'complete' || changeInfo.url)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && /formResponse/i.test(tab.url || '')) {
        await finalizeTab(tabId, true, null);
        return;
      }
    } catch { /* tab đã đóng */ }
  }

  if (changeInfo.status !== 'complete') return;
  const job = state.pendingSend.get(tabId);
  if (!job || job.runId !== state.runId) return;
  state.pendingSend.delete(tabId);

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'FILL_FORM', payload: job.payload, runId: job.runId });
  } catch {
    const curMeta = state.activeTabs.get(tabId);
    if (curMeta) {
      clearTimeout(curMeta.timeoutId);
      state.activeTabs.delete(tabId);
    }
    try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
    if (state.isRunning) {
      state.stats.failed++;
      const msg = `Form #${job.index ?? '?'}: không gửi được kịch bản tới tab (trang chặn/Captcha), đã bỏ qua.`;
      logError(job.index ?? '?', msg);
      await persistStats({ lastError: msg });
      pump();
    }
  }
});

// Tab bị đóng tay hoặc crash -> cập nhật failed và kích hoạt lại pump() để không treo phiên chạy
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.activeTabs.has(tabId)) {
    const meta = state.activeTabs.get(tabId);
    clearTimeout(meta.timeoutId);
    state.activeTabs.delete(tabId);
    state.pendingSend.delete(tabId);
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
  state.pendingSend.delete(tabId);
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
  if (state.queue.length === 0 && state.activeTabs.size === 0 && state.resolvingCount === 0) {
    state.isRunning = false;
    persistStats({ finishedAt: Date.now() });
  }
}

async function abortAll(reason) {
  state.isRunning = false;
  state.isPumping = false;
  state.resolvingCount = 0;
  state.abortReason = reason || 'Người dùng dừng khẩn cấp.';
  state.queue = [];
  state.pendingSend.clear();
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
        await chrome.storage.session.set({ geminiApiKey: msg.apiKey || '' });
        state.apiKey = msg.apiKey || '';
        state.isRunning = true;
        state.isPumping = false;
        state.resolvingCount = 0;
        state.nextIndex = 0;
        state.runId = 'run_' + Date.now();
        state.formUrl = msg.formUrl;
        state.queue = [...(msg.payloads || [])];
        state.questionsMeta = msg.questionsMeta || {};
        state.stats = { total: state.queue.length, success: 0, failed: 0 };
        state.errorLog = [];
        state.apiErrorCount = 0;
        state.abortReason = null;
        state.delayMin = msg.delayMin;
        state.delayMax = msg.delayMax;
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