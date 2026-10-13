# Dashboard Quảng cáo Facebook – Trường Ngôi Sao Hoàng Mai

Báo cáo quảng cáo Facebook cho Chủ tịch HĐQT và Ban Truyền thông. Trang gồm 7 thẻ:

- Tổng quan
- Xu hướng
- Khối tuyển sinh
- Chiến dịch
- Nội dung
- Khán giả
- Phân tích & đề xuất

Số liệu được cập nhật mỗi sáng.

## Cách hoạt động

| Thành phần | Vai trò |
|---|---|
| `index.html`, `fbads-core.js`, `config.js` | Trang tĩnh. Mọi biểu đồ và chỉ số được tính ngay trên trình duyệt. |
| Firebase dự án **dugiotih** (dùng chung với Dashboard dự giờ) | Đăng nhập bằng tài khoản Microsoft 365 của trường. Số liệu nằm trong collection Firestore `fbads`. |
| `api/data.js` | Trả số liệu cho người đã đăng nhập và có tên trong danh sách được xem. |
| `api/ingest.js` | Nhận số liệu do tác vụ Claude đẩy lên mỗi sáng (đã đối chiếu với tổng của Meta). |
| `api/sync.js` | Tuỳ chọn. Khi có `META_ACCESS_TOKEN`, Vercel Cron tự lấy số liệu từ Meta lúc 06:30 và nút “Đồng bộ ngay” hiện cho quản trị. |

**Không cần tạo dự án Firebase mới.** Collection `fbads` chỉ do máy chủ đọc và ghi (firebase-admin), trình duyệt không truy cập trực tiếp. Vì vậy không phải sửa `firestore.rules` của Dashboard dự giờ, miễn là các quy tắc hiện có không mở collection lạ cho người dùng. Hiện tại chúng chặn mặc định.

## Triển khai lần đầu

1. **Tạo repo GitHub** (ví dụ `tuan303/quangcao-nshm`) và đẩy toàn bộ thư mục này lên. Trên Vercel chọn **Add New → Project**, import repo, Framework Preset để **Other**.
2. **Đặt biến môi trường** trong Vercel → Settings → Environment Variables (môi trường Production), rồi **Redeploy**. Danh sách đầy đủ có trong `.env.example`.
   - `FIREBASE_SERVICE_ACCOUNT`: dùng lại đúng giá trị đang đặt cho Dashboard dự giờ.
   - `FBADS_ADMINS`: email quản trị, phân cách bằng dấu phẩy. Quản trị xem được và bấm được “Đồng bộ ngay”.
   - `FBADS_VIEWERS`: email được xem, ví dụ cô Ngà và Ban Truyền thông.
   - `CRON_SECRET` và `INGEST_SECRET`: hai chuỗi ngẫu nhiên khác nhau, tạo bằng lệnh `openssl rand -hex 32`.
   - `META_ACCESS_TOKEN`: tuỳ chọn, xem mục bên dưới.
3. **Firebase console → Authentication → Settings → Authorized domains**: thêm tên miền Vercel của trang, ví dụ `quangcao-nshm.vercel.app`. Ứng dụng Microsoft trên Entra giữ nguyên, không cần sửa.
4. **Trên máy quản trị** (máy chạy tác vụ Claude), tạo file `~/.claude/scheduled-tasks/fbads-nshm-daily-sync/tools/vercel.env` gồm hai dòng sau rồi chạy `chmod 600` cho file đó:

   ```
   FBADS_URL=https://quangcao-nshm.vercel.app
   INGEST_SECRET=<đúng chuỗi đã đặt trên Vercel>
   ```

5. **Đẩy số liệu lần đầu.** Bấm **Run now** cho tác vụ “Đồng bộ Dashboard Quảng cáo Facebook – Ngôi Sao Hoàng Mai” trong mục Scheduled của Claude. Từ đó, mỗi sáng tác vụ tự đẩy số liệu và phần nhận định lên Vercel.

## Tuỳ chọn: Vercel tự lấy số liệu từ Meta

Khi có token, trang không còn phụ thuộc máy quản trị phải bật lúc 06:30. Ngoài ra, quản trị bấm “Đồng bộ ngay” là có số liệu mới tức thì.

1. Vào Business Manager **Công ty CP Giáo dục Đông Đô**. Hai tài khoản quảng cáo `1870132100153072` (Fanpage trường) và `163604412431952` chưa thuộc Business nào. Thêm chúng vào Business bằng **Tài khoản quảng cáo → Thêm → Yêu cầu quyền truy cập**. Không chọn “Nhận quyền sở hữu” nếu không chắc chắn.
2. Vào **Người dùng hệ thống** và tạo một System User. Gán tài sản là 4 tài khoản quảng cáo với quyền **Xem hiệu quả**.
3. Bấm **Tạo token mới**, chọn quyền **ads_read** và hạn **Không bao giờ hết hạn**. Dán token vào biến `META_ACCESS_TOKEN` trên Vercel, rồi Redeploy.
4. Chạy thử, không ghi dữ liệu:

   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET>" "https://quangcao-nshm.vercel.app/api/sync?dry=1&groups=base"
   ```

   Kết quả cần có `"ok": true` và `mismatches` rỗng. Máy chủ đối chiếu số liệu mới với số liệu đang lưu. Nếu lệch ở nhiều ngày, máy chủ không ghi.

Lịch đồng bộ trong ngày:

| Nhóm số liệu | Nội dung | Khi nào |
|---|---|---|
| `base` | số liệu ngày, chiến dịch, tiếp cận | mỗi ngày |
| `ads` | mẫu quảng cáo và nội dung bài | thứ 2 và thứ 5 |
| `bd` | độ tuổi, giới tính, tỉnh, nền tảng, thiết bị | thứ 3 và thứ 6 |

Phần **Phân tích & đề xuất** (nhận định, tuyến bài, lịch nội dung) vẫn do tác vụ Claude viết mỗi sáng. Phần này cần mô hình ngôn ngữ nên Vercel không tự làm.

## Kiểm thử

```bash
npm install
npm test
```

Bộ kiểm thử chạy offline với Meta API giả lập. Nó kiểm tra cách đọc trường `actions` (lead, click, tương tác, lưu, chia sẻ), cách chuyển bộ lọc trạng thái, cách tự bỏ trường Meta không hỗ trợ, và quyền xem.

## Lưu ý số liệu

- **Lead** là lead do Meta ghi nhận, gồm form và Messenger.
- **Tiếp cận** khi cộng nhiều tài khoản có thể đếm trùng người.
- **Dữ liệu** bắt đầu từ 01/03/2025. Số liệu của ngày hôm nay chưa trọn ngày.
- **Lượt xem**: khi lấy trực tiếp từ Meta API, chỉ số này dùng trường `views`. Nếu Meta không trả trường đó, trang dùng lượt hiển thị thay thế.

## Công cụ đồng bộ của tác vụ Claude (`tools/`)

Đây là bản sao các công cụ mà tác vụ Claude hằng ngày dùng (bản đang chạy nằm ở `~/.claude/scheduled-tasks/fbads-nshm-daily-sync/tools/`). Mọi công cụ đều dùng chung `fbads-core.js` ở thư mục gốc.

| Tệp | Việc |
|---|---|
| `plan.mjs` | In danh sách lời gọi Facebook Ads cho một lần đồng bộ (`--mode=quick` hoặc `full`) |
| `build.mjs` | Chuyển số liệu thô thành tài liệu dashboard và đối chiếu với tổng của Meta (`ALL CHECKS PASSED`) |
| `batches.mjs` | Chia tài liệu thành các đợt ghi vào kho số liệu của bản claude.ai |
| `pack.mjs`, `themes.mjs` | Tính sẵn mọi con số cho phần nhận định và hiệu quả theo tuyến nội dung |
| `check_raw.py`, `creative_ids.py` | Kiểm tra tệp số liệu thô và lấy mã nội dung quảng cáo |
| `insights.schema.json` | Cấu trúc bắt buộc của tài liệu nhận định |
