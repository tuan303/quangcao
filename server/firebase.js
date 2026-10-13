// firebase-admin cho dự án Firebase quangcao-9a705, khởi tạo lười từ biến môi trường.
//   FIREBASE_SERVICE_ACCOUNT = nội dung file JSON của service account (nguyên văn hoặc base64)
//   hoặc FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { initializeFirestore, getFirestore } from 'firebase-admin/firestore';
import { verifyFirebaseIdToken } from './verify-token.js';

const APP_NAME = 'quangcao-server';
export const publicError = (message, code, status = 500) => Object.assign(new Error(message), { expose: true, code, status });
const unquote = s => { const t = String(s ?? '').trim(); return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t; };

export function getServiceAccount(env = process.env) {
  let o = null;
  if (env.FIREBASE_SERVICE_ACCOUNT && String(env.FIREBASE_SERVICE_ACCOUNT).trim()) {
    const t = unquote(env.FIREBASE_SERVICE_ACCOUNT);
    const parse = s => { try { return JSON.parse(s); } catch { return null; } };
    o = t.startsWith('{') ? parse(t) : parse(Buffer.from(t, 'base64').toString('utf8'));
    if (!o) throw publicError('FIREBASE_SERVICE_ACCOUNT không phải JSON hợp lệ (dán nguyên nội dung file JSON của service account, hoặc bản base64).', 'CONFIG_FIREBASE');
  } else if (env.FIREBASE_CLIENT_EMAIL || env.FIREBASE_PRIVATE_KEY) {
    o = { project_id: unquote(env.FIREBASE_PROJECT_ID), client_email: unquote(env.FIREBASE_CLIENT_EMAIL), private_key: env.FIREBASE_PRIVATE_KEY || '' };
  } else return null;
  const sa = { project_id: o.project_id || o.projectId || unquote(env.FIREBASE_PROJECT_ID), client_email: o.client_email || o.clientEmail, private_key: unquote(o.private_key || o.privateKey).replace(/\\n/g, '\n') };
  const missing = ['project_id', 'client_email', 'private_key'].filter(k => !sa[k]);
  if (missing.length) throw publicError('Thông tin service account Firebase thiếu: ' + missing.join(', ') + '.', 'CONFIG_FIREBASE');
  return sa;
}

let app = null, db = null;
function adminApp() {
  if (app) return app;
  const existing = getApps().find(a => a.name === APP_NAME);
  if (existing) return (app = existing);
  const sa = getServiceAccount();
  if (!sa) throw publicError('Chưa cấu hình service account Firebase trên Vercel (FIREBASE_SERVICE_ACCOUNT). Đặt biến môi trường rồi Redeploy.', 'CONFIG_FIREBASE');
  return (app = initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }), projectId: sa.project_id }, APP_NAME));
}
export function getDb() {
  if (db) return db;
  const a = adminApp();
  try { db = initializeFirestore(a, { preferRest: true }); } catch { db = getFirestore(a); }
  return db;
}
export function projectId() {
  const sa = getServiceAccount();
  return (sa && sa.project_id) || String(process.env.FIREBASE_PROJECT_ID || '').trim();
}
function unverifiedAud(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).aud || ''; } catch { return ''; }
}
export const verifyIdToken = token => {
  const pid = projectId();
  if (!pid) throw publicError('Chưa cấu hình service account Firebase trên Vercel (FIREBASE_SERVICE_ACCOUNT). Đặt biến môi trường rồi Redeploy.', 'CONFIG_FIREBASE');
  const aud = unverifiedAud(token);
  // Trang đăng nhập bằng một dự án Firebase nhưng service account thuộc dự án khác → lỗi cấu hình, không phải lỗi người dùng.
  if (aud && aud !== pid) throw publicError('Service account trên Vercel thuộc dự án Firebase "' + pid + '" nhưng trang đăng nhập bằng dự án "' + aud + '". Thay FIREBASE_SERVICE_ACCOUNT bằng khóa của dự án "' + aud + '" rồi Redeploy.', 'CONFIG_FIREBASE');
  return verifyFirebaseIdToken(token, pid);
};
