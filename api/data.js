// GET /api/data – trả toàn bộ số liệu dashboard cho người đã đăng nhập và được cấp quyền.
//   Authorization: Bearer <Firebase ID token> (tài khoản Microsoft 365 của trường, email trong FBADS_VIEWERS / FBADS_ADMINS)
//   → { ok, docs: {docId: body}, me: {email, role}, sync: {meta: bool} }
import { authorize } from '../server/auth.js';
import { send, safeError } from '../server/http.js';

let cache = null; // { at, docs } – mỗi instance giữ 60 giây để nhiều người mở cùng lúc không đọc Firestore liên tục
export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Chỉ hỗ trợ GET.' });
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken });
    if (!who.ok) return send(res, who.status, who);
    const fresh = /^(1|true)$/.test(String(req.query && req.query.fresh || ''));
    if (!cache || fresh || Date.now() - cache.at > 60000) {
      const { readAll } = await import('../server/store.js');
      cache = { at: Date.now(), docs: await readAll() };
    }
    let docs = cache.docs;
    // chi tiết lỗi đồng bộ (thông báo thô của Meta) chỉ dành cho quản trị
    if (who.role !== 'admin' && docs.meta && docs.meta.perAccount) {
      const perAccount = Object.fromEntries(Object.entries(docs.meta.perAccount).map(([a, x]) => [a, Object.assign({}, x, { error: null })]));
      docs = Object.assign({}, docs, { meta: Object.assign({}, docs.meta, { perAccount }) });
    }
    send(res, 200, { ok: true, docs, me: { email: who.email, role: who.role }, sync: { meta: !!String(process.env.META_ACCESS_TOKEN || '').trim(), ai: !!String(process.env.ANTHROPIC_API_KEY || '').trim() } });
  } catch (e) {
    console.error('[data]', e);
    send(res, e.status || 500, { ok: false, error: safeError(e) });
  }
}
