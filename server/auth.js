// Ai được xem / ai được bấm đồng bộ.
//   Người xem: đăng nhập Microsoft 365 của trường (Firebase Auth, nhà cung cấp 'microsoft.com') và email nằm trong
//   FBADS_VIEWERS hoặc FBADS_ADMINS (hoặc tên miền trong FBADS_VIEWER_DOMAINS nếu muốn mở cho cả trường).
//   Quản trị (FBADS_ADMINS): xem + bấm "Đồng bộ ngay".
//   Máy (cron Vercel): Bearer CRON_SECRET. Claude đẩy số liệu: Bearer INGEST_SECRET.
// ⚠ Như dự án dự giờ: app registration Microsoft Entra mà Firebase dùng phải là SINGLE-TENANT.
import { createHash, timingSafeEqual } from 'node:crypto';

export const REQUIRED_PROVIDER = 'microsoft.com';
const list = s => [...new Set(String(s || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase().replace(/^@+/, '')).filter(Boolean))];
const singleAt = e => { const p = String(e || '').split('@'); return p.length === 2 && p[0] && p[1]; };

export function secretEquals(given, expected) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  const exp = expected.trim();
  if (!exp || !given) return false;
  const a = createHash('sha256').update(given, 'utf8').digest(), b = createHash('sha256').update(exp, 'utf8').digest();
  return timingSafeEqual(a, b);
}
export function bearerToken(header) {
  const h = Array.isArray(header) ? header[0] : header;
  const m = String(h || '').match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : '';
}
export function roleOf(email, env = process.env) {
  const e = String(email || '').toLowerCase();
  if (!singleAt(e)) return null;
  if (list(env.FBADS_ADMINS).includes(e)) return 'admin';
  if (list(env.FBADS_VIEWERS).includes(e)) return 'viewer';
  if (list(env.FBADS_VIEWER_DOMAINS).includes(e.split('@')[1])) return 'viewer';
  return null;
}
const deny = (status, error) => ({ ok: false, status, error });

/** @returns {Promise<{ok:true, kind:'cron'|'ingest'|'user', email?:string, role?:string}|{ok:false,status:number,error:string}>} */
export async function authorize({ authorization, env = process.env, verifyIdToken, allowSecrets = [] }) {
  const token = bearerToken(authorization);
  if (!token) return deny(401, 'Vui lòng đăng nhập bằng tài khoản Microsoft 365 của trường.');
  if (allowSecrets.includes('cron') && secretEquals(token, env.CRON_SECRET)) return { ok: true, kind: 'cron' };
  if (allowSecrets.includes('ingest') && secretEquals(token, env.INGEST_SECRET)) return { ok: true, kind: 'ingest' };
  let claims;
  try { claims = await verifyIdToken(token); }
  catch (e) { if (e && e.expose) throw e; return deny(401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.'); }
  if (!claims || !claims.firebase || claims.firebase.sign_in_provider !== REQUIRED_PROVIDER) return deny(403, 'Chỉ chấp nhận tài khoản Microsoft 365 của trường.');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const role = roleOf(email, env);
  if (!role) return deny(403, 'Tài khoản ' + (email || '(không có email)') + ' chưa được cấp quyền xem báo cáo quảng cáo. Liên hệ quản trị CNTT để được thêm vào danh sách.');
  return { ok: true, kind: 'user', email, role };
}
