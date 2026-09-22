/* ============================================================================
 * background.js — Service Worker (BỘ NÃO)
 * - Queue Manager: tối đa 10 tab ẩn cùng lúc
 * - Resolve AI (Gemini 2.5 Flash) + Spintax cho câu hỏi text
 * - Fail-safe 1: timeout 30s / tab  |  Fail-safe 2: API lỗi 3 lần liên tiếp
 * - Delay ngẫu nhiên Min–Max (phút) giữa các lượt submit
 * ========================================================================== */

// --- Hằng số cấu hình ---
const MAX_CONCURRENT_TABS = 10;   // giới hạn đa nhiệm
const TAB_TIMEOUT_MS = 30 * 1000; // Fail-safe 1: 30 giây / tab
const API_MAX_STRIKE = 3;         // Fail-safe 2: 3 lỗi liên tiếp -> dừng hệ thống
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = 25 * 1000;

// --- State toàn cục của 1 phiên chạy ---
const state = {
  isRunning: false,
  runId: null,
  formUrl: null,
  queue: [],            // mảng payload thô chờ xử lý (mỗi phần tử = 1 form)
  questionsMeta: {},    // { qid: {title, type} }
  activeTabs: new Map(),// tabId -> { timeoutId, index }
  pendingSend: new Map(), // tabId -> payload đã resolve, chờ tab load xong
  stats: { total: 0, success: 0, failed: 0 },
  errorLog: [],       // nhật ký lỗi chi tiết [{index (số form), error, time}]
  apiErrorCount: 0,
  delayMin: 0.05,       // phút (mặc định 3 giây để dễ test; user đổi trong popup)
  delayMax: 0.1,
  apiKey: null,
  abortReason: null,
};

/* ------------------------------------------------------------------
 * TIỆN ÍCH
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// Delay ngẫu nhiên Min–Max (đơn vị PHÚT theo spec) -> đổi ra ms
function randomDelayMs() {
  const lo = Math.max(0, Number(state.delayMin) || 0);
  const hi = Math.max(lo, Number(state.delayMax) || lo);
  return rand(lo, hi) * 60 * 1000;
}

// Ghi 1 dòng lỗi chi tiết (form số mấy, lỗi gì, ở đâu) — popup hiển thị khi chạy xong
function logError(index, error) {
  state.errorLog.push({ index, error: String(error || 'Không rõ lỗi'), time: new Date().toLocaleTimeString('vi-VN') });
  if (state.errorLog.length > 500) state.errorLog.splice(0, state.errorLog.length - 500); // chống tràn storage
}

// Gom stats + nhật ký lỗi để popup (Tracking UI) đọc được ngay cả khi đóng/mở lại
function statsPayload() {
  return {
    ...state.stats,
    active: state.activeTabs.size,
    isRunning: state.isRunning,
    abortReason: state.abortReason,
    errorLog: state.errorLog,
  };
}

// Lưu stats để popup (Tracking UI) đọc được ngay cả khi popup đóng/mở lại
async function persistStats(extra = {}) {
  await chrome.storage.local.set({ runStats: { ...statsPayload(), ...extra } });
  // Đẩy sự kiện realtime cho popup đang mở
  try {
    await chrome.runtime.sendMessage({ type: 'STATS_UPDATE', stats: statsPayload() });
  } catch { /* popup đang đóng -> bỏ qua */ }
}

/* ------------------------------------------------------------------
 * SPINTAX: "{Vui vẻ|Buồn bã} trả lời: {{question}}" -> random 1 nhánh.
 * Hỗ trợ lồng nhau bằng cách lặp đến khi hết dấu {..|..}.
 * Lưu ý: {{question}} là biến template -> giữ nguyên, chỉ parse {a|b}.
 * ------------------------------------------------------------------ */
function parseSpintax(text) {
  let out = String(text);
  // Khớp { ... } NHƯNG bỏ qua {{...}} (biến template 2 ngoặc)
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
 * GEMINI 2.5 FLASH (Fail-safe 2: 3-Strike)
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
    state.apiErrorCount = 0; // thành công -> reset bộ đếm
    return text;
  } catch (e) {
    state.apiErrorCount++;
    if (state.apiErrorCount >= API_MAX_STRIKE) {
      // Kích hoạt dừng khẩn cấp toàn hệ thống
      abortAll('Dừng khẩn cấp: Gemini API lỗi 3 lần liên tiếp (' + (e.message || e) + ')');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve 1 payload thô -> payload hoàn chỉnh cho content.js
// rawPayload: { [qid]: {kind:'choice', value} | {kind:'static', value} | {kind:'ai', prompt, questionTitle} }
async function resolvePayload(rawPayload) {
  const items = [];
  for (const [qid, spec] of Object.entries(rawPayload)) {
    const meta = state.questionsMeta[qid] || { title: qid, type: 'TEXT' };
    if (spec.kind === 'ai') {
      // 1. Parse Spintax trước, 2. thay {{question}} bằng tiêu đề thật, 3. gọi API
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
 * QUEUE MANAGER (tối đa 10 tab ẩn)
 * ------------------------------------------------------------------ */
async function pump() {
  if (!state.isRunning) return;
  // Mở tab mới cho đến khi đủ 10 tab hoặc hết hàng đợi
  while (state.isRunning && state.activeTabs.size < MAX_CONCURRENT_TABS && state.queue.length > 0) {
    const rawPayload = state.queue.shift();
    const index = state.stats.success + state.stats.failed + state.activeTabs.size + 1;
    // Resolve AI TRƯỚC khi mở tab (để tab mở ra là điền ngay, không chờ)
    let resolved;
    try {
      resolved = await resolvePayload(rawPayload);
    } catch (e) {
      if (!state.isRunning) return; // đã abort (3-strike / user dừng)
      // Lỗi AI lẻ (chưa đủ 3 strike): coi form này là failed, đi tiếp
      state.stats.failed++;
      logError(index, 'Lỗi Gemini khi sinh câu trả lời: ' + (e.message || e));
      await persistStats();
      checkFinished();
      continue;
    }
    if (!state.isRunning) {
      // Trong lúc resolve thì user bấm Dừng -> trả payload về queue rồi thoát
      state.queue.unshift(rawPayload);
      return;
    }
    await openTabForPayload(resolved, index);
  }
  checkFinished();
}

async function openTabForPayload(resolvedPayload, index) {
  const tab = await chrome.tabs.create({ url: state.formUrl, active: false });
  const tabId = tab.id;
  state.pendingSend.set(tabId, { payload: resolvedPayload, runId: state.runId, index });

  // Fail-safe 1: sau 30s không báo cáo -> đóng tab, đánh failed, chạy tiếp
  const timeoutId = setTimeout(async () => {
    if (!state.activeTabs.has(tabId)) return;
    state.activeTabs.delete(tabId);
    state.pendingSend.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch { /* tab đã đóng */ }
    if (state.isRunning) {
      state.stats.failed++;
      const msg = `Form #${index} timeout 30s (kẹt/Captcha/mạng), đã bỏ qua.`;
      logError(index, msg);
      await persistStats({ lastError: msg });
      // Delay ngẫu nhiên rồi bơm tiếp để tránh dồn dập
      await sleep(Math.min(randomDelayMs(), 10 * 1000)); // timeout retry chờ tối đa 10s
      pump();
    }
  }, TAB_TIMEOUT_MS);

  state.activeTabs.set(tabId, { timeoutId, index });
  await persistStats();
}

// Khi tab load xong -> gửi kịch bản cho content.js điền
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const job = state.pendingSend.get(tabId);
  if (!job || job.runId !== state.runId) return;
  state.pendingSend.delete(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'FILL_FORM', payload: job.payload, runId: job.runId });
  } catch {
    // content.js chưa sẵn sàng (trang lỗi/Captcha): dọn tab, đánh failed
    const meta = state.activeTabs.get(tabId);
    if (meta) {
      clearTimeout(meta.timeoutId);
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

// Tab bị user đóng tay -> dọn record, tránh kẹt bộ đếm active
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.activeTabs.has(tabId)) {
    const meta = state.activeTabs.get(tabId);
    clearTimeout(meta.timeoutId);
    state.activeTabs.delete(tabId);
    state.pendingSend.delete(tabId);
    await persistStats();
  }
});

// Xử lý báo cáo từ content.js
async function handleTabResult(tabId, ok, error) {
  const meta = state.activeTabs.get(tabId);
  if (!meta) return; // tab lạ / đã timeout
  clearTimeout(meta.timeoutId);
  state.activeTabs.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
  if (!state.isRunning) { await persistStats(); return; }

  if (ok) state.stats.success++;
  else {
    state.stats.failed++;
    logError(meta.index, `Form #${meta.index}: ` + error);
  }
  await persistStats(ok ? {} : { lastError: `Form #${meta.index}: ` + error });

  // Delay ngẫu nhiên Min–Max trước khi mở form tiếp theo trong queue
  const d = randomDelayMs();
  setTimeout(() => pump(), d);
  checkFinished();
}

function checkFinished() {
  if (!state.isRunning) return;
  if (state.queue.length === 0 && state.activeTabs.size === 0) {
    state.isRunning = false;
    persistStats({ finishedAt: Date.now() });
  }
}

// Dừng khẩn cấp: hủy queue, đóng mọi tab, reset AI-strike
async function abortAll(reason) {
  state.isRunning = false;
  state.abortReason = reason || 'Người dùng dừng khẩn cấp.';
  state.queue = [];
  state.pendingSend.clear();
  const tabs = [...state.activeTabs.keys()];
  for (const [tabId, meta] of state.activeTabs) clearTimeout(meta.timeoutId);
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
        if (state.isRunning) { sendResponse({ ok: false, error: 'Đang có phiên chạy, hãy dừng trước.' }); return; }
        // API Key CHỈ lưu ở chrome.storage.session (tự xóa khi đóng trình duyệt)
        await chrome.storage.session.set({ geminiApiKey: msg.apiKey || '' });
        state.apiKey = msg.apiKey || '';
        state.isRunning = true;
        state.runId = 'run_' + Date.now();
        state.formUrl = msg.formUrl;
        state.queue = [...(msg.payloads || [])];
        state.questionsMeta = msg.questionsMeta || {};
        state.stats = { total: state.queue.length, success: 0, failed: 0 };
        state.errorLog = []; // reset nhật ký lỗi cho phiên chạy mới
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
        if (msg.runId !== state.runId) { sendResponse({ ack: true }); return; }
        await handleTabResult(sender.tab.id, true, null);
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_ERROR': {
        if (msg.runId !== state.runId) { sendResponse({ ack: true }); return; }
        await handleTabResult(sender.tab.id, false, msg.error);
        sendResponse({ ack: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true; // giữ channel cho sendResponse async
});
