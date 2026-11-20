// GET /api/data – trả toàn bộ số liệu dashboard cho người đã đăng nhập và được cấp quyền.
//   Authorization: Bearer <Firebase ID token> (tài khoản Microsoft 365 của trường, email trong FBADS_VIEWERS / FBADS_ADMINS)
//   → { ok, docs: {docId: body}, me: {email, role}, sync: {meta: bool} }
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

let cache = null; // { at, docs } – mỗi instance giữ 60 giây để nhiều người mở cùng lúc không đọc Firestore liên tục
/* Tài liệu tuyển sinh luôn đi qua kiểm tra cấu trúc trước khi trả ra, dù được ghi bằng đường nào: chỉ số tổng hợp theo đúng dạng đã biết mới ra trang. */
async function checkedAdmissions(docs) {
  if (!docs.admissions) return docs;
  await import('../admissions.js');
  const raw = docs.admissions, v = globalThis.FBAdm.validate(raw), next = Object.assign({}, docs);
  if (v.ok) {
    // uploadedAt và by do máy chủ ghi: chỉ nhận đúng dạng (giờ ISO, một địa chỉ email ngắn), chuỗi khác bị bỏ
    const at = typeof raw.uploadedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw.uploadedAt) && Number.isFinite(Date.parse(raw.uploadedAt)) ? raw.uploadedAt : null;
    const by = typeof raw.by === 'string' && raw.by.length <= 100 && /^[^\s@<>"']+@[^\s@<>"']+$/.test(raw.by) ? raw.by : null;
    next.admissions = Object.assign({}, v.summary, { uploadedAt: at, by });
  } else { console.warn('[data] tài liệu admissions bị loại vì sai cấu trúc:', v.error); delete next.admissions; }
  return next;
}
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Chỉ hỗ trợ GET.' });
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken });
    if (!who.ok) return send(res, who.status, who);
    const fresh = /^(1|true)$/.test(String(req.query && req.query.fresh || ''));
    if (!cache || fresh || Date.now() - cache.at > 60000) {
      const { readAll } = await import('../server/store.js');
      await import('../fbads-core.js');
      const { scopeDocs } = await import('../server/scope.js');
      cache = { at: Date.now(), docs: await checkedAdmissions(scopeDocs(globalThis.FBCore, await readAll(), process.env)) }; // chỉ hai tài khoản đang kết nối
    }
    let docs = cache.docs;
    // thông báo lỗi thô của Meta và email của quản trị (người đồng bộ, người tải số liệu tuyển sinh, người viết phân tích) chỉ dành cho quản trị
    if (who.role !== 'admin') { const { redactForViewer } = await import('../server/scope.js'); docs = redactForViewer(docs); }
    send(res, 200, { ok: true, docs, me: { email: who.email, role: who.role }, sync: { meta: !!String(process.env.META_ACCESS_TOKEN || '').trim(), ai: !!String(process.env.ANTHROPIC_API_KEY || '').trim() } });
  } catch (e) {
    console.error('[data]', e);
    send(res, e.status || 500, { ok: false, error: safeError(e) });
  }
}
