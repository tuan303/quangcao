// Tiện ích chung cho các hàm Vercel.
export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(body));
}
export function safeError(e) {
  if (e && e.expose) return e.message;
  const msg = String(e && e.message || '');
  if (/PERMISSION_DENIED/.test(msg)) return 'Service account không có quyền đọc/ghi Firestore.';
  if (/NOT_FOUND/.test(msg) && /database/i.test(msg)) return 'Chưa tạo cơ sở dữ liệu Firestore cho dự án Firebase.';
  if (/RESOURCE_EXHAUSTED|quota/i.test(msg)) return 'Đã vượt hạn mức Firestore. Vui lòng thử lại sau.';
  return 'Lỗi máy chủ. Xem log của hàm trên Vercel để biết chi tiết.';
}
export async function readJson(req, limit = 4 * 1024 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Dữ liệu gửi lên quá lớn.'), { expose: true, status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Dữ liệu gửi lên không phải JSON.'), { expose: true, status: 400 }); }
}
