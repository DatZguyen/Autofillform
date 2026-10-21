# Structure

## Câu hỏi dạng LƯỚI (GRID) — tỷ lệ % riêng từng dòng con

### 1. Bóc tách (`scripts/content.js`)

Sau khi parse `FB_PUBLIC_LOAD_DATA_`, một câu GRID có cấu trúc:

```js
q.type        = 'GRID';
q.options     = [ {t:'1'}, {t:'2'}, {t:'3'} ];          // danh sách CỘT
q.gridRows    = ['Dòng A','Dòng B','Dòng C'];           // tên các DÒNG con
q.gridRowIds  = ['r1','r2','r3'];                       // id từng dòng (rowEntry[0])
q.gridRowsMeta= [ {index, id, label}, ... ];            // chi tiết từng dòng
q.rowCount    = 3;
q.gridKind    = 'RADIO' | 'CHECKBOX';                   // mỗi hàng chọn 1 / chọn nhiều
```

Nguồn nhãn dòng con (theo thứ tự ưu tiên):

| Vị trí trong `entry[4][i]` | Ý nghĩa |
|---|---|
| `rowEntry[3][0]` | nhãn hiển thị của dòng (phổ biến nhất) |
| `rowEntry[1][0][0]` | fallback — một số phiên bản lưu ở cột options |
| `rowEntry[1]` (string) | fallback |
| `rowEntry[0]` | **id** của dòng (không phải nhãn) |

Nếu FB data không lộ dòng con → fallback lấy từ DOM
(`div[role="radiogroup"]` / `div[role="group"]` có `aria-label` = tên dòng).

`gridKind` được nhận diện từ DOM (`div[role="checkbox"]` vs `div[role="radio"]`),
mặc định `'RADIO'`. Lúc điền, `fillGrid()` vẫn tự phát hiện lại theo DOM thực tế.

### 2. Giao diện (`popup/popup.js` — `renderGridBlock`)

- Tiêu đề chính của GRID là **group header**.
- Mỗi **dòng con** = 1 khối cấu hình độc lập: đầy đủ ô `%` cho từng cột,
  kèm thanh "Còn lại: %" + nút 🎲 (ngẫu nhiên) / ⚖ (chia đều) **riêng của dòng đó**.
- Thanh công cụ của khối GRID:
  - `📋 Áp dụng tỷ lệ dòng 1 cho tất cả các dòng trong bảng này` — copy % dòng đầu sang mọi dòng.
  - `⚖ Chia đều mọi dòng` · `🎲 Ngẫu nhiên mọi dòng`.
  - `▾ Thu gọn` — dùng `max-height` (KHÔNG dùng `display:none`) để `offsetParent`
    vẫn khác `null`, nên phần trăm "Còn lại" vẫn tính đúng khi đang thu gọn.

DOM sinh ra (dùng cho Lưu/Tải cấu hình):

```html
<div class="grid-row" data-row="Dòng A">
  <input class="pct-input" data-opt="1" data-row="Dòng A" />
  <input class="pct-input" data-opt="2" data-row="Dòng A" />
  ...
</div>
```

### 3. Đóng gói payload (`popup/popup.js` — `onStart`)

Mỗi dòng con có **1 bộ `largestRemainder(pcts, total)` riêng**
(Largest Remainder + Fisher-Yates shuffle) → số lượng mỗi cột trên mừng dòng luôn
khớp **chính xác** tỷ lệ đã khai báo, còn thứ tự submit vẫn ngẫu nhiên.

```js
one[qid] = {
  kind: 'choice',
  value: {
    __rowAnswers: ['3','1','2'],   // theo đúng thứ tự dòng
    'Dòng A': '3',                 // ánh xạ theo tên dòng
    'Dòng B': '1',
    'Dòng C': '2',
  },
};
```

### 4. Truyền payload (`scripts/background.js` — `resolvePayload`)

| `spec.value` | Hành động |
|---|---|
| Object (có `__rowAnswers` hoặc map theo tên dòng) | **truyền nguyên vẹn** |
| Array (đáp án theo thứ tự dòng) | **truyền nguyên vẹn** |
| Giá trị đơn (cấu hình cũ) | fallback `drawGridRowAnswers()` — rút ngẫu nhiên cho từng dòng |

### 5. Điền form (`scripts/content.js` — `fillGrid`)

Thứ tự ưu tiên khoá đáp án cho 1 dòng:

1. **Câu hỏi bẫy (Attention check)** — VD *"Vui lòng chọn mức 4…"* → luôn ưu tiên vượt qua bẫy.
2. **Khớp theo tên dòng** — `answer[rowLabel]`.
3. **Khớp theo index** — `answer.__rowAnswers[i]` hoặc `answer[i]`.

Nếu không xác định được đáp án → chọn ngẫu nhiên 1 giá trị khả dụng của dòng.

### 6. Lưu / Tải cấu hình (Preset)

`collectConfig()` / `applyConfig()` lưu theo schema:

```js
questions: {
  [qid]: {
    type: 'GRID',
    grid: {                       // % RIÊNG của từng dòng con
      'Dòng A': { '1': 10, '2': 20, '3': 70 },
      'Dòng B': { '1': 70, '2': 20, '3': 10 },
    },
  },
}
```

Lưu trong `chrome.storage.local` (`formAutoFillPresets`) → tỷ lệ % riêng của từng dòng con
được giữ nguyên khi lưu/tải lại cấu hình.

### 7. Kiểm thử

```bash
npm test     # gồm tests/grid.test.js + tests/grid-ui.test.js
npm run lint
```
