# THIẾT KẾ KIẾN TRÚC & HƯỚNG DẪN TRIỂN KHAI (BLUEPRINT)
## Dự án: Extension Auto-Fill Google Forms Thông Minh (Tích hợp AI & Đa nhiệm)

---

## 1. TỔNG QUAN DỰ ÁN (PROJECT OVERVIEW)
Đây là một Chrome/Edge Extension (Manifest V3) được thiết kế để tự động hóa việc điền và submit Google Forms với số lượng lớn. 
Điểm nổi bật của dự án là khả năng phân bổ tỷ lệ đáp án chính xác bằng toán học, tích hợp AI (Gemini) để sinh câu trả lời nhập liệu đa dạng, và cơ chế chạy đa nhiệm ngầm thông minh không làm treo trình duyệt.

**Phạm vi (Scope):** Chỉ hỗ trợ Google Forms.

---

## 2. CẤU TRÚC THƯ MỤC (FILE STRUCTURE)
Dự án bao gồm các file cốt lõi sau:

```text
/
├── manifest.json       # Cấu hình Extension (Manifest V3), cấp quyền (tabs, storage, scripting, alarms).
├── popup/
│   ├── popup.html      # Giao diện UI người dùng (Progress bar, Form Config, Stats).
│   ├── popup.css       # Style cho giao diện.
│   └── popup.js        # Xử lý logic UI, gửi thông điệp cấu hình tới Background.
├── scripts/
│   ├── background.js   # Service Worker (Bộ não): Quản lý Queue 10 tab, đếm lỗi API, delay, gọi Gemini API.
│   └── content.js      # Script chạy trên trang Google Forms: Bóc tách dữ liệu, nhận kịch bản từ Background và thực thi click/điền text.
└── assets/
    └── icons/          # Chứa icon của extension (16, 48, 128px).

    3. ĐẶC TẢ KỸ THUẬT & THUẬT TOÁN (TECHNICAL SPECIFICATIONS)
3.1. Nhận diện & Bóc tách Form (Form Extraction)
Phương pháp: KHÔNG dùng cào dữ liệu (crawler) hay giả lập click qua từng trang.

Thực thi: content.js quét mã nguồn trang HTML ban đầu, tìm đoạn <script> chứa biến FB_PUBLIC_LOAD_DATA_.

Mục đích: Parse chuỗi JSON này để lấy được TẤT CẢ ID câu hỏi, loại câu hỏi, tiêu đề, và toàn bộ Sơ đồ rẽ nhánh (Branching Logic) của form (ngay cả các trang bị ẩn) chỉ trong 0.1 giây. Dữ liệu này được gửi về popup.js để hiển thị UI.

3.2. Thuật toán Phân bổ Tỷ lệ (Largest Remainder Method)
Để giải quyết bài toán: "Điền 10 form, Tỷ lệ A: 33%, B: 33%, C: 34%" (Không bị thiếu hoặc thừa form khi làm tròn).

Tính số lượng lý thuyết = Tổng số form * %. (VD: A=3.3, B=3.3, C=3.4).

Lấy phần nguyên làm số form mặc định (A=3, B=3, C=3). Tổng = 9 (thiếu 1).

Lấy phần thập phân (A=0.3, B=0.3, C=0.4).

Cộng thêm 1 form cho các lựa chọn có phần thập phân lớn nhất (C+1 = 4) cho đến khi đủ tổng số form.

Đầu ra: Mảng [100 kịch bản], mỗi kịch bản là 1 bộ đáp án hoàn chỉnh cho 1 form.

3.3. Tích hợp AI (Gemini 2.5 Flash) & Prompt
Bảo mật API: Người dùng nhập API Key vào ô trong Popup. Key chỉ được lưu ở chrome.storage.session (Tự xóa khi đóng trình duyệt).

Custom Prompt: Có ô nhập Prompt tùy chỉnh kèm Spintax và biến {{question}}.

Ví dụ Spintax: {Vui vẻ|Buồn bã}, trả lời câu hỏi: {{question}}. Background.js phải parse Spintax này thành 1 prompt cụ thể trước khi gọi API.

Cơ chế gọi: background.js gọi fetch() tới API Gemini. Nhận text text trả về và nhúng vào kịch bản form.

3.4. Quản lý Đa nhiệm & Hàng đợi (Concurrency Queue)
Giới hạn luồng: Tối đa 10 tab ẩn chạy cùng lúc.

Luồng hoạt động (Queue System):

Lấy N kịch bản đầu tiên đẩy vào các tab ẩn (chrome.tabs.create({active: false})).

Trong mỗi tab, content.js tự động tìm các thẻ div[role="radio"], div[role="checkbox"], input[type="text"], textarea, giả lập .click() và bắn event input, change, sau đó .click() nút Submit.

Khi 1 tab submit xong (hoặc gặp lỗi), content.js báo về background.js.

background.js đóng tab đó (chrome.tabs.remove), áp dụng một khoảng Delay ngẫu nhiên (VD: 3 - 5 phút tùy cấu hình), sau đó mới mở tab tiếp theo trong hàng đợi.

3.5. Xử lý Lỗi & Fail-Safe (Cực kỳ quan trọng)
Hệ thống KHÔNG ĐƯỢC CHẾT giữa chừng, áp dụng các quy tắc sau:

Quy tắc Form Kẹt (30s Timeout): Khi background mở 1 tab, nó đặt một bộ đếm. Nếu sau 30 giây tab đó không báo cáo hoàn thành (do rớt mạng, dính Captcha, web lag...), đóng tab ngay lập tức. Đánh dấu form đó là Skipped (Bỏ qua) và chạy form tiếp theo.

Quy tắc API 3-Strike (Dừng hệ thống): Khởi tạo biến apiErrorCount = 0. Mỗi lần gọi Gemini API bị Timeout/Lỗi mạng, apiErrorCount++. Nếu thành công, apiErrorCount = 0. Nếu apiErrorCount === 3:

Gửi lệnh ngắt toàn bộ hàng đợi.

Đóng toàn bộ các tab ẩn đang mở.

Hiển thị thông báo (Notification) "Dừng khẩn cấp: Gemini API lỗi 3 lần liên tiếp."

4. GIAO DIỆN NGƯỜI DÙNG (POPUP UI)
Giao diện Popup gồm 3 trạng thái chính:

Trạng thái 1: Nhập cấu hình (Config Mode)

Danh sách câu hỏi (Lấy từ FB_PUBLIC_LOAD_DATA_).

Các input nhập % cho từng đáp án trắc nghiệm.

Câu hỏi Text: Checkbox "Dùng AI", ô nhập Custom Prompt, ô nhập Text tĩnh (nếu không dùng AI).

Cài đặt chung: Tổng số form cần điền, Min Delay, Max Delay (tính bằng phút).

Ô nhập Gemini API Key.

Nút "Bắt đầu chạy".

Trạng thái 2: Đang chạy (Running Mode / Tracking)

Thanh tiến độ (Progress Bar) % hoàn thành.

Dashboard thống kê:

🎯 Yêu cầu: [Total]

✅ Thành công: [Success]

❌ Bỏ qua/Lỗi: [Skipped]

⏳ Đang chạy: [Active Tabs]

Nút "Dừng khẩn cấp" (Abort).

5. CÁC BƯỚC PHÁT TRIỂN DÀNH CHO AI / LẬP TRÌNH VIÊN
Bước 1 (Data Extraction): Viết logic bóc tách FB_PUBLIC_LOAD_DATA_ trong content.js để ra được array chứa toàn bộ câu hỏi.

Bước 2 (UI & Algorithm): Xây dựng popup, viết hàm tính toán Largest Remainder Method để chia cấu hình thành mảng N kịch bản.

Bước 3 (Queue Manager): Viết class FormQueueManager trong background.js quản lý 10 luồng, hàm tạo tab, đóng tab và logic timeout 30s.

Bước 4 (Auto-Fill Content Script): Viết logic trong content.js để đọc 1 kịch bản và thực thi click DOM, điền text, qua trang và submit.

Bước 5 (AI Integration): Tích hợp hàm fetch Gemini API vào background. Cài đặt luật 3-Strike Error.

Bước 6 (Refining): Test thử nghiệm, thêm hàm delay ngẫu nhiên vào Queue Manager, tối ưu hóa Tracking UI.