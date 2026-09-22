# CẤU TRÚC DỰ ÁN (PROJECT BLUEPRINT): GOOGLE FORMS AI AUTO-FILL & SUBMITTER

## 1. TỔNG QUAN DỰ ÁN
Một Chrome/Edge Extension (Manifest V3) chuyên dụng để tự động hóa việc điền và submit Google Forms với số lượng lớn. 
Hệ thống sử dụng toán học để phân bổ tỷ lệ đáp án chính xác, tích hợp AI (Gemini) để đa dạng hóa câu trả lời văn bản, và chạy ngầm đa nhiệm tối đa 10 tab để tối ưu hiệu suất mà không làm treo trình duyệt.

**Ràng buộc cốt lõi:**
- Nền tảng hỗ trợ: Duy nhất Google Forms.
- Không lưu trữ API Key cố định (sử dụng Session Storage).
- Phải có cơ chế tự động thoát lỗi (Fail-Safe) để hệ thống chạy ổn định 24/7.

---

## 2. CẤU TRÚC THƯ MỤC (DIRECTORY STRUCTURE)

```text
google-forms-auto-filler/
│
├── manifest.json           # Khai báo Manifest V3, permissions: tabs, storage, scripting, host_permissions (google.com, gemini api).
│
├── popup/
│   ├── popup.html          # Giao diện chính (2 màn hình: Config và Tracking).
│   ├── popup.css           # Style cho giao diện (hiện đại, gọn gàng).
│   └── popup.js            # Lắng nghe sự kiện UI, gửi message cho Background.
│
├── scripts/
│   ├── background.js       # (Service Worker) Quản lý Queue, gọi Gemini API, xử lý Delay, quản lý Vòng đời Tab.
│   └── content.js          # Chạy trên tab Google Forms: Extract dữ liệu ẩn, giả lập click/nhập text và submit.
│
└── assets/
    └── icons/
        ├── icon16.png
        ├── icon48.png
        └── icon128.png


        3. ĐẶC TẢ KỸ THUẬT VÀ THUẬT TOÁN (CORE MECHANISMS)
3.1. Trích xuất Cấu trúc Form (Form Extraction)
Tuyệt đối KHÔNG dùng phương pháp cào dữ liệu (crawler) qua từng trang.

Cách làm: content.js quét mã nguồn HTML của trang form ngay khi tải xong, tìm thẻ <script> có chứa biến toàn cục FB_PUBLIC_LOAD_DATA_.

Mục đích: Parse chuỗi JSON này để lấy TẤT CẢ: Question ID, Tiêu đề, Loại câu hỏi (Radio, Checkbox, Text), và danh sách Lựa chọn, bao gồm cả những câu hỏi nằm ở các trang (section) bị ẩn.

Luồng dữ liệu: content.js -> gửi JSON data -> popup.js để render ra giao diện Config.

3.2. Thuật toán Phân bổ (Largest Remainder Method)
Đảm bảo khi chia tỷ lệ %, tổng số form thực tế không bao giờ bị lệch (thiếu/thừa) so với số lượng cấu hình.

Logic thực thi:

Tính số lượng lý thuyết cho từng đáp án: Số form = Tổng số form * (Tỷ lệ % / 100).

Lấy phần nguyên gán làm số lượng mặc định.

Lấy phần thập phân (số dư) của các lựa chọn.

Thiếu bao nhiêu form, sẽ cộng thêm 1 vào các lựa chọn có phần thập phân từ cao xuống thấp cho đến khi đủ tổng số form.

Kết quả: Trả về một mảng chứa N "Kịch bản" (Mỗi kịch bản là 1 object mapping Question ID -> Giá trị trả lời).

3.3. Tích hợp AI (Gemini 2.5 Flash API)
Bảo mật: API Key do người dùng nhập ở Popup, lưu bằng chrome.storage.session (tự hủy khi đóng trình duyệt).

Custom Prompt & Spintax:

Hỗ trợ biến {{question}} để chèn tự động câu hỏi của form.

Hỗ trợ Spintax {A|B|C} để tạo ngẫu nhiên bối cảnh.

Ví dụ: {Hãy đóng vai sinh viên|Hãy đóng vai người đi làm}, trả lời ngắn gọn: {{question}} -> background.js sẽ parse ra 1 prompt ngẫu nhiên trước khi gọi API.

Lưu ý: Chỉ gọi API ở background.js để tránh bị lỗi CORS.

3.4. Quản lý Đa nhiệm (10-Tab Concurrency Queue)
Giới hạn: Mở tối đa 10 tab ẩn (chrome.tabs.create({ active: false, url: formUrl })) tại cùng một thời điểm.

Quy trình Hàng đợi (Queue):

Background bốc 10 kịch bản đầu tiên, mở 10 tab.

content.js trong từng tab nhận kịch bản, giả lập thao tác điền form và Submit.

Báo cáo kết quả về Background.

Background đóng tab đó (chrome.tabs.remove), áp dụng một khoảng Delay ngẫu nhiên (Min - Max do user cấu hình), sau đó bốc kịch bản tiếp theo mở tab mới.

Quá trình lặp lại cho đến khi hết mảng kịch bản.

3.5. Xử lý Thao tác DOM (Auto-Fill Execution)
Google Forms KHÔNG dùng chuẩn HTML thông thường. content.js phải xử lý như sau:

Radio/Checkbox: Tìm các thẻ div[role="radio"] hoặc div[role="checkbox"] chứa data-value khớp với kịch bản, gọi hàm .click().

Text/Textarea: Điền .value, sau đó bắt buộc phải dispatchEvent(new Event('input', {bubbles: true})) và dispatchEvent(new Event('change', {bubbles: true})) để React/JS của Google Forms ghi nhận dữ liệu.

Tiến trình: Click nút "Tiếp" (Next) nếu có, lặp lại việc điền cho đến khi thấy nút "Gửi" (Submit) thì click Submit.

4. QUẢN LÝ RỦI RO & BẮT LỖI (FAIL-SAFE PROTOCOLS)
Đây là các quy tắc bắt buộc để hệ thống không bị treo vô hạn:

Timeout 30s (Form Kẹt):

Khi background.js mở 1 tab điền form, nó bắt đầu đếm giờ.

Nếu qua 30 giây mà content.js chưa báo "Thành công", tab đó coi như kẹt (do Captcha, rớt mạng, lag).

Hành động: background.js ép đóng tab, đánh dấu form đó là Skipped (Bỏ qua), và chạy form tiếp theo. Không dừng hệ thống.

The 3-Strike API Rule (Lỗi Gemini):

Tạo biến apiErrorCount = 0 trong background.js.

Mỗi lần fetch API Gemini bị Timeout hoặc Trả về lỗi, apiErrorCount++. Fetch thành công, apiErrorCount = 0.

Nếu apiErrorCount === 3: Lỗi hệ thống diện rộng.

Hành động: Lập tức Abort (Hủy) toàn bộ Hàng đợi, đóng tất cả 10 tab đang chạy, hiển thị thông báo lỗi lên giao diện người dùng.

5. THIẾT KẾ GIAO DIỆN (UI/UX)
Giao diện popup.html được chia làm 2 màn hình (View):

View 1: Configuration (Cấu hình)

Khung nhập Gemini API Key.

Danh sách câu hỏi (được render động từ content script gửi về).

Câu trắc nghiệm: Các ô input nhập % cho từng đáp án (tổng phải validate = 100%).

Câu văn bản: Toggle bật/tắt AI. Nếu bật: Hiện ô nhập Spintax Prompt. Nếu tắt: Hiện ô nhập text tĩnh.

Cài đặt hệ thống: Tổng số form cần điền, Delay Min (phút), Delay Max (phút).

Nút Action: "BẮT ĐẦU CHẠY".

View 2: Tracking Dashboard (Giám sát)

Progress bar (Thanh tiến độ %).

Bảng thống kê Real-time:

Tổng Yêu Cầu: N

Thành Công: X

Bỏ Qua (Lỗi/Timeout): Y

Đang Chạy: Z (Max 10).

Nút Action: "DỪNG KHẨN CẤP" (Ngắt toàn bộ hàng đợi và đóng tab).