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
/** Tài khoản để đồng bộ: META_AD_ACCOUNTS nếu có (chỉ những tài khoản đang kết nối), không thì toàn bộ FBCore.ACCOUNTS. */
export function syncAccounts(C, env = process.env) {
  const allowed = C.ACCOUNTS.map(a => a.id);
  const listed = [...new Set(String(env.META_AD_ACCOUNTS || '').split(/[\s,;]+/).map(s => s.replace(/^act_/i, '')).filter(Boolean))];
  const kept = listed.filter(a => allowed.includes(a));
  return { accts: kept.length ? kept : allowed, ignored: listed.filter(a => !allowed.includes(a)) };
}
