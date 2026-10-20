/* ============================================================================
 * content.js — Chạy trên trang Google Forms
 * 2 nhiệm vụ:
 *  (1) BÓC TÁCH: quét <script> chứa FB_PUBLIC_LOAD_DATA_, parse JSON lấy full
 *      cấu trúc form (kể cả trang ẩn / nhiều trang / rẽ nhánh) -> gửi về Popup.
 *  (2) AUTO-FILL: nhận 1 kịch bản (payload) từ background, click/điền DOM,
 *      qua trang, bấm Submit, báo kết quả về background.
 * ========================================================================== */
(() => {
  'use strict';

  // --- Bảng map typeId của Google Forms sang loại nội bộ ---
  // 0: text ngắn, 1: paragraph, 2: radio, 3: dropdown, 4: checkbox,
  // 5: linear scale, 6: section/title, 7: grid (choice grid),
  // 8: page break (ngắt trang), 9: date, 10: time, 11: image, 12: video
  const TYPE_MAP = {
    0: 'TEXT', 1: 'PARAGRAPH', 2: 'RADIO', 3: 'DROPDOWN',
    4: 'CHECKBOX', 5: 'SCALE', 6: 'SECTION', 7: 'GRID',
    8: 'PAGE_BREAK', 9: 'DATE', 10: 'TIME', 11: 'IMAGE', 12: 'VIDEO'
  };

  /* ------------------------------------------------------------------
   * (1) BÓC TÁCH FB_PUBLIC_LOAD_DATA_ (Hỗ trợ đầy đủ Multi-Page)
   * ------------------------------------------------------------------ */

  // Cắt mảng JSON bằng bộ đếm độ sâu ngoặc vuông [] (an toàn khi script có nhiều lệnh)
  function extractJsonArray(str, startIndex) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < str.length; i++) {
      const ch = str[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) {
            return str.slice(startIndex, i + 1);
          }
        }
      }
    }
    return null;
  }

  // Tìm chuỗi JSON của biến FB_PUBLIC_LOAD_DATA_ trong các thẻ <script>.
  function findLoadDataRaw() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.includes('FB_PUBLIC_LOAD_DATA_')) {
        const eq = txt.indexOf('FB_PUBLIC_LOAD_DATA_');
        const start = txt.indexOf('[', eq);
        if (start !== -1) {
          const extracted = extractJsonArray(txt, start);
          if (extracted) return extracted;
          // Fallback nếu cắt ngoặc thất bại
          const end = txt.lastIndexOf(';');
          if (end !== -1 && end > start) {
            return txt.slice(start, end).trim();
          }
        }
      }
    }
    return null;
  }

  // Parse an toàn: FB data là JSON hợp lệ (đã escape), chỉ cần JSON.parse.
  function parseLoadData(raw) {
    let s = raw.trim();
    while (s.endsWith(';')) s = s.slice(0, -1).trim();
    return JSON.parse(s);
  }

  // Nhận diện đáp án "Mục khác / Other": khi chọn sẽ hiện textbox riêng để nhập.
  const OTHER_RE = /^(other|khác|mục khác|otro|autre|altro|ander(e|o)?s?)\s*:?$/i;
  const OTHER_VALUE = '__other_option__'; // data-value của radio/checkbox "Other" trên DOM

  // Chuẩn hóa 1 tuple đáp án FB thành {t: text, other} (other='maybe' = slot rỗng chưa rõ).
  // Trong FB_PUBLIC_LOAD_DATA_, tuple đáp án có dạng: [text, null, null, null, isOtherFlag]
  // Nếu o[4] === 1 thì chắc chắn 100% là đáp án "Mục khác / Other" (kể cả ở trang ẩn).
  function normOptionTuple(o) {
    if (Array.isArray(o)) {
      if (o[4] === 1) {
        const label = typeof o[0] === 'string' && o[0].trim() !== '' ? o[0] : 'Mục khác:';
        return { t: label, other: true };
      }
      if (typeof o[0] === 'string') {
        const t = o[0].trim();
        if (t === '') return { t: '', other: 'maybe' };
        return { t: o[0], other: OTHER_RE.test(t) };
      }
      // Slot "Other" đôi khi serialize thành null / [null, ...]
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
      // Chỉ nhận khi có ít nhất 1 đáp án text thật hoặc Other xác thực
      if (out.some((x) => (x.other !== 'maybe' && x.t !== '') || x.other === true)) return out;
    }
    return [];
  }

  // Trích options cho câu trắc nghiệm — thử nhiều đường dẫn (mỗi bản Forms lồng khác nhau).
  function extractOptions(entry) {
    try {
      const e4 = entry[4];
      if (!Array.isArray(e4)) return [];
      const roots = [e4[0], e4[0] && e4[0][1], e4];
      for (const r of roots) {
        const list = normalizeOptionList(r);
        if (list.length) return list;
      }
      return [];
    } catch { return []; }
  }

  // Quét DOM bổ sung đáp án (fallback khi FB thiếu; và để phát hiện nút "Mục khác:").
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
  // Hỗ trợ câu hỏi nằm ở trang sau (khi block DOM chưa được render).
  function mergeWithDom(fbOpts, title, type) {
    let dom = [];
    let isRenderedOnDom = false;
    try {
      const block = typeof document !== 'undefined' ? findQuestionBlock(title) : null;
      isRenderedOnDom = !!block;
      if (isRenderedOnDom) {
        dom = scrapeOptionsFromDOM(title, type);
      }
    } catch { /* bỏ qua */ }

    const domHasOther = dom.some((d) => d.isOther);
    const out = [];

    for (const x of fbOpts) {
      if (x.other === true) {
        if (!out.some((o) => o.other)) out.push({ t: x.t || 'Mục khác:', other: true });
        continue;
      }
      if (x.other === 'maybe') {
        // Nếu câu hỏi đang hiển thị trên DOM trang 1: kiểm tra domHasOther.
        // Nếu câu hỏi ở trang ẩn (isRenderedOnDom === false): giữ lại làm Other để không mất đáp án.
        if (domHasOther || !isRenderedOnDom) {
          if (!out.some((o) => o.other)) out.push({ t: 'Mục khác:', other: true });
        }
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
  function extractScale(entry) {
    try {
      const e4 = entry[4];
      const cands = [e4 && e4[0], e4 && e4[0] && e4[0][0], e4 && e4[0] && e4[0][1]];
      for (const c of cands) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          const [min, max] = [c[0], c[1]];
          const labels = [];
          for (let v = min; v <= max; v++) labels.push(String(v));
          return { min, max, options: labels.map((t) => ({ t, other: false })) };
        }
        // Trường hợp Google Forms lưu scale dưới dạng danh sách các mảng ["1"], ["2"]...
        if (Array.isArray(c) && c.length >= 2 && Array.isArray(c[0]) && /^\d+$/.test(String(c[0][0]))) {
          const nums = c.map((item) => Number(item[0])).filter((n) => !Number.isNaN(n));
          if (nums.length >= 2) {
            const min = Math.min(...nums);
            const max = Math.max(...nums);
            return { min, max, options: nums.map((n) => ({ t: String(n), other: false })) };
          }
        }
      }
    } catch { /* bỏ qua */ }
    return null;
  }

  // Hàm chính: trả về mảng câu hỏi chuẩn hóa (bao gồm tất cả các trang)
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

  // Parse mảng FB đã JSON.parse thành danh sách câu hỏi xuyên suốt mọi trang.
  function parseStructureFromData(data) {
    try {
      const items = (data[1] && data[1][1]) || [];
      const questions = [];
      let currentPage = 1;

      for (const entry of items) {
        if (!Array.isArray(entry) || entry.length < 4) continue;
        const qid = entry[0];
        const title = entry[1] || '(Không tiêu đề)';
        const typeId = entry[3];
        const type = TYPE_MAP[typeId] || ('UNKNOWN_' + typeId);

        // Ngắt trang (Page Break / Section sang trang mới) -> tăng số trang
        if (type === 'PAGE_BREAK') {
          currentPage++;
          continue;
        }
        // Bỏ qua khối tiêu đề/mô tả văn bản, hình ảnh, video trang trí
        if (type === 'SECTION' || type === 'IMAGE' || type === 'VIDEO') continue;
        // Một số câu hỏi thực tế có dữ liệu con nằm ở entry[4]; nếu không có entry[4] thì không phải câu hỏi nhập liệu
        if (!Array.isArray(entry[4]) || entry[4].length === 0) continue;

        // Input field ID thực sự của câu hỏi thường nằm ở entry[4][0][0]
        const inputId = (entry[4][0] && entry[4][0][0]) ? String(entry[4][0][0]) : String(qid);
        const isRequired = Boolean(entry[4][0] && entry[4][0][2] === 1);

        const q = {
          id: String(qid),
          inputId,
          title: String(title).trim(),
          typeId,
          type,
          page: currentPage,
          required: isRequired,
          options: []
        };

        if (type === 'RADIO' || type === 'CHECKBOX' || type === 'DROPDOWN') {
          q.options = mergeWithDom(extractOptions(entry), q.title, type);
        } else if (type === 'SCALE') {
          const sc = extractScale(entry);
          if (sc) {
            q.scaleMin = sc.min;
            q.scaleMax = sc.max;
            q.options = sc.options;
          } else {
            q.options = mergeWithDom(extractOptions(entry), q.title, type);
          }
        } else if (type === 'GRID') {
          // Grid: trong FB_PUBLIC_LOAD_DATA_, mỗi dòng của Grid là 1 phần tử trong entry[4]
          // entry[4][rowIndex][0] = rowId, entry[4][rowIndex][1] = danh sách cột, entry[4][rowIndex][3][0] = Tên dòng
          try {
            const firstRowCols = entry[4][0] && entry[4][0][1];
            const cols = normalizeOptionList(firstRowCols).filter((x) => !x.other || x.t);
            q.options = cols.length ? cols : extractOptions(entry).filter((x) => !x.other || x.t);

            const gridRows = [];
            for (const rowEntry of entry[4]) {
              if (Array.isArray(rowEntry) && Array.isArray(rowEntry[3]) && rowEntry[3][0]) {
                gridRows.push(String(rowEntry[3][0]));
              }
            }
            if (gridRows.length === 0 && Array.isArray(entry[4][8])) {
              entry[4][8].forEach((r) => {
                const rName = Array.isArray(r) ? r[0] : r;
                if (rName) gridRows.push(String(rName));
              });
            }
            if (gridRows.length > 0) q.gridRows = gridRows;
          } catch { /* bỏ qua */ }
        }
        questions.push(q);
      }
      const title = (data[1] && data[1][8]) || (typeof document !== 'undefined' ? document.title : '');
      return { ok: true, questions, totalPages: currentPage, formTitle: title };
    } catch (e) {
      return { ok: false, error: 'Cấu trúc FB data không như kỳ vọng: ' + e.message, questions: [] };
    }
  }

  /* ------------------------------------------------------------------
   * (2) AUTO-FILL DOM
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');

  // Chuẩn hóa tiêu đề trên DOM: xóa dấu '*' của câu hỏi bắt buộc ở cuối
  function cleanHeadingText(headingEl) {
    if (!headingEl) return '';
    // Clone để xóa các span dấu * (aria-label="Câu hỏi bắt buộc") nếu có
    const clone = headingEl.cloneNode(true);
    const reqSpans = clone.querySelectorAll('[aria-label*="bắt buộc" i], [aria-label*="required" i]');
    reqSpans.forEach((s) => s.remove());
    return norm(clone.textContent).replace(/\s*\*\s*$/, '');
  }

  // Tìm "khối câu hỏi" trên DOM bằng cách so khớp tiêu đề hoặc data-params chứa ID.
  function findQuestionBlock(questionTitle, questionId) {
    const blocks = document.querySelectorAll('div[role="listitem"]');
    // 1. Ưu tiên khớp theo questionId trong thuộc tính data-params (nếu có)
    if (questionId) {
      for (const b of blocks) {
        const dpEl = b.querySelector('[data-params]');
        if (dpEl) {
          const dp = dpEl.getAttribute('data-params') || '';
          if (dp.includes('[' + questionId + ',')) return b;
        }
      }
    }

    const want = norm(questionTitle).replace(/\s*\*\s*$/, '');
    if (!want) return null;

    // 2. Ưu tiên khớp chính xác 100% tiêu đề đã làm sạch dấu *
    for (const b of blocks) {
      const heading = b.querySelector('[role="heading"]');
      if (heading && cleanHeadingText(heading).toLowerCase() === want.toLowerCase()) return b;
    }

    // 3. Dự phòng: khớp chứa (chỉ khi chuỗi đủ dài để tránh bắt nhầm câu ngắn)
    for (const b of blocks) {
      const heading = b.querySelector('[role="heading"]');
      if (!heading) continue;
      const hText = cleanHeadingText(heading).toLowerCase();
      const wText = want.toLowerCase();
      if ((wText.length >= 4 && hText.includes(wText)) || (hText.length >= 4 && wText.includes(hText))) return b;
    }
    return null;
  }

  // Click phần tử theo cách "giống người": scroll vào view + click chuột thật
  function humanClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
  }

  // Tìm phần tử khớp nhất trong danh sách theo 2 vòng:
  // Vòng 1: Khớp chính xác 100% (===)
  // Vòng 2: Khớp một phần (includes) - chỉ cho phép option chứa want, tắt nếu exactOnly = true (như SCALE)
  function matchBestElement(elements, getLabelFn, wantRaw, exactOnly = false) {
    const want = norm(String(wantRaw)).toLowerCase();
    if (!want) return null;

    // Vòng 1: Khớp tuyệt đối
    for (const el of elements) {
      const v = norm(getLabelFn(el)).toLowerCase();
      if (v === want) return el;
    }
    if (exactOnly) return null;

    // Vòng 2: Khớp bao hàm (chỉ xét nhãn v chứa want, không cho want chứa v để tránh "Nam" khớp vào "Việt Nam")
    for (const el of elements) {
      const v = norm(getLabelFn(el)).toLowerCase();
      if (v && v.includes(want)) return el;
    }
    return null;
  }

  // Chọn đáp án "Mục khác:" (data-value="__other_option__") rồi điền textbox hiện ra.
  async function fillOther(block, text) {
    const cands = block.querySelectorAll('div[role="radio"], div[role="checkbox"]');
    let otherEl = null;
    for (const el of cands) {
      const v = el.getAttribute('data-value') || '';
      const lb = norm(el.getAttribute('aria-label') || el.textContent);
      if (v === OTHER_VALUE || (lb !== '' && OTHER_RE.test(lb))) {
        otherEl = el;
        break;
      }
    }
    if (!otherEl) return false;
    if (otherEl.getAttribute('aria-checked') !== 'true') {
      humanClick(otherEl);
      await sleep(200); // Chờ Google Forms mở khóa ô input của "Mục khác"
    }
    const box = block.querySelector('input[type="text"], textarea, input:not([type])');
    if (!box) return true;
    return fillTextInput(box, text);
  }

  // Điền RADIO: Google Forms dùng div[role="radio"][data-value="..."]
  async function fillRadio(block, answer, exactOnly = false) {
    if (answer && typeof answer === 'object' && answer.other) {
      return await fillOther(block, answer.text || '');
    }
    const radios = [...block.querySelectorAll('div[role="radio"]')];
    const target = matchBestElement(
      radios,
      (r) => r.getAttribute('data-value') || r.getAttribute('aria-label') || r.textContent,
      answer,
      exactOnly
    );
    if (target) {
      if (target.getAttribute('aria-checked') !== 'true') humanClick(target);
      return true;
    }
    return false;
  }

  // Điền CHECKBOX: answer là mảng (nhiều lựa chọn), phần tử có thể là {other:true, text}
  async function fillCheckbox(block, answers) {
    const list = Array.isArray(answers) ? answers : [answers];
    let ok = 0;
    const boxes = [...block.querySelectorAll('div[role="checkbox"]')];
    for (const wantRaw of list) {
      if (wantRaw && typeof wantRaw === 'object' && wantRaw.other) {
        if (await fillOther(block, wantRaw.text || '')) ok++;
        continue;
      }
      const target = matchBestElement(
        boxes,
        (c) => c.getAttribute('data-value') || c.getAttribute('aria-label') || c.textContent,
        wantRaw,
        false
      );
      if (target) {
        const checked = target.getAttribute('aria-checked') === 'true';
        if (!checked) {
          humanClick(target);
          await sleep(100);
        }
        ok++;
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
    await sleep(550);
    // Chỉ lấy các option đang hiển thị trong popup menu của dropdown
    const opts = [...document.querySelectorAll('div[role="option"]')].filter(
      (o) => o.offsetParent !== null && o.getAttribute('data-value') !== ''
    );
    const target = matchBestElement(
      opts,
      (o) => o.getAttribute('data-value') || o.textContent,
      want,
      false
    );
    if (target) {
      humanClick(target);
      await sleep(300);
      return true;
    }
    listbox.blur();
    return false;
  }

  // Điền SCALE: bắt buộc khớp chính xác (exactOnly = true) để "1" không nhầm vào "10"
  async function fillScale(block, answer) {
    const val = answer && typeof answer === 'object' ? String(answer.text || '') : String(answer);
    return await fillRadio(block, val, true);
  }

  // Điền giá trị vào 1 ô input/textarea cụ thể (dùng native setter cho framework Google)
  function fillTextInput(field, value) {
    field.scrollIntoView({ block: 'center', behavior: 'instant' });
    field.focus();
    const proto = field.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(field, String(value));
    } else {
      field.value = String(value);
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.blur();
    return true;
  }

  // Điền TEXT / PARAGRAPH
  function fillText(block, value) {
    const field = block.querySelector('textarea, input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input[type="url"], input:not([type])');
    if (!field) return false;
    return fillTextInput(field, value);
  }

  // Điền DATE: hỗ trợ cả 1 ô input[type="date"] hoặc 3 ô tách rời (Ngày / Tháng / Năm)
  function fillDate(block, value) {
    const raw = String(value || '').trim();
    if (!raw) return false;

    // Chuẩn hóa chuỗi ngày về { yyyy, mm, dd }
    let yyyy = '2000', mm = '01', dd = '01';
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw)) { const parts = raw.split(/[-/]/); yyyy = parts[0]; mm = parts[1].padStart(2, '0'); dd = parts[2].padStart(2, '0'); } else if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(raw)) {
      const parts = raw.split(/[-/]/);
      dd = parts[0].padStart(2, '0');
      mm = parts[1].padStart(2, '0');
      yyyy = parts[2];
    }

    const dateInput = block.querySelector('input[type="date"]');
    if (dateInput) {
      return fillTextInput(dateInput, `${yyyy}-${mm}-${dd}`);
    }

    const inputs = [...block.querySelectorAll('input[type="text"], input[type="number"], input:not([type])')];
    if (inputs.length >= 3) {
      let filledLabels = 0;
      for (const inp of inputs) {
        const lbl = stripVi(inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || '').toLowerCase();
        if (lbl.includes('ngay') || lbl.includes('day')) { fillTextInput(inp, dd); filledLabels++; }
        else if (lbl.includes('thang') || lbl.includes('month')) { fillTextInput(inp, mm); filledLabels++; }
        else if (lbl.includes('nam') || lbl.includes('year')) { fillTextInput(inp, yyyy); filledLabels++; }
      }
      if (filledLabels === 0) {
        // Fallback theo thứ tự thông thường (Ngày / Tháng / Năm)
        fillTextInput(inputs[0], dd);
        fillTextInput(inputs[1], mm);
        fillTextInput(inputs[2], yyyy);
      }
      return true;
    }
    if (inputs.length === 1) {
      return fillTextInput(inputs[0], `${dd}/${mm}/${yyyy}`);
    }
    return false;
  }

  // Điền TIME: hỗ trợ cả 1 ô input[type="time"] hoặc 2 ô tách rời (Giờ / Phút)
  function fillTime(block, value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const match = raw.match(/(\d{1,2})[:h](\d{1,2})/);
    const hh = match ? match[1].padStart(2, '0') : '08';
    const min = match ? match[2].padStart(2, '0') : '00';

    const timeInput = block.querySelector('input[type="time"]');
    if (timeInput) {
      return fillTextInput(timeInput, `${hh}:${min}`);
    }

    const inputs = [...block.querySelectorAll('input[type="text"], input[type="number"], input:not([type])')];
    if (inputs.length >= 2) {
      let filledAny = false;
      for (const inp of inputs) {
        const lbl = stripVi(inp.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('gio') || lbl.includes('hour')) { fillTextInput(inp, hh); filledAny = true; }
        else if (lbl.includes('phut') || lbl.includes('minute')) { fillTextInput(inp, min); filledAny = true; }
      }
      if (!filledAny) {
        fillTextInput(inputs[0], hh);
        fillTextInput(inputs[1], min);
      }
      return true;
    }
    if (inputs.length === 1) {
      return fillTextInput(inputs[0], `${hh}:${min}`);
    }
    return false;
  }

  // Điền 1 câu hỏi theo payload { questionId, title, type, answer }
  async function fillOne(item) {
    const block = findQuestionBlock(item.title, item.questionId);
    if (!block) return { ok: false, reason: 'Không tìm thấy khối DOM cho: ' + item.title };
    switch (item.type) {
      case 'RADIO': return { ok: await fillRadio(block, item.answer) };
      case 'CHECKBOX': return { ok: await fillCheckbox(block, item.answer) };
      case 'DROPDOWN': return { ok: await fillDropdown(block, item.answer) };
      case 'SCALE': return { ok: await fillScale(block, item.answer) };
      case 'DATE': return { ok: fillDate(block, item.answer) };
      case 'TIME': return { ok: fillTime(block, item.answer) };
      case 'TEXT':
      case 'PARAGRAPH':
        return { ok: fillText(block, item.answer) };
      case 'GRID': {
        if (typeof item.answer === 'object' && item.answer !== null) {
          let okCount = 0;
          const rows = block.querySelectorAll('div[role="radiogroup"], div[role="group"]');
          for (const rg of rows) {
            const rowLabel = norm(rg.getAttribute('aria-label') || '').toLowerCase();
            for (const [rowName, colVal] of Object.entries(item.answer)) {
              const wantRow = norm(rowName).toLowerCase();
              if (rowLabel === wantRow || (wantRow && rowLabel.includes(wantRow))) {
                const container = rg.parentElement || rg;
                if (Array.isArray(colVal)) {
                  if (await fillCheckbox(container, colVal)) okCount++;
                } else {
                  if (await fillRadio(container, colVal)) okCount++;
                }
              }
            }
          }
          return { ok: okCount > 0 };
        }
        return { ok: await fillRadio(block, item.answer) };
      }
      default:
        if (fillText(block, item.answer)) return { ok: true };
        return { ok: await fillRadio(block, item.answer) };
    }
  }

  // Bỏ dấu tiếng Việt để so khớp bền vững
  function stripVi(s) {
    return (s || '').normalize('NFD')
      .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D');
  }

  const SUBMIT_KEYS = ['gui', 'goi', 'submit', 'send', 'hoan tat', 'hoan thanh', 'xac nhan', 'done'];
  const NEXT_KEYS = ['tiep', 'next', 'continue'];
  const BACK_KEYS = ['quay lai', 'tro lai', 'quay ve', 'truoc', 'back', 'previous'];
  const CLEAR_KEYS = ['xoa', 'clear'];

  function navText(el) {
    try {
      const raw = norm(el.textContent) + ' ' + norm(el.getAttribute && el.getAttribute('aria-label')) + ' ' + norm(el.value);
      return stripVi(raw).toLowerCase().replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }
  const isClearBtn = (t) => CLEAR_KEYS.some((k) => t.includes(k));
  const isBackBtn = (t) => BACK_KEYS.some((k) => t.includes(k));
  const hitKeys = (t, keys) => keys.some((k) => t === k || t.includes(k));

  // Tìm nút Tiếp/Next hoặc Gửi/Submit ĐANG HIỂN THỊ ở cuối trang hiện tại.
  function findNavButton() {
    const btns = [...document.querySelectorAll(
      'div[role="button"], span[role="button"], button, input[type="submit"], input[type="button"]'
    )];
    // Lọc bỏ các nút đang bị ẩn (offsetParent === null) nếu chạy trên trình duyệt thật
    const visibleBtns = btns.filter((b) => {
      if (typeof window !== 'undefined' && typeof b.offsetParent !== 'undefined') {
        // Trong môi trường JSDOM/Node test, offsetParent luôn là null nên cho qua nếu innerWidth === 0
        if (window.innerWidth > 0 && b.offsetParent === null) return false;
      }
      return true;
    });

    const items = visibleBtns.map((b) => ({ el: b, t: navText(b) })).filter((x) => x.t !== '');
    const usable = items.filter((x) => !isClearBtn(x.t) && !isBackBtn(x.t));

    // Nếu trang có nút "Tiếp / Next", ưu tiên đi tiếp trước khi bấm Submit
    const n = usable.find((x) => hitKeys(x.t, NEXT_KEYS));
    if (n) return { el: n.el, kind: 'next' };
    const s = usable.find((x) => hitKeys(x.t, SUBMIT_KEYS));
    if (s) return { el: s.el, kind: 'submit' };

    if (usable.length) {
      const last = usable[usable.length - 1];
      return { el: last.el, kind: hitKeys(last.t, NEXT_KEYS) ? 'next' : (hitKeys(last.t, SUBMIT_KEYS) ? 'submit' : 'next') };
    }
    return null;
  }

  function seenButtons() {
    try {
      const list = [...document.querySelectorAll('div[role="button"], span[role="button"], button')]
        .map((b) => norm(b.textContent || (b.getAttribute && b.getAttribute('aria-label')) || b.value))
        .filter(Boolean).slice(0, 12);
      return list.length ? list.join(' | ') : '(không thấy nút nào trên trang)';
    } catch { return '(không đọc được DOM)'; }
  }

  // Luồng fill chính: điền từng câu trên trang hiện tại -> bấm Tiếp sang trang sau -> bấm Gửi ở trang cuối
  async function runFill(payloadItems, runId) {
    const maxPages = 25;
    let page = 0;
    const remaining = [...payloadItems];
    const errors = [];
    let filled = 0;

    const heartbeat = () => {
      try { chrome.runtime.sendMessage({ type: 'FORM_HEARTBEAT', runId }); } catch { /* bỏ qua */ }
    };

    while (page < maxPages) {
      await sleep(800); // chờ trang hiện tại render đầy đủ
      heartbeat();

      let filledOnThisPage = 0;
      const failedVisibleOnThisPage = [];

      // Điền mọi câu hỏi đang HIỂN THỊ trên trang hiện tại
      for (let i = remaining.length - 1; i >= 0; i--) {
        const item = remaining[i];
        const block = findQuestionBlock(item.title, item.questionId);
        if (!block) continue; // câu hỏi nằm ở trang sau hoặc nhánh khác
        if (window.innerWidth > 0 && block.offsetParent === null) continue; // khối đang bị ẩn

        const res = await fillOne(item);
        await sleep(150 + Math.random() * 250);
        if (res.ok) {
          remaining.splice(i, 1);
          filled++;
          filledOnThisPage++;
          if (filled % 8 === 0) heartbeat();
        } else {
          const errMsg = item.title + ': ' + (res.reason || 'không điền được');
          errors.push(errMsg);
          failedVisibleOnThisPage.push(item.title);
        }
      }

      // Kiểm tra xem Google Forms có đang báo lỗi đỏ (role="alert") trên câu bắt buộc nào không
      const nav = findNavButton();
      if (!nav) break;

      if (nav.kind === 'submit') {
        // Nếu vẫn còn câu hỏi ĐANG HIỂN THỊ trên trang cuối mà điền thất bại -> báo lỗi
        if (failedVisibleOnThisPage.length > 0) {
          return {
            ok: false,
            error: 'Không điền được câu hỏi trên trang cuối: ' + failedVisibleOnThisPage.join('; ')
          };
        }
        // Lưu ý: Nếu remaining.length > 0 nhưng KHÔNG hiển thị trên trang cuối,
        // nghĩa là các câu đó thuộc nhánh rẽ (Conditional Branching) bị bỏ qua -> vẫn cho phép Submit!
        humanClick(nav.el);
        try { chrome.runtime.sendMessage({ type: 'FORM_SUBMITTED', runId }); } catch { /* bỏ qua */ }

        for (let k = 0; k < 10; k++) {
          await sleep(1000);
          try {
            const bt = norm(document.body && document.body.innerText);
            if (/đã ghi lại|đã gửi|response.*recorded|thank you|cảm ơn|your response has been recorded|đã được ghi|gửi phản hồi khác|submit another response/i.test(bt)) {
              return { ok: true };
            }
            // Nếu trang không còn bất kỳ listitem câu hỏi nào và URL chứa formResponse -> đã tới trang cảm ơn
            const stillHasQuestions = document.querySelectorAll('div[role="listitem"]').length > 0;
            if (!stillHasQuestions && /formResponse/i.test(location.href)) {
              return { ok: true };
            }
          } catch { break; }
        }

        let pageErr = '';
        try {
          pageErr = [...document.querySelectorAll('[role="alert"]')]
            .map((e) => norm(e.textContent)).filter(Boolean).slice(0, 3).join(' | ');
        } catch { /* bỏ qua */ }
        return {
          ok: false,
          error: 'Đã bấm Submit nhưng không qua được trang cảm ơn. ' +
                 (pageErr ? 'Trang báo lỗi: ' + pageErr + '. ' : '') +
                 'Các nút đang thấy: ' + seenButtons()
        };
      } else {
        // Trang trung gian (Multi-page): bấm "Tiếp / Next" để tải trang tiếp theo
        humanClick(nav.el);
        page++;
        await sleep(1200);
      }
    }

    if (remaining.length > 0) {
      return {
        ok: false,
        error: 'Vượt quá số trang tối đa hoặc kẹt nút điều hướng, còn sót: ' +
               remaining.map((r) => r.title).join('; ') + ' | Các nút đang thấy: ' + seenButtons()
      };
    }
    return {
      ok: false,
      error: 'Không tìm thấy nút Gửi/Submit. Các nút đang thấy: ' + seenButtons() +
             (errors.length ? '. Chi tiết lỗi: ' + errors.join('; ') : '')
    };
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
        sendResponse({ ok: false, error: String((e && e.message) || e), questions: [] });
      }
      return true;
    }
    if (msg && msg.type === 'FILL_FORM') {
      (async () => {
        try {
          const res = await runFill(msg.payload || [], msg.runId);
          chrome.runtime.sendMessage({
            type: res.ok ? 'FORM_DONE' : 'FORM_ERROR',
            runId: msg.runId,
            error: res.error || null
          });
        } catch (e) {
          chrome.runtime.sendMessage({
            type: 'FORM_ERROR',
            runId: msg.runId,
            error: String((e && e.message) || e)
          });
        }
      })();
      sendResponse({ ack: true });
      return true;
    }
  });

  // Hook cho kiểm thử Node
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TYPE_MAP, OTHER_RE, OTHER_VALUE,
      extractJsonArray, findLoadDataRaw, parseLoadData, parseStructureFromData,
      normalizeOptionList, extractOptions, extractScale, mergeWithDom,
      cleanHeadingText, matchBestElement,
      stripVi, navText, findNavButton, seenButtons,
    };
  }
})();