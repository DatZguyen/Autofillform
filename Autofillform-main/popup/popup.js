/* ============================================================================
 * popup.js — Giao diện cấu hình + Tracking
 * - Xin cấu trúc form từ content.js (EXTRACT_REQUEST)
 * - Render TẤT CẢ câu hỏi + câu trả lời, mỗi câu trả lời có ô % riêng
 * - Thuật toán Largest Remainder Method -> sinh mảng kịch bản (payloads)
 * - Gửi START_RUN cho background, theo dõi tiến độ (STATS_UPDATE)
 * ========================================================================== */
'use strict';

let QUESTIONS = [];   // [{id,title,type,typeId,options,page,required}]
let FORM_URL = null;
let TOTAL_PAGES = 1; // so trang (section) cua form

// Loại chọn-1-đáp-án: dùng LRM để chia đúng tổng. Checkbox: % = xác suất độc lập.
const SINGLE_CHOICE = new Set(['RADIO', 'DROPDOWN', 'SCALE', 'GRID']);

/* ---------------- Khởi động: lấy form từ tab đang mở ---------------- */
document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireButtons();
  // Nếu đang có phiên chạy dở -> nhảy thẳng vào Tracking
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (st?.stats?.isRunning || (st?.stats && (st.stats.success + st.stats.failed) > 0)) {
      showTracking();
      renderStats(st.stats);
    }
  } catch { /* background chưa sẵn sàng */ }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/docs\.google\.com\/forms\//.test(tab.url || '')) {
    setLoad('⚠️ Hãy mở một Google Forms rồi bấm vào extension để cấu hình.', true);
    return;
  }
  FORM_URL = tab.url.split('?')[0].split('#')[0];

  // Hỏi content.js cấu trúc đã bóc từ FB_PUBLIC_LOAD_DATA_
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_REQUEST' });
  } catch {
    // content script chưa inject (trang load dở) -> inject thử
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['scripts/content.js'] });
      await new Promise((r) => setTimeout(r, 500));
      res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_REQUEST' });
    } catch (e2) {
      setLoad('❌ Không giao tiếp được với trang form. Hãy tải lại trang (F5) rồi thử lại.', true);
      return;
    }
  }
  if (!res?.ok) {
    setLoad('❌ ' + (res?.error || 'Bóc tách thất bại.'), true);
    return;
  }
  QUESTIONS = res.questions || [];
  TOTAL_PAGES = res.totalPages || 1;
  document.getElementById('formTitle').textContent =
    (res.formTitle || 'Google Forms') + (TOTAL_PAGES > 1 ? ` — ${TOTAL_PAGES} trang` : '');
  if (QUESTIONS.length === 0) {
    setLoad('⚠️ Form này không có câu hỏi nào nhận diện được.', true);
    return;
  }
  setLoad(`✅ Đã bóc tách ${QUESTIONS.length} câu hỏi (kể cả trang ẩn). Hãy nhập tỷ lệ % bên dưới.`, false);
  renderQuestions();
  document.getElementById('btnStart').disabled = false;
}

function setLoad(msg, isErr) {
  const el = document.getElementById('loadState');
  el.textContent = msg;
  el.style.borderColor = isErr ? '#d32f2f' : '#673ab7';
}

function wireButtons() {
  document.getElementById('btnStart').addEventListener('click', onStart);
  document.getElementById('btnStop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
  });
  document.getElementById('btnBack').addEventListener('click', () => {
    document.getElementById('view-tracking').hidden = true;
    document.getElementById('view-config').hidden = false;
  });
}

/* ---------------- Render danh sách câu hỏi ---------------- */
function renderQuestions() {
  const wrap = document.getElementById('questionList');
  wrap.innerHTML = '';
  QUESTIONS.forEach((q, qi) => {
    const card = document.createElement('div');
    card.className = 'q-card';
    card.dataset.qid = q.id;

    // Tiêu đề + badge LOẠI câu trả lời (hiển thị rõ cho mọi câu hỏi)
    const h = document.createElement('h3');
    h.textContent = `${qi + 1}. ${q.title}`;
    const badge = document.createElement('span');
    badge.className = 'q-type';
    badge.textContent = 'Loại: ' + labelType(q);
    card.append(h, badge);

    // Badge trang (section) + dau bat buoc
    const meta = document.createElement('div');
    meta.className = 'q-meta';
    if (q.page && TOTAL_PAGES > 1) {
      const pg = document.createElement('span');
      pg.className = 'q-page';
      pg.textContent = 'Trang ' + q.page + '/' + TOTAL_PAGES;
      meta.appendChild(pg);
    }
    if (q.required) {
      const rq = document.createElement('span');
      rq.className = 'q-req';
      rq.textContent = 'Bắt buộc';
      meta.appendChild(rq);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    // Trắc nghiệm / Checkbox: LIỆT KÊ SẴN toàn bộ đáp án, mỗi đáp án 1 ô %.
    // Các loại này KHÔNG có khung nhập đáp án và KHÔNG có nút thêm đáp án.
    if (SINGLE_CHOICE.has(q.type)) {
      if (!q.options?.length) {
        card.appendChild(noOptionsWarn());
      } else {
        // Nhập % cho từng đáp án (RADIO / DROPDOWN / SCALE / GRID-cols)
        const info = document.createElement('div');
        info.className = 'hint';
        info.textContent = q.type === 'GRID'
          ? 'Phân bổ % chung cho các CỘT (áp dụng cho mọi dòng). Tổng phải = 100%. Số % còn lại hiển thị ở dưới; nút 🎲/⚖ sẽ chia (ngẫu nhiên/đều) phần còn lại cho các ô còn trống.'
          : 'Nhập % cho từng đáp án. Tổng phải = 100%. Số % còn lại hiển thị ở dưới; nút 🎲/⚖ sẽ chia (ngẫu nhiên/đều) phần còn lại cho các ô còn trống.';
        card.appendChild(info);
        const cols = q.options;
        // Mặc định để TRỐNG tất cả ô % — người dùng tự nhập hoặc bấm 🎲 chia ngẫu nhiên
        cols.forEach((opt) => {
          card.appendChild(choiceRow(opt, 'pct-input', ''));
          // Đáp án "Mục khác:" cần thêm ô nhập nội dung điền vào textbox hiện ra
          if (opt && typeof opt === 'object' && opt.other) card.appendChild(otherTextInput());
        });
        if (q.type === 'GRID' && q.gridRows?.length) {
          const rowsHint = document.createElement('div');
          rowsHint.className = 'hint';
          rowsHint.textContent = 'Các dòng: ' + q.gridRows.join(' | ');
          card.appendChild(rowsHint);
        }
        // Thanh "Còn lại: %" + nút chia ngẫu nhiên (đặt cuối card)
        card.appendChild(remainderFooter(card, '.pct-input'));
      }
    } else if (q.type === 'CHECKBOX') {
      if (!q.options?.length) {
        card.appendChild(noOptionsWarn());
      } else {
        const info = document.createElement('div');
        info.className = 'hint';
        info.textContent = 'Checkbox: mỗi % là XÁC SUẤT độc lập được tick (0–100, không cần tổng = 100).';
        card.appendChild(info);
        q.options.forEach((opt) => {
          card.appendChild(choiceRow(opt, 'prob-input', ''));
          // Đáp án "Mục khác:" cần thêm ô nhập nội dung điền vào textbox hiện ra
          if (opt && typeof opt === 'object' && opt.other) card.appendChild(otherTextInput());
        });
      }
    } else {
      // ---- Câu NHẬP LIỆU: 1 ô textarea, MỖI DÒNG là 1 đáp án ----
      const info = document.createElement('div');
      info.className = 'hint';
      info.textContent = 'Nhập nhiều đáp án, MỖI DÒNG là 1 đáp án (dùng xuống dòng để tách). '
        + 'Mỗi form sẽ chọn NGẪU NHIÊN 1 dòng để điền vào ô trả lời. Hỗ trợ Spintax {A|B}.';
      card.appendChild(info);

      const ta = document.createElement('textarea');
      ta.className = 'text-answers';
      ta.rows = 4;
      ta.placeholder = 'Dap an so 1\nDap an so 2\nDap an so 3';
      card.appendChild(ta);

      const cnt = document.createElement('div');
      cnt.className = 'hint ans-count';
      card.appendChild(cnt);

      const updateCount = () => {
        const n = splitAnswers(ta.value).length;
        cnt.textContent = n ? `Số đáp án trong danh sách: ${n}` : 'Chưa có đáp án nào.';
      };
      ta.addEventListener('input', updateCount);
      updateCount();

    }
    wrap.appendChild(card);
  });
}

// Cảnh báo khi câu trắc nghiệm/checkbox không bóc được đáp án nào
function noOptionsWarn() {
  const w = document.createElement('div');
  w.className = 'notice small';
  w.textContent = '⚠️ Không bóc được danh sách đáp án của câu này. Hãy tải lại trang form (F5) rồi mở lại popup. Câu này sẽ chặn nút Bắt đầu.';
  return w;
}

// 1 dòng "câu trả lời + ô %" cho câu trắc nghiệm / checkbox.
// opt có thể là string (bản cũ) hoặc {t, other} (bản mới, có đáp án "Mục khác:").
function choiceRow(opt, inputClass, defaultPct) {
  const isObj = opt && typeof opt === 'object';
  const label = isObj ? (opt.t || 'Mục khác:') : String(opt);
  const isOther = !!(isObj && opt.other);
  const row = document.createElement('div');
  row.className = 'opt-row';
  const lb = document.createElement('span');
  lb.textContent = label + (isOther ? ' ✏️' : ''); lb.title = label;
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '1';
  inp.value = defaultPct;
  inp.dataset.opt = label;
  if (isOther) inp.dataset.other = '1';
  inp.className = inputClass;
  inp.title = '% số form dùng đáp án này';
  const pct = document.createElement('span');
  pct.textContent = '%'; pct.className = 'pct-lb';
  row.append(lb, inp, pct);
  return row;
}

// Ô nhập nội dung điền vào textbox của đáp án "Mục khác:".
// MỖI DÒNG là 1 nội dung khác nhau -> mỗi form chọn ngẫu nhiên 1 dòng.
function otherTextInput() {
  const wrap = document.createElement('div');
  wrap.className = 'other-text-wrap';
  const lb = document.createElement('div');
  lb.textContent = 'Nội dung điền vào "Mục khác" (mỗi dòng 1 nội dung, chọn random 1 dòng)';
  lb.className = 'hint';
  const inp = document.createElement('textarea');
  inp.rows = 2;
  inp.className = 'other-text';
  inp.placeholder = 'Ý kiến riêng\nĐề xuất khác';
  wrap.append(lb, inp);
  return wrap;
}

/* ---------- DANH SÁCH ĐÁP ÁN (textarea nhiều dòng) ---------- */

// Tách chuỗi textarea thành danh sách đáp án: MỖI DÒNG = 1 đáp án.
// Bỏ qua dòng trống và khoảng trắng thừa 2 đầu.
function splitAnswers(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// Chọn NGẪU NHIÊN đúng 1 đáp án trong danh sách.
function pickRandomAnswer(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list[Math.floor(Math.random() * list.length)];
}

/* ---------- Thanh "Còn lại: %" + nút 🎲 chia ngẫu nhiên ---------- */

// Các ô % đang hiển thị trong card (bỏ qua khối prompt AI đang ẩn)
function visiblePctInputs(card, selector) {
  return [...card.querySelectorAll(selector)].filter((el) => el.offsetParent !== null);
}

function sumPct(card, selector) {
  return visiblePctInputs(card, selector).reduce((a, el) => a + (parseFloat(el.value) || 0), 0);
}

// Vẽ thanh "Còn lại: X%" + 2 nút chia (ngẫu nhiên / đều); tự cập nhật live khi gõ
function remainderFooter(card, selector) {
  card.dataset.pctSel = selector;
  const bar = document.createElement('div');
  bar.className = 'pct-bar';
  const rem = document.createElement('span');
  rem.className = 'remain-lb';
  const btnRand = document.createElement('button');
  btnRand.type = 'button';
  btnRand.className = 'rand-btn';
  btnRand.textContent = '🎲 Ngẫu nhiên';
  btnRand.title = 'Chia ngẫu nhiên số % còn lại cho các ô TRỐNG, giữ nguyên các ô đã nhập';
  const btnEven = document.createElement('button');
  btnEven.type = 'button';
  btnEven.className = 'rand-btn';
  btnEven.textContent = '⚖ Chia đều';
  btnEven.title = 'Chia đều số % còn lại cho các ô TRỐNG, giữ nguyên các ô đã nhập';
  const msg = document.createElement('span');
  msg.className = 'rand-msg hint';
  btnRand.addEventListener('click', () => randomSplit(card, selector, rem, msg));
  btnEven.addEventListener('click', () => evenSplit(card, selector, rem, msg));
  bar.append(btnRand, btnEven, rem);
  const wrap = document.createElement('div');
  wrap.append(bar, msg);
  // Cập nhật live mỗi khi gõ trong card (chỉ đọc các ô % nên không ảnh hưởng ô text)
  card.addEventListener('input', () => { updateRemain(card, selector, rem); msg.textContent = ''; });
  updateRemain(card, selector, rem);
  return wrap;
}

// Cập nhật nhãn "Còn lại: X%" (VD: nhập A 20% -> hiện Còn lại: 80%)
function updateRemain(card, selector, remEl) {
  const rest = 100 - sumPct(card, selector);
  remEl.textContent = `Còn lại: ${Math.round(rest * 100) / 100}%`;
  remEl.classList.toggle('neg', rest < -0.001);   // vượt 100 -> đỏ
  remEl.classList.toggle('done', Math.abs(rest) <= 0.001); // đủ 100 -> xanh
}

// Làm mới nhãn còn-lại của 1 card (gọi sau khi thêm/xóa dòng, bật/tắt AI)
function refreshCard(card) {
  if (!card) return;
  const rem = card.querySelector('.remain-lb');
  if (!rem || !card.dataset.pctSel) return;
  updateRemain(card, card.dataset.pctSel, rem);
}

// Kiểm tra điều kiện chung trước khi chia: còn dư? còn ô trống?
// Trả về {blanks, rest} hoặc null (đã hiện thông báo lỗi vào msgEl).
function splitPrecheck(card, selector, msgEl) {
  const inputs = visiblePctInputs(card, selector);
  const blanks = inputs.filter((el) => el.value.trim() === ''); // chỉ ô chưa nhập
  const rest = 100 - sumPct(card, selector);
  msgEl.textContent = '';
  if (rest < -0.001) { msgEl.textContent = '⚠️ Tổng đã vượt 100%. Hãy giảm bớt rồi chia lại.'; return null; }
  if (rest <= 0.001) { msgEl.textContent = 'Đã đủ 100%, không còn gì để chia.'; return null; }
  if (!blanks.length) { msgEl.textContent = 'Không có ô trống — hãy xóa giá trị một ô rồi bấm chia lại.'; return null; }
  return { blanks, rest };
}

// Chia NGẪU NHIÊN số % còn lại cho các ô TRỐNG, không đụng tới ô đã nhập.
// VD: A=20 (đã nhập), B và C trống -> còn 80% chia ngẫu nhiên cho B, C (tổng B+C=80).
function randomSplit(card, selector, remEl, msgEl) {
  const pre = splitPrecheck(card, selector, msgEl);
  if (!pre) return;
  // Chia ngẫu nhiên thành số nguyên, ô cuối nhận phần còn lại để tổng khớp tuyệt đối
  let left = Math.round(pre.rest);
  pre.blanks.forEach((el, i) => {
    if (i === pre.blanks.length - 1) el.value = left;
    else {
      const v = Math.floor(Math.random() * (left + 1));
      el.value = v;
      left -= v;
    }
  });
  // Hiệu chỉnh sai số làm tròn thập phân (khi % còn lại không phải số nguyên)
  const diff = 100 - sumPct(card, selector);
  if (Math.abs(diff) > 0.001) {
    pre.blanks[pre.blanks.length - 1].value = (parseFloat(pre.blanks[pre.blanks.length - 1].value) || 0) + Math.round(diff * 100) / 100;
  }
  updateRemain(card, selector, remEl);
}

// Chia ĐỀU số % còn lại cho các ô TRỐNG, không đụng tới ô đã nhập.
// VD: còn 80%, 2 ô trống -> 40/40 (ô đầu nhận phần dư nếu chia không hết).
function evenSplit(card, selector, remEl, msgEl) {
  const pre = splitPrecheck(card, selector, msgEl);
  if (!pre) return;
  const n = pre.blanks.length;
  const base = Math.floor(pre.rest / n);
  pre.blanks.forEach((el, i) => {
    el.value = i === 0
      ? Math.round((pre.rest - base * (n - 1)) * 100) / 100
      : base;
  });
  updateRemain(card, selector, remEl);
}

function labelType(q) {
  const m = {
    RADIO: 'Trắc nghiệm (chọn 1 đáp án)', CHECKBOX: 'Checkbox (nhiều đáp án)',
    DROPDOWN: 'Dropdown (chọn 1)', SCALE: 'Thang đo (chọn 1)', GRID: 'Lưới (mỗi dòng chọn 1)',
    TEXT: 'Ô nhập liệu (text ngắn)', PARAGRAPH: 'Ô nhập liệu (đoạn văn)',
    DATE: 'Ngày', TIME: 'Giờ',
  };
  return m[q.type] || q.type;
}

/* ============================================================================
 * THUẬT TOÁN LARGEST REMAINDER METHOD
 * Input: options [{name, pct}], total (tổng form)
 * Output: mảng đáp án dài đúng = total, phân bổ khớp % nhất có thể.
 * VD: total=10, A=33 B=33 C=34 -> quotas 3.3/3.3/3.4 -> base 3/3/3 (thiếu 1)
 *     -> phần dư lớn nhất là C (0.4) -> C+1 => A=3,B=3,C=4. Tổng = 10 ✅
 * ========================================================================== */
function largestRemainder(percentList, total) {
  const quotas = percentList.map((p) => (total * p) / 100);
  const base = quotas.map((q) => Math.floor(q));
  let assigned = base.reduce((a, b) => a + b, 0);
  let rest = total - assigned;
  // Sắp xếp chỉ số theo phần thập phân giảm dần
  const order = quotas
    .map((q, i) => ({ i, frac: q - Math.floor(q) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map((o) => o.i);
  const counts = [...base];
  for (let k = 0; k < rest; k++) counts[order[k % order.length]]++;
  // Dựng mảng đáp án + xáo trộn (Fisher–Yates) để thứ tự submit ngẫu nhiên
  const bag = [];
  counts.forEach((c, i) => { for (let j = 0; j < c; j++) bag.push(i); });
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag; // mảng index của options, dài đúng = total
}

// Parse Spintax phía popup cho đáp án tĩnh (chọn 1 nhánh ngẫu nhiên)
function spinOnce(s) {
  return String(s).replace(/(?<!\{)\{([^{}]*)\}(?!\})/g, (_m, inner) => {
    const parts = String(inner).split('|');
    return parts[Math.floor(Math.random() * parts.length)];
  });
}

/* ---------------- Nút Bắt đầu: validate + sinh payloads + gửi chạy ---------------- */
async function onStart() {
  const errEl = document.getElementById('configError');
  errEl.textContent = '';
  const total = parseInt(document.getElementById('inTotal').value, 10);
  const delayMin = parseFloat(document.getElementById('inDelayMin').value);
  const delayMax = parseFloat(document.getElementById('inDelayMax').value);

  if (!FORM_URL) { errEl.textContent = 'Chưa xác định được URL form.'; return; }
  if (!total || total < 1 || total > 1000) { errEl.textContent = 'Tổng số form phải từ 1–1000.'; return; }
  if (!(delayMin >= 0) || !(delayMax >= 0) || delayMax < delayMin) { errEl.textContent = 'Delay Min/Max (giây) không hợp lệ (Max ≥ Min ≥ 0).'; return; }

  // Đọc cấu hình từng câu hỏi từ DOM
  const cards = [...document.querySelectorAll('.q-card')];
  const qConfigs = []; // [{q, kind:'single'|'checkbox'|'text', ...}]
  for (const card of cards) {
    const q = QUESTIONS.find((x) => x.id === card.dataset.qid);
    // Chặn sớm: trắc nghiệm/checkbox mà không có đáp án bóc sẵn thì không thể chạy
    if ((SINGLE_CHOICE.has(q.type) || q.type === 'CHECKBOX') && !q.options?.length) {
      errEl.textContent = `Câu "${q.title}": không bóc được đáp án từ form nên không thể chạy. Hãy tải lại trang form (F5) rồi mở lại popup.`;
      return;
    }
    if (SINGLE_CHOICE.has(q.type) && q.options?.length) {
      const inputs = [...card.querySelectorAll('.pct-input')];
      const pcts = inputs.map((i) => parseFloat(i.value) || 0);
      const sum = pcts.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 100) > 0.001) {
        errEl.textContent = `Câu "${q.title}": tổng % phải = 100 (hiện ${sum}).`;
        return;
      }
      if (pcts.some((p) => p < 0 || p > 100)) { errEl.textContent = `Câu "${q.title}": % phải 0–100.`; return; }
      const otherFlags = inputs.map((i) => i.dataset.other === '1');
      // Danh sách nội dung cho "Mục khác:" (mỗi dòng 1 nội dung) — bắt buộc khi tỉ lệ Other > 0
      const otherAnswers = splitAnswers(((card.querySelector('.other-text') || {}).value || ''));
      const otherIdx = otherFlags.findIndex(Boolean);
      if (otherIdx !== -1 && pcts[otherIdx] > 0 && otherAnswers.length === 0) {
        errEl.textContent = `Câu "${q.title}": đáp án "Mục khác" có tỉ lệ > 0 — hãy nhập ít nhất 1 nội dung (mỗi dòng 1 nội dung).`;
        return;
      }
      qConfigs.push({ q, kind: 'single', opts: inputs.map((i) => i.dataset.opt), pcts, otherFlags, otherAnswers });
    } else if (q.type === 'CHECKBOX') {
      const inputs = [...card.querySelectorAll('.prob-input')];
      const probs = inputs.map((i) => Math.min(100, Math.max(0, parseFloat(i.value) || 0)));
      const otherFlags = inputs.map((i) => i.dataset.other === '1');
      const otherAnswers = splitAnswers(((card.querySelector('.other-text') || {}).value || ''));
      const otherIdx = otherFlags.findIndex(Boolean);
      if (otherIdx !== -1 && probs[otherIdx] > 0 && otherAnswers.length === 0) {
        errEl.textContent = `Câu "${q.title}": đáp án "Mục khác" có tỉ lệ > 0 — hãy nhập ít nhất 1 nội dung (mỗi dòng 1 nội dung).`;
        return;
      }
      qConfigs.push({ q, kind: 'checkbox', opts: inputs.map((i) => i.dataset.opt), probs, otherFlags, otherAnswers });
    } else {
      // ---- Câu nhập liệu: 1 textarea nhiều dòng, mỗi dòng = 1 đáp án ----
      const answers = splitAnswers(((card.querySelector('.text-answers') || {}).value || ''));
      if (answers.length === 0) {
        errEl.textContent = `Câu "${q.title}": hãy nhập ít nhất 1 đáp án (mỗi dòng 1 đáp án).`;
        return;
      }
      qConfigs.push({ q, kind: 'text', answers });
    }
  }

  // Sinh mảng kịch bản bằng LRM cho các câu single-choice…
  const singleBags = new Map(); // qid -> mảng INDEX đáp án dài = total
  for (const cfg of qConfigs) {
    if (cfg.kind === 'single') {
      singleBags.set(cfg.q.id, largestRemainder(cfg.pcts, total));
    }
  }

  // Dựng payloads: mỗi phần tử = 1 form { [qid]: {kind, value|prompt} }
  const payloads = [];
  for (let f = 0; f < total; f++) {
    const one = {};
    for (const cfg of qConfigs) {
      const qid = cfg.q.id;
      if (cfg.kind === 'single') {
        const bag = singleBags.get(qid);
        // Đáp án Other -> gói {other:true, text} để content.js tick + điền textbox
        const toVal = (idx) => (cfg.otherFlags[idx]
          ? { other: true, text: spinOnce(pickRandomAnswer(cfg.otherAnswers)) }
          : cfg.opts[idx]);
        if (cfg.q.type === 'GRID') {
          // Grid: mỗi dòng nhận 1 cột theo phân bổ (random dòng để đa dạng).
          // Grid lấy nhãn text (không hỗ trợ textbox Other).
          const rowAns = {};
          (cfg.q.gridRows?.length ? cfg.q.gridRows : ['Row1']).forEach((row) => {
            // Lấy ngẫu nhiên từ bag để các dòng không giống hệt nhau
            rowAns[row] = cfg.opts[bag[Math.floor(Math.random() * total)]];
          });
          one[qid] = { kind: 'choice', value: rowAns };
        } else {
          one[qid] = { kind: 'choice', value: toVal(bag[f]) };
        }
      } else if (cfg.kind === 'checkbox') {
        // Mỗi option tung đồng xu theo % xác suất
        let pickedIdx = cfg.opts.map((_, i) => i).filter((i) => Math.random() * 100 < cfg.probs[i]);
        if (!pickedIdx.length) {
          // Dự phòng: chọn ngẫu nhiên 1 đáp án THƯỜNG (tránh Other khi chưa có mẫu text)
          const normal = cfg.opts.map((_, i) => i).filter((i) => !cfg.otherFlags[i]);
          const pool = normal.length ? normal : cfg.opts.map((_, i) => i);
          pickedIdx = [pool[Math.floor(Math.random() * pool.length)]];
        }
        one[qid] = {
          kind: 'choice',
          value: pickedIdx.map((i) => (cfg.otherFlags[i]
            ? { other: true, text: spinOnce(pickRandomAnswer(cfg.otherAnswers)) }
            : cfg.opts[i])),
        };
      } else if (cfg.kind === 'text') {
        // Chọn NGẪU NHIÊN đúng 1 đáp án trong danh sách (mỗi dòng 1 đáp án)
        one[qid] = { kind: 'static', value: spinOnce(pickRandomAnswer(cfg.answers)) };
      }
    }
    payloads.push(one);
  }

  const questionsMeta = {};
  QUESTIONS.forEach((q) => {
    questionsMeta[q.id] = {
      title: q.title,
      type: q.type,
      page: q.page || 1,
      required: !!q.required,
      inputId: q.inputId || '',
    };
  });

  // Gửi cho background chạy queue
  const resp = await chrome.runtime.sendMessage({
    type: 'START_RUN',
    formUrl: FORM_URL, payloads, questionsMeta, delayMin, delayMax,
  });
  if (!resp?.ok) { errEl.textContent = resp?.error || 'Không khởi động được.'; return; }
  showTracking();
  const st = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (st?.stats) renderStats(st.stats);
}

/* ---------------- Tracking UI ---------------- */
function showTracking() {
  document.getElementById('view-config').hidden = true;
  document.getElementById('view-tracking').hidden = false;
}

function renderStats(s) {
  document.getElementById('stTotal').textContent = s.total ?? 0;
  document.getElementById('stSuccess').textContent = s.success ?? 0;
  document.getElementById('stFailed').textContent = s.failed ?? 0;
  document.getElementById('stActive').textContent = s.active ?? 0;
  const skEl = document.getElementById('stSkipped');
  if (skEl) skEl.textContent = s.skippedCount ?? 0;
  const done = (s.success || 0) + (s.failed || 0);
  const pct = s.total ? Math.round((done / s.total) * 100) : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = `${pct}% (${done}/${s.total || 0})`;
  document.getElementById('abortReason').textContent = s.abortReason ? '⛔ ' + s.abortReason : '';
  if (s.lastError) document.getElementById('lastError').textContent = 'Ghi chú: ' + s.lastError;
  renderErrorList(s.errorLog || []);
  if (!s.isRunning && s.total > 0 && done >= s.total) {
    document.getElementById('progressText').textContent += ' — HOÀN TẤT ✅';
  }
}

// Danh sách lỗi đầy đủ: form nào, lỗi gì, ở đâu (dùng textContent để an toàn)
function renderErrorList(logs) {
  document.getElementById('errCount').textContent = logs.length;
  const list = document.getElementById('errorList');
  list.innerHTML = '';
  if (!logs.length) {
    const ok = document.createElement('div');
    ok.className = 'hint';
    ok.textContent = 'Chưa có lỗi. ✅';
    list.appendChild(ok);
    return;
  }
  const MAX_SHOW = 200;
  if (logs.length > MAX_SHOW) {
    const more = document.createElement('div');
    more.className = 'hint';
    more.textContent = `…và ${logs.length - MAX_SHOW} lỗi cũ hơn (giữ lại ${MAX_SHOW} dòng mới nhất).`;
    list.appendChild(more);
  }
  // Mới nhất lên đầu để xem ngay khi chạy xong
  logs.slice(-MAX_SHOW).reverse().forEach((e) => {
    const row = document.createElement('div');
    row.className = 'err-item';
    const idx = document.createElement('b');
    idx.textContent = `Form #${e.index}`;
    const txt = document.createElement('span');
    txt.textContent = ` [${e.time || ''}] ${e.error}`;
    row.append(idx, txt);
    list.appendChild(row);
  });
}

// Nhận stats realtime từ background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'STATS_UPDATE' && msg.stats) {
    showTracking();
    renderStats(msg.stats);
  }
});

// Poll dự phòng mỗi 2s khi đang ở màn tracking (popup mở)
setInterval(async () => {
  if (document.getElementById('view-tracking').hidden) return;
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (st?.stats) renderStats(st.stats);
  } catch { /* bỏ qua */ }
}, 2000);
