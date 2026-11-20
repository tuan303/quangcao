/* Luồng đọc file tuyển sinh. File Excel do quản trị chọn được đọc ở đây, tách khỏi trang: file lạ không chạm được vào trang,
 * mã đăng nhập hay số liệu đã tải; trang chỉ nhận lại số tổng hợp rồi tự kiểm tra lại trước khi gửi. */
importScripts('vendor/xlsx.mini.min.js', 'admissions.js');
self.onmessage = function (e) {
  var out;
  try { out = self.FBAdm.readWorkbook(self.XLSX, e.data); } catch (err) { out = { ok: false, error: 'Không đọc được file Excel.' }; }
  self.postMessage(out);
};
