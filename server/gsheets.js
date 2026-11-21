// Đọc file DATA TUYỂN SINH trên Google Sheets bằng service account (chỉ đọc), để trang không cần quản trị tải file Excel lên thủ công.
//   Dùng cùng service account Firebase (FIREBASE_SERVICE_ACCOUNT, dự án quangcao-9a705): chỉ cần (1) bật Google Sheets API cho dự án đó,
//   (2) chia sẻ Sheet cho email của service account với quyền Người xem (Viewer). Id Sheet đặt ở biến môi trường ADMISSIONS_SHEET_ID (id hoặc cả đường dẫn).
// Nội dung Sheet (họ tên, ngày sinh, số điện thoại…) chỉ nằm trong bộ nhớ của hàm trong lúc tính; không ghi log, không lưu.
import { createSign } from 'node:crypto';
import { getServiceAccount } from './firebase.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const MAX_ROWS = 60000, MAX_TABS = 30, TIMEOUT_MS = 25000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (message, extra = {}) => Object.assign(new Error(message), { expose: true, status: 502 }, extra);

/** Id Sheet từ id trần hoặc đường dẫn docs.google.com/spreadsheets/d/<id>/…; không hợp lệ → ''. */
export function sheetIdFrom(v) {
  const s = String(v == null ? '' : v).trim().replace(/^['"]|['"]$/g, '');
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : '';
}
/** Email và dự án của service account (để hướng dẫn chia sẻ Sheet); null khi chưa cấu hình. Không trả khoá riêng. */
export function serviceAccountInfo(env = process.env) {
  const sa = getServiceAccount(env);
  return sa ? { email: sa.client_email, projectId: sa.project_id } : null;
}

let cached = null; // { token, exp }
export function resetTokenCache() { cached = null; }
const b64u = x => Buffer.from(x).toString('base64url');
export function buildJwt(sa, now = Math.floor(Date.now() / 1000)) {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  return head + '.' + claim + '.' + sig;
}
async function fetchJson(url, init) {
  const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(TIMEOUT_MS) }, init));
  const text = await res.text(); let j = null; try { j = text ? JSON.parse(text) : {}; } catch { /* không phải JSON */ }
  return { res, j };
}
export async function accessToken(env = process.env) {
  if (cached && cached.exp - Date.now() > 300000) return cached.token;
  const sa = getServiceAccount(env);
  if (!sa) throw fail('Chưa cấu hình service account (FIREBASE_SERVICE_ACCOUNT) nên chưa đọc được Google Sheet.', { status: 501 });
  let out;
  try {
    out = await fetchJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(buildJwt(sa)) });
  } catch (e) { throw fail('Không kết nối được Google để lấy quyền đọc (' + String(e && e.name === 'TimeoutError' ? 'hết thời gian chờ' : e && e.message || e).slice(0, 80) + ').'); }
  const { res, j } = out;
  if (!res.ok || !j || !j.access_token) {
    const code = j && j.error;
    throw fail(code === 'invalid_grant' ? 'Google từ chối khoá service account (khoá đã bị xoá hoặc thu hồi, hoặc đồng hồ máy chủ lệch). Tạo khoá mới cho service account rồi cập nhật FIREBASE_SERVICE_ACCOUNT.'
      : 'Google từ chối cấp quyền đọc cho service account (' + String(code || res.status).slice(0, 40) + ').');
  }
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** Lỗi của Sheets API → câu tiếng Việt nói rõ cần làm gì (không kèm nội dung Sheet). */
export function describeSheetsError(status, body, sa) {
  const e = body && body.error || {}, msg = String(e.message || ''), reasons = (e.details || []).map(d => d && d.reason).filter(Boolean);
  const mail = sa && sa.email || 'email của service account';
  if (status === 403 && (reasons.includes('SERVICE_DISABLED') || /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)))
    return 'Chưa bật Google Sheets API cho dự án Google Cloud' + (sa && sa.projectId ? ' "' + sa.projectId + '"' : '') + '. Mở console.cloud.google.com → APIs & Services → Library → "Google Sheets API" → Enable, đợi 1–2 phút rồi thử lại.';
  if (status === 403) return 'Service account ' + mail + ' chưa có quyền đọc Sheet này. Mở Sheet → Chia sẻ → thêm email đó với quyền Người xem (Viewer).';
  if (status === 404) return 'Không tìm thấy Sheet: sai ID, hoặc chưa chia sẻ cho ' + mail + ' (quyền Người xem).';
  if (status === 400 && /not supported for this document/i.test(msg)) return 'File này là Excel (.xlsx) lưu trên Drive, không phải Google Sheet. Mở file → Tệp → Lưu dưới dạng Google Trang tính, rồi dùng đường dẫn của bản mới.';
  if (status === 400) return 'Google Sheets từ chối yêu cầu đọc (' + (reasons[0] || e.status || 'sai tham số') + ').';
  if (status === 401) return 'Quyền đọc của service account bị Google từ chối (401). Thử lại sau vài phút.';
  if (status === 429) return 'Google Sheets đang giới hạn số lần đọc. Thử lại sau vài phút.';
  return 'Google Sheets trả lỗi ' + status + '.';
}
async function sheetsGet(path, params, sa, env) {
  const url = new URL(API + path);
  for (const [k, v] of params || []) url.searchParams.append(k, v); // cho phép lặp tham số (ranges)
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(env);
    let out;
    try { out = await fetchJson(url, { headers: { Authorization: 'Bearer ' + token } }); }
    catch (e) {
      if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      throw fail('Không đọc được Google Sheet (' + (e && e.name === 'TimeoutError' ? 'hết thời gian chờ' : 'mất kết nối') + ').');
    }
    const { res, j } = out;
    if (res.ok && j) return j;
    if (res.status === 401 && attempt < 1) { cached = null; continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    throw fail(describeSheetsError(res.status, j, sa), { status: res.status === 403 || res.status === 404 || res.status === 400 ? 502 : res.status === 429 ? 429 : 502 });
  }
}

/* Ô gộp: lấy giá trị ô trên cùng bên trái cho các ô còn lại (giống file Excel), để cột Chiến dịch, Khối… gộp ô không mất dữ liệu.
 * `merges` là danh sách ô gộp của đúng tab đó (sheets[i].merges). Không so sheetId: Google bỏ các số 0 khỏi JSON (tab đầu tiên có sheetId 0 nên có thể không có trường này). */
export function expandMerges(rows, merges) {
  if (!Array.isArray(merges) || !merges.length || merges.length > 5000) return rows;
  for (const m of merges) {
    const sr = m.startRowIndex || 0, er = m.endRowIndex || 0, sc = m.startColumnIndex || 0, ec = m.endColumnIndex || 0;
    if (er <= sr || ec <= sc || (er - sr) * (ec - sc) > 100000 || er > MAX_ROWS) continue;
    const tl = rows[sr] && rows[sr][sc];
    if (tl == null || tl === '') continue;
    for (let r = sr; r < er; r++) for (let c = sc; c < ec; c++) {
      if (r === sr && c === sc) continue;
      const row = rows[r] || (rows[r] = []);
      if (row[c] == null || row[c] === '') { while (row.length < c) row.push(''); row[c] = tl; }
    }
  }
  return rows;
}

/**
 * Đọc các tab cần dùng của file DATA TUYỂN SINH: Danh sách đăng ký và các tab (ĐP).
 * @returns {Promise<{title:string, reg:any[][], paid:{name:string,rows:any[][]}[], skipped:string[], tabs:string[]}>}
 */
export async function readAdmissionsSheet(sheetId, { pickTabs, env = process.env } = {}) {
  const id = sheetIdFrom(sheetId); if (!id) throw fail('ADMISSIONS_SHEET_ID không hợp lệ (dán đường dẫn hoặc ID của Google Sheet).', { status: 501 });
  const sa = serviceAccountInfo(env);
  const meta = await sheetsGet(id, [['fields', 'properties.title,sheets(properties(sheetId,title),merges)']], sa, env);
  const sheets = (meta.sheets || []).filter(s => s && s.properties && typeof s.properties.title === 'string');
  if (sheets.length > MAX_TABS * 4) throw fail('Sheet có quá nhiều tab (' + sheets.length + ').');
  const names = sheets.map(s => s.properties.title);
  const pick = typeof pickTabs === 'function' ? pickTabs : globalThis.FBAdm && globalThis.FBAdm.pickTabs;
  const tabs = pick && pick(names);
  if (!tabs) throw fail('Không thấy tab "Danh sách đăng ký" trong Google Sheet này.');
  const want = [tabs.regName].concat(tabs.paidNames); if (want.length > MAX_TABS) throw fail('Sheet có quá nhiều tab (ĐP) (' + want.length + ').');
  const q = ['majorDimension', 'ROWS'], params = [q, ['valueRenderOption', 'UNFORMATTED_VALUE'], ['dateTimeRenderOption', 'SERIAL_NUMBER']];
  for (const n of want) params.push(['ranges', "'" + n.replace(/'/g, "''") + "'"]);
  const got = await sheetsGet(id + '/values:batchGet', params, sa, env);
  const ranges = got.valueRanges || [];
  if (ranges.length !== want.length) throw fail('Google Sheets trả về số tab không khớp yêu cầu.');
  const rowsOf = (i, name) => {
    const rows = (ranges[i] && ranges[i].values || []).slice();
    if (rows.length > MAX_ROWS) throw fail('Tab "' + name.slice(0, 40) + '" quá dài (' + rows.length + ' dòng).');
    const sh = sheets.find(s => s.properties.title === name);
    return expandMerges(rows, sh && sh.merges);
  };
  return { title: String(meta.properties && meta.properties.title || '').slice(0, 120), reg: rowsOf(0, tabs.regName), paid: tabs.paidNames.map((n, i) => ({ name: n, rows: rowsOf(i + 1, n) })), skipped: tabs.skipped, tabs: want };
}
