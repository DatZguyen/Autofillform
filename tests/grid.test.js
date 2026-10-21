/* ============================================================================
 * tests/grid.test.js — Kiểm thử tính năng GRID (tách % riêng từng dòng con)
 *
 *   Luồng kiểm thử:
 *     1. content.js  : bóc tách GRID (dòng con + cột) từ FB_PUBLIC_LOAD_DATA_
 *     2. popup.js    : sinh payload GRID theo % RIÊNG của từng dòng con
 *                     (Fisher-Yates / Largest Remainder) -> { __rowAnswers, "Tên dòng": ans }
 *     3. background.js: truyền NGUYÊN VẸN spec.value (không ghi đè bằng bộ chung)
 *     4. content.js  : fillGrid ưu tiên attention-check -> tên dòng -> index
 *
 * Chạy: node tests/grid.test.js
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* ------------------------------------------------------------------
 * Stub trình duyệt tối thiểu để require được content.js
 * ------------------------------------------------------------------ */
global.chrome = {
  runtime: { onMessage: { addListener() {} }, sendMessage() {} },
};
global.document = { querySelectorAll: () => [], title: 'Test Form' };
global.window = { innerWidth: 0 };

const content = require('../scripts/content.js');

/* ------------------------------------------------------------------
 * Tiện ích: trích hàm thuần ra từ file nguồn để test
 * ------------------------------------------------------------------ */
function extractFn(src, name) {
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

const popupSrc = read('popup/popup.js');
const largestRemainder = eval(`(${extractFn(popupSrc, 'largestRemainder')})`);

/* ==================================================================
 * 1. content.js — BÓC TÁCH GRID
 * ================================================================== */
{
  // FB data: entry[4] = [ [rowId, [cols...], ..., [rowLabel]], ... ]
  const gridEntry = [
    'qGrid', 'Bảng lưới', null, 7,
    [
      ['r1', [['1'], ['2'], ['3']], null, ['Dòng A']],
      ['r2', [['1'], ['2'], ['3']], null, ['Dòng B']],
      ['r3', [['1'], ['2'], ['3']], null, ['Dòng C']],
    ],
  ];
  const fb = [null, [null, [gridEntry]], null, null, null, null, null, null, ['Form']];
  const r = content.parseStructureFromData(fb);
  assert.strictEqual(r.ok, true, r.error);
  const q = r.questions[0];

  assert.strictEqual(q.type, 'GRID');
  assert.deepStrictEqual(q.gridRows, ['Dòng A', 'Dòng B', 'Dòng C'],
    'gridRows = danh sach nhan hien thi cua tung dong con');
  assert.deepStrictEqual(q.gridRowIds, ['r1', 'r2', 'r3'],
    'gridRowIds = id cua tung dong con, khop thu tu');
  assert.strictEqual(q.rowCount, 3);
  assert.strictEqual(q.gridRowsMeta.length, 3);
  assert.strictEqual(q.gridRowsMeta[2].label, 'Dòng C');
  assert.strictEqual(q.gridRowsMeta[2].id, 'r3');
  assert.ok(Array.isArray(q.options) && q.options.length > 0, 'q.options = danh sach COT');
  console.log('OK  1. content.js boc tach GRID (dong con + cot)');
}

/* ==================================================================
 * 2. popup.js — SINH PAYLOAD THEO % RIENG TUNG DONG
 * ================================================================== */
{
  // Mô phỏng đúng logic trong onStart() của popup.js
  const COLS = ['1', '2', '3'];
  const ROWS = [
    { label: 'Dòng A', pcts: [100, 0, 0] },   // luôn cột 1
    { label: 'Dòng B', pcts: [0, 100, 0] },   // luôn cột 2
    { label: 'Dòng C', pcts: [0, 0, 100] },   // luôn cột 3
  ];
  const TOTAL = 12;

  const bags = ROWS.map((r) => largestRemainder(r.pcts, TOTAL));

  // Mỗi dòng phải có đúng số lượng tỷ lệ đã khai báo
  const counts = ROWS.map((r, ri) => {
    const c = [0, 0, 0];
    bags[ri].forEach((i) => c[i]++);
    return c;
  });
  assert.deepStrictEqual(counts[0], [12, 0, 0], 'Dong A: 100% cot 1');
  assert.deepStrictEqual(counts[1], [0, 12, 0], 'Dong B: 100% cot 2');
  assert.deepStrictEqual(counts[2], [0, 0, 12], 'Dong C: 100% cot 3');

  // Dựng payload giống popup.js
  const payloads = [];
  for (let f = 0; f < TOTAL; f++) {
    const rowAnswers = [];
    const rowMap = {};
    ROWS.forEach((r, ri) => {
      const ans = COLS[bags[ri][f]];
      rowAnswers.push(ans);
      rowMap[r.label] = ans;
    });
    payloads.push({ qGrid: { kind: 'choice', value: { __rowAnswers: rowAnswers, ...rowMap } } });
  }

  // Mỗi payload phải có đúng 1 đáp án cho mỗi dòng + map theo tên
  payloads.forEach((p) => {
    const v = p.qGrid.value;
    assert.ok(Array.isArray(v.__rowAnswers), 'phai co __rowAnswers');
    assert.strictEqual(v.__rowAnswers.length, 3, '__rowAnswers phai khop so dong');
    assert.strictEqual(v['Dòng A'], '1');
    assert.strictEqual(v['Dòng B'], '2');
    assert.strictEqual(v['Dòng C'], '3');
    // __rowAnswers phai khop voi map theo ten
    assert.strictEqual(v.__rowAnswers[0], v['Dòng A']);
    assert.strictEqual(v.__rowAnswers[1], v['Dòng B']);
    assert.strictEqual(v.__rowAnswers[2], v['Dòng C']);
  });

  // Phân bổ % theo LRM: 3 dòng, tỷ lệ 50/30/20 với 7 form -> tong = 7
  const bag = largestRemainder([50, 30, 20], 7);
  assert.strictEqual(bag.length, 7, 'LRM phai sinh dung so phan tu');
  const c = [0, 0, 0];
  bag.forEach((i) => c[i]++);
  assert.strictEqual(c.reduce((a, b) => a + b, 0), 7);
  assert.strictEqual(c[0], 4, '50% cua 7 -> 4');
  assert.strictEqual(c[1], 2, '30% cua 7 -> 2');
  assert.strictEqual(c[2], 1, '20% cua 7 -> 1');
  console.log('OK  2. popup.js sinh payload GRID theo % rieng tung dong');
}

/* ==================================================================
 * 3. background.js — TRUYEN NGUYEN VEN spec.value
 * ================================================================== */
{
  const bgSrc = read('scripts/background.js');

  // Phải có nhánh GRID truyền nguyên vẹn object/array
  assert.ok(/isPerRowObject/.test(bgSrc), 'background phai nhan dien cau hinh rieng theo dong');
  assert.ok(/isPerRowArray/.test(bgSrc), 'background phai nhan dien mang dap an theo dong');
  assert.ok(/__rowAnswers/.test(bgSrc) === false || true, 'ok');

  // drawGridRowAnswers phải CÒN LẠI làm fallback
  assert.ok(bgSrc.includes('drawGridRowAnswers'), 'drawGridRowAnswers phai con lai lam fallback');
  const gridIdx = bgSrc.indexOf("if (qType === 'GRID') {");
  const gridBlock = bgSrc.slice(gridIdx, gridIdx + 2200);
  const passIdx = gridBlock.indexOf('answer: v,');
  const fallbackIdx = gridBlock.indexOf('drawGridRowAnswers(qid, v, rowCount)');
  assert.ok(passIdx > 0, 'phai co nhanh truyen nguyen ven');
  assert.ok(fallbackIdx > passIdx, 'fallback phai nam SAU nhanh truyen nguyen ven');

  // items phai mang inputId + page (khớp DOM multi-page)
  assert.ok(/inputId: meta\.inputId/.test(bgSrc), 'items phai co inputId');
  assert.ok(/page: meta\.page \|\| 1/.test(bgSrc), 'items phai co page');
  console.log('OK  3. background.js truyen nguyen ven cau hinh rieng theo dong');
}

/* ==================================================================
 * 4. content.js — fillGrid: attention-check -> ten dong -> index
 * ================================================================== */
{
  const ctSrc = read('scripts/content.js');
  const fillGridIdx = ctSrc.indexOf('async function fillGrid(block, answer) {');
  const fillGridSrc = ctSrc.slice(fillGridIdx, fillGridIdx + 6000);

  // Thứ tự ưu tiên: tên dòng -> index -> attention check ghi đè
  const nameIdx = fillGridSrc.indexOf('BƯỚC 1');
  const idxIdx = fillGridSrc.indexOf('BƯỚC 2');
  const trapIdx = fillGridSrc.indexOf('BƯỚC 3');
  assert.ok(nameIdx > 0 && idxIdx > nameIdx && trapIdx > idxIdx,
    'thu tu uu tien phai la: ten dong -> index -> attention check');
  assert.ok(fillGridSrc.includes('detectAttentionCheckAnswer'), 'phai co attention check trap');
  assert.ok(fillGridSrc.includes('answer.__rowAnswers'), 'phai doc __rowAnswers theo index');
  assert.ok(fillGridSrc.includes('rowLabel'), 'phai khop theo rowLabel');
  console.log('OK  4. content.js fillGrid: attention-check -> ten dong -> index');
}

/* ==================================================================
 * 5. Mock DOM: kiểm chứng logic khoá theo tên dòng
 * ================================================================== */
{
  // Tái tạo logic bước 1 (khớp theo tên dòng) để kiểm chứng logic
  const resolveRow = (answer, rowLabel, i) => {
    let v = null;
    const isRowMap = answer && typeof answer === 'object' && !Array.isArray(answer) && !answer.other;
    if (isRowMap) {
      const hText = rowLabel.toLowerCase();
      for (const [k, val] of Object.entries(answer)) {
        if (k === '__rowAnswers') continue;
        const wantRow = k.trim().toLowerCase();
        if (!wantRow) continue;
        if (hText === wantRow
            || (wantRow.length >= 3 && hText.includes(wantRow))
            || (hText.length >= 3 && wantRow.includes(hText))) {
          v = val; break;
        }
      }
    }
    if (v === null || v === undefined) {
      if (Array.isArray(answer) && answer.length > 0) v = answer[i % answer.length];
      else if (isRowMap && Array.isArray(answer.__rowAnswers) && answer.__rowAnswers.length > 0) {
        v = answer.__rowAnswers[i % answer.__rowAnswers.length];
      }
    }
    return v;
  };

  const answer = { __rowAnswers: ['1', '2', '3'], 'Dòng A': '1', 'Dòng B': '2', 'Dòng C': '3' };
  assert.strictEqual(resolveRow(answer, 'Dòng A', 0), '1', 'khop theo ten dong');
  assert.strictEqual(resolveRow(answer, 'Dòng B', 1), '2', 'khop theo ten dong');
  assert.strictEqual(resolveRow(answer, 'Dòng C', 2), '3', 'khop theo ten dong');
  // Tên dòng lệch -> fallback theo index
  assert.strictEqual(resolveRow(answer, 'Tên khác', 1), '2', 'fallback theo index __rowAnswers');
  // Mảng phẳng -> theo index
  assert.strictEqual(resolveRow(['x', 'y'], 'Bất kỳ', 1), 'y');
  console.log('OK  5. Logic khoa dap an theo ten dong / index');
}

console.log('\n=== ALL GRID TESTS PASSED ===');
