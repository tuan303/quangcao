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
      await import('../fbads-core.js');
      const { scopeDocs, checkedAdmissionsDocs, checkedMatchDocs } = await import('../server/scope.js');
      cache = { at: Date.now(), docs: await checkedMatchDocs(await checkedAdmissionsDocs(scopeDocs(globalThis.FBCore, await readAll(), process.env))) }; // chỉ hai tài khoản đang kết nối
    }
    let docs = cache.docs;
    // thông báo lỗi thô của Meta và email của quản trị (người đồng bộ, người tải số liệu tuyển sinh, người viết phân tích) chỉ dành cho quản trị
    if (who.role !== 'admin') { const { redactForViewer } = await import('../server/scope.js'); docs = redactForViewer(docs); }
    // cấu hình cập nhật tự động số đối chiếu phụ huynh; quản trị còn thấy email service account để biết chia sẻ Sheet cho ai
    const { leadSyncConfig } = await import('../server/leadsync.js');
    let leads = leadSyncConfig(process.env);
    if (who.role === 'admin') { try { const sa = (await import('../server/gsheets.js')).serviceAccountInfo(process.env); if (sa) leads = Object.assign({}, leads, { email: sa.email, projectId: sa.projectId }); } catch { /* cấu hình hỏng được báo ở phần kiểm tra kết nối */ } }
    send(res, 200, { ok: true, docs, me: { email: who.email, role: who.role }, sync: { meta: !!String(process.env.META_ACCESS_TOKEN || '').trim(), ai: !!String(process.env.ANTHROPIC_API_KEY || '').trim(), leads } });
  } catch (e) {
    console.error('[data]', e);
    send(res, e.status || 500, { ok: false, error: safeError(e) });
  }
}
