/* ============================================================================
 * tests/popup.test.js — Unit test cho popup/popup.js
 *   - splitAnswers(): tách textarea thành danh sách đáp án (mỗi dòng 1 đáp án)
 *   - pickRandomAnswer(): lấy đúng 1 đáp án ngẫu nhiên trong danh sách
 *   - largestRemainder(): phân bổ % (Largest Remainder Method)
 * Chạy: node tests/popup.test.js
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// popup.js là script chạy trong trình duyệt -> stub tối thiểu để require được
global.chrome = {
  runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({}) },
  tabs: { query: async () => [{}] },
};
global.document = {
  addEventListener() {},
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  createElement: () => ({
    append() {}, appendChild() {}, addEventListener() {},
    classList: { toggle() {} }, style: {}, dataset: {}, children: [],
  }),
};
global.setInterval = () => 0;

const src = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');

// Trích các hàm thuần (không phụ thuộc DOM) ra để test
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `khong tim thay ham ${name}`);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  // tra ve phan THAN + TEN ham, de goi duoc nhu 1 function binh thuong
  return src.slice(start, i + 1);
}

const splitAnswers = eval(`(${extractFn('splitAnswers')})`);
const pickRandomAnswer = eval(`(${extractFn('pickRandomAnswer')})`);
const largestRemainder = eval(`(${extractFn('largestRemainder')})`);

/* ------------------------------------------------------------------
 * splitAnswers — mỗi dòng = 1 đáp án
 * ------------------------------------------------------------------ */
{
  assert.deepStrictEqual(
    splitAnswers('A\nB\nC'),
    ['A', 'B', 'C'],
    '3 dong -> 3 dap an'
  );

  // Bỏ qua dòng trống + khoảng trắng thừa
  assert.deepStrictEqual(
    splitAnswers('  A  \n\n\nB\n   \nC  '),
    ['A', 'B', 'C'],
    'bo qua dong trong va trim khoang trang'
  );

  // Xuống dòng Windows (\r\n)
  assert.deepStrictEqual(splitAnswers('A\r\nB'), ['A', 'B'], 'ho tro CRLF');

  // Chuỗi rỗng / null
  assert.deepStrictEqual(splitAnswers(''), []);
  assert.deepStrictEqual(splitAnswers('   \n  '), []);
  assert.deepStrictEqual(splitAnswers(null), []);
  assert.deepStrictEqual(splitAnswers(undefined), []);

  // 1 dòng duy nhất
  assert.deepStrictEqual(splitAnswers('Dap an'), ['Dap an']);

  // Giữ nguyên nội dung có khoảng trắng bên trong
  assert.deepStrictEqual(splitAnswers('Xin chào bạn'), ['Xin chào bạn']);

  console.log('OK  splitAnswers (moi dong = 1 dap an)');
}

/* ------------------------------------------------------------------
 * pickRandomAnswer — lấy đúng 1 đáp án ngẫu nhiên
 * ------------------------------------------------------------------ */
{
  const list = ['A', 'B', 'C', 'D'];
  const picked = new Set();
  for (let i = 0; i < 500; i++) {
    const v = pickRandomAnswer(list);
    assert.ok(list.includes(v), 'phai tra ve 1 phan tu trong danh sach');
    picked.add(v);
  }
  assert.strictEqual(picked.size, list.length, 'phai lay duoc het cac dap an (random that)');

  // Danh sách rỗng -> chuỗi rỗng
  assert.strictEqual(pickRandomAnswer([]), '');
  assert.strictEqual(pickRandomAnswer(null), '');
  assert.strictEqual(pickRandomAnswer(undefined), '');

  // Danh sách 1 phần tử -> luôn trả về phần tử đó
  assert.strictEqual(pickRandomAnswer(['only']), 'only');

  console.log('OK  pickRandomAnswer (random 1 dap an trong danh sach)');
}

/* ------------------------------------------------------------------
 * largestRemainder — phân bổ % (giữ nguyên cho câu trắc nghiệm)
 * ------------------------------------------------------------------ */
{
  // 10 form: 33/33/34 -> 3/3/4 (tổng đúng 10)
  const bag = largestRemainder([33, 33, 34], 10);
  assert.strictEqual(bag.length, 10, 'do dai bang tong so form');
  const counts = [0, 0, 0];
  bag.forEach((i) => counts[i]++);
  assert.deepStrictEqual(counts, [3, 3, 4]);

  // 3 form: 50/50 -> 2/1 (tổng 3)
  const bag2 = largestRemainder([50, 50], 3);
  assert.strictEqual(bag2.length, 3);

  // Tổng luôn khớp tuyệt đối
  for (const t of [1, 7, 25, 100]) {
    const b = largestRemainder([20, 30, 50], t);
    assert.strictEqual(b.length, t, `tong so form ${t} phai khop`);
  }

  console.log('OK  largestRemainder (LRM)');
}

/* ------------------------------------------------------------------
 * Kiểm tra không còn AI trong popup
 * ------------------------------------------------------------------ */
{
  assert.ok(!/apiKey|inApiKey|use-ai|ai-prompt|ai-pct|gemini/i.test(src),
    'popup van con tham chieu AI');
  assert.ok(!src.includes('textmix'), 'popup van con kieu textmix');
  console.log('OK  popup khong con tham chieu AI');
}

console.log('\n=== ALL POPUP TESTS PASSED ===');
