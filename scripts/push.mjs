// push.mjs — gửi các tài liệu dashboard (thư mục *.json) lên trang Vercel qua POST /api/ingest.
// usage: node push.mjs <docsDir> [envFile]
//   envFile (mặc định ./vercel.env cạnh script): FBADS_URL=https://<tên-dự-án>.vercel.app  INGEST_SECRET=<chuỗi bí mật>
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [docsDir, envFile = path.join(here, 'vercel.env')] = process.argv.slice(2);
if (!docsDir) { console.error('usage: node push.mjs <docsDir> [envFile]'); process.exit(2); }
if (!fs.existsSync(envFile)) { console.log('SKIP: chưa có ' + envFile + ' (chưa cấu hình trang Vercel)'); process.exit(0); }
const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const url = String(env.FBADS_URL || '').replace(/\/+$/, ''), secret = env.INGEST_SECRET || '';
if (!/^https:\/\//.test(url) || !secret) { console.error('FAIL: vercel.env cần FBADS_URL (https://…) và INGEST_SECRET'); process.exit(2); }
const files = fs.readdirSync(docsDir).filter(f => f.endsWith('.json')).sort((a, b) => (a === 'meta.json') - (b === 'meta.json')); // meta cuối cùng
const batches = []; let cur = {}, size = 0;
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
  const body = j && j.data && j.id ? j.data : j; // nhận cả file do ArtifactData lưu ({id, data, version})
  const s = JSON.stringify(body).length;
  if (size && size + s > 3_000_000) { batches.push(cur); cur = {}; size = 0; }
  cur[f.replace(/\.json$/, '')] = body; size += s;
}
if (Object.keys(cur).length) batches.push(cur);
let total = 0;
for (const docs of batches) {
  const res = await fetch(url + '/api/ingest', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ docs }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) { console.error('FAIL ' + res.status + ': ' + (j.error || 'không rõ')); process.exit(1); }
  total += j.written;
}
console.log('OK pushed ' + total + ' docs to ' + url);
