/* ============================================================================
 * tests/grid-ui.test.js — Kiểm thử GIAO DIỆN GRID trong popup.js
 *   - renderGridBlock(): tách từng dòng con thành khối % độc lập
 *   - applyRowPctToAll(): nút "Áp dụng tỷ lệ dòng 1 cho tất cả các dòng"
 *   - collectConfig()/applyConfig(): Lưu / Tải cấu hình giữ được % từng dòng GRID
 *
 * Chạy: node tests/grid-ui.test.js
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------
 * Mini DOM (đủ dùng cho popup.js)
 * ------------------------------------------------------------------ */
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this._value = '';
    this._text = '';
    this._listeners = {};
    this.offsetParent = {};   // coi như đang hiển thị
    this.hidden = false;
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, f) => {
        const has = this.classList._s.has(c);
        if (f === undefined) { has ? this.classList._s.delete(c) : this.classList._s.add(c); }
        else { f ? this.classList._s.add(c) : this.classList._s.delete(c); }
        return has;
      },
      contains: (c) => this.classList._s.has(c),
    };
  }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.children.push(c)); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatch(t) { (this._listeners[t] || []).forEach((f) => f({ target: this })); }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
  set value(v) { this._value = v === null || v === undefined ? '' : String(v); }
  get value() { return this._value; }
  set innerHTML(v) { this.children = []; }
  set className(v) { this._cls = v; this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return this._cls || ''; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = [...String(sel).matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
    const tag = String(sel).match(/^([a-zA-Z][\w-]*)/);
    const out = [];
    const test = (e) => cls.every((c) => e.classList.contains(c))
      && (!tag || e.tagName === tag[1]);
    const walk = (e) => { for (const c of e.children) { if (test(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

const byId = {};
global.document = {
  createElement: (t) => new El(t),
  getElementById(id) { return byId[id] || (byId[id] = new El('div')); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
global.chrome = {
  runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [{}] },
};
global.setInterval = () => 0;

/* ------------------------------------------------------------------
 * Nạp các hàm cần test từ popup.js
 * ------------------------------------------------------------------ */
const src = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `khong tim thay ham ${name}`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
// Nạp vào globalThis để các hàm gọi lẫn nhau tìm thấy nhau
for (const fn of [
  'renderGridBlock', 'applyRowPctToAll', 'splitAllGridRows', 'remainderFooter',
  'updateRemain', 'sumPct', 'visiblePctInputs', 'choiceRow', 'setPresetMsg',
  'collectConfig', 'applyConfig', 'splitAnswers',
]) {
  globalThis[fn] = eval(`(${extractFn(fn)})`);
}
global.PRESET_VERSION = 2;
global.QUESTIONS = [];
global.TOTAL_PAGES = 1;

const Q = {
  id: 'qGrid',
  title: 'Bảng lưới',
  type: 'GRID',
  gridKind: 'RADIO',
  options: [{ t: '1', other: false }, { t: '2', other: false }, { t: '3', other: false }],
  gridRows: ['Dòng A', 'Dòng B', 'Dòng C'],
};
global.QUESTIONS = [Q];

const card = new El('div');
card.dataset.qid = 'qGrid';
renderGridBlock(card, Q);

/* ------------------------------------------------------------------
 * 1. Mỗi dòng con là 1 khối cấu hình % độc lập
 * ------------------------------------------------------------------ */
{
  const rows = card.querySelectorAll('.grid-row');
  assert.strictEqual(rows.length, 3, 'phai co 3 dong con');
  rows.forEach((r, i) => {
    assert.strictEqual(r.dataset.row, Q.gridRows[i], 'moi dong phai co ten');
    const inputs = r.querySelectorAll('.pct-input');
    assert.strictEqual(inputs.length, 3, 'moi dong co 3 o % (theo so cot)');
    inputs.forEach((inp) => assert.strictEqual(inp.dataset.row, Q.gridRows[i],
      'input phai gan ten dong de luu/tai cau hinh'));
    assert.ok(r.querySelector('.remain-lb'), 'moi dong co thanh "Con lai"');
    assert.ok(r.querySelector('.rand-btn'), 'moi dong co nut chia');
  });
  console.log('OK  1. renderGridBlock: tach tung dong con thanh khoi % rieng');
}

/* ------------------------------------------------------------------
 * 2. Nút "Áp dụng tỷ lệ dòng 1 cho tất cả các dòng trong bảng này"
 * ------------------------------------------------------------------ */
{
  const rows = card.querySelectorAll('.grid-row');
  const setRow = (r, vals) => r.querySelectorAll('.pct-input').forEach((inp, i) => { inp.value = vals[i]; });

  setRow(rows[0], ['100', '0', '0']);
  setRow(rows[1], ['', '', '']);
  setRow(rows[2], ['', '', '']);

  const applied = applyRowPctToAll(card);
  assert.strictEqual(applied, 2, 'phai ap dung cho 2 dong con lai');
  assert.deepStrictEqual(rows[1].querySelectorAll('.pct-input').map((i) => i.value), ['100', '0', '0']);
  assert.deepStrictEqual(rows[2].querySelectorAll('.pct-input').map((i) => i.value), ['100', '0', '0']);
  console.log('OK  2. Nut "Ap dung ty le dong 1 cho tat ca"');
}

/* ------------------------------------------------------------------
 * 3. Lưu / Tải cấu hình giữ được % RIÊNG của từng dòng GRID
 * ------------------------------------------------------------------ */
{
  const rows = card.querySelectorAll('.grid-row');
  global.document.querySelectorAll = (sel) => (sel === '.q-card' ? [card] : []);
  document.getElementById('inTotal').value = '25';

  const cfg = collectConfig();
  assert.ok(cfg.questions.qGrid, 'phai luu cau hoi GRID');
  assert.strictEqual(Object.keys(cfg.questions.qGrid.grid).length, 3, 'phai luu 3 dong');
  assert.deepStrictEqual(cfg.questions.qGrid.grid['Dòng B'], { 1: 100, 2: 0, 3: 0 });
  console.log('OK  3a. collectConfig luu % rieng tung dong GRID');

  // Sửa lại giá trị trên UI rồi khôi phục từ config
  rows.forEach((r) => r.querySelectorAll('.pct-input').forEach((inp) => { inp.value = ''; }));
  cfg.questions.qGrid.grid = {
    'Dòng A': { 1: 10, 2: 20, 3: 70 },
    'Dòng B': { 1: 70, 2: 20, 3: 10 },
    'Dòng C': { 1: 33, 2: 33, 3: 34 },
  };
  applyConfig(cfg);
  assert.deepStrictEqual(rows[0].querySelectorAll('.pct-input').map((i) => i.value), ['10', '20', '70']);
  assert.deepStrictEqual(rows[1].querySelectorAll('.pct-input').map((i) => i.value), ['70', '20', '10']);
  assert.deepStrictEqual(rows[2].querySelectorAll('.pct-input').map((i) => i.value), ['33', '33', '34']);
  console.log('OK  3b. applyConfig khoi phuc % rieng tung dong GRID');
}

console.log('\n=== ALL GRID UI TESTS PASSED ===');
