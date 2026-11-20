# Dashboard Quảng cáo Facebook – Trường Ngôi Sao Hoàng Mai

Báo cáo quảng cáo Facebook cho Chủ tịch HĐQT và Ban Truyền thông. Trang gồm 9 thẻ:

- Tổng quan
- Báo cáo tổng thể
- Xu hướng
- Khối tuyển sinh
- Chuyển đổi
- Chiến dịch
- Nội dung
- Đối tượng
- Phân tích & đề xuất

Số liệu được cập nhật mỗi sáng.

## Cách hoạt động

| Thành phần | Vai trò |
|---|---|
| `index.html`, `fbads-core.js`, `config.js` | Trang tĩnh. Mọi biểu đồ và chỉ số được tính ngay trên trình duyệt. |
| Firebase dự án riêng **quangcao-9a705** | Đăng nhập bằng tài khoản Microsoft 365 của trường. Số liệu nằm trong collection Firestore `fbads`. |
| `api/data.js` | Trả số liệu cho người đã đăng nhập và có tên trong danh sách được xem. |
| `api/ingest.js` | Nhận số liệu do tác vụ Claude đẩy lên mỗi sáng (đã đối chiếu với tổng của Meta). |
| `api/sync.js` | Tuỳ chọn. Khi có `META_ACCESS_TOKEN`, Vercel Cron tự lấy số liệu từ Meta mỗi sáng (gói Hobby chạy trong khoảng 05:00–06:00) và nút “Đồng bộ ngay” hiện cho quản trị. |
| `api/insights.js` | Tuỳ chọn. Khi có `ANTHROPIC_API_KEY`, Claude tự viết phần “Phân tích & đề xuất” mỗi sáng sau đồng bộ (gói Hobby chạy trong khoảng 07:00–08:00) và quản trị bấm được “Viết phân tích ngay”. |
| `admissions.js`, `api/admissions.js`, `vendor/xlsx.mini.min.js` | Thẻ Chuyển đổi: đọc file DATA TUYỂN SINH ngay trong trình duyệt của quản trị, chỉ gửi lên số tổng hợp (không có tên, ngày sinh, số điện thoại học sinh). |
| `benchmarks.js` | Khoảng tham chiếu của quảng cáo ngành giáo dục, kèm nguồn và thời điểm, để so sánh khách quan ngoài so với kỳ trước. |

Dự án Firebase **quangcao-9a705** chỉ phục vụ dashboard này, không dùng chung với dự án nào khác. Collection `fbads` chỉ do máy chủ đọc và ghi (firebase-admin). File `firestore.rules` chặn mọi truy cập trực tiếp từ trình duyệt.

> **Tên miền Vercel.** Trong hướng dẫn này, `<tên-miền-Vercel>` là tên miền thật của trang sau lần triển khai đầu, xem ở Vercel → Project → Settings → Domains (thường có dạng `quangcao-xxxx.vercel.app`, hoặc tên miền riêng của trường). **Không dùng `quangcao.vercel.app`**: tên miền đó đang thuộc một trang web khác.

## Cài đặt dự án Firebase quangcao-9a705 (làm một lần)

1. **Tạo cơ sở dữ liệu Firestore.** Firebase console → Databases & Storage → Firestore → Create database.
   - Chọn **Standard edition**.
   - **Để trống Database ID** để hệ thống tạo `(default)`. Máy chủ chỉ đọc cơ sở dữ liệu này.
   - Location: `asia-southeast1` (Singapore). Không đổi được vị trí sau khi tạo.
   - Chọn **Production mode**, rồi Create.
2. **Đặt quy tắc chặn truy cập từ trình duyệt.** Mở thẻ Rules, dán nội dung file `firestore.rules`, rồi bấm Publish. Hoặc chạy hai lệnh sau trong thư mục repo (cần Node.js 18 trở lên, đăng nhập bằng tài khoản Google sở hữu dự án):

   ```bash
   npx firebase-tools login
   ```

   ```bash
   npx firebase-tools deploy --only firestore:rules --project quangcao-9a705
   ```

3. **Tạo ứng dụng đăng nhập trên Microsoft Entra.** Vào entra.microsoft.com → App registrations → New registration.
   - Đặt tên, ví dụ “Quảng cáo NSHM – Firebase”.
   - Supported account types: **Accounts in this organizational directory only** (single tenant). Bắt buộc chọn đúng mục này.
   - Redirect URI loại **Web**: `https://quangcao-9a705.firebaseapp.com/__/auth/handler`.
   - Ở trang Overview, chép **Application (client) ID**. Đối chiếu **Directory (tenant) ID** với `tenant` trong `config.js` (hiện là `af9ef20a-3158-43a0-a1ab-ad72a03eb4c5`). Ứng dụng single-tenant bắt buộc gửi đúng tenant, nếu sai Microsoft báo lỗi AADSTS50194.
   - Certificates & secrets → New client secret. Chép ngay cột **Value** (không phải Secret ID), vì giá trị chỉ hiện một lần. Hạn tối đa 24 tháng: hãy đặt lịch nhắc tạo secret mới trước ngày hết hạn, nếu không đăng nhập sẽ ngừng hoạt động.
   - API permissions: giữ quyền mặc định Microsoft Graph **User.Read**, rồi bấm **Grant admin consent** (cần quyền quản trị ứng dụng của trường). Nếu không, người dùng có thể gặp thông báo “Need admin approval”.
   - Khuyến nghị: Enterprise applications → ứng dụng vừa tạo → Properties → **Assignment required = Yes**, rồi vào Users and groups để gán những người được xem. Khi đó chỉ người được gán mới đăng nhập được.
4. **Bật đăng nhập Microsoft trong Firebase.** Security → Authentication (bấm Get started nếu là lần đầu) → Sign-in method → Add new provider → Microsoft. Dán Application ID và secret Value ở bước 3, rồi Save.
5. **Kiểm tra Email enumeration protection.** Security → Authentication → Settings → User actions: mục này cần đang bật (dự án mới bật sẵn). Nó ngăn người dùng đổi sang email chưa được xác minh. Người dùng vẫn đổi được sang hộp thư mà họ đọc được, nên chỉ đưa email cá nhân vào `FBADS_VIEWERS` và `FBADS_ADMINS`, không đưa hộp thư dùng chung.
6. **Lấy khóa service account.** Project settings → Service accounts → Generate new private key. Sau khi dán vào Vercel, xoá file JSON khỏi máy và không đưa lên GitHub. Nếu Google báo không cho tạo khóa (Service account key creation is disabled), người quản trị tổ chức Google Cloud cần mở ngoại lệ cho dự án `quangcao-9a705`.

## Triển khai trên Vercel

1. **Import repo** `tuan303/quangcao` vào Vercel bằng Add New → Project, Framework Preset để **Other**. Sau lần triển khai đầu, chép tên miền thật ở Settings → Domains.
2. **Đặt biến môi trường** trong Vercel → Settings → Environment Variables (môi trường Production), rồi **Redeploy**. Các biến bắt buộc và thường dùng có trong `.env.example`.
   - `FIREBASE_SERVICE_ACCOUNT`: dán nguyên nội dung file JSON ở bước 6 phía trên. Nếu trước đây đã đặt khóa của dự án khác, phải thay hẳn; trang sẽ báo rõ khi khóa không khớp dự án.
   - `FBADS_ADMINS`: email quản trị, phân cách bằng dấu phẩy. Quản trị xem được và bấm được “Đồng bộ ngay”.
   - `FBADS_VIEWERS`: email được xem, ví dụ cô Ngà và Ban Truyền thông.
   - `CRON_SECRET` và `INGEST_SECRET`: hai chuỗi ngẫu nhiên khác nhau, tạo bằng lệnh `openssl rand -hex 32`.
   - `META_ACCESS_TOKEN`: tuỳ chọn, xem mục bên dưới.
   - `ANTHROPIC_API_KEY`: tuỳ chọn, để Claude tự viết phân tích mỗi sáng. Xem mục “Phân tích tự động”.
3. **Thêm tên miền của trang** vào Firebase console → Security → Authentication → Settings → Authorized domains: thêm `<tên-miền-Vercel>`. Dự án mới không có sẵn `localhost`; chỉ thêm nếu cần chạy thử trên máy.
4. **Trên máy quản trị** (máy chạy tác vụ Claude), tạo file `~/.claude/scheduled-tasks/fbads-nshm-daily-sync/tools/vercel.env` gồm hai dòng sau rồi chạy `chmod 600` cho file đó:

   ```
   FBADS_URL=https://<tên-miền-Vercel>
   INGEST_SECRET=<đúng chuỗi đã đặt trên Vercel>
   ```

5. **Đẩy số liệu lần đầu.** Bấm **Run now** cho tác vụ “Đồng bộ Dashboard Quảng cáo Facebook – Ngôi Sao Hoàng Mai” trong mục Scheduled của Claude. Từ đó, mỗi sáng tác vụ tự đẩy số liệu và phần nhận định lên Vercel.
6. **Đăng nhập thử và kiểm tra email.** Sau lần đăng nhập đầu, vào Firebase → Security → Authentication → Users và xem cột email của tài khoản vừa đăng nhập. Nếu cột trống, vào Entra → App registrations → ứng dụng → Token configuration → Add optional claim → ID → `email`, rồi Grant admin consent. Ghi `FBADS_VIEWERS` và `FBADS_ADMINS` đúng địa chỉ hiển thị ở đó.

**Đăng nhập dùng cửa sổ bật lên (pop-up).** Nếu trình duyệt chặn pop-up, trang sẽ hướng dẫn cho phép. Trình duyệt bên trong Zalo, Messenger hay Facebook không hỗ trợ đăng nhập; hãy mở link bằng Safari, Chrome hoặc Edge.

**Khuyến nghị giới hạn API key** (Google Cloud console → APIs & Services → Credentials → khóa Browser key):
- Application restrictions → Websites: thêm `https://<tên-miền-Vercel>/*` và `https://quangcao-9a705.firebaseapp.com/*`.
- API restrictions phải còn **Identity Toolkit API** và **Token Service API**.
- Chỉ làm khi `sdk` trong `config.js` từ bản 12.15.0 trở lên (hiện là 12.19.0). Bản xem trước (preview) của Vercel sẽ không đăng nhập được sau khi giới hạn.

## Tuỳ chọn: Vercel tự lấy số liệu từ Meta

Khi có token, trang không còn phụ thuộc máy quản trị phải bật vào buổi sáng. Ngoài ra, quản trị bấm “Đồng bộ ngay” là có số liệu mới tức thì.

Trang chỉ kết nối hai tài khoản quảng cáo, khai báo trong `ACCOUNTS` ở `fbads-core.js`:

| Tài khoản | ID |
|---|---|
| TK Fanpage Trường | `895057262833914` |
| TK Facebook cô Ngà | `1870132100153072` |

Số liệu cũ của các tài khoản đã gỡ vẫn nằm trong Firestore nhưng không hiển thị và không được đồng bộ nữa. Biến `META_AD_ACCOUNTS`, nếu có, chỉ dùng được để bớt tài khoản; tài khoản ngoài danh sách trên bị bỏ qua. Tài khoản bị bớt cũng không hiển thị trên trang và không đưa vào bản phân tích (số liệu của nó không còn được cập nhật). Để trống biến này là đúng nhất.

1. Vào Business Manager có hai tài khoản trên, chọn **Tài khoản quảng cáo**. Tài khoản nào chưa có thì thêm bằng **Thêm → Yêu cầu quyền truy cập**. Không chọn “Nhận quyền sở hữu” nếu không chắc chắn.
2. Vào **Người dùng hệ thống** và tạo một System User. Gán tài sản là đúng hai tài khoản quảng cáo trên với quyền **Xem hiệu quả**. Gỡ các tài khoản khác khỏi System User nếu trước đây đã gán.
3. Bấm **Tạo token mới**, chọn quyền **ads_read** và hạn **Không bao giờ hết hạn**. Dán token vào biến `META_ACCESS_TOKEN` trên Vercel, rồi Redeploy.
4. Chạy thử, không ghi dữ liệu. Chỉ làm sau khi đã đẩy số liệu lần đầu (bước 5 phần Triển khai), để có số liệu cũ mà đối chiếu:

   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET>" "https://<tên-miền-Vercel>/api/sync?dry=1&groups=base"
   ```

   Kết quả cần có `"ok": true`, `checks.mismatches` rỗng và `checks.checkedDays` lớn hơn 0. Máy chủ đối chiếu số liệu mới với số liệu đang lưu; nếu lệch ở nhiều ngày, máy chủ không ghi.

Lần đồng bộ đầu tiên lấy số liệu từ 01/03/2025. Mỗi lần đồng bộ được chạy tối đa 300 giây (Fluid compute, bật trong `vercel.json`). Nếu không kịp, máy chủ ghi phần đã lấy được (số liệu gần đây được lấy trước) và lần sau lấy tiếp phần lịch sử còn thiếu. Nhóm mẫu quảng cáo hoặc đối tượng chưa lấy xong cũng được lấy tiếp ở lần đồng bộ sau, không phải chờ tới ngày theo lịch; thử tối đa 3 lần liên tiếp, sau đó quay về lịch hằng tuần. Hai lần đồng bộ không chạy chồng lên nhau: lần sau được báo “đang có lần đồng bộ khác chạy” và trang tự cập nhật khi xong. Tiến độ lưu ở tài liệu `syncstate`. Khi một tài khoản chưa lấy đủ, trang hiện thông báo màu vàng ghi rõ tài khoản đó. Quản trị còn thấy thêm lỗi chi tiết của Meta.

Phiên bản Meta Graph API mặc định là `v25.0`, vì v23.0 đã hết hạn cho Marketing API từ 09/06/2026. Có thể đổi bằng biến `META_API_VERSION`.

Lịch đồng bộ trong ngày:

| Nhóm số liệu | Nội dung | Khi nào |
|---|---|---|
| `base` | số liệu ngày, chiến dịch, tiếp cận | mỗi ngày |
| `ads` | mẫu quảng cáo và nội dung bài | thứ 2 và thứ 5 |
| `bd` | độ tuổi, giới tính, tỉnh, nền tảng, thiết bị | thứ 3 và thứ 6 |

## Báo cáo ngày (có ngay, không cần cấu hình thêm)

Đầu thẻ **Tổng quan** có khối **Báo cáo ngày**. Khối này tự tính từ số liệu đã đồng bộ, nên có ngay sau mỗi lần đồng bộ:

- hôm qua so với trung bình 7 ngày trước đó;
- 7 ngày qua so với 7 ngày trước;
- tháng này đến nay so với cùng kỳ tháng trước;
- lead theo khối, chiến dịch ra nhiều lead nhất, chiến dịch tốn tiền mà chưa ra lead;
- so với mặt bằng ngành và tài khoản chưa đồng bộ đủ (nếu có).

Nút **Sao chép gửi Zalo** chép bản chữ để dán vào Zalo hoặc email gửi Chủ tịch.

## Chuyển đổi tuyển sinh (thẻ Chuyển đổi)

Thẻ này cho thấy lead quảng cáo Facebook trở thành học sinh đăng ký và học sinh đã đóng phí (ĐP) ra sao, theo từng chương trình (TS1, JS, TS6, TS10, HB), theo khối và theo thời gian. Số liệu tuyển sinh lấy từ file **DATA TUYỂN SINH** (Google Sheets).

**Cách cập nhật** (chỉ tài khoản quản trị): tải file về từ Google Sheets (Tệp → Tải xuống → Microsoft Excel), vào thẻ Chuyển đổi, bấm **Tải file tuyển sinh (.xlsx)**. File được đọc ngay trong trình duyệt, ở một luồng riêng tách khỏi trang; chỉ số tổng hợp được gửi lên, tên, ngày sinh, số điện thoại không rời khỏi máy; máy chủ dựng lại bản tổng hợp theo đúng cấu trúc đã biết (bỏ mọi trường lạ, từ chối số sai dạng hoặc không khớp tổng) và `/api/data` kiểm tra lại một lần nữa trước khi trả ra. Trước khi lưu, trang hiện hộp xác nhận so số mới với số đang có và nêu các lưu ý về file (dòng bị bỏ, tab không đọc được, cột ngày chưa đủ). Mỗi lần tải thay thế lần trước. Chỉ đọc được .xlsx thật (file .xls, .xlsb, .ods, .csv hay file có mật khẩu bị từ chối).

**Trang đọc những gì**
- Tab **Danh sách đăng ký**: cột `MDT`, `HS nội bộ` (bắt buộc, để tách học sinh nội bộ), `Họ tên học sinh`, `Khối …`, `Chiến dịch` (mã chương trình). Học sinh nội bộ là cột này có mã. Thêm cột **Ngày đăng ký** (và **Ngày đóng phí**, không bắt buộc) thì xem được theo khoảng thời gian đang chọn, có biểu đồ theo tuần/tháng và so với lead, chi tiêu cùng kỳ. Ô ngày có thể là ô ngày của Excel hoặc chữ dd/mm/yyyy, dd/mm/yy, yyyy-mm-dd; ngày không có thật hoặc năm ngoài 2020–2040 tính là chưa có ngày. Ngày **sau ngày tải file** hoặc **sớm hơn đầu mùa quảng cáo hơn ba tháng** (thường là gõ nhầm năm) cũng bị bỏ qua, được đếm và báo trong hộp xác nhận, để một ô sai không kéo cả khoảng thời gian của báo cáo. **Chỉ khi từ 90% học sinh có Ngày đăng ký đọc được** thì trang mới xem theo kỳ; ít hơn thì là số tích luỹ cả mùa và trang nói rõ vì sao.
- Các tab có đuôi **(ĐP)**: học sinh có mặt ở đây là đã đóng phí, ghép với danh sách đăng ký qua `MDT` (cột MDT có thể ở bất kỳ cột nào). Tab có chữ ĐP nhưng không kết thúc bằng "(ĐP)" hoặc không có cột MDT được báo là không đọc được. Nếu tên tab có mã mùa (ví dụ `LỚP 6 2728 (ĐP)`) mà khác mùa của tab Danh sách đăng ký (tiêu đề cột Khối ghi "27 28") thì tab đó là của mùa khác để lại trong file: không được cộng vào mùa này và được báo.
- Dòng thiếu hoặc sai MDT/họ tên không được tính nhưng được đếm và báo.

**Cách tính**
- Học sinh nội bộ được tách riêng và không tính vào tỷ lệ từ lead Facebook. Dòng **Tổng** chỉ cộng năm chương trình TS1, JS, TS6, TS10, HB (có chiến dịch Facebook để ghép). Học sinh mang mã chương trình khác (ví dụ một chương trình mới) hoặc để trống ô Chiến dịch hiện riêng, kèm ghi chú, và không cộng vào Tổng, vì không có lead hay chi tiêu Facebook tương ứng. Ô Chiến dịch được hiểu như tên chiến dịch: "Học bổng", "HB27", "TS 06", "Jolly" gộp vào mã chuẩn.
- Chương trình ghép với chiến dịch Facebook theo tên chiến dịch: mã `TS10`, `TS6`, `TS1`, `JS` (hoặc "Jolly") đứng gần đầu tên thắng, chịu được "TS 6", "TS-6"; chiến dịch mang hai mã TS khác nhau (nhiều khối) để ở "chưa ghép"; chiến dịch có chữ "học bổng" hoặc "HB" mà chưa có mã nào tính cho HB. Chiến dịch khác (thương hiệu, trại hè…) hiện riêng, không vào tỷ lệ.
- Lead → đăng ký → ĐP = học sinh ngoài nội bộ ÷ lead Facebook của chương trình. Chi phí / đăng ký và chi phí / ĐP = chi tiêu Facebook của chương trình ÷ số học sinh tương ứng. Đăng ký có thể đến cả từ nguồn ngoài Facebook nên đây là ước tính gộp; tỷ lệ trên 100% nghĩa là có đăng ký đến từ nguồn khác (có dấu * và chương trình đó không được dùng để xếp hạng tỷ lệ hay chi phí / ĐP).
- Khi xem theo kỳ: lấy nhóm học sinh đăng ký trong kỳ rồi xem bao nhiêu em trong nhóm đã đóng phí tính đến nay. Học sinh mới đăng ký có thể chưa kịp đóng phí nên kỳ gần nhất thấp hơn thực tế. Lead và chi tiêu Facebook chỉ tính trong khoảng file có số đăng ký (từ đầu mùa đến ngày tải file, hoặc đến 31/07 nếu mùa trong file đã hết); kỳ nằm ngoài khoảng đó thì trang báo, không hiện số 0. Cảnh báo "nên rà soát khâu liên hệ" chỉ đưa ra khi kỳ dài từ 4 tuần, vì học sinh thường đăng ký sau lead vài ngày.
- Số tích luỹ cả mùa: lead và chi tiêu Facebook tính từ 01/08 của năm trước mùa trong file (mùa 2027–28 → từ 01/08/2026) **đến ngày tải file lên**, để lead cùng mốc thời gian với số đăng ký trong file; file cũ hơn 3 ngày thì trang nhắc tải lại. Mùa ghi trong tiêu đề cột Khối phải là hai năm liên tiếp ("27 28"); ghi sai thì bị bỏ qua, và mùa chưa bắt đầu thì trang báo thay vì hiện số 0.
- Thẻ này luôn tính chung các tài khoản tuyển sinh, không theo bộ lọc tài khoản ở thanh trên.
- Dưới 10 học sinh hoặc lead thì không tính phần trăm hay xếp hạng.

Phần Phân tích của Claude và Báo cáo tổng thể cũng dùng các số này khi đã có file tuyển sinh. Thư viện đọc Excel (SheetJS 0.18.5, bản mini) nằm trong `vendor/` và chạy trong luồng riêng `admissions-worker.js` (hết 90 giây thì dừng), chỉ tải khi quản trị bấm tải file; kết quả trả về được kiểm tra lại bằng `validate()` trước khi gửi. Bản 0.18.5 có hai lỗi đã biết khi đọc file được làm riêng (treo khi đọc, ô nhiễm prototype). Luồng riêng giữ thư viện ra khỏi bộ nhớ của trang, nhưng cùng nguồn gốc với trang nên **không phải hộp cát kín**; an toàn còn dựa vào việc chỉ quản trị tải file và chỉ nên tải file xuất từ Google Sheets của trường. Nên nâng thư viện lên SheetJS 0.20.2 trở lên khi có thể tải được bản đó. **Kho mã này công khai: tuyệt đối không đưa file Excel, số điện thoại, email hay số liệu học sinh thật vào kho, kể cả trong bài kiểm thử** (dùng số giả). `.gitignore` chặn các đuôi file dữ liệu; `npm test` quét số điện thoại và email trong các file đang theo dõi; `npm run privacy` quét **mọi nhánh và toàn bộ lịch sử git** (kể cả nhánh cũ chưa xoá) và thoát lỗi nếu thấy gì. Nếu lỡ đẩy dữ liệu thật lên: xoá cả nhánh đó trên GitHub (sửa lại commit rồi đẩy sang tên nhánh mới không gỡ được bản cũ), rồi nhờ GitHub Support gỡ mã commit khỏi bộ nhớ đệm. Những chỗ đã biết nằm sẵn trong lịch sử của `main` và chỉ gỡ được bằng cách viết lại lịch sử được ghi ở `scripts/privacy-baseline.json`.

## Báo cáo tổng thể (thẻ thứ hai)

Bản báo cáo cho Ban lãnh đạo, đọc từ trên xuống hoặc bấm **In / Lưu PDF** (khổ A4, luôn nền trắng). Báo cáo theo kỳ và tài khoản ở thanh lọc, kỳ dừng ở hết hôm qua vì hôm nay chưa trọn ngày; ba nút chọn nhanh là 7 ngày qua, Tháng trước và Năm học. Các phần, theo đúng thứ tự trên trang:

1. Đầu báo cáo:
   - kỳ, kỳ so sánh, tài khoản, giờ đồng bộ;
   - cảnh báo nếu thiếu số liệu;
   - bốn con số chính, so với kỳ trước và cùng kỳ năm trước.
2. Kết luận chính.
3. Việc cần làm tiếp theo: của Claude nếu bản phân tích còn mới, nếu không thì gợi ý tự động; kèm cảnh báo 7 ngày gần nhất.
4. Theo khối tuyển sinh.
5. Chuyển đổi tuyển sinh: từ lead Facebook đến học sinh đã đóng phí (chỉ hiện sau khi quản trị tải file tuyển sinh và khi kỳ báo cáo nằm trong số liệu đăng ký).
6. Mùa tuyển sinh: từng tháng so với năm học trước.
7. Nhịp chi ngân sách tháng này.
8. Chiến dịch và vận hành: tiền chưa ra lead, chiến dịch nổi bật, chiến dịch cần xem lại, mẫu quảng cáo ra lead rẻ.
9. Theo tài khoản và mục tiêu quảng cáo.
10. So với mặt bằng ngành giáo dục tại Việt Nam (30 ngày trọn gần nhất).
11. Cách đọc số liệu.

Nút **Sao chép tóm tắt** chép kết luận, việc cần làm, cảnh báo và (khi có file tuyển sinh) khối Chuyển đổi tuyển sinh để gửi qua Zalo hoặc email. Đường link kèm theo (`#bao-cao?p=<kỳ>&a=<tài khoản>`) mở đúng kỳ và tài khoản của bản báo cáo đó.

Các ngưỡng tự động là quy ước của trang, dùng để gợi ý:

| Ngưỡng | Dùng để |
|---|---|
| 5 lead | Mới tính chi phí/lead cho một khối, chiến dịch hay mẫu quảng cáo |
| 20 lead mỗi kỳ | Mới so phần trăm; dưới mức này chỉ ghi số lead hai kỳ |
| Chi phí/lead thay đổi quá 10% | Đánh giá tự động tốt hơn hay kém hơn kỳ trước. Lead rẻ hơn nhưng giảm quá 20% thì ghi riêng |
| 300.000 ₫ chưa ra lead | Đưa chiến dịch thu lead vào danh sách cần xem lại |
| Chi phí/lead từ 1,5 lần bình quân | Đưa chiến dịch thu lead vào danh sách cần xem lại |
| Từ 10 lead và chi phí/lead ≤ 0,8 lần bình quân | Gợi ý cân nhắc tăng ngân sách (chỉ chiến dịch đang chạy) |
| 3% và 10% chi tiêu | Mức "theo dõi" và "cần xử lý" của tiền chưa ra lead |

## Tuỳ chọn: Phân tích tự động bằng Claude

Phần **Phân tích & đề xuất** (nhận định, đánh giá, việc nên làm, tuyến bài, lịch nội dung, so với mặt bằng ngành) do Claude viết từ số liệu đang lưu.

1. Tạo khóa API ở [console.anthropic.com](https://console.anthropic.com) → API Keys. Nạp một ít tiền vào Billing; mỗi lần viết tốn khoảng vài nghìn đồng.
2. Dán khóa vào biến `ANTHROPIC_API_KEY` trên Vercel (môi trường Production), rồi **Redeploy**.
3. Quản trị mở trang và bấm **Viết phân tích chuyên sâu ngay** (mất 1–3 phút). Từ hôm sau, Vercel Cron tự viết lại mỗi sáng sau khi đồng bộ.

Chạy thử, không ghi:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<tên-miền-Vercel>/api/insights?dry=1"
```

Mô hình mặc định là `claude-opus-5-5`; đổi bằng biến `INSIGHTS_MODEL` nếu cần. Nếu tác vụ Claude trên máy quản trị cũng đẩy phần nhận định lên, bản ghi sau cùng sẽ được hiển thị.

## So với mặt bằng ngành giáo dục

`benchmarks.js` chỉ ghi mặt bằng quảng cáo ngành giáo dục tại Việt Nam (chi phí/lead, chi phí/lượt nhấp), kèm phạm vi, nguồn, đường dẫn và thời điểm, cùng phần so sánh của Meta với các trường học, mầm non cùng chạy quảng cáo thu lead. Trang đặt số của trường cạnh các khoảng đó. Chỉ số về lead chỉ tính các chiến dịch có mục tiêu thu lead. Chưa có báo cáo có phương pháp cho riêng giáo dục tại Việt Nam, nên các khoảng lấy từ blog agency trong nước, độ tin cậy thấp.

Đây là mốc tham khảo, không phải chuẩn tuyệt đối: thị trường, mục tiêu chiến dịch và mùa tuyển sinh đều làm số khác đi. Cập nhật tệp khi có báo cáo mới, rồi chạy `npm test`.

## Kiểm thử

```bash
npm install
npm test
```

Bộ kiểm thử chạy offline với Meta API giả lập. Nó kiểm tra:

- cách đọc trường `actions` (lead, click, tương tác, lưu, chia sẻ);
- cách chuyển bộ lọc trạng thái và cách tự bỏ trường Meta không hỗ trợ;
- quyền xem;
- gói số liệu cho phân tích, cấu trúc đầu ra của Claude và phép so với mặt bằng ngành;
- chuyển đổi tuyển sinh: đọc bảng, tổng hợp, ghép chương trình với chiến dịch Facebook, tỷ lệ, khoảng thời gian (ngày gõ nhầm năm, mốc ngày tải file, mùa đã hết hoặc chưa bắt đầu), phần ngoài dòng Tổng và việc máy chủ chỉ nhận số tổng hợp;
- quyền riêng tư: người chỉ xem không thấy email của quản trị, bộ quét số điện thoại và email trong kho mã và trong mọi nhánh git (`npm run privacy` chạy riêng, quét cả lịch sử).

## Lưu ý số liệu

- **Lead** là lead do Meta ghi nhận, gồm form và Messenger. Khi lấy trực tiếp từ Meta API, trang dùng loại `lead` (tổng của Meta). Nếu Meta không trả loại này, trang lấy một giá trị lead trên Meta (`onsite_conversion.lead_grouped`, rồi `leadgen_grouped`, rồi `leadgen.other`) cộng một giá trị lead website (`offsite_conversion.fb_pixel_lead`). Các loại chồng lên nhau không bao giờ được cộng hai lần.
- **Chi phí/lead** = chi tiêu của các chiến dịch thu lead (mục tiêu “Khách hàng tiềm năng”) ÷ lead của chính các chiến dịch đó. Chi cho thương hiệu, tương tác, lưu lượng ghi riêng là “chi thương hiệu, tương tác” và không tính vào chi phí/lead. Lead của các chiến dịch khác (tin nhắn, tương tác…) vẫn nằm trong “Lead thu được” nhưng không tính vào chi phí/lead; trang ghi rõ số lead đó. Kỳ cũ hơn khoảng 2 tháng mà không trọn tháng thì chia số theo tháng của chiến dịch cho các ngày chiến dịch chạy nên là ước tính. Khi số theo chiến dịch chưa phủ đủ chi tiêu của tài khoản trong kỳ (80%–125%), trang tạm tính bằng tổng chi tiêu ÷ tổng lead và ghi rõ; hai kỳ chỉ được so sánh khi cùng cách tính.
- **Tiếp cận** khi cộng nhiều tài khoản có thể đếm trùng người.
- **Dữ liệu** bắt đầu từ 01/03/2025. Số liệu của ngày hôm nay chưa trọn ngày.
- **Lượt xem**: khi lấy trực tiếp từ Meta API, chỉ số này dùng trường `views`. Nếu Meta không trả trường đó, trang dùng lượt hiển thị thay thế.

## Công cụ đồng bộ của tác vụ Claude (`tools/`)

Đây là bản sao các công cụ mà tác vụ Claude hằng ngày dùng (bản đang chạy nằm ở `~/.claude/scheduled-tasks/fbads-nshm-daily-sync/tools/`). Mọi công cụ đều dùng chung `fbads-core.js` ở thư mục gốc. Sau khi cập nhật mã (hai tài khoản, cách tính chi phí/lead), cần chép lại `fbads-core.js` và thư mục `tools/` vào thư mục của tác vụ để bản đang chạy dùng cùng cách tính.

| Tệp | Việc |
|---|---|
| `plan.mjs` | In danh sách lời gọi Facebook Ads cho một lần đồng bộ (`--mode=quick` hoặc `full`) |
| `build.mjs` | Chuyển số liệu thô thành tài liệu dashboard và đối chiếu với tổng của Meta (`ALL CHECKS PASSED`) |
| `batches.mjs` | Chia tài liệu thành các đợt ghi vào kho số liệu của bản claude.ai |
| `pack.mjs`, `themes.mjs` | Tính sẵn mọi con số cho phần nhận định và hiệu quả theo tuyến nội dung |
| `check_raw.py`, `creative_ids.py` | Kiểm tra tệp số liệu thô và lấy mã nội dung quảng cáo |
| `insights.schema.json` | Cấu trúc bắt buộc của tài liệu nhận định |
