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
    const source = raw.source === 'sheet' || raw.source === 'upload' ? raw.source : null; // sheet = máy chủ tự đọc Google Sheet; upload = quản trị tải file lên
    next.admissions = Object.assign({}, v.summary, { uploadedAt: at, by, source });
  } else { console.warn('[data] tài liệu admissions bị loại vì sai cấu trúc:', v.error); delete next.admissions; }
  return next;
}
const iso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
const num = v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : null;
/* Tài liệu đối chiếu phụ huynh (fbmatch) và trạng thái cập nhật (leadsync) cũng chỉ ra trang khi đúng cấu trúc đã biết; chuỗi lạ bị loại. */
async function checkedMatch(docs) {
  if (!docs.fbmatch && !docs.leadsync) return docs;
  const next = Object.assign({}, docs);
  if (docs.fbmatch) {
    await import('../admissions.js'); await import('../leadmatch.js');
    const v = globalThis.FBMatch.validate(docs.fbmatch);
    if (v.ok) next.fbmatch = v.match; else { console.warn('[data] tài liệu fbmatch bị loại vì sai cấu trúc:', v.error); delete next.fbmatch; }
  }
  if (docs.leadsync && typeof docs.leadsync === 'object') {
    const r = docs.leadsync, st = r.stats && typeof r.stats === 'object' ? r.stats : null, stats = {};
    if (st) for (const k of ['rows', 'parents', 'matched', 'students', 'studentsWithPhone', 'paidExt', 'paidExtWithPhone', 'forms', 'pages', 'skippedForms']) stats[k] = num(st[k]);
    next.leadsync = { v: 1, at: iso(r.at), ok: r.ok === true, stage: ['sheet', 'meta', 'match', 'write'].includes(r.stage) ? r.stage : null, error: typeof r.error === 'string' ? r.error.slice(0, 400) : null,
      ms: num(r.ms), by: r.by === 'cron' || r.by === 'admin' ? r.by : null, running: !!(iso(r.runningUntil) && Date.parse(r.runningUntil) > Date.now()), stats: st ? stats : null };
  } else delete next.leadsync;
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
      cache = { at: Date.now(), docs: await checkedMatch(await checkedAdmissions(scopeDocs(globalThis.FBCore, await readAll(), process.env))) }; // chỉ hai tài khoản đang kết nối
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
