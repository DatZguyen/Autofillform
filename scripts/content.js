/* ============================================================================
 * content.js — Chạy trên trang Google Forms
 * 2 nhiệm vụ:
 *  (1) BÓC TÁCH: quét <script> chứa FB_PUBLIC_LOAD_DATA_, parse JSON lấy full
 *      cấu trúc form (kể cả trang ẩn / rẽ nhánh) -> gửi về Popup.
 *  (2) AUTO-FILL: nhận 1 kịch bản (payload) từ background, click/điền DOM,
 *      qua trang, bấm Submit, báo kết quả về background.
 * ========================================================================== */
(() => {
  'use strict';

  // --- Bảng map typeId của Google Forms sang loại nội bộ ---
  // 0: text ngắn, 1: paragraph, 2: radio, 3: dropdown, 4: checkbox,
  // 5: linear scale, 7: grid (choice grid), 9: date, 10: time
  const TYPE_MAP = {
    0: 'TEXT', 1: 'PARAGRAPH', 2: 'RADIO', 3: 'DROPDOWN',
    4: 'CHECKBOX', 5: 'SCALE', 6: 'SECTION', 7: 'GRID',
    8: 'IMAGE', 9: 'DATE', 10: 'TIME'
  };

  /* ------------------------------------------------------------------
   * (1) BÓC TÁCH FB_PUBLIC_LOAD_DATA_
   * ------------------------------------------------------------------ */

  // Tìm chuỗi JSON của biến FB_PUBLIC_LOAD_DATA_ trong các thẻ <script>.
  function findLoadDataRaw() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('FB_PUBLIC_LOAD_DATA_')) {
        // Cắt từ dấu '[' đầu tiên sau dấu '=' đến dấu ';' cuối cùng
        const eq = txt.indexOf('FB_PUBLIC_LOAD_DATA_');
        const start = txt.indexOf('[', eq);
        const end = txt.lastIndexOf(';');
        if (start !== -1 && end !== -1 && end > start) {
          return txt.slice(start, end).trim();
        }
      }
    }
    return null;
  }

  // Parse an toàn: FB data là JSON hợp lệ (đã escape), chỉ cần JSON.parse.
  function parseLoadData(raw) {
    // Bỏ ký tự ';' thừa ở cuối nếu còn sót
    let s = raw.trim();
    if (s.endsWith(';')) s = s.slice(0, -1);
    return JSON.parse(s);
  }

  // Nhận diện đáp án "Mục khác / Other": khi chọn sẽ hiện textbox riêng để nhập.
  const OTHER_RE = /^(other|khác|mục khác|otro|autre|altro|ander(e|o)?s?)\s*:?$/i;
  const OTHER_VALUE = '__other_option__'; // data-value của radio/checkbox "Other" trên DOM

  // Chuẩn hóa 1 tuple đáp án FB thành {t: text, other} (other='maybe' = slot rỗng chưa rõ).
  function normOptionTuple(o) {
    if (Array.isArray(o)) {
      if (typeof o[0] === 'string') {
        const t = o[0].trim();
        if (t === '') return { t: '', other: 'maybe' };
        return { t: o[0], other: OTHER_RE.test(t) };
      }
      // Slot "Other" hay serialize thành null / [null, ...]
      if (o.length === 0 || o[0] === null || o[0] === undefined) return { t: '', other: 'maybe' };
      return null;
    }
    if (typeof o === 'string') {
      const t = o.trim();
      if (t === '') return null;
      return { t: o, other: OTHER_RE.test(t) };
    }
    if (o === null || o === undefined) return { t: '', other: 'maybe' };
    return null;
  }

  // Thử đọc node (hoặc node[0] khi lồng thêm 1 cấp) thành danh sách options.
  // Chấp nhận nhiều biến thể FB: entry[4][0] = [[text,..],..] HOẶC [[[...]], flags..].
  function normalizeOptionList(node) {
    if (!Array.isArray(node) || node.length === 0) return [];
    const candidates = [node];
    if (Array.isArray(node[0])) candidates.push(node[0]);
    for (const cand of candidates) {
      const out = [];
      for (const o of cand) {
        const n = normOptionTuple(o);
        if (n) out.push(n);
      }
      // Chỉ nhận khi có ít nhất 1 đáp án text thật (tránh nhầm flags/nhãn trang trí)
      if (out.some((x) => x.other !== 'maybe' && x.t !== '')) return out;
    }
    return [];
  }

  // Trích options cho câu trắc nghiệm — thử nhiều đường dẫn (mỗi bản Forms lồng khác nhau).
  function extractOptions(entry) {
    try {
      const e4 = entry[4];
      if (!Array.isArray(e4)) return [];
      const roots = [e4[0], e4];
      for (const r of roots) {
        const list = normalizeOptionList(r);
        if (list.length) return list;
      }
      return [];
    } catch { return []; }
  }

  // Quét DOM bổ sung đáp án (fallback khi FB thiếu; và để phát hiện nút "Mục khác:").
  // Chỉ áp dụng RADIO/CHECKBOX/SCALE (dropdown đóng nên options không có sẵn trên DOM).
  function scrapeOptionsFromDOM(title, type) {
    if (type !== 'RADIO' && type !== 'CHECKBOX' && type !== 'SCALE') return [];
    try {
      const block = findQuestionBlock(title);
      if (!block) return [];
      const role = 'div[role="' + (type === 'CHECKBOX' ? 'checkbox' : 'radio') + '"]';
      const els = block.querySelectorAll(role);
      const out = [];
      els.forEach((el) => {
        const v = el.getAttribute('data-value') || '';
        const label = norm(el.getAttribute('aria-label') || el.textContent);
        const isOther = v === OTHER_VALUE || (label !== '' && OTHER_RE.test(label));
        out.push({ value: v, label, isOther });
      });
      return out;
    } catch { return []; }
  }

  // Gộp đáp án FB + DOM: ưu tiên FB, thêm cái DOM có mà FB thiếu, chốt trạng thái Other.
  function mergeWithDom(fbOpts, title, type) {
    let dom = [];
    try { dom = scrapeOptionsFromDOM(title, type); } catch { /* bỏ qua */ }
    const domHasOther = dom.some((d) => d.isOther);
    const out = [];
    for (const x of fbOpts) {
      if (x.other === true) { out.push({ t: x.t || 'Mục khác:', other: true }); continue; }
      if (x.other === 'maybe') {
        // Slot rỗng: chỉ giữ làm Other khi DOM xác nhận form có nút Other
        if (domHasOther) out.push({ t: 'Mục khác:', other: true });
        continue;
      }
      if (x.t) out.push({ t: x.t, other: false });
    }
    const hasText = (t) => out.some((x) => !x.other && x.t.trim().toLowerCase() === String(t).trim().toLowerCase());
    for (const d of dom) {
      if (d.isOther) {
        if (!out.some((x) => x.other)) out.push({ t: d.label || 'Mục khác:', other: true });
      } else if (d.label && !hasText(d.label)) {
        out.push({ t: d.label, other: false });
      }
    }
    return out;
  }

  // Trích thang đo linear scale: [min, max, ...labels] (thử cả dạng lồng 1 cấp).
  // Trả về options dạng object {t, other} để đồng nhất với trắc nghiệm.
  function extractScale(entry) {
    try {
      const e4 = entry[4];
      const cands = [e4 && e4[0], e4 && e4[0] && e4[0][0]];
      for (const c of cands) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          const [min, max] = [c[0], c[1]];
          const labels = [];
          for (let v = min; v <= max; v++) labels.push(String(v));
          return { min, max, options: labels.map((t) => ({ t, other: false })) };
        }
      }
    } catch { /* bỏ qua */ }
    return null;
  }

  // Hàm chính: trả về mảng câu hỏi chuẩn hóa
  function extractFormStructure() {
    const raw = findLoadDataRaw();
    if (!raw) return { ok: false, error: 'Không tìm thấy FB_PUBLIC_LOAD_DATA_ trên trang này.', questions: [] };
    let data;
    try {
      data = parseLoadData(raw);
    } catch (e) {
      return { ok: false, error: 'Parse FB_PUBLIC_LOAD_DATA_ thất bại: ' + e.message, questions: [] };
    }
    return parseStructureFromData(data);
  }

  // Parse mảng FB đã JSON.parse thành danh sách câu hỏi.
  // Tách riêng để kiểm thử được (hàm thuần, chỉ chạm DOM khi merge fallback).
  // options của mỗi câu hỏi: [{t: text hiển thị, other: true/false}]
  function parseStructureFromData(data) {
    try {
      // Đường dẫn chuẩn: data[1][1] = danh sách item (mỗi item = 1 câu hỏi / section)
      const items = (data[1] && data[1][1]) || [];
      const questions = [];
      for (const entry of items) {
        if (!Array.isArray(entry) || entry.length < 4) continue;
        const qid = entry[0];
        const title = entry[1] || '(Không tiêu đề)';
        const typeId = entry[3];
        const type = TYPE_MAP[typeId] || ('UNKNOWN_' + typeId);
        if (type === 'SECTION' || type === 'IMAGE') continue; // bỏ khối trang trí

        const q = { id: String(qid), title: String(title), typeId, type, options: [] };
        if (type === 'RADIO' || type === 'CHECKBOX' || type === 'DROPDOWN') {
          // FB trước, DOM bổ sung sau (chống lệch biến thể cấu trúc + bắt nút Other)
          q.options = mergeWithDom(extractOptions(entry), q.title, type);
        } else if (type === 'SCALE') {
          const sc = extractScale(entry);
          if (sc) {
            q.scaleMin = sc.min; q.scaleMax = sc.max; q.options = sc.options;
          } else {
            // Fallback cuối: quét thang đo đang render trên DOM
            q.options = mergeWithDom([], q.title, type);
          }
        } else if (type === 'GRID') {
          // Grid: rows ở entry[4][?] — cố gắng bóc rows/cols, nếu không được thì để auto-fill theo DOM
          q.options = extractOptions(entry).filter((x) => !x.other || x.t);
          try {
            const rows = entry[4] && entry[4][8];
            if (Array.isArray(rows)) q.gridRows = rows.map(r => (Array.isArray(r) ? r[0] : r)).filter(Boolean);
          } catch { /* bỏ qua */ }
        }
        questions.push(q);
      }
      const title = (data[1] && data[1][8]) || (typeof document !== 'undefined' ? document.title : '');
      return { ok: true, questions, formTitle: title };
    } catch (e) {
      return { ok: false, error: 'Cấu trúc FB data không như kỳ vọng: ' + e.message, questions: [] };
    }
  }

  /* ------------------------------------------------------------------
   * (2) AUTO-FILL DOM
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');

  // Tìm "khối câu hỏi" trên DOM bằng cách so khớp tiêu đề.
  // Google Forms render mỗi câu trong div[role="listitem"] chứa tiêu đề.
  function findQuestionBlock(questionTitle) {
    const want = norm(questionTitle);
    const blocks = document.querySelectorAll('div[role="listitem"]');
    // Ưu tiên khớp chính xác tiêu đề
    for (const b of blocks) {
      const heading = b.querySelector('[role="heading"]');
      if (heading && norm(heading.textContent) === want) return b;
    }
    // Dự phòng: khớp chứa (contains)
    for (const b of blocks) {
      const heading = b.querySelector('[role="heading"]');
      if (heading && (norm(heading.textContent).includes(want) || want.includes(norm(heading.textContent)))) return b;
    }
    return null;
  }

  // Click phần tử theo cách "giống người": scroll vào view + click chuột thật
  function humanClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
  }

  // Điền RADIO: Google Forms dùng div[role="radio"][data-value="..."]
  // answer có thể là string, hoặc {other:true, text} cho đáp án "Mục khác:".
  function fillRadio(block, answer) {
    if (answer && typeof answer === 'object' && answer.other) {
      return fillOther(block, answer.text || '');
    }
    const want = norm(answer);
    const radios = block.querySelectorAll('div[role="radio"]');
    for (const r of radios) {
      const v = norm(r.getAttribute('data-value') || r.getAttribute('aria-label') || r.textContent);
      if (v === want || v.includes(want) || want.includes(v)) { humanClick(r); return true; }
    }
    return false;
  }

  // Chọn đáp án "Mục khác:" (data-value="__other_option__") rồi điền textbox hiện ra.
  function fillOther(block, text) {
    const cands = block.querySelectorAll('div[role="radio"], div[role="checkbox"]');
    let otherEl = null;
    for (const el of cands) {
      const v = el.getAttribute('data-value') || '';
      const lb = norm(el.getAttribute('aria-label') || el.textContent);
      if (v === OTHER_VALUE || (lb !== '' && OTHER_RE.test(lb))) { otherEl = el; break; }
    }
    if (!otherEl) return false;
    if (otherEl.getAttribute('aria-checked') !== 'true') humanClick(otherEl);
    // Ô nhập của "Mục khác" nằm ngay trong khối câu hỏi
    const box = block.querySelector('input[type="text"], textarea, input:not([type])');
    if (!box) return true; // đã tick được nút Other (ô nhập có thể render trễ)
    return fillTextInput(box, text);
  }

  // Điền CHECKBOX: answer là mảng (nhiều lựa chọn), phần tử có thể là {other:true, text}
  function fillCheckbox(block, answers) {
    const list = Array.isArray(answers) ? answers : [answers];
    let ok = 0;
    const boxes = block.querySelectorAll('div[role="checkbox"]');
    for (const wantRaw of list) {
      if (wantRaw && typeof wantRaw === 'object' && wantRaw.other) {
        if (fillOther(block, wantRaw.text || '')) ok++;
        continue;
      }
      const want = norm(String(wantRaw));
      for (const c of boxes) {
        const v = norm(c.getAttribute('data-value') || c.getAttribute('aria-label') || c.textContent);
        if (v === want || v.includes(want) || want.includes(v)) {
          const checked = c.getAttribute('aria-checked') === 'true';
          if (!checked) humanClick(c);
          ok++;
          break;
        }
      }
    }
    return ok > 0;
  }

  // Điền DROPDOWN: click listbox để mở, rồi click option
  async function fillDropdown(block, answer) {
    const want = norm(answer && typeof answer === 'object' ? (answer.text || '') : answer);
    const listbox = block.querySelector('div[role="listbox"]');
    if (!listbox) return false;
    humanClick(listbox);
    await sleep(600);
    const opts = document.querySelectorAll('div[role="option"]');
    for (const o of opts) {
      const v = norm(o.getAttribute('data-value') || o.textContent);
      if (v === want || v.includes(want) || want.includes(v)) { humanClick(o); await sleep(300); return true; }
    }
    // Đóng dropdown nếu không tìm thấy
    listbox.blur();
    return false;
  }

  // Điền SCALE: các nút radio mang data-value = số
  function fillScale(block, answer) {
    return fillRadio(block, answer && typeof answer === 'object' ? String(answer.text || '') : String(answer));
  }

  // Điền TEXT / PARAGRAPH / DATE / TIME:
  // BẮT BUỘC dispatch input + change để framework của Google nhận diện.
  function fillText(block, value) {
    const field = block.querySelector('input[type="text"], input[type="date"], input[type="time"], textarea, input:not([type])');
    if (!field) return false;
    return fillTextInput(field, value);
  }

  // Điền giá trị vào 1 ô input/textarea cụ thể (dùng cho cả ô "Mục khác:").
  function fillTextInput(field, value) {
    field.scrollIntoView({ block: 'center' });
    field.focus();
    // Dùng native setter để React/Angular bắt được thay đổi
    const proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(field, String(value));
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return true;
  }

  // Điền 1 câu hỏi theo payload { questionId, title, type, answer }
  async function fillOne(item) {
    const block = findQuestionBlock(item.title);
    if (!block) return { ok: false, reason: 'Không tìm thấy khối DOM cho: ' + item.title };
    switch (item.type) {
      case 'RADIO': return { ok: fillRadio(block, item.answer) };
      case 'CHECKBOX': return { ok: fillCheckbox(block, item.answer) };
      case 'DROPDOWN': return { ok: await fillDropdown(block, item.answer) };
      case 'SCALE': return { ok: fillScale(block, item.answer) };
      case 'TEXT': case 'PARAGRAPH': case 'DATE': case 'TIME':
        return { ok: fillText(block, item.answer) };
      case 'GRID': {
        // Grid: answer dạng { "Row1": "ColA", ... } — tìm từng dòng rồi click cột
        if (typeof item.answer === 'object' && item.answer !== null) {
          let okCount = 0;
          const rows = block.querySelectorAll('div[role="radiogroup"]');
          for (const rg of rows) {
            const rowLabel = norm(rg.getAttribute('aria-label') || '');
            // Tìm đáp án cho dòng này (khớp tên dòng)
            for (const [rowName, colVal] of Object.entries(item.answer)) {
              if (rowLabel === norm(rowName) || rowLabel.includes(norm(rowName))) {
                if (fillRadio(rg.parentElement || block, colVal)) okCount++;
              }
            }
          }
          return { ok: okCount > 0 };
        }
        return { ok: fillRadio(block, item.answer) };
      }
      default:
        // Loại lạ: thử text trước, rồi radio
        if (fillText(block, item.answer)) return { ok: true };
        return { ok: fillRadio(block, item.answer) };
    }
  }

  // Bỏ dấu tiếng Việt để so khớp bền vững: "Gửi"/"Gởi"/"gui" đều -> "gui"/"goi".
  function stripVi(s) {
    return (s || '').normalize('NFD')
      .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D');
  }

  // Từ khóa nhận diện nút (đã bỏ dấu, viết thường).
  // Lưu ý "Gởi" (miền Nam) strip thành "goi" nên cần cả 2 biến thể.
  const SUBMIT_KEYS = ['gui', 'goi', 'submit', 'send', 'hoan tat', 'hoan thanh', 'xac nhan', 'done'];
  const NEXT_KEYS = ['tiep', 'next', 'continue'];
  const BACK_KEYS = ['quay lai', 'tro lai', 'quay ve', 'truoc', 'back', 'previous'];
  const CLEAR_KEYS = ['xoa', 'clear']; // "Xóa hết câu trả lời" — luôn loại trừ

  // Text dùng để nhận diện nút: textContent + aria-label + value (cho input[type=submit]).
  function navText(el) {
    try {
      const raw = norm(el.textContent) + ' ' + norm(el.getAttribute && el.getAttribute('aria-label')) + ' ' + norm(el.value);
      return stripVi(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }
  const isClearBtn = (t) => CLEAR_KEYS.some((k) => t.includes(k));
  const isBackBtn = (t) => BACK_KEYS.some((k) => t.includes(k));
  const hitKeys = (t, keys) => keys.some((k) => t === k || t.includes(k));

  // Tìm nút Tiếp/Next hoặc Gửi/Submit ở cuối trang hiện tại.
  // Ưu tiên khớp từ khóa -> fallback nút hiển thị cuối cùng (loại trừ Xóa/Quay lại).
  function findNavButton() {
    const btns = [...document.querySelectorAll(
      'div[role="button"], span[role="button"], button, input[type="submit"], input[type="button"]'
    )];
    const items = btns.map((b) => ({ el: b, t: navText(b) })).filter((x) => x.t !== '');
    const usable = items.filter((x) => !isClearBtn(x.t));
    const s = usable.find((x) => hitKeys(x.t, SUBMIT_KEYS));
    if (s) return { el: s.el, kind: 'submit' };
    const n = usable.find((x) => !isBackBtn(x.t) && hitKeys(x.t, NEXT_KEYS));
    if (n) return { el: n.el, kind: 'next' };
    // Fallback cấu trúc: nút bấm đang hiển thị cuối cùng thường chính là nút điều hướng
    const vis = usable.filter((x) => !isBackBtn(x.t) && x.el.offsetParent !== null);
    if (vis.length) {
      const last = vis[vis.length - 1];
      return { el: last.el, kind: hitKeys(last.t, SUBMIT_KEYS) ? 'submit' : 'next' };
    }
    return null;
  }

  // Liệt kê các nút đang thấy trên trang để gắn vào thông báo lỗi (dễ chẩn đoán).
  function seenButtons() {
    try {
      const list = [...document.querySelectorAll('div[role="button"], span[role="button"], button')]
        .map((b) => norm(b.textContent || (b.getAttribute && b.getAttribute('aria-label')) || b.value))
        .filter(Boolean).slice(0, 12);
      return list.length ? list.join(' | ') : '(không thấy nút nào trên trang)';
    } catch { return '(không đọc được DOM)'; }
  }

  // Luồng fill chính: điền từng câu, xử lý phân trang, submit
  async function runFill(payloadItems, runId) {
    // payloadItems: [{questionId, title, type, answer}]
    const maxPages = 20; // chống lặp vô hạn nếu logic rẽ nhánh lỗi
    let page = 0;
    const remaining = [...payloadItems];
    const errors = [];
    let filled = 0;

    // Heartbeat: báo background "tab vẫn sống, đang điền" để reset bộ đếm
    // timeout 30s — tránh form nhiều trang/dài bị kết luận timeout oan dù vẫn chạy tốt.
    const heartbeat = () => {
      try { chrome.runtime.sendMessage({ type: 'FORM_HEARTBEAT', runId }); } catch { /* bỏ qua */ }
    };

    while (page < maxPages) {
      await sleep(800); // chờ trang render
      heartbeat(); // đầu mỗi trang
      // Điền mọi câu hỏi đang HIỂN THỊ trên trang hiện tại
      for (let i = remaining.length - 1; i >= 0; i--) {
        const item = remaining[i];
        const block = findQuestionBlock(item.title);
        if (!block) continue; // câu ở trang ẩn -> để vòng sau
        // Bỏ qua nếu khối đang bị ẩn (display:none / offsetParent null)
        if (block.offsetParent === null) continue;
        const res = await fillOne(item);
        await sleep(150 + Math.random() * 250); // delay ngẫu nhiên nhẹ giống người
        if (res.ok) {
          remaining.splice(i, 1);
          filled++;
          if (filled % 8 === 0) heartbeat(); // form dài: heartbeat giữa trang
        }
        else errors.push(item.title + ': ' + (res.reason || 'không điền được'));
      }

      const nav = findNavButton();
      if (!nav) {
        // Không còn nút điều hướng: có thể đã submit hoặc form lỗi
        break;
      }
      if (nav.kind === 'submit') {
        if (remaining.length > 0) {
          // Vẫn còn câu chưa điền mà đã tới nút Submit -> báo thiếu
          return { ok: false, error: 'Còn ' + remaining.length + ' câu chưa điền được: ' + remaining.map(r => r.title).join('; ') };
        }
        humanClick(nav.el);
        // Bắn báo "đã bấm submit" NGAY LẬP TỨC (không sleep trước), vì trang sắp
        // chuyển sang trang cảm ơn và context script có thể bị hủy khi điều hướng.
        try { chrome.runtime.sendMessage({ type: 'FORM_SUBMITTED', runId }); } catch { /* bỏ qua */ }
        // Chờ trang cảm ơn tối đa ~8s (poll mỗi 1s). Nếu context chết giữa chừng
        // do chuyển trang thì background sẽ tự chốt thành công qua URL formResponse.
        for (let k = 0; k < 8; k++) {
          await sleep(1000);
          try {
            if (/formResponse/i.test(location.href)) return { ok: true };
            const bt = norm(document.body && document.body.innerText);
            if (/đã ghi lại|đã gửi|response.*recorded|thank you|cảm ơn|your response has been recorded|đã được ghi/i.test(bt)) {
              return { ok: true };
            }
          } catch { break; } // DOM đã hủy do chuyển trang -> background chốt qua URL
        }
        // Hết chờ mà vẫn ở trang form: lấy lỗi hiển thị (thiếu câu bắt buộc/kẹt captcha)
        let pageErr = '';
        try {
          pageErr = [...document.querySelectorAll('[role="alert"]')]
            .map((e) => norm(e.textContent)).filter(Boolean).slice(0, 3).join(' | ');
        } catch { /* bỏ qua */ }
        return { ok: false, error: 'Đã bấm Submit nhưng không thấy trang cảm ơn (thiếu câu bắt buộc/kẹt captcha?). ' + (pageErr ? 'Trang báo: ' + pageErr + '. ' : '') + 'Các nút đang thấy: ' + seenButtons() };
      } else {
        // Trang trung gian: bấm Tiếp để sang trang kế (kích hoạt logic rẽ nhánh)
        humanClick(nav.el);
        page++;
        await sleep(1200);
      }
    }
    if (remaining.length > 0) return { ok: false, error: 'Hết số trang, còn sót: ' + remaining.map(r => r.title).join('; ') + ' | Các nút đang thấy: ' + seenButtons() };
    return { ok: false, error: 'Không tìm thấy nút Gửi/Submit. Các nút đang thấy trên trang: ' + seenButtons() + (errors.length ? '. Chi tiết điền: ' + errors.join('; ') : '. (Mọi câu hỏi đã điền xong.)') };
  }

  /* ------------------------------------------------------------------
   * MESSAGE ROUTER
   * ------------------------------------------------------------------ */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'EXTRACT_REQUEST') {
      try {
        const result = extractFormStructure();
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e), questions: [] });
      }
      return true;
    }
    if (msg && msg.type === 'FILL_FORM') {
      // Chạy async rồi báo về background (không dùng sendResponse vì cần thời gian dài)
      (async () => {
        try {
          const res = await runFill(msg.payload || [], msg.runId);
          chrome.runtime.sendMessage({
            type: res.ok ? 'FORM_DONE' : 'FORM_ERROR',
            runId: msg.runId, error: res.error || null
          });
        } catch (e) {
          chrome.runtime.sendMessage({ type: 'FORM_ERROR', runId: msg.runId, error: String(e && e.message || e) });
        }
      })();
      sendResponse({ ack: true });
      return true;
    }
  });

  // Hook cho kiểm thử Node (trình duyệt bỏ qua vì không có `module`).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TYPE_MAP, OTHER_RE, OTHER_VALUE,
      parseLoadData, parseStructureFromData,
      normalizeOptionList, extractOptions, extractScale, mergeWithDom,
      stripVi, navText, findNavButton, seenButtons,
    };
  }
})();
