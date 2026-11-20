// POST /api/admissions – quản trị tải lên số tổng hợp từ file DATA TUYỂN SINH (đã tính trong trình duyệt).
//   Authorization: Bearer <Firebase ID token> của tài khoản quản trị (FBADS_ADMINS);  body: { summary }
//   Chỉ nhận SỐ TỔNG HỢP: mọi trường ngoài cấu trúc đã biết (tên, số điện thoại…) bị loại, dạng sai bị từ chối.
//   Ghi vào tài liệu `admissions` của kho số liệu; trang đọc qua /api/data như các tài liệu khác.
import { authorize } from '../server/auth.js';
import { send, safeError, readJson } from '../server/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Chỉ hỗ trợ POST.' });
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken });
    if (!who.ok) return send(res, who.status, who);
    if (who.role !== 'admin') return send(res, 403, { ok: false, error: 'Chỉ quản trị mới được tải số liệu tuyển sinh.' });
    const body = await readJson(req, 1024 * 1024);
    await import('../admissions.js');
    const v = globalThis.FBAdm.validate(body && body.summary);
    if (!v.ok) return send(res, 400, { ok: false, error: v.error });
    const doc = Object.assign({}, v.summary, { uploadedAt: new Date().toISOString(), by: who.email });
    const { writeDocs } = await import('../server/store.js');
    await writeDocs({ admissions: doc }, { by: who.email });
    send(res, 200, { ok: true, uploadedAt: doc.uploadedAt, total: doc.total });
  } catch (e) {
    console.error('[admissions]', e);
    send(res, e.status || 500, { ok: false, error: safeError(e) });
  }
}
