// Chỉ giữ số liệu của các tài khoản quảng cáo đang kết nối (FBCore.ACCOUNTS). Tài liệu cũ của tài khoản đã gỡ vẫn nằm trong
// Firestore (không xoá dữ liệu) nhưng không trả ra trang và không đưa vào bản phân tích.
export function scopeDocs(C, docs, env) {
  // env (tuỳ chọn): tài khoản bị loại khỏi META_AD_ACCOUNTS cũng không hiển thị, tránh số cũ đứng yên mà không ai biết
  const ids = env ? syncAccounts(C, env).accts : C.ACCOUNTS.map(a => a.id);
  const allowed = new Set(ids);
  const out = {};
  for (const [id, d] of Object.entries(docs || {})) {
    if (d && typeof d === 'object' && d.acct && !allowed.has(String(d.acct))) continue;
    out[id] = d;
  }
  if (out.meta) {
    const m = Object.assign({}, out.meta);
    m.accounts = C.ACCOUNTS.filter(a => allowed.has(a.id)).map(a => Object.assign({}, a));
    if (m.perAccount) m.perAccount = Object.fromEntries(Object.entries(m.perAccount).filter(([a]) => allowed.has(a)));
    if (Array.isArray(m.failed)) m.failed = m.failed.filter(k => allowed.has(String(k).split('|')[0]));
    if (Array.isArray(m.leadLoss)) m.leadLoss = m.leadLoss.filter(a => allowed.has(String(a)));
    out.meta = m;
  }
  return out;
}
/** Phần của docs mà người chỉ xem không được thấy: thông báo lỗi thô của Meta và email của quản trị (người bấm đồng bộ, người tải số liệu tuyển sinh, người bấm viết phân tích). */
export function redactForViewer(docs) {
  if (!docs || typeof docs !== 'object') return docs;
  let out = docs;
  const patch = (id, p) => { out = Object.assign({}, out, { [id]: Object.assign({}, out[id], p) }); };
  const m = docs.meta;
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const p = {};
    if (/@/.test(String(m.syncedBy || ''))) p.syncedBy = null;
    if (m.perAccount && typeof m.perAccount === 'object') p.perAccount = Object.fromEntries(Object.entries(m.perAccount).map(([a, x]) => [a, Object.assign({}, x, { error: null })]));
    if (Object.keys(p).length) patch('meta', p);
  }
  for (const id of ['admissions', 'insights']) if (out[id] && typeof out[id] === 'object' && out[id].by) patch(id, { by: null });
  if (out.leadsync && typeof out.leadsync === 'object') patch('leadsync', { error: null, by: null }); // chi tiết lỗi Google/Meta chỉ dành cho quản trị
  return out;
}
/** Tài khoản để đồng bộ: META_AD_ACCOUNTS nếu có (chỉ những tài khoản đang kết nối), không thì toàn bộ FBCore.ACCOUNTS. */
export function syncAccounts(C, env = process.env) {
  const allowed = C.ACCOUNTS.map(a => a.id);
  const listed = [...new Set(String(env.META_AD_ACCOUNTS || '').split(/[\s,;]+/).map(s => s.replace(/^act_/i, '')).filter(Boolean))];
  const kept = listed.filter(a => allowed.includes(a));
  return { accts: kept.length ? kept : allowed, ignored: listed.filter(a => !allowed.includes(a)) };
}

/* Tài liệu tuyển sinh luôn đi qua kiểm tra cấu trúc trước khi trả ra, dù được ghi bằng đường nào: chỉ số tổng hợp theo đúng dạng đã biết mới ra trang. */
export async function checkedAdmissionsDocs(docs) {
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
export async function checkedMatchDocs(docs) {
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
