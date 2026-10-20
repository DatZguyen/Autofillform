# JTBD: Nâng cấp & Vá lỗi Toàn diện Hệ thống Auto-Fill Google Forms (`content.js` & `background.js`)

## 1. Bối cảnh & Job Story (Mục tiêu cốt lõi)
- **Khi (When):** Người dùng sử dụng Extension để quét cấu trúc (Extract) và tự động điền (Auto-Fill) các biểu mẫu Google Forms phức tạp (có nhiều trang/Section, rẽ nhánh điều kiện, câu hỏi bắt buộc, ngày giờ, và tạo câu trả lời bằng Gemini AI).
- **Tôi muốn (I want to):**
  1. Quét chính xác 100% câu hỏi và đáp án ở **tất cả các trang (Multi-page)** ngay từ trang đầu tiên mà không cần bấm "Tiếp tục" thủ công.
  2. Điền chính xác từng loại câu hỏi trên DOM, chuyển trang mượt mà và chỉ chốt kết quả khi thực sự đã bấm Submit hoàn tất.
  3. Quản lý hàng đợi đa luồng (Multi-tab Queue) an toàn, không bị race condition, không vượt quá số tab quy định và không bị đóng tab oan.
- **Để (So that):** Chiến dịch điền form tự động đạt tỷ lệ thành công tối đa, dữ liệu chính xác tuyệt đối và vận hành ổn định không bị treo giữa chừng.

---

## 2. Phân tích Nguyên nhân & Kế hoạch Sửa lỗi Chi tiết

### PHẦN A: Sửa lỗi Quét câu hỏi Form nhiều trang (Multi-page Extraction) trong `content.js`

#### A1. Bộ cắt JSON `findLoadDataRaw()` an toàn theo cặp ngoặc vuông `[]`
- **Vấn đề hiện tại:** Dùng `txt.indexOf('[', eq)` và `txt.lastIndexOf(';')` để cắt chuỗi JSON của `FB_PUBLIC_LOAD_DATA_`. Nếu thẻ `<script>` chứa thêm lệnh JS khác phía sau biến `FB_PUBLIC_LOAD_DATA_`, `lastIndexOf(';')` sẽ lấy lố sang code JS khác gây lỗi `JSON.parse`.
- **Giải pháp:** Viết thuật toán đếm độ sâu ngoặc vuông (`bracket depth counter`) bắt đầu từ dấu `[` đầu tiên sau `FB_PUBLIC_LOAD_DATA_` (bỏ qua các ký tự `[` hoặc `]` nằm bên trong chuỗi string `"..."` và xử lý ký tự escape `\"`, `\\`). Khi `depth === 0`, cắt chính xác tại vị trí `]` đó.

#### A2. Chuẩn hóa lại `TYPE_MAP`, nhận diện Phân trang (Page Break) và Nút "Other" ở trang ẩn
- **Vấn đề hiện tại:**
  1. `TYPE_MAP` đang gán sai `8: 'IMAGE'` (thực tế trong Google Forms: `8` là `PAGE_BREAK` / Section sang trang mới, `6` là `TITLE_DESC`, `11` là `IMAGE`).
  2. Ở các trang sau (Trang 2, 3...), DOM chưa được render khi quét ở Trang 1. Do đó `scrapeOptionsFromDOM()` luôn trả về `[]` cho câu hỏi ở trang sau. Điều này làm hàm `mergeWithDom()` loại bỏ mất đáp án "Mục khác" (`other === 'maybe'`) vì `domHasOther` trả về `false`.
  3. Chưa đọc cờ nhận diện "Other" gốc trong `FB_PUBLIC_LOAD_DATA_`: Trong cấu trúc tuple đáp án của Google Forms `[text, null, null, null, isOtherFlag]`, đáp án "Mục khác" luôn có phần tử ở index `4` bằng `1` (tức `o[4] === 1`) hoặc `o[0] === ""` đi kèm cờ cấu hình.
- **Giải pháp:**
  1. Cập nhật `TYPE_MAP`: `8: 'PAGE_BREAK'`, `11: 'IMAGE'`. Theo dõi biến `currentPage = 1` trong `parseStructureFromData(data)`, mỗi khi gặp `entry[3] === 8` thì tăng `currentPage++` và gắn thuộc tính `page: currentPage` vào từng câu hỏi `q` để Popup và bộ Auto-fill biết câu hỏi nằm ở trang nào.
  2. Sửa `normOptionTuple(o)`: Nếu `Array.isArray(o)` và `o[4] === 1`, trả về ngay `{ t: o[0] || 'Mục khác:', other: true }` (xác nhận chắc chắn từ FB data mà không cần phụ thuộc DOM ở các trang ẩn).
  3. Trong `mergeWithDom(fbOpts, title, type)`: Kiểm tra xem khối câu hỏi đó có đang tồn tại trên DOM không (`const block = findQuestionBlock(title)`). Nếu `block === null` (câu hỏi nằm ở trang ẩn chưa render) và có slot `other === 'maybe'`, mặc định giữ lại thành `{ t: 'Mục khác:', other: true }` thay vì xóa bỏ.

---

### PHẦN B: Sửa lỗi Tương tác DOM & Điền Form (Auto-Fill) trong `content.js`

#### B1. Làm sạch dấu `*` (Câu hỏi bắt buộc) trong `findQuestionBlock(questionTitle)`
- **Vấn đề hiện tại:** Thẻ `[role="heading"]` trên DOM bao gồm cả dấu `*` của câu hỏi bắt buộc (VD: `"Họ và tên *"`), làm trượt điều kiện khớp chính xác `===` và rơi xuống điều kiện `includes()`, gây bắt nhầm các câu hỏi có tên chứa nhau.
- **Giải pháp:** Viết hàm chuẩn hóa tiêu đề riêng cho Heading: xóa bỏ thẻ con chứa `aria-label` bắt buộc hoặc dùng Regex `.replace(/\s*\*\s*$/, '')` trước khi so sánh `===`. Trong vòng lặp dự phòng `includes()`, chỉ cho phép `headingText.includes(want)` chứ không cho `want.includes(headingText)` nếu `headingText` quá ngắn (< 4 ký tự).

#### B2. Tách 2 vòng lặp so khớp cho `fillRadio`, `fillCheckbox`, `fillDropdown`, `fillScale`
- **Vấn đề hiện tại:** Chung một vòng lặp kiểm tra `if (v === want || v.includes(want) || want.includes(v))` khiến đáp án `"Nam"` click nhầm vào `"Việt Nam"`, hoặc thang đo `"1"` click nhầm vào `"10"`.
- **Giải pháp:**
  - Với `SCALE`: Chỉ dùng so sánh bằng tuyệt đối `v === want`.
  - Với `RADIO`, `CHECKBOX`, `DROPDOWN`:
    - **Vòng 1 (Ưu tiên tuyệt đối):** Duyệt toàn bộ danh sách để tìm phần tử có `v.toLowerCase() === want.toLowerCase()`.
    - **Vòng 2 (Fallback khi Vòng 1 không khớp):** Chỉ chạy khi Vòng 1 thất bại, tìm phần tử có `v.toLowerCase().includes(want.toLowerCase())`.

#### B3. Chuyển `fillOther` và `fillCheckbox` sang `async/await`
- **Vấn đề hiện tại:** Khi click chọn radio/checkbox "Mục khác", ô `<input>` đi kèm cần thời gian để Google Forms kích hoạt (enable/focus). Điền đồng bộ ngay lập tức làm mất chữ hoặc tự bỏ chọn.
- **Giải pháp:** Đổi `fillOther`, `fillRadio`, `fillCheckbox` sang `async function`. Sau khi `humanClick(otherEl)`, `await sleep(200)` rồi mới tìm ô input và gọi `fillTextInput(box, text)`.

#### B4. Xử lý riêng câu hỏi `DATE` và `TIME` nhiều ô `<input>`
- **Vấn đề hiện tại:** Google Forms thường tách `DATE` thành 3 ô (Ngày / Tháng / Năm) và `TIME` thành 2 ô (Giờ / Phút) dạng `input[type="text"]` hoặc `input[type="number"]`. Hàm `fillText` chỉ lấy ô đầu tiên.
- **Giải pháp:** Viết hàm riêng `fillDate(block, value)` và `fillTime(block, value)`:
  - Nếu có `input[type="date"]` hoặc `input[type="time"]` nguyên khối -> dùng `fillTextInput`.
  - Nếu có nhiều thẻ `input` bên trong `block` (kiểm tra qua `aria-label` như "Ngày/Day", "Tháng/Month", "Năm/Year", "Giờ/Hour", "Phút/Minute" hoặc thứ tự ô): tách chuỗi `YYYY-MM-DD` (hoặc `DD/MM/YYYY`) và `HH:MM` để điền lần lượt vào từng ô tương ứng.

#### B5. Cho phép Submit khi Form rẽ nhánh hoặc đã đến trang cuối trong `runFill()`
- **Vấn đề hiện tại:** Khi `nav.kind === 'submit'`, nếu `remaining.length > 0` thì chặn Submit và báo lỗi. Nhưng với form nhiều trang có **rẽ nhánh (Branching)**, các câu hỏi thuộc nhánh không đi qua sẽ không bao giờ hiển thị và luôn nằm lại trong `remaining`.
- **Giải pháp:**
  - Khi gặp `nav.kind === 'submit'` (và trang hiện tại không còn nút `next`): Kiểm tra xem trên trang hiện tại còn câu hỏi nào trong `remaining` đang hiển thị (`offsetParent !== null`) mà điền thất bại không.
  - Nếu các câu trong `remaining` đều **không tồn tại trên DOM của trang hiện tại** (do nằm ở nhánh rẽ bị bỏ qua), cho phép bấm Submit bình thường thay vì return lỗi.

#### B6. Nhận diện chuyển trang trong `runFill()`
- **Vấn đề hiện tại:** Khi một trang đồng thời có cả nút "Tiếp" và nút "Gửi" (hoặc nút ẩn), `findNavButton()` ưu tiên tìm `SUBMIT_KEYS` trước `NEXT_KEYS`. Nếu nút Submit bị ẩn ở DOM hoặc nằm ở footer mẫu, nó có thể bấm nhầm.
- **Giải pháp:** Trong `findNavButton()`, bắt buộc lọc `x.el.offsetParent !== null` (chỉ xét các nút **đang hiển thị thực tế trên màn hình**) ngay từ bước tạo danh sách `usable` trước khi tìm `SUBMIT_KEYS` và `NEXT_KEYS`.

---

### PHẦN C: Sửa lỗi Quản lý Hàng đợi & Tab trong `background.js`

#### C1. Chống đóng tab oan ở Trang 2+ do URL `/formResponse/i` (`chrome.tabs.onUpdated`)
- **Vấn đề hiện tại:** Khi form nhiều trang chuyển từ Trang 1 sang Trang 2 (bấm nút "Tiếp"), URL của Google Forms lập tức đổi sang `.../formResponse`. Listener `onUpdated` kiểm tra `/formResponse/i.test(tab.url)` sẽ tưởng form đã Submit xong và gọi `finalizeTab(tabId, true)` giết chết tab ngay ở Trang 2.
- **Giải pháp:** Trong `chrome.tabs.onUpdated`, **CHỈ** cho phép chốt thành công qua URL `/formResponse/i` khi `meta && meta.submitted === true` (tức là `content.js` đã thực sự bấm vào nút Submit và bắn message `FORM_SUBMITTED` về trước đó).

#### C2. Khóa chống Race Condition (Mutex) và Bộ đếm Index độc lập trong `pump()`
- **Vấn đề hiện tại:**
  1. `pump()` là hàm `async` có `await resolvePayload()` bên trong vòng lặp `while`. Khi nhiều tab xong cùng lúc, nhiều luồng `pump()` chạy chồng chéo khi `activeTabs.size` chưa kịp cập nhật -> mở vượt quá `MAX_CONCURRENT_TABS`.
  2. Công thức `index = state.stats.success + state.stats.failed + state.activeTabs.size + 1` bị trùng số thứ tự khi nhiều luồng cùng đang `await resolvePayload()`.
- **Giải pháp:**
  1. Thêm `state.nextIndex = 0` vào `state` (reset về `0` ở `START_RUN`). Mỗi lần lấy 1 phần tử từ `state.queue.shift()`, tăng `const index = ++state.nextIndex;`.
  2. Thêm `state.resolvingCount = 0` (số lượng payload đang gọi AI chờ mở tab) và cờ `state.isPumping = false`.
  3. Điều kiện vòng lặp: `while (state.isRunning && (state.activeTabs.size + state.resolvingCount) < MAX_CONCURRENT_TABS && state.queue.length > 0)`.

#### C3. Xử lý dọn dẹp hoàn chỉnh khi đóng tab thủ công (`chrome.tabs.onRemoved`)
- **Vấn đề hiện tại:** Khi tab bị đóng tay hoặc crash, `onRemoved` chỉ xóa khỏi `activeTabs` mà không cập nhật `failed`, không gọi `pump()` và `checkFinished()`, gây treo phiên chạy.
- **Giải pháp:** Trong `onRemoved`, nếu `state.activeTabs.has(tabId)` và `state.isRunning === true`:
  - Tăng `state.stats.failed++`.
  - Ghi log lỗi `logError(meta.index, 'Tab bị đóng đột ngột trước khi hoàn tất.')`.
  - Gọi `await persistStats()`, sau đó gọi `pump()` và `checkFinished()`.

---

## 3. Tiêu chí Nghiệm thu (Acceptance Criteria)
1. **Test Quét Form nhiều trang:** Mở một Google Form có 3 trang (Section), đứng ở Trang 1 bấm Quét -> Phải lấy được đầy đủ câu hỏi của cả 3 trang, giữ nguyên các đáp án "Mục khác" ở Trang 2 và 3, không báo lỗi `JSON.parse`.
2. **Test Điền Form nhiều trang:** Chạy Auto-fill trên form 3 trang -> Tab tự động điền Trang 1, bấm "Tiếp" sang Trang 2 (URL đổi thành `/formResponse` nhưng tab **không bị đóng**), điền tiếp Trang 2, 3 và bấm "Gửi" thành công.
3. **Test Câu hỏi Bắt buộc & Đáp án trùng tên:** Câu hỏi có dấu `*` khớp chính xác 100%; đáp án `"Nam"` không bao giờ chọn nhầm vào `"Việt Nam"`.
4. **Test Đa luồng (Concurrency):** Chạy 25 form với AI Gemini bật sẵn -> Không bao giờ có quá 10 tab mở cùng lúc, `index` trong log từ `#1` đến `#25` không bị trùng lặp hay nhảy cóc.

## 4. Yêu cầu Đầu ra cho AI
Hãy cung cấp toàn bộ mã nguồn hoàn chỉnh của 2 file `content.js` và `background.js` sau khi đã áp dụng tất cả các bản vá trong phần Kế hoạch trên. Giữ nguyên cấu trúc Message Router và các hàm export phục vụ unit test ở cuối file `content.js`.