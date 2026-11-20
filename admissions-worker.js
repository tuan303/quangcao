/* Luồng đọc file tuyển sinh. File Excel do quản trị chọn được đọc ở đây, tách khỏi trang: thư viện đọc file không được nạp vào trang và một file lạ
 * không sửa được dữ liệu hay mã nguồn của trang; trang chỉ nhận lại số tổng hợp rồi tự kiểm tra lại trước khi gửi.
 * Lưu ý: luồng này cùng nguồn gốc với trang nên KHÔNG phải hộp cát kín. An toàn còn dựa vào việc chỉ quản trị tải lên file Excel của chính trường
 * và vào phiên bản thư viện đã biết (SheetJS 0.18.5, xem vendor/README.md). */
importScripts('vendor/xlsx.mini.min.js', 'admissions.js');
self.onmessage = function (e) {
  var out;
  try { out = self.FBAdm.readWorkbook(self.XLSX, e.data); } catch (err) { out = { ok: false, error: 'Không đọc được file Excel.' }; }
  self.postMessage(out);
};
