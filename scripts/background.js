/* ============================================================================
 * background.js — Service Worker (BỘ NÃO)
 * - Chạy theo ĐỢT (barrier): mỗi đợt tối đa 10 tab; hết đợt mới sang đợt tiếp
 * - Delay TRƯỚC khi tạo tab, mỗi tab 1 giá trị ngẫu nhiên Min–Max riêng
 * - Resolve AI (Free.AI Chat, tương thích OpenAI) + Spintax cho câu hỏi text
 * - Fail-safe 1: timeout 30s / tab (reset bằng heartbeat) | Fail-safe 2: API 3-Strike
 * ========================================================================== */

// --- Hằng số cấu hình ---
const MAX_CONCURRENT_TABS = 10;   // giới hạn đa nhiệm
const TAB_TIMEOUT_MS = 30 * 1000; // Fail-safe 1: 30 giây / tab
const API_MAX_STRIKE = 3;         // Fail-safe 2: 3 lỗi liên tiếp -> dừng hệ thống
const CHAT_API_URL = 'https://api.free.ai/v1/chat/';
const DEFAULT_CHAT_MODEL = 'qwen7b';
const CHAT_TIMEOUT_MS = 25 * 1000;

// --- State toàn cục của 1 phiên chạy ---
const state = {
  isRunning: false,
  runId: null,
  formUrl: null,
  queue: [],            // hàng đợi [{n: số thứ tự form, data: payload thô}]
  questionsMeta: {},    // { qid: {title, type} }
  activeTabs: new Map(),// tabId -> { timeoutId, index, submitted }
  pendingSend: new Map(), // tabId -> payload đã resolve, chờ tab load xong
  waiters: new Map(),   // tabId -> resolve() của Promise mà đợt (batch) đang chờ
  stats: { total: 0, success: 0, failed: 0 },
  errorLog: [],       // nhật ký lỗi chi tiết [{index (số form), error, time}]
  apiErrorCount: 0,
  delayMin: 3,           // GIÂY giữa các lượt submit (user đổi trong popup)
  delayMax: 5,
  apiKey: null,
  chatModel: DEFAULT_CHAT_MODEL,
  abortReason: null,
};

/* ------------------------------------------------------------------
 * TIỆN ÍCH
 * ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// Delay ngẫu nhiên Min–Max (đơn vị GIÂY, đồng bộ với hiển thị ở popup) -> đổi ra ms
function randomDelayMs() {
  const lo = Math.max(0, Number(state.delayMin) || 0);
  const hi = Math.max(lo, Number(state.delayMax) || lo);
  return rand(lo, hi) * 1000;
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
 * FREE.AI CHAT (tương thích OpenAI, Fail-safe 2: 3-Strike)
 * POST {CHAT_API_URL} {messages:[{role,user,content}], model}
 * ------------------------------------------------------------------ */
async function callChatAI(prompt, apiKey, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: model || DEFAULT_CHAT_MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('Chat AI HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const ch = data && data.choices && data.choices[0];
    const text = ch ? ((ch.message && ch.message.content) || ch.text || '').trim() : '';
    if (!text) throw new Error('Chat AI trả về rỗng.');
    state.apiErrorCount = 0; // thành công -> reset bộ đếm
    return text;
  } catch (e) {
    state.apiErrorCount++;
    if (state.apiErrorCount >= API_MAX_STRIKE) {
      // Kích hoạt dừng khẩn cấp toàn hệ thống
      abortAll('Dừng khẩn cấp: Chat AI lỗi 3 lần liên tiếp (' + (e.message || e) + ')');
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
      const answer = await callChatAI(finalPrompt, state.apiKey, state.chatModel);
      items.push({ questionId: qid, title: meta.title, type: meta.type, answer });
      if (!state.isRunning) throw new Error('Đã dừng (abort trong lúc gọi AI).');
    } else {
      items.push({ questionId: qid, title: meta.title, type: meta.type, answer: spec.value });
    }
  }
  return items;
}

/* ------------------------------------------------------------------
 * CHẠY THEO ĐỢT (BATCH) — DELAY TRƯỚC KHI TẠO TAB, MỖI TAB 1 DELAY RIÊNG
 * - Mỗi đợt lấy tối đa 10 payload từ queue.
 * - Mỗi tab nhận RIÊNG 1 delay ngẫu nhiên Min–Max (giây): sleep xong mới
 *   resolve AI + tạo tab + điền (delay gắn với TAB, không gắn với đợt).
 * - Các tab trong đợt chạy đồng thời (tối đa 10 tab); khi CẢ ĐỢT xong
 *   (barrier) mới lấy đợt tiếp theo — các đợt không chạy song song.
 * ------------------------------------------------------------------ */
async function runBatches() {
  while (state.isRunning && state.queue.length > 0) {
    const batch = state.queue.splice(0, MAX_CONCURRENT_TABS);
    await Promise.all(batch.map((item) => runOneWithDelay(item)));
  }
  checkFinished();
}

// 1 tab: nhận delay riêng -> chờ -> resolve AI -> tạo tab -> treo tới khi tab chốt
async function runOneWithDelay(item) {
  const { n, data } = item;
  const d = randomDelayMs(); // mỗi tab 1 giá trị delay riêng trong khoảng Min–Max
  await sleep(d);            // delay TRƯỚC khi tạo tab
  if (!state.isRunning) { state.queue.unshift(item); return; }
  let resolved;
  try {
    resolved = await resolvePayload(data);
  } catch (e) {
    if (!state.isRunning) { state.queue.unshift(item); return; }
    // Lỗi AI lẻ (chưa đủ 3 strike): coi form này là failed, đợt tiếp tục
    state.stats.failed++;
    logError(n, 'Lỗi Chat AI khi sinh câu trả lời: ' + (e.message || e));
    await persistStats();
    return;
  }
  if (!state.isRunning) { state.queue.unshift(item); return; }
  let tabId;
  try {
    tabId = await openTabForPayload(resolved, n);
  } catch (e) {
    if (!state.isRunning) { state.queue.unshift(item); return; }
    state.stats.failed++;
    logError(n, 'Không tạo được tab: ' + (e.message || e));
    await persistStats();
    return;
  }
  await waitForTab(tabId); // treo tới khi tab chốt (xong/lỗi/timeout) -> barrier của đợt
}

// Promise mà đợt đang chờ: resolve khi finalizeTab chốt tab tương ứng
function waitForTab(tabId) {
  return new Promise((resolve) => { state.waiters.set(tabId, resolve); });
}

function resolveWaiter(tabId) {
  const w = state.waiters.get(tabId);
  if (w) { state.waiters.delete(tabId); try { w(); } catch { /* bỏ qua */ } }
}

async function openTabForPayload(resolvedPayload, index) {
  const tab = await chrome.tabs.create({ url: state.formUrl, active: false });
  const tabId = tab.id;
  state.pendingSend.set(tabId, { payload: resolvedPayload, runId: state.runId, index });

  armTabTimeout(tabId, index); // Fail-safe 1: 30s không heartbeat/báo cáo -> đóng tab
  await persistStats();
  return tabId;
}

// Đặt (hoặc reset khi có heartbeat) bộ đếm timeout 30s cho 1 tab.
// Chỉ tab "chết lặng" (kẹt/Captcha/rớt mạng, không heartbeat) mới bị đóng oan tránh;
// tab đang điền form dài vẫn heartbeat đều nên không bao giờ bị giết giữa chừng.
function armTabTimeout(tabId, index) {
  const old = state.activeTabs.get(tabId);
  if (old) clearTimeout(old.timeoutId);
  const timeoutId = setTimeout(async () => {
    const cur = state.activeTabs.get(tabId);
    if (!cur) return;
    const wasSubmitted = !!cur.submitted;
    // Phân biệt 2 ca: đã bấm Submit nhưng không thấy trang cảm ơn (nghi captcha/
    // xác minh) vs tab chết lặng từ đầu (kẹt/mạng). finalizeTab sẽ kill tab,
    // ghi failed và giải phóng waiter để đợt (batch) không kẹt.
    const msg = wasSubmitted
      ? `Đã bấm Submit nhưng 30s vẫn chưa thấy trang cảm ơn (có thể dính captcha/xác minh), đã bỏ qua.`
      : `Timeout 30s (kẹt/mạng, không phản hồi), đã bỏ qua.`;
    await finalizeTab(tabId, false, msg);
  }, TAB_TIMEOUT_MS);

  const meta = state.activeTabs.get(tabId) || {};
  state.activeTabs.set(tabId, { ...meta, timeoutId, index });
}

// Khi tab load xong -> gửi kịch bản cho content.js điền
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // Trang cảm ơn sau submit có URL chứa "formResponse" -> chốt THÀNH CÔNG + kill tab
  // NGAY LẬP TỨC, không chờ content báo (script trong tab có thể đã chết khi chuyển trang).
  if (changeInfo.status === 'complete' || changeInfo.url) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && /formResponse/i.test(tab.url || '') && state.activeTabs.has(tabId)) {
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
    // content.js chưa sẵn sàng (trang lỗi/Captcha): chốt failed, đợt tiếp tục khi đủ
    await finalizeTab(tabId, false, 'Không gửi được kịch bản tới tab (trang chặn/Captcha), đã bỏ qua.');
  }
});

// Tab bị đóng (tay hoặc hệ thống) -> chốt failed để đợt (batch) không kẹt + giải phóng waiter.
// finalizeTab idempotent nên việc đóng tab do chính hệ thống gọi cũng an toàn.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.activeTabs.has(tabId)) {
    await finalizeTab(tabId, false, 'Tab bị đóng giữa chừng (đóng tay/lỗi trình duyệt), đã bỏ qua.');
  }
});

// Chốt 1 tab (thành công/thất bại): kill tab ngay, ghi nhận, bơm tiếp.
// Idempotent: tab đã chốt/timeout trước đó thì bỏ qua (tránh đếm trùng khi cả
// URL formResponse lẫn FORM_DONE cùng tới).
async function finalizeTab(tabId, ok, error) {
  const meta = state.activeTabs.get(tabId);
  if (!meta) return false; // tab lạ / đã chốt / đã timeout
  clearTimeout(meta.timeoutId);
  state.activeTabs.delete(tabId);
  state.pendingSend.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch { /* bỏ qua */ }
  if (!state.isRunning) { await persistStats(); resolveWaiter(tabId); return true; }

  if (ok) state.stats.success++;
  else {
    state.stats.failed++;
    logError(meta.index, `Form #${meta.index}: ` + error);
  }
  await persistStats(ok ? {} : { lastError: `Form #${meta.index}: ` + error });
  checkFinished();
  resolveWaiter(tabId); // thả barrier để đợt (batch) tiếp tục/kết thúc
  return true;
}

function checkFinished() {
  if (!state.isRunning) return;
  if (state.queue.length === 0 && state.activeTabs.size === 0) {
    state.isRunning = false;
    persistStats({ finishedAt: Date.now() });
  }
}

// Dừng khẩn cấp: hủy queue, đóng mọi tab, thả toàn bộ waiter để các đợt thoát
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
  for (const tabId of [...state.waiters.keys()]) resolveWaiter(tabId);
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
        await chrome.storage.session.set({ chatApiKey: msg.apiKey || '' });
        state.apiKey = msg.apiKey || '';
        state.chatModel = (msg.chatModel || '').trim() || DEFAULT_CHAT_MODEL;
        state.isRunning = true;
        state.runId = 'run_' + Date.now();
        state.formUrl = msg.formUrl;
        state.queue = (msg.payloads || []).map((p, i) => ({ n: i + 1, data: p })); // đánh số form
        state.questionsMeta = msg.questionsMeta || {};
        state.stats = { total: state.queue.length, success: 0, failed: 0 };
        state.errorLog = []; // reset nhật ký lỗi cho phiên chạy mới
        state.waiters = new Map();
        state.apiErrorCount = 0;
        state.abortReason = null;
        state.delayMin = msg.delayMin;
        state.delayMax = msg.delayMax;
        await persistStats({ total: state.stats.total });
        sendResponse({ ok: true, runId: state.runId });
        runBatches(); // chạy theo đợt, delay trước khi tạo tab
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
        await finalizeTab(sender.tab.id, true, null);
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_SUBMITTED': {
        // Content vừa bấm Submit -> đánh dấu + reset bộ đếm 30s chờ trang cảm ơn
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
        // Tab báo "vẫn sống, đang điền" -> reset bộ đếm timeout 30s của tab đó
        if (msg.runId !== state.runId || !sender.tab) { sendResponse({ ack: true }); return; }
        const meta = state.activeTabs.get(sender.tab.id);
        if (meta && state.isRunning) armTabTimeout(sender.tab.id, meta.index);
        sendResponse({ ack: true });
        break;
      }
      case 'FORM_ERROR': {
        if (msg.runId !== state.runId) { sendResponse({ ack: true }); return; }
        await finalizeTab(sender.tab.id, false, msg.error);
        sendResponse({ ack: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })();
  return true; // giữ channel cho sendResponse async
});
