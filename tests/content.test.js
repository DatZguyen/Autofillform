/* ============================================================================
 * tests/content.test.js — Unit test cho scripts/content.js
 * Chạy: node tests/content.test.js
 * ========================================================================== */
'use strict';

global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    sendMessage() {},
  },
};
global.document = { querySelectorAll: () => [], title: 'Test Form' };
global.window = { innerWidth: 0 };

const assert = require('assert');
const m = require('../scripts/content.js');

/* ------------------------------------------------------------------
 * A1 — Bộ cắt JSON theo cặp ngoặc vuông []
 * ------------------------------------------------------------------ */
{
  const raw = 'var FB_PUBLIC_LOAD_DATA_ = [1,"a]",{x:"[y]"}]; var other=1;';
  const cut = m.extractJsonArray(raw, raw.indexOf('['));
  assert.strictEqual(cut, '[1,"a]",{x:"[y]"}]');

  const raw2 = 'FB_PUBLIC_LOAD_DATA_=[["A"],["B"]];';
  assert.strictEqual(m.extractJsonArray(raw2, raw2.indexOf('[')), '[["A"],["B"]]');

  const raw3 = 'FB_PUBLIC_LOAD_DATA_=["a\\"b","c\\\\"];';
  assert.strictEqual(m.extractJsonArray(raw3, raw3.indexOf('[')), '["a\\"b","c\\\\"]');

  console.log('A1  extractJsonArray (bracket-depth counter) OK');
}

/* ------------------------------------------------------------------
 * A2 — TYPE_MAP
 * ------------------------------------------------------------------ */
{
  assert.strictEqual(m.TYPE_MAP[8], 'PAGE_BREAK');
  assert.strictEqual(m.TYPE_MAP[11], 'IMAGE');
  assert.strictEqual(m.TYPE_MAP[7], 'GRID');
  console.log('A2  TYPE_MAP OK');
}

/* ------------------------------------------------------------------
 * GRID — Tách dòng con: rowEntry[0] = id dòng, rowEntry[3][0] = nhãn
 * ------------------------------------------------------------------ */
{
  // extractGridRowLabel: ưu tiên rowEntry[3][0]
  assert.strictEqual(m.extractGridRowLabel(['rowid1', null, null, ['Tên dòng A']]), 'Tên dòng A');
  // fallback rowEntry[1][0][0]
  assert.strictEqual(m.extractGridRowLabel(['rowid1', [['Cột A']]]), 'Cột A');
  // fallback rowEntry[1] là string
  assert.strictEqual(m.extractGridRowLabel(['rowid1', 'Tên dòng B']), 'Tên dòng B');
  // không có nhãn -> null
  assert.strictEqual(m.extractGridRowLabel(['rowid1', null, null, null]), null);

  // extractGridRows: đủ id + label, bỏ dòng trùng, bỏ dòng rỗng
  const entry = {
    4: [
      ['row1', null, null, ['Dòng 1']],
      ['row2', null, null, ['Dòng 2']],
      ['row3', null, null, ['Dòng 1']],   // trùng -> bỏ
      ['row4', null, null, ['']],         // rỗng -> bỏ
    ],
  };
  const g = m.extractGridRows(entry);
  assert.deepStrictEqual(g.labels, ['Dòng 1', 'Dòng 2'], 'phai lay dung 2 dong');
  assert.deepStrictEqual(g.ids, ['row1', 'row2'], 'phai lay dung id tung dong');
  assert.strictEqual(g.rows.length, 2);
  assert.strictEqual(g.rows[0].index, 0);
  assert.strictEqual(g.rows[0].id, 'row1');
  assert.strictEqual(g.rows[0].label, 'Dòng 1');

  console.log('OK  GRID extractGridRows / extractGridRowLabel');
}

/* ------------------------------------------------------------------
 * GRID — Parse form có GRID: options = cột, gridRows = dòng
 * ------------------------------------------------------------------ */
function buildFbData(entries) {
  return [null, [null, entries], null, null, null, null, null, null, ['Form Title']];
}
{
  // Cấu trúc GRID: entry[4] = [ [rowId, ..., [rowLabel]], ... ]
  // và các cột nằm trong entry[4][0][1]
  const gridEntry = [
    'qGrid',
    'Bảng lưới',
    null,
    7,
    [
      ['r1', [['1'], ['2'], ['3']], null, ['Dòng A']],
      ['r2', [['1'], ['2'], ['3']], null, ['Dòng B']],
    ],
  ];
  const fb = buildFbData([gridEntry]);
  const r = m.parseStructureFromData(fb);
  assert.strictEqual(r.ok, true, r.error);
  const q = r.questions.find((x) => x.id === 'qGrid');
  assert.ok(q, 'phai tim thay cau GRID');
  assert.strictEqual(q.type, 'GRID');
  assert.deepStrictEqual(q.gridRows, ['Dòng A', 'Dòng B'], 'gridRows phai la danh sach ten dong');
  assert.deepStrictEqual(q.gridRowIds, ['r1', 'r2'], 'gridRowIds phai khop thu tu dong');
  assert.strictEqual(q.rowCount, 2);
  assert.ok(Array.isArray(q.gridRowsMeta) && q.gridRowsMeta.length === 2);
  assert.ok(q.gridRowsMeta[1].label === 'Dòng B');
  assert.ok(q.options.length > 0, 'q.options phai la danh sach COT');
  console.log('OK  GRID parseStructureFromData (options=cot, gridRows=dong)');
}

/* ------------------------------------------------------------------
 * A2 — Parse form nhiều trang + giữ đáp án "Mục khác" ở trang ẩn
 * ------------------------------------------------------------------ */
{
  const fb = buildFbData([
    ['q1', 'Cau 1', null, 2, [[null, null, 1], [null, null, null, null, null, null, null, [['A'], ['B']]]]],
    ['q2', 'Cau 2', null, 8, []],
    ['q3', 'Cau 3', null, 2, [[null, null, 1], [null, null, null, null, null, null, null, [['X'], ['', null, null, null, 1]]]]],
  ]);
  const r = m.parseStructureFromData(fb);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.totalPages, 2);
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.questions[0].page, 1);
  assert.strictEqual(r.questions[1].page, 2);
  assert.ok(r.questions[1].options.some((o) => o.other === true),
    'dap an "Mục khác" o trang an phai duoc giu lai');
  console.log('A2  parse multi-page + giu "Mục khác" o trang an OK');
}

/* ------------------------------------------------------------------
 * B1 — Làm sạch dấu "*"
 * ------------------------------------------------------------------ */
{
  const fake = {
    cloneNode() {
      return { textContent: 'Họ và tên *', querySelectorAll: () => [] };
    },
  };
  assert.strictEqual(m.cleanHeadingText(fake), 'Họ và tên');
  console.log('B1  cleanHeadingText OK');
}

/* ------------------------------------------------------------------
 * B2 — matchBestElement: 2 vòng + ranh giới từ
 * ------------------------------------------------------------------ */
{
  const mk = (label, dv) => ({
    getAttribute: (a) => (a === 'aria-label' ? label : (a === 'data-value' ? (dv || '') : '')),
  });
  const els = [mk('Việt Nam', 'Viet Nam'), mk('Nam', 'Nam')];

  assert.strictEqual(m.matchBestElement(els, (e) => e.getAttribute('aria-label'), 'Nam', false), els[1],
    'phai chon dung "Nam"');
  assert.strictEqual(m.matchBestElement([els[0]], (e) => e.getAttribute('aria-label'), 'Nam', false), els[0]);
  assert.strictEqual(m.matchBestElement([mk('Tham')], (e) => e.getAttribute('aria-label'), 'Nam', false), null,
    '"Tham" khong duoc khop voi "Nam"');

  const scaleEls = [mk('1'), mk('10')];
  assert.strictEqual(m.matchBestElement(scaleEls, (e) => e.getAttribute('aria-label'), '1', true), scaleEls[0]);
  assert.strictEqual(m.matchBestElement(scaleEls, (e) => e.getAttribute('aria-label'), '10', true), scaleEls[1]);

  assert.ok(m.matchBestElement([mk('Hien thi', 'Gia tri')], (e) => e.getAttribute('aria-label'), 'Gia tri', true));
  console.log('B2  matchBestElement OK');
}

/* ------------------------------------------------------------------
 * B2 — stripVi
 * ------------------------------------------------------------------ */
{
  assert.strictEqual(m.stripVi('Ngày'), 'Ngay');
  assert.strictEqual(m.stripVi('Đường'), 'Duong');
  console.log('B2  stripVi OK');
}

/* ------------------------------------------------------------------
 * Kiểm tra hợp đồng export
 * ------------------------------------------------------------------ */
{
  const required = [
    'TYPE_MAP', 'OTHER_RE', 'OTHER_VALUE',
    'extractJsonArray', 'findLoadDataRaw', 'parseLoadData', 'parseStructureFromData',
    'normalizeOptionList', 'extractOptions', 'extractScale', 'mergeWithDom',
    'extractGridRowLabel', 'extractGridRows', 'extractGridRowsFromDOM', 'detectGridKind',
    'cleanHeadingText', 'matchBestElement',
    'stripVi', 'navText', 'findNavButton', 'seenButtons',
  ];
  for (const k of required) {
    assert.ok(m[k] !== undefined, `thieu export: ${k}`);
  }
  console.log('OK  tat ca ham export cho unit test deu ton tai');
}

console.log('\n=== ALL CONTENT TESTS PASSED ===');
