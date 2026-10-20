# THIẾT KẾ KIẾN TRÚC & HƯỚNG DẪN TRIỂN KHAI (BLUEPRINT)
## Dự án: Extension Auto-Fill Google Forms Thông Minh (Đa nhiệm, Không dùng AI)

---

## 1. TỔNG QUAN DỰ ÁN (PROJECT OVERVIEW)
Đây là một Chrome/Edge Extension (Manifest V3) được thiết kế để tự động hóa việc điền và submit Google Forms với số lượng lớn. 
Điểm nổi bật của dự án là khả năng phân bổ tỷ lệ đáp án chính xác bằng toán học, nhập **danh sách đáp án nhiều dòng** và chọn ngẫu nhiên 1 đáp án cho mỗi form, và cơ chế chạy đa nhiệm ngầm thông minh không làm treo trình duyệt. Không cần AI hay API Key.

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
│   ├── background.js   # Service Worker (Bộ não): Quản lý Queue 10 tab, delay, quản lý vòng đời tab.
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

3.3. NHẬP LIỆU TỪ DANH SÁCH NHIỀU DÒNG (KHÔNG DÙNG AI)

Mỗi câu hỏi nhập liệu có 1 ô textarea: MỖI DÒNG là 1 đáp án.

Khi sinh kịch bản cho từng form, hệ thống chọn NGẪU NHIÊN đúng 1 dòng để điền vào ô trả lời.

Hàm dùng ở popup.js:
- splitAnswers(raw): tách chuỗi textarea thành mảng đáp án (bỏ dòng trống, trim).
- pickRandomAnswer(list): lấy ngẫu nhiên 1 phần tử.

Spintax {A|B} vẫn hỗ trợ ở cấp từng dòng.

Không còn API Key, không còn gọi mạng ra ngoài.

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

Quy tắc giới hạn 5 phút / tab:

Mỗi tab có startedAt. Nếu chạy quá TAB_MAX_LIFETIME_MS (5 phút) mà chưa hoàn tất -> đóng tab, đánh dấu Skipped, chạy form tiếp theo. Không dừng hệ thống.

Quy tắc Abort:

Người dùng bấm "DỪNG KHẨN CẤP" -> xoá hàng đợi, đóng toàn bộ tab đang chạy, hiển thị lý do trên giao diện.

4. GIAO DIỆN NGƯỜI DÙNG (POPUP UI)
Giao diện Popup gồm 3 trạng thái chính:

Trạng thái 1: Nhập cấu hình (Config Mode)

Danh sách câu hỏi (Lấy từ FB_PUBLIC_LOAD_DATA_).

Các input nhập % cho từng đáp án trắc nghiệm.

Câu hỏi Text: 1 ô textarea nhiều dòng — mỗi dòng là 1 đáp án, chọn ngẫu nhiên 1 dòng cho mỗi form.

Cài đặt chung: Tổng số form cần điền, Min Delay, Max Delay (tính bằng phút).

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

Bước 5 (Danh sách đáp án): Cho phép nhập nhiều đáp án (mỗi dòng 1 đáp án) và chọn ngẫu nhiên 1 đáp án cho mỗi form.

Bước 6 (Refining): Test thử nghiệm, thêm hàm delay ngẫu nhiên vào Queue Manager, tối ưu hóa Tracking UI.