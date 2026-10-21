/* ============================================================================
 * tests/wiring.test.js — Kiểm tra tính "liên kết" của toàn bộ dự án
 *   - Mọi message giữa 3 file phải khớp tên & đích đến
 *   - Các yêu cầu then chốt trong JTBD.md phải có mặt trong mã nguồn
 * Chạy: node tests/wiring.test.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const bg = read('scripts/background.js');
const ct = read('scripts/content.js');
const pp = read('popup/popup.js');
const mf = JSON.parse(read('manifest.json'));

/* ------------------------------------------------------------------
 * 1. Hợp đồng message
 * ------------------------------------------------------------------ */
function casesOf(src) {
  const set = new Set();
  for (const m of src.matchAll(/case\s+'([A-Z_]+)'/g)) set.add(m[1]);
  return set;
}
function sentTypes(src) {
  const set = new Set();
  for (const m of src.matchAll(/type:\s*'([A-Z_]+)'/g)) set.add(m[1]);
  return set;
}

const bgCases = casesOf(bg);
const ctToBg = sentTypes(ct);
const bgToCt = sentTypes(bg);
const ppToBg = sentTypes(pp);

// Mọi message content -> background đều phải được background xử lý
for (const t of ctToBg) {
  if (t === 'EXTRACT_REQUEST' || t === 'TEXT') continue; // TEXT là false-positive của regex
  assert.ok(bgCases.has(t), `background chua xu ly message '${t}' gui tu content.js`);
}
// Mọi message popup -> background đều phải được background xử lý
for (const t of ppToBg) {
  if (t === 'EXTRACT_REQUEST' || t === 'TEXT') continue;
  assert.ok(bgCases.has(t), `background chua xu ly message '${t}' gui tu popup.js`);
}
// Các message mà background gửi đi phải được content/popup nhận
assert.ok(bgToCt.has('FILL_FORM'), 'background phai gui FILL_FORM cho content.js');
assert.ok(pp.includes('STATS_UPDATE'), 'popup phai nhan STATS_UPDATE');
console.log('OK  hop dong message giua popup/background/content khop');

// Danh sách message bắt buộc theo JTBD
const REQUIRED_MSGS = [
  'EXTRACT_REQUEST', 'START_RUN', 'STOP_RUN', 'GET_STATUS',
  'STATS_UPDATE', 'FILL_FORM',
  'FORM_HEARTBEAT', 'FORM_SUBMITTED', 'FORM_NEXT_PAGE', 'FORM_DONE', 'FORM_ERROR',
];
for (const t of REQUIRED_MSGS) {
  const all = bg + ct + pp;
  assert.ok(all.includes(`'${t}'`), `thieu message bat buoc: ${t}`);
}
console.log('OK  tat ca message bat buoc deu ton tai');

/* ------------------------------------------------------------------
 * 2. Manifest
 * ------------------------------------------------------------------ */
assert.strictEqual(mf.manifest_version, 3, 'phai la Manifest V3');
assert.ok(mf.background.service_worker === 'scripts/background.js');
assert.ok(mf.content_scripts[0].js.includes('scripts/content.js'));
assert.ok(mf.content_scripts[0].matches.some((x) => x.includes('docs.google.com/forms')));
for (const p of ['tabs', 'storage', 'scripting']) {
  assert.ok(mf.permissions.includes(p), `thieu permission: ${p}`);
}
assert.ok(!mf.host_permissions.some((x) => x.includes('generativelanguage.googleapis.com')),
  'da bo AI -> khong con host_permission cho Gemini API');
// Icons phải tồn tại thật
for (const [, p] of Object.entries(mf.icons || {})) {
  assert.ok(fs.existsSync(path.join(root, p)), `icon khong ton tai: ${p}`);
}
console.log('OK  manifest.json hop le + icons ton tai');

/* ------------------------------------------------------------------
 * 3. Yêu cầu JTBD — PHẦN A: bóc tách multi-page
 * ------------------------------------------------------------------ */
assert.ok(/8:\s*'PAGE_BREAK'/.test(ct), 'TYPE_MAP phai co 8 = PAGE_BREAK');
assert.ok(/11:\s*'IMAGE'/.test(ct), 'TYPE_MAP phai co 11 = IMAGE');
assert.ok(ct.includes('extractJsonArray'), 'phai co bo cat JSON theo do sau ngoac vuong');
assert.ok(ct.includes("o[4] === 1"), 'phai doc co isOtherFlag o[4] === 1');
assert.ok(/currentPage\+\+/.test(ct), 'phai tang currentPage khi gap PAGE_BREAK');
assert.ok(/page:\s*currentPage/.test(ct), 'phai gan thuoc tinh page cho cau hoi');
console.log('OK  JTBD PHAN A (boc tach multi-page)');

// Popup phai hien thi thong tin trang
assert.ok(pp.includes('TOTAL_PAGES'), 'popup phai biet tong so trang');
assert.ok(pp.includes("q.page"), 'popup phai gan nhan trang cho cau hoi');
assert.ok(pp.includes('totalPages'), 'popup phai doc totalPages tu content.js');
console.log('OK  popup hien thi thong tin trang (page badge)');

/* ------------------------------------------------------------------
 * 4. Yêu cầu JTBD — PHẦN B: điền form
 * ------------------------------------------------------------------ */
assert.ok(ct.includes('cleanHeadingText'), 'phai co ham lam sach dau *');
assert.ok(ct.includes('containsWord'), 'phai co so khop co ranh giới từ');
assert.ok(ct.includes('exactOnly'), 'SCALE phai dung so sanh tuyet doi');
assert.ok(/async function fillOther/.test(ct), 'fillOther phai la async');
assert.ok(/async function fillCheckbox/.test(ct), 'fillCheckbox phai la async');
assert.ok(/function fillDate/.test(ct), 'phai co fillDate rieng');
assert.ok(/function fillTime/.test(ct), 'phai co fillTime rieng');
assert.ok(ct.includes('input[type="date"]'), 'fillDate phai ho tro input[type=date]');
assert.ok(ct.includes('input[type="time"]'), 'fillTime phai ho tro input[type=time]');
assert.ok(ct.includes('isElementHidden') || ct.includes('offsetParent'),
  'phai loc phan tu dang hien thi');
console.log('OK  JTBD PHAN B (dien form)');

// B5: cho phep Submit khi form re nhanh
assert.ok(ct.includes('nav.kind === \'submit\''), 'phai co nhanh submit');
assert.ok(ct.includes('failedVisibleOnThisPage'), 'phai kiem tra cau hoi that bai tren trang hien tai');
// Nhanh re: cau hoi khong ton tai tren DOM -> bi bo qua (continue), khong chan Submit.
// Chi cau hoi that bai TREN TRANG HIEN TAI moi chan Submit.
assert.ok(/if \(!block\) continue;/.test(ct),
  'cau hoi khong co tren DOM (nhanh re / trang sau) phai duoc bo qua');
assert.ok(/failedVisibleOnThisPage\.length > 0/.test(ct),
  'chi cau hoi that bai tren trang hien tai moi chan Submit');
console.log('OK  JTBD B5 (Submit khi form re nhanh)');

/* ------------------------------------------------------------------
 * 5. Yêu cầu JTBD — PHẦN C: queue & tab
 * ------------------------------------------------------------------ */
// C1: KHONG đóng tab nhầm ở trang 2+ (URL đổi /formResponse khi bấm "Tiếp").
// Kiến trúc hiện tại: content.js tự đọc DOM thật để quyết định DONE (trang cảm ơn)
// hay ERROR -> background chỉ đóng tab khi nhận FORM_DONE / FORM_ERROR.
assert.ok(ct.includes('isThankYouPage'), 'C1: content.js phai tu nhan trang cam on tu DOM that');
assert.ok(bg.includes("case 'FORM_DONE'"), 'C1: background xu ly FORM_DONE');
assert.ok(bg.includes("case 'FORM_ERROR'"), 'C1: background xu ly FORM_ERROR');
assert.ok(!/onUpdated[\s\S]{0,600}formResponse/i.test(bg),
  'C1: KHONG duoc finalize tab chi vi URL doi thanh /formResponse');
// C2: mutex + index độc lập
assert.ok(bg.includes('isPumping'), 'C2: phai co mutex isPumping');
assert.ok(bg.includes('++state.nextIndex'), 'C2: phai co bo dem index doc lap');
assert.ok(/activeTabs\.size < MAX_CONCURRENT_TABS/.test(bg),
  'C2: dieu kien vong lap phai gioi han so tab dang chay');
// C3: xử lý onRemoved
const onRemovedIdx = bg.indexOf('chrome.tabs.onRemoved.addListener');
assert.ok(onRemovedIdx > 0, 'phai co onRemoved listener');
assert.ok(bg.slice(onRemovedIdx, onRemovedIdx + 900).includes('state.stats.failed++'),
  'C3: onRemoved phai tang failed');
assert.ok(bg.slice(onRemovedIdx, onRemovedIdx + 900).includes('pump()'),
  'C3: onRemoved phai goi pump()');
assert.ok(bg.slice(onRemovedIdx, onRemovedIdx + 900).includes('checkFinished()'),
  'C3: onRemoved phai goi checkFinished()');
console.log('OK  JTBD PHAN C (queue, tab, race condition)');

/* ------------------------------------------------------------------
 * 6. Cơ chế quá trang (multi-page) — 3 tầng bảo vệ
 * ------------------------------------------------------------------ */
// Cơ chế quá trang hiện tại: background GIỮ job và gửi lại TOÀN BỘ payload mỗi lần
// tab load xong; content.js quét lại toàn bộ payloadItems trên trang hiện tại
// (bỏ qua câu hỏi không có trong DOM = trang sau / nhánh rẽ).
assert.ok(bg.includes('state.tabJobs.set(tabId'), 'background phai luu job theo tab');
assert.ok(bg.includes("type: 'FILL_FORM'"), 'background phai gui FILL_FORM');
const onUpdatedIdx = bg.indexOf('chrome.tabs.onUpdated.addListener');
const onUpdatedBlock = bg.slice(onUpdatedIdx, onUpdatedIdx + 2200);
assert.ok(onUpdatedBlock.includes("type: 'FILL_FORM'"),
  'background phai gui lai FILL_FORM moi lan trang load xong');
assert.ok(!/state\.tabJobs\.delete\(tabId\);[\s\S]{0,400}type: 'FILL_FORM'/.test(onUpdatedBlock),
  'KHONG duoc xoa job truoc khi gui FILL_FORM (de gui lai duoc o trang sau)');
// content.js phai quet lai TOAN BO payloadItems tren trang hien tai
assert.ok(/for \(let i = 0; i < payloadItems\.length; i\+\+\)/.test(ct),
  'content.js phai quet lai toan bo payloadItems tren trang hien tai');
// Co tin nhan FORM_NEXT_PAGE de background theo doi chuyen trang
assert.ok(ct.includes('FORM_NEXT_PAGE') && bg.includes("case 'FORM_NEXT_PAGE'"),
  'can co tin nhan FORM_NEXT_PAGE de theo doi chuyen trang');
console.log('OK  co che qua trang multi-page (3 tang bao ve)');

/* ------------------------------------------------------------------
 * 7. ĐÃ LOẠI BỎ HOÀN TOÀN AI
 * ------------------------------------------------------------------ */
for (const [name, src] of [['background.js', bg], ['content.js', ct], ['popup.js', pp]]) {
  assert.ok(!/generativelanguage|GEMINI_MODEL|callGemini|apiKey|geminiApiKey/i.test(src),
    `${name} van con tham chieu AI`);
}
assert.ok(!pp.includes('use-ai') && !pp.includes('ai-prompt') && !pp.includes('ai-pct'),
  'popup van con UI AI');
assert.ok(!pp.includes('inApiKey'), 'popup van con o nhap API Key');
assert.ok(!bg.includes("'ai'"), 'background van con xu ly payload kind=ai');
console.log('OK  da loai bo hoan toan AI (khong con Gemini/API Key)');

/* ------------------------------------------------------------------
 * 8. Fail-safe
 * ------------------------------------------------------------------ */
assert.ok(bg.includes('TAB_TIMEOUT_MS'), 'phai co timeout 30s');
assert.ok(bg.includes('abortAll'), 'phai co ham abortAll');
assert.ok(bg.includes('TAB_TIMEOUT_MS'), 'phai co timeout cho 1 tab');
assert.ok(bg.includes('abortAll'), 'phai co ham abortAll');
console.log('OK  fail-safe (timeout cho 1 tab + abort)');

/* ------------------------------------------------------------------
 * 9. Ô nhập liệu dạng textarea nhiều dòng (mỗi dòng 1 đáp án, lấy random 1)
 * ------------------------------------------------------------------ */
assert.ok(pp.includes('splitAnswers'), 'popup phai co ham tach danh sach dap anh theo dong');
assert.ok(pp.includes('pickRandomAnswer'), 'popup phai co ham chon random 1 dap an');
assert.ok(pp.includes("text-answers"), 'phai render textarea .text-answers cho cau nhap lieu');
assert.ok(pp.includes('other-text'), 'phai co textarea cho dap an "Mục khác"');
// Không còn UI % cho câu nhập liệu
assert.ok(!pp.includes('variant-pct') && !pp.includes('variant-text'),
  'popup van con bang % / o text don le cho cau nhap lieu');
assert.ok(!pp.includes('textmix'), 'popup van con kieu cau hoi "textmix"');
// Payload cua cau nhap lieu phai la 1 chuoi da chon random
assert.ok(/kind: 'text'/.test(pp), 'phai con kieu cau hoi "text"');
assert.ok(pp.includes("kind: 'static', value: spinOnce(pickRandomAnswer(cfg.answers))"),
  'payload cau nhap lieu phai lay random 1 dong trong danh sach');
console.log('OK  o nhap lieu nhieu dong (random 1 dap an/dong)');

console.log('\n=== ALL WIRING TESTS PASSED ===');
