/* ============================================================================
 * content.js — Chạy trên trang Google Forms (ĐÃ FIX LỖI FALSE-POSITIVE DONE & CLICK NAV)
 * ========================================================================== */
(() => {
  'use strict';

  const TYPE_MAP = {
    0: 'TEXT', 1: 'PARAGRAPH', 2: 'RADIO', 3: 'DROPDOWN',
    4: 'CHECKBOX', 5: 'SCALE', 6: 'SECTION', 7: 'GRID',
    8: 'PAGE_BREAK', 9: 'DATE', 10: 'TIME', 11: 'IMAGE', 12: 'VIDEO'
  };

  let activeFillingRunId = null;

  /* ------------------------------------------------------------------
   * (1) BÓC TÁCH FB_PUBLIC_LOAD_DATA_
   * ------------------------------------------------------------------ */

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
          const end = txt.lastIndexOf(';');
          if (end !== -1 && end > start) {
            return txt.slice(start, end).trim();
          }
        }
      }
    }
    return null;
  }

  function parseLoadData(raw) {
    let s = raw.trim();
    while (s.endsWith(';')) s = s.slice(0, -1).trim();
    return JSON.parse(s);
  }

  const OTHER_RE = /^(other|khác|mục khác|otro|autre|altro|ander(e|o)?s?)\s*:?$/i;
  const OTHER_VALUE = '__other_option__';

  function normOptionTuple(o) {
    if (Array.isArray(o)) {
      if (o[4] === 1) {
        const label = typeof o[0] === 'string' && o[0].trim() !== '' ? o[0] : 'Mục khác:';
        return { t: label, other: true };
      }
      if (typeof o[0] === 'string' || typeof o[0] === 'number') {
        const rawStr = String(o[0]);
        const t = rawStr.trim();
        if (t === '') return { t: '', other: 'maybe' };
        return { t: rawStr, other: OTHER_RE.test(t) };
      }
      if (o.length === 0 || o[0] === null || o[0] === undefined) return { t: '', other: 'maybe' };
      return null;
    }
    if (typeof o === 'string' || typeof o === 'number') {
      const rawStr = String(o);
      const t = rawStr.trim();
      if (t === '') return null;
      return { t: rawStr, other: OTHER_RE.test(t) };
    }
    if (o === null || o === undefined) return { t: '', other: 'maybe' };
    return null;
  }

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
      if (out.some((x) => (x.other !== 'maybe' && x.t !== '') || x.other === true)) return out;
    }
    return [];
  }

  function extractOptions(entry) {
    try {
      const e4 = entry[4];
      if (!Array.isArray(e4) || e4.length === 0) return [];
      const roots = [
        e4[0] && e4[0][1],
        e4[0],
        e4
      ];
      for (const r of roots) {
        const list = normalizeOptionList(r);
        if (list.length) return list;
      }
      return [];
    } catch { return []; }
  }

  function scrapeOptionsFromDOM(title, type) {
    if (type !== 'RADIO' && type !== 'CHECKBOX' && type !== 'SCALE' && type !== 'GRID') return [];
    try {
      const block = findQuestionBlock(title);
      if (!block) return [];
      const roleSelector = type === 'CHECKBOX' ? 'div[role="checkbox"]' : 'div[role="radio"]';
      const scope = (type === 'GRID' && block.querySelector('div[role="radiogroup"]:not([aria-hidden="true"]), div[role="group"]:not([aria-hidden="true"])')) || block;
      const els = scope.querySelectorAll(roleSelector);
      const out = [];
      els.forEach((el) => {
        if (el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-hidden="true"]')) return;
        const v = el.getAttribute('data-value') || '';
        const label = norm(v || el.getAttribute('aria-label') || el.textContent);
        if (!v && !label) return;
        const isOther = v === OTHER_VALUE || (label !== '' && OTHER_RE.test(label));
        out.push({ value: v, label: v || label, isOther });
      });
      return out;
    } catch { return []; }
  }

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
        if (domHasOther || !isRenderedOnDom) {
          if (!out.some((o) => o.other)) out.push({ t: 'Mục khác:', other: true });
        }
        continue;
      }
      if (x.t !== undefined && x.t !== '') out.push({ t: String(x.t), other: false });
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

  function extractScale(entry) {
    try {
      const e4 = entry[4];
      const cands = [e4 && e4[0] && e4[0][1], e4 && e4[0], e4 && e4[0] && e4[0][0]];
      for (const c of cands) {
        if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
          const [min, max] = [c[0], c[1]];
          const labels = [];
          for (let v = min; v <= max; v++) labels.push(String(v));
          return { min, max, options: labels.map((t) => ({ t, other: false })) };
        }
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

        if (type === 'PAGE_BREAK') {
          currentPage++;
          continue;
        }
        if (type === 'SECTION' || type === 'IMAGE' || type === 'VIDEO') continue;
        if (!Array.isArray(entry[4]) || entry[4].length === 0) continue;

        const q = {
          id: String(qid),
          title: String(title).trim(),
          typeId,
          type,
          page: currentPage,
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
          const colOpts = extractOptions(entry).filter((x) => !x.other && x.t !== '');
          q.options = colOpts.length ? colOpts : mergeWithDom([], q.title, 'GRID');

          const gridRows = [];
          for (const rowEntry of entry[4]) {
            if (Array.isArray(rowEntry)) {
              const rowLabel = Array.isArray(rowEntry[3]) ? rowEntry[3][0] : null;
              if (rowLabel) gridRows.push(String(rowLabel).trim());
            }
          }
          if (gridRows.length === 0 && Array.isArray(entry[4][8])) {
            entry[4][8].forEach((r) => {
              const rName = Array.isArray(r) ? r[0] : r;
              if (rName) gridRows.push(String(rName).trim());
            });
          }
          q.gridRows = gridRows;
          q.rowCount = gridRows.length || entry[4].length || 1;
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

  function isElementHidden(el) {
    if (!el) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) {
        return true;
      }
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        try {
          const cs = window.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
        } catch { /* bỏ qua */ }
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function cleanHeadingText(headingEl) {
    if (!headingEl) return '';
    const clone = headingEl.cloneNode(true);
    const reqSpans = clone.querySelectorAll('.vnumgf, [aria-label*="bắt buộc" i], [aria-label*="required" i]');
    reqSpans.forEach((s) => s.remove());
    return norm(clone.textContent).replace(/\s*\*\s*$/, '');
  }

  function findQuestionBlock(questionTitle, questionId) {
    const blocks = document.querySelectorAll('div[role="listitem"]');
    if (questionId) {
      for (const b of blocks) {
        if (isElementHidden(b)) continue;
        const dpEl = b.querySelector('[data-params]');
        if (dpEl) {
          const dp = dpEl.getAttribute('data-params') || '';
          if (dp.includes('[' + questionId + ',')) return b;
        }
      }
    }

    const want = norm(questionTitle).replace(/\s*\*\s*$/, '');
    if (!want) return null;

    for (const b of blocks) {
      if (isElementHidden(b)) continue;
      const heading = b.querySelector('[role="heading"]');
      if (heading && cleanHeadingText(heading).toLowerCase() === want.toLowerCase()) return b;
    }

    for (const b of blocks) {
      if (isElementHidden(b)) continue;
      const heading = b.querySelector('[role="heading"]');
      if (!heading) continue;
      const hText = cleanHeadingText(heading).toLowerCase();
      const wText = want.toLowerCase();
      if (hText.includes(wText) || (hText.length >= 5 && wText.includes(hText))) return b;
    }
    return null;
  }

  // Click chuẩn Google Forms (Closure Library / Wiz jsaction)
  function humanClick(el) {
    if (!el) return;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch {
      try { el.scrollIntoView(); } catch { /* bỏ qua */ }
    }
    try { el.focus(); } catch { /* bỏ qua */ }

    let clientX = 10, clientY = 10;
    try {
      const rect = el.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        clientX = Math.round(rect.left + rect.width / 2);
        clientY = Math.round(rect.top + rect.height / 2);
      }
    } catch { /* bỏ qua */ }

    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: typeof window !== 'undefined' ? window : null,
      detail: 1,
      screenX: clientX,
      screenY: clientY,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    const dispatchFullSequence = (target) => {
      if (!target) return;
      try {
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerover', opts));
          target.dispatchEvent(new PointerEvent('pointerenter', opts));
          target.dispatchEvent(new PointerEvent('pointerdown', opts));
        }
        target.dispatchEvent(new MouseEvent('mouseover', opts));
        target.dispatchEvent(new MouseEvent('mouseenter', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        if (typeof PointerEvent === 'function') {
          target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        }
        target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      } catch {
        try { target.click(); } catch { /* bỏ qua */ }
      }
    };

    dispatchFullSequence(el);
  }

  function matchBestElement(elements, getLabelFn, wantRaw, exactOnly = false) {
    const want = norm(String(wantRaw)).toLowerCase();
    if (!want) return null;

    for (const el of elements) {
      const v = norm(getLabelFn(el)).toLowerCase();
      if (v === want) return el;
    }
    if (exactOnly) return null;

    for (const el of elements) {
      const v = norm(getLabelFn(el)).toLowerCase();
      if (v && v.includes(want)) return el;
    }
    for (const el of elements) {
      const v = norm(getLabelFn(el)).toLowerCase();
      if (v && v.length >= 2 && want.includes(v)) return el;
    }
    return null;
  }

  function pickLineIfMultiline(val) {
    if (typeof val !== 'string') return String(val ?? '');
    if (!val.includes('\n')) return val;
    const lines = val.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) return '';
    return lines[Math.floor(Math.random() * lines.length)];
  }

  async function fillOther(block, text) {
    const cands = [...block.querySelectorAll('div[role="radio"], div[role="checkbox"]')].filter(
      (el) => el.getAttribute('aria-disabled') !== 'true' && !el.closest('[aria-hidden="true"]')
    );
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
      await sleep(200);
    }
    const box = block.querySelector('input[type="text"], textarea, input:not([type]):not([type="hidden"])');
    if (!box) return true;
    return fillTextInput(box, pickLineIfMultiline(text));
  }

  async function fillRadio(block, answer, exactOnly = false) {
    if (answer && typeof answer === 'object' && answer.other) {
      return await fillOther(block, answer.text || '');
    }
    const radios = [...block.querySelectorAll('div[role="radio"]')].filter(
      (r) => r.getAttribute('aria-disabled') !== 'true' && !r.closest('[aria-hidden="true"]')
    );
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

  async function fillCheckbox(block, answers) {
    const list = Array.isArray(answers) ? answers : [answers];
    let ok = 0;
    const boxes = [...block.querySelectorAll('div[role="checkbox"]')].filter(
      (c) => c.getAttribute('aria-disabled') !== 'true' && !c.closest('[aria-hidden="true"]')
    );
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
          await sleep(80);
        }
        ok++;
      }
    }
    return ok > 0;
  }

  async function fillDropdown(block, answer) {
    const want = norm(answer && typeof answer === 'object' ? (answer.text || '') : answer);
    const listbox = block.querySelector('div[role="listbox"]');
    if (!listbox) return false;
    humanClick(listbox);
    await sleep(550);
    const opts = [...document.querySelectorAll('div[role="option"]')].filter(
      (o) => !isElementHidden(o) && o.getAttribute('data-value') !== ''
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

  async function fillScale(block, answer) {
    const val = answer && typeof answer === 'object' ? String(answer.text || '') : String(answer);
    return await fillRadio(block, val, true);
  }

  function detectAttentionCheckAnswer(rowLabel, availableValues) {
    if (!rowLabel) return null;
    const m = rowLabel.match(/(?:vui\s+lòng|hãy|xin\s+hãy|bắt\s+buộc)?\s*(?:chọn|tích\s+vào|đánh\s+dấu)\s+(?:vào\s+)?(?:số|mức|đáp\s+án|ô|cột|mục)?\s*["'“”]?(\d+)["'“”]?/i);
    if (m && m[1]) {
      const trappedVal = m[1].trim();
      if (!availableValues || availableValues.length === 0 || availableValues.includes(trappedVal)) {
        return trappedVal;
      }
    }
    return null;
  }

  async function fillGrid(block, answer) {
    const rows = [...block.querySelectorAll('div[role="radiogroup"], div[role="group"]')].filter(
      (rg) => rg.getAttribute('aria-hidden') !== 'true' && !rg.closest('[aria-hidden="true"]')
    );
    if (rows.length === 0) {
      return await fillRadio(block, Array.isArray(answer) ? answer[0] : answer);
    }

    let okCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const rg = rows[i];
      const rowLabel = norm(rg.getAttribute('aria-label') || '');

      const rowRadios = [...rg.querySelectorAll('div[role="radio"]')].filter(
        (r) => r.getAttribute('aria-disabled') !== 'true'
      );
      const rowCheckboxes = [...rg.querySelectorAll('div[role="checkbox"]')].filter(
        (c) => c.getAttribute('aria-disabled') !== 'true'
      );
      const availableVals = rowRadios.map((r) => norm(r.getAttribute('data-value') || ''));

      let rowTargetVal = null;

      if (Array.isArray(answer) && answer.length > 0) {
        rowTargetVal = answer[i % answer.length];
      } else if (answer && typeof answer === 'object' && !answer.other) {
        if (Array.isArray(answer.__rowAnswers) && answer.__rowAnswers.length > 0) {
          rowTargetVal = answer.__rowAnswers[i % answer.__rowAnswers.length];
        } else {
          for (const [k, v] of Object.entries(answer)) {
            const wantRow = norm(k).toLowerCase();
            if (rowLabel.toLowerCase() === wantRow || (wantRow && rowLabel.toLowerCase().includes(wantRow))) {
              rowTargetVal = v;
              break;
            }
          }
        }
      } else {
        rowTargetVal = answer;
      }

      const trapVal = detectAttentionCheckAnswer(rowLabel, availableVals);
      if (trapVal !== null) {
        rowTargetVal = trapVal;
      }

      if (rowTargetVal === null || rowTargetVal === undefined || rowTargetVal === '') {
        if (availableVals.length > 0) {
          rowTargetVal = availableVals[Math.floor(Math.random() * availableVals.length)];
        }
      }

      let rowFilled = false;
      if (rowCheckboxes.length > 0) {
        rowFilled = await fillCheckbox(rg, rowTargetVal);
      } else if (rowRadios.length > 0) {
        const isNumericVal = /^\d+$/.test(norm(String(rowTargetVal)));
        const targetRadio = matchBestElement(
          rowRadios,
          (r) => r.getAttribute('data-value') || r.getAttribute('aria-label') || r.textContent,
          rowTargetVal,
          isNumericVal
        );
        if (targetRadio) {
          if (targetRadio.getAttribute('aria-checked') !== 'true') {
            humanClick(targetRadio);
          }
          rowFilled = true;
        }
      }

      if (rowFilled) {
        okCount++;
        await sleep(50 + Math.random() * 50);
      }
    }

    return okCount === rows.length;
  }

  function fillTextInput(field, value) {
    try {
      field.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch { /* bỏ qua */ }
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

  function fillText(block, value) {
    const field = block.querySelector('textarea, input[type="text"], input[type="email"], input[type="number"], input[type="tel"], input[type="url"], input:not([type]):not([type="hidden"])');
    if (!field) return false;
    return fillTextInput(field, pickLineIfMultiline(value));
  }

  function fillDate(block, value) {
    const raw = pickLineIfMultiline(value).trim();
    if (!raw) return false;

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

    const inputs = [...block.querySelectorAll('input[type="text"], input[type="number"], input:not([type]):not([type="hidden"])')];
    if (inputs.length >= 3) {
      for (const inp of inputs) {
        const lbl = stripVi(inp.getAttribute('aria-label') || '').toLowerCase();
        if (lbl.includes('ngay') || lbl.includes('day')) fillTextInput(inp, dd);
        else if (lbl.includes('thang') || lbl.includes('month')) fillTextInput(inp, mm);
        else if (lbl.includes('nam') || lbl.includes('year')) fillTextInput(inp, yyyy);
      }
      return true;
    }
    if (inputs.length === 1) {
      return fillTextInput(inputs[0], `${dd}/${mm}/${yyyy}`);
    }
    return false;
  }

  function fillTime(block, value) {
    const raw = pickLineIfMultiline(value).trim();
    if (!raw) return false;
    const match = raw.match(/(\d{1,2})[:h](\d{1,2})/);
    const hh = match ? match[1].padStart(2, '0') : '08';
    const min = match ? match[2].padStart(2, '0') : '00';

    const timeInput = block.querySelector('input[type="time"]');
    if (timeInput) {
      return fillTextInput(timeInput, `${hh}:${min}`);
    }

    const inputs = [...block.querySelectorAll('input[type="text"], input[type="number"], input:not([type]):not([type="hidden"])')];
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

  async function fillOne(item) {
    const block = findQuestionBlock(item.title, item.questionId);
    if (!block) return { ok: false, reason: 'Không tìm thấy khối DOM cho: ' + item.title };

    const activeRadioGroups = [...block.querySelectorAll('div[role="radiogroup"], div[role="group"]')].filter(
      (rg) => rg.getAttribute('aria-hidden') !== 'true' && !rg.closest('[aria-hidden="true"]')
    );
    if (item.type === 'GRID' || activeRadioGroups.length > 1) {
      return { ok: await fillGrid(block, item.answer) };
    }

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
      default:
        if (fillText(block, item.answer)) return { ok: true };
        return { ok: await fillRadio(block, item.answer) };
    }
  }

  function stripVi(s) {
    return (s || '').normalize('NFD')
      .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D');
  }

  const SUBMIT_KEYS = ['gui', 'goi', 'submit', 'send', 'hoan tat', 'hoan thanh', 'xac nhan', 'done'];
  const NEXT_KEYS = ['tiep', 'next', 'continue', 'ke tiep'];
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

  // Nhận diện chính xác nút "Tiếp" (Next) và "Gửi" (Submit) của Google Forms
  function findNavButton() {
    // 1. Ưu tiên nhận diện theo thuộc tính jsname chuẩn của Google Forms:
    // - jsname="OCpkoe": Nút Tiếp (Next)
    // - jsname="M2UYVd": Nút Gửi (Submit)
    const jsNext = document.querySelector('div[role="button"][jsname="OCpkoe"], span[role="button"][jsname="OCpkoe"]');
    if (jsNext && !isElementHidden(jsNext)) {
      return { el: jsNext, kind: 'next' };
    }
    const jsSubmit = document.querySelector('div[role="button"][jsname="M2UYVd"], span[role="button"][jsname="M2UYVd"]');
    if (jsSubmit && !isElementHidden(jsSubmit)) {
      return { el: jsSubmit, kind: 'submit' };
    }

    // 2. Quét tất cả các nút điều hướng hiển thị trên trang
    const btns = [...document.querySelectorAll(
      'div[role="button"], span[role="button"], button, input[type="submit"], input[type="button"]'
    )];
    const visibleBtns = btns.filter((b) => !isElementHidden(b));
    const items = visibleBtns.map((b) => ({ el: b, t: navText(b) })).filter((x) => x.t !== '');
    const usable = items.filter((x) => !isClearBtn(x.t) && !isBackBtn(x.t));

    const n = usable.find((x) => hitKeys(x.t, NEXT_KEYS));
    if (n) return { el: n.el, kind: 'next' };

    const s = usable.find((x) => hitKeys(x.t, SUBMIT_KEYS));
    if (s) return { el: s.el, kind: 'submit' };

    return null;
  }

  function seenButtons() {
    try {
      const list = [...document.querySelectorAll('div[role="button"], span[role="button"], button')]
        .filter((b) => !isElementHidden(b))
        .map((b) => norm(b.textContent || (b.getAttribute && b.getAttribute('aria-label')) || b.value))
        .filter(Boolean).slice(0, 12);
      return list.length ? list.join(' | ') : '(không thấy nút nào trên trang)';
    } catch { return '(không đọc được DOM)'; }
  }

  /**
   * FIX QUAN TRỌNG: Kiểm tra trang cảm ơn (Thank You page) sau khi Submit.
   * TUYỆT ĐỐI KHÔNG trả về true nếu trên trang vẫn còn câu hỏi hoặc nút Tiếp/Gửi!
   * (Tránh nhầm với chữ "Cảm ơn" trong mô tả form hoặc câu "Tên và ảnh sẽ được ghi lại...")
   */
  function isThankYouPage() {
    try {
      // 1. Nếu vẫn còn bất kỳ khối câu hỏi hiển thị nào hoặc vẫn còn nút Next/Submit -> CHẮC CHẮN CHƯA PHẢI trang cảm ơn!
      const visibleQuestions = [...document.querySelectorAll('div[role="listitem"]')]
        .filter((b) => !isElementHidden(b));
      if (visibleQuestions.length > 0) return false;

      const nav = findNavButton();
      if (nav) return false;

      // 2. Kiểm tra các dấu hiệu DOM đặc trưng của trang xác nhận đã gửi (Confirmation Page) của Google Forms
      const hasConfirmClass = !!document.querySelector('.vHW8K, .freebirdFormviewerViewResponseConfirmationMessage, .freebirdFormviewerViewResponseLinksContainer');
      const hasAnotherResponseLink = !!document.querySelector('a[href*="viewform"]');
      if (hasConfirmClass || hasAnotherResponseLink) {
        return true;
      }

      // 3. Kiểm tra cụm từ xác nhận cụ thể (chỉ khi KHÔNG còn câu hỏi và KHÔNG còn nút Tiếp/Gửi)
      const bt = norm(document.body && document.body.innerText);
      if (/phản hồi của bạn đã được ghi lại|câu trả lời của bạn đã được ghi lại|your response has been recorded|gửi phản hồi khác|submit another response/i.test(bt)) {
        return true;
      }
    } catch { /* bỏ qua */ }
    return false;
  }

  // Click nút Điều hướng (Tiếp / Gửi) đảm bảo ăn 100% trên Google Forms
  async function clickNavButton(navEl) {
    if (!navEl) return;
    humanClick(navEl);
    await sleep(80);
    // Nếu Google Forms gắn listener sâu hơn hoặc cần click trực tiếp vào span bên trong
    const innerSpan = navEl.querySelector('span');
    if (innerSpan) {
      try { innerSpan.click(); } catch { /* bỏ qua */ }
    }
  }

  async function runFill(payloadItems, runId) {
    const heartbeat = () => {
      try { chrome.runtime.sendMessage({ type: 'FORM_HEARTBEAT', runId }); } catch { /* bỏ qua */ }
    };

    // Chờ DOM của Google Forms render xong câu hỏi hoặc trang cảm ơn (tối đa ~4 giây)
    for (let waitDom = 0; waitDom < 10; waitDom++) {
      const hasQuestions = document.querySelectorAll('div[role="listitem"]').length > 0;
      const nav = findNavButton();
      if (hasQuestions || nav || isThankYouPage()) break;
      await sleep(400);
    }

    if (isThankYouPage()) {
      return { status: 'DONE' };
    }

    const maxPages = 25;
    let page = 0;
    const errors = [];

    while (page < maxPages) {
      await sleep(500);
      heartbeat();

      if (isThankYouPage()) {
        return { status: 'DONE' };
      }

      const failedVisibleOnThisPage = [];

      // Quét toàn bộ payloadItems cho những câu hỏi ĐANG HIỂN THỊ trên trang hiện tại
      for (let i = 0; i < payloadItems.length; i++) {
        const item = payloadItems[i];
        const block = findQuestionBlock(item.title, item.questionId);
        if (!block) continue;

        heartbeat();
        const res = await fillOne(item);
        heartbeat();
        await sleep(150 + Math.random() * 150);

        if (!res.ok) {
          const errMsg = item.title + ': ' + (res.reason || 'không điền được');
          errors.push(errMsg);
          failedVisibleOnThisPage.push(item.title);
        }
      }

      await sleep(300);
      const nav = findNavButton();
      if (!nav) {
        if (isThankYouPage()) return { status: 'DONE' };
        break;
      }

      if (nav.kind === 'submit') {
        if (failedVisibleOnThisPage.length > 0) {
          return {
            status: 'ERROR',
            error: 'Không điền được câu hỏi trên trang cuối: ' + failedVisibleOnThisPage.join('; ')
          };
        }

        // Báo cho background biết sắp bấm Submit
        try { chrome.runtime.sendMessage({ type: 'FORM_SUBMITTED', runId }); } catch { /* bỏ qua */ }
        await sleep(150);
        await clickNavButton(nav.el);

        // Chờ trang chuyển sang trang Cảm ơn (nếu trang reload thì script mới sẽ kiểm tra isThankYouPage())
        for (let k = 0; k < 15; k++) {
          await sleep(800);
          if (isThankYouPage()) {
            return { status: 'DONE' };
          }
          // Nếu sau 3s nút Submit vẫn còn nguyên trên trang và không có lỗi alert -> thử click bồi thêm 1 lần
          if (k === 3) {
            const alertNow = [...document.querySelectorAll('[role="alert"]')].map((e) => norm(e.textContent)).filter(Boolean);
            const stillSubmit = findNavButton();
            if (alertNow.length === 0 && stillSubmit && stillSubmit.kind === 'submit') {
              await clickNavButton(stillSubmit.el);
            }
          }
        }

        let pageErr = '';
        try {
          pageErr = [...document.querySelectorAll('[role="alert"]')]
            .map((e) => norm(e.textContent)).filter(Boolean).slice(0, 3).join(' | ');
        } catch { /* bỏ qua */ }
        return {
          status: 'ERROR',
          error: 'Đã bấm Submit nhưng không qua được trang cảm ơn. ' +
                 (pageErr ? 'Trang báo lỗi: ' + pageErr + '. ' : '') +
                 'Các nút đang thấy: ' + seenButtons()
        };
      } else {
        // Bấm nút "Tiếp / Next" để qua trang tiếp theo
        heartbeat();
        try { chrome.runtime.sendMessage({ type: 'FORM_NEXT_PAGE', runId }); } catch { /* bỏ qua */ }

        const prevSignature = [...document.querySelectorAll('div[role="listitem"] [role="heading"]')]
          .filter((h) => !isElementHidden(h))
          .map((h) => norm(h.textContent))
          .join('||');

        await clickNavButton(nav.el);
        page++;

        // Chờ trang mới tải (hỗ trợ cả chuyển trang không reload lẫn full page reload)
        let pageChanged = false;
        for (let w = 0; w < 12; w++) {
          await sleep(450);
          if (isThankYouPage()) return { status: 'DONE' };

          const curSignature = [...document.querySelectorAll('div[role="listitem"] [role="heading"]')]
            .filter((h) => !isElementHidden(h))
            .map((h) => norm(h.textContent))
            .join('||');

          const curNav = findNavButton();
          if (curSignature !== prevSignature || (curNav && curNav.kind === 'submit' && prevSignature === '')) {
            pageChanged = true;
            break;
          }

          // Nếu sau ~1.8s vẫn chưa chuyển trang và chưa báo lỗi alert, thử click lại nút Tiếp lần nữa
          if (w === 4) {
            const retryNav = findNavButton();
            if (retryNav && retryNav.kind === 'next') {
              await clickNavButton(retryNav.el);
            }
          }

          const alertTexts = [...document.querySelectorAll('[role="alert"]')]
            .map((e) => norm(e.textContent)).filter(Boolean);
          if (w >= 6 && alertTexts.length > 0) {
            return {
              status: 'ERROR',
              error: 'Không thể qua trang tiếp theo do báo lỗi trên form: ' + alertTexts.join(' | ')
            };
          }
        }

        if (!pageChanged) {
          const alertTexts = [...document.querySelectorAll('[role="alert"]')]
            .map((e) => norm(e.textContent)).filter(Boolean);
          return {
            status: 'ERROR',
            error: 'Đã bấm nút Tiếp nhưng trang không chuyển sang trang mới. ' +
                   (alertTexts.length ? 'Lỗi trên trang: ' + alertTexts.join(' | ') : 'Các nút đang thấy: ' + seenButtons())
          };
        }
      }
    }

    return {
      status: 'ERROR',
      error: 'Không tìm thấy nút điều hướng hoặc bị kẹt trang. Các nút đang thấy: ' + seenButtons() +
             (errors.length ? '. Chi tiết: ' + errors.join('; ') : '')
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
      if (activeFillingRunId === msg.runId) {
        sendResponse({ ack: true, alreadyRunning: true });
        return true;
      }
      activeFillingRunId = msg.runId;

      (async () => {
        try {
          const res = await runFill(msg.payload || [], msg.runId);
          if (res.status === 'DONE') {
            chrome.runtime.sendMessage({ type: 'FORM_DONE', runId: msg.runId, error: null });
          } else if (res.status === 'ERROR') {
            chrome.runtime.sendMessage({ type: 'FORM_ERROR', runId: msg.runId, error: res.error || 'Lỗi không xác định' });
          }
        } catch (e) {
          const errStr = String((e && e.message) || e);
          if (!/context invalidated|unload/i.test(errStr)) {
            try {
              chrome.runtime.sendMessage({ type: 'FORM_ERROR', runId: msg.runId, error: errStr });
            } catch { /* bỏ qua */ }
          }
        } finally {
          activeFillingRunId = null;
        }
      })();
      sendResponse({ ack: true });
      return true;
    }
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      TYPE_MAP, OTHER_RE, OTHER_VALUE,
      parseLoadData, parseStructureFromData,
      normalizeOptionList, extractOptions, extractScale, mergeWithDom,
      stripVi, navText, findNavButton, seenButtons, isThankYouPage
    };
  }
})();