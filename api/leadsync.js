// /api/leadsync – cập nhật số liệu "Phụ huynh điền form Facebook → đóng phí" (đối chiếu từng phụ huynh).
//   GET  – Vercel Cron (Authorization: Bearer <CRON_SECRET>): chạy nếu đã cấu hình
//   POST – quản trị (Bearer <Firebase ID token>, email trong FBADS_ADMINS): body { action: "run" | "check", force?: true }
//          run   = đọc Google Sheet + lead Facebook rồi đối chiếu ngay;  check = kiểm tra từng bước kết nối (không in nội dung dữ liệu)
// Cần: ADMISSIONS_SHEET_ID (Sheet đã chia sẻ cho service account), META_ACCESS_TOKEN có quyền đọc lead. Xem README.
import { authorize } from '../server/auth.js';
import { send, safeError, readJson } from '../server/http.js';

const HARD_MS = 100000; // vercel.json cho hàm này 120 giây: mọi yêu cầu Meta dừng sau 100 giây để còn thời gian ghi

export default async function handler(req, res) {
  const { withDeadline } = await import('../server/meta.js');
  return withDeadline(() => run(req, res));
}
async function run(req, res) {
  try {
    const { verifyIdToken } = await import('../server/firebase.js');
    const who = await authorize({ authorization: req.headers.authorization, verifyIdToken, allowSecrets: ['cron'] });
    if (!who.ok) return send(res, who.status, who);
    if (who.kind === 'cron' && req.method !== 'GET') return send(res, 405, { ok: false, error: 'Cron dùng GET.' });
    if (who.kind === 'user' && (req.method !== 'POST' || who.role !== 'admin')) return send(res, 403, { ok: false, error: 'Chỉ quản trị (FBADS_ADMINS) được cập nhật hoặc kiểm tra kết nối.' });
    const { setDeadline } = await import('../server/meta.js');
    setDeadline(Date.now() + HARD_MS);
    const ls = await import('../server/leadsync.js');
    if (who.kind === 'cron') return send(res, 200, Object.assign({ ok: true }, await ls.maybeLeadSync({ by: 'cron', staleMs: 3600000 })));
    const body = await readJson(req, 4096);
    const action = body && body.action;
    if (action === 'check') return send(res, 200, Object.assign({ ok: true }, await ls.checkSetup()));
    if (action === 'run') return send(res, 200, await ls.runLeadSync({ by: 'admin', force: body.force === true }));
    return send(res, 400, { ok: false, error: 'action phải là "run" hoặc "check".' });
  } catch (e) {
    console.error('[leadsync]', e && e.expose ? e.message : e);
    send(res, e.busy ? 409 : e.status && e.status < 600 ? e.status : 500, { ok: false, error: safeError(e), stage: e && e.stage || undefined });
  }
}
