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
  // Script có nhiều lệnh JS sau FB_PUBLIC_LOAD_DATA_ -> lastIndexOf(';') sẽ cắt lố
  const raw = 'var FB_PUBLIC_LOAD_DATA_ = [1,"a]",{x:"[y]"}]; var other=1;';
  const cut = m.extractJsonArray(raw, raw.indexOf('['));
  assert.strictEqual(cut, '[1,"a]",{x:"[y]"}]');

  // Chuỗi chứa dấu ngoặc vuông bên trong vẫn không làm hỏng cắt chuỗi
  const raw2 = 'FB_PUBLIC_LOAD_DATA_=[["A"],["B"]];';
  assert.strictEqual(m.extractJsonArray(raw2, raw2.indexOf('[')), '[["A"],["B"]]');

  // Escape chuỗi: \" và \\
  const raw3 = 'FB_PUBLIC_LOAD_DATA_=["a\\"b","c\\\\"];';
  assert.strictEqual(m.extractJsonArray(raw3, raw3.indexOf('[')), '["a\\"b","c\\\\"]');

  console.log('A1  extractJsonArray (bracket-depth counter) OK');
}

/* ------------------------------------------------------------------
 * A2 — TYPE_MAP: 8 = PAGE_BREAK, 11 = IMAGE
 * ------------------------------------------------------------------ */
{
  assert.strictEqual(m.TYPE_MAP[8], 'PAGE_BREAK');
  assert.strictEqual(m.TYPE_MAP[11], 'IMAGE');
  assert.strictEqual(m.TYPE_MAP[6], 'SECTION');
  assert.strictEqual(m.TYPE_MAP[2], 'RADIO');
  assert.strictEqual(m.TYPE_MAP[4], 'CHECKBOX');
  console.log('A2  TYPE_MAP OK');
}

/* ------------------------------------------------------------------
 * A2 — Parse form nhiều trang: đánh số trang + giữ đáp án "Mục khác"
 *      ở các trang chưa render (đáp án lấy từ FB data, không phụ thuộc DOM)
 * ------------------------------------------------------------------ */
function buildFbData(entries) {
  return [null, [null, entries], null, null, null, null, null, null, ['Form Title']];
}

{
  const fb = buildFbData([
    ['q1', 'Cau 1', null, 2, [[null, null, 1], [null, null, null, null, null, null, null, [['A'], ['B']]]]],
    ['q2', 'Cau 2', null, 8, []],
    ['q3', 'Cau 3', null, 2, [[null, null, 1], [null, null, null, null, null, null, null, [['X'], ['', null, null, null, 1]]]]],
  ]);
  const r = m.parseStructureFromData(fb);
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.totalPages, 2, 'phai nhanh ra 2 trang');
  assert.strictEqual(r.questions.length, 2, 'cau o trang 2 van duoc lay');
  assert.strictEqual(r.questions[0].page, 1);
  assert.strictEqual(r.questions[1].page, 2);
  assert.ok(r.questions[1].options.some((o) => o.other === true),
    'dap an "Mục khác" o trang an (chua render) phai duoc giu lai');
  assert.ok(r.questions[1].options.some((o) => o.t === 'X'));
  console.log('A2  parse multi-page + giu "Mục khác" o trang an OK');
}

/* ------------------------------------------------------------------
 * A2 — normOptionTuple: cờ isOtherFlag o[4] === 1 xác nhận chắc chắn "Other"
 * ------------------------------------------------------------------ */
{
  const list = m.normalizeOptionList([['A'], ['', null, null, null, 1]]);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].other, false);
  assert.strictEqual(list[1].other, true, 'o[4] === 1 -> other = true');
  console.log('A2  normOptionTuple (isOtherFlag) OK');
}

/* ------------------------------------------------------------------
 * B1 — Làm sạch dấu "*" của câu hỏi bắt buộc trong heading
 * ------------------------------------------------------------------ */
{
  const fake = {
    cloneNode() {
      return {
        textContent: 'Họ và tên *',
        querySelectorAll: () => [],
      };
    },
  };
  assert.strictEqual(m.cleanHeadingText(fake), 'Họ và tên');
  assert.strictEqual(m.cleanHeadingText(null), '');
  console.log('B1  cleanHeadingText (loại dấu *) OK');
}

/* ------------------------------------------------------------------
 * B2 — Tách 2 vòng lặp so khớp: tuyệt đối -> bao hàm có ranh giới từ
 * ------------------------------------------------------------------ */
{
  const mk = (label, dv) => ({
    getAttribute: (a) => (a === 'aria-label' ? label : (a === 'data-value' ? (dv || '') : '')),
  });
  const els = [mk('Việt Nam', 'Viet Nam'), mk('Nam', 'Nam')];

  // Vòng 1: khớp tuyệt đối -> "Nam" phải chọn đúng "Nam", không phải "Việt Nam"
  const t = m.matchBestElement(els, (e) => e.getAttribute('aria-label'), 'Nam', false);
  assert.strictEqual(t, els[1], 'phai chon dung "Nam"');

  // Vòng 2: bao hàm có ranh giới từ -> "Việt Nam" chứa từ "Nam" nên vẫn khop
  const t2 = m.matchBestElement([els[0]], (e) => e.getAttribute('aria-label'), 'Nam', false);
  assert.strictEqual(t2, els[0]);

  // "Tham" KHÔNG được khớp với "Nam" (ranh giới từ)
  const t3 = m.matchBestElement([mk('Tham')], (e) => e.getAttribute('aria-label'), 'Nam', false);
  assert.strictEqual(t3, null, '"Tham" khong duoc khop voi "Nam"');

  // SCALE: exactOnly -> "1" khong bao gio chon "10"
  const scaleEls = [mk('1'), mk('10')];
  assert.strictEqual(m.matchBestElement(scaleEls, (e) => e.getAttribute('aria-label'), '1', true), scaleEls[0]);
  assert.strictEqual(m.matchBestElement(scaleEls, (e) => e.getAttribute('aria-label'), '10', true), scaleEls[1]);

  // data-value cũng được dùng để khớp tuyệt đối
  const t4 = m.matchBestElement([mk('Hien thi', 'Gia tri')], (e) => e.getAttribute('aria-label'), 'Gia tri', true);
  assert.ok(t4, 'phai khop qua data-value');

  console.log('B2  matchBestElement (2 vong lap + ranh giới từ) OK');
}

/* ------------------------------------------------------------------
 * B2 — stripVi: so khớp tiếng Việt bền vững
 * ------------------------------------------------------------------ */
{
  assert.strictEqual(m.stripVi('Ngày'), 'Ngay');
  assert.strictEqual(m.stripVi('Đường'), 'Duong');
  console.log('B2  stripVi OK');
}

/* ------------------------------------------------------------------
 * B6 — findNavButton: chỉ xét nút ĐANG HIỂN THỊ
 * ------------------------------------------------------------------ */
{
  assert.ok(m.navText({ textContent: 'Tiếp', getAttribute: () => '' }) === 'tiep');
  assert.ok(m.navText({ textContent: 'Gửi', getAttribute: () => '' }) === 'gui');
  console.log('B6  navText OK');
}

/* ------------------------------------------------------------------
 * Kiểm tra hợp đồng export (JTBD: giữ hàm export phục vụ unit test)
 * ------------------------------------------------------------------ */
{
  const required = [
    'TYPE_MAP', 'OTHER_RE', 'OTHER_VALUE',
    'extractJsonArray', 'findLoadDataRaw', 'parseLoadData', 'parseStructureFromData',
    'normalizeOptionList', 'extractOptions', 'extractScale', 'mergeWithDom',
    'cleanHeadingText', 'matchBestElement',
    'stripVi', 'navText', 'findNavButton', 'seenButtons',
  ];
  for (const k of required) {
    assert.ok(m[k] !== undefined, `thieu export: ${k}`);
  }
  console.log('OK  tat ca ham export cho unit test deu ton tai');
}

console.log('\n=== ALL CONTENT TESTS PASSED ===');
