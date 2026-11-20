// Quét MỌI nhánh và toàn bộ lịch sử git tìm số điện thoại, email thật hay file dữ liệu: `npm run privacy` (thoát mã 1 khi thấy).
// Kho mã này CÔNG KHAI: thứ đã đẩy lên là ai cũng tải được, kể cả ở nhánh cũ quên xoá. Chỉ in đường dẫn, mã rút gọn và dạng đã che chữ số, không in giá trị.
// Không phát hiện được mã học sinh (dãy số thường) nên đừng đưa dữ liệu thật vào mã hay kiểm thử.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Số điện thoại Việt Nam: viết liền (9–10 số, có thể có +84, 84 hay 0 đứng đầu) hoặc chia nhóm kiểu 0xxx xxx xxx, 0xx-xxx-xxxx, +84 xxx.xxx.xxx; không nằm trong một số dài hơn
const PHONE = new RegExp([
  '(?<![0-9.,])(?:\\+?84|0)?[35789][0-9]{8}(?![0-9]|[.,][0-9])',
  '(?<![0-9.,\\-])(?:\\+?84|0)[ .\\-]?[35789][0-9]{1,2}[ .\\-][0-9]{3}[ .\\-][0-9]{3,4}(?![0-9]|[.,\\-][0-9])'
].join('|'), 'g');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// miền dùng làm ví dụ hoặc công khai (tài khoản dịch vụ Google trong JWKS), không phải hộp thư thật
const EMAIL_OK = /@(?:example\.(?:com|org|net|edu|test)|[A-Za-z0-9-]*\.?gserviceaccount\.com|users\.noreply\.github\.com)$/i;
export const DATA_FILE = /\.(xlsx?|xlsb|xlsm|ods|csv|tsv)$/i;
const SKIP = /^(vendor\/|package-lock\.json$)|\.(png|jpe?g|gif|ico|woff2?)$/i;

/** Các chuỗi giống số điện thoại hoặc email trong `text`, đã che chữ số: [{ kind, shape }]. Số lặp chữ số (0900000000, 999999999) là dữ liệu giả nên bỏ qua. */
export function scanText(text) {
  const out = [];
  for (const m of String(text).matchAll(PHONE)) {
    const d = m[0].replace(/\D/g, '').replace(/^84/, '');
    if (new Set(d).size > 2) out.push({ kind: 'phone', shape: m[0].replace(/[0-9]/g, '#') });
  }
  for (const m of String(text).matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) out.push({ kind: 'email', shape: m[0].replace(/[^@.]/g, '#') });
  return out;
}

const git = (args, cwd, input) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28, input, stdio: ['pipe', 'pipe', 'ignore'] });

// Những chỗ đã biết và chấp nhận (nằm trong lịch sử của main, chỉ xoá được bằng cách viết lại lịch sử): "mã tệp rút gọn:loại". Xem scripts/privacy-baseline.json.
function accepted() {
  try { return new Set(JSON.parse(readFileSync(new URL('./privacy-baseline.json', import.meta.url), 'utf8')).accepted || []); } catch { return new Set(); }
}
/** Quét mọi commit của mọi nhánh (cả nhánh trên máy lẫn nhánh theo dõi từ GitHub). Trả về { blobs, refs, hits: [{ path, blob, kind, shape, refs }] }; bỏ các chỗ đã chấp nhận trong baseline. */
export function scanHistory(cwd, baseline = accepted()) {
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], cwd).toString('utf8').split('\n').filter(r => r && !/\/HEAD$/.test(r));
  const inRef = new Map(); // blob → các nhánh chứa nó
  const paths = new Map();
  for (const ref of refs) {
    for (const line of git(['rev-list', '--objects', ref], cwd).toString('utf8').split('\n')) {
      const i = line.indexOf(' '); if (i < 0) continue;
      const sha = line.slice(0, i), path = line.slice(i + 1);
      (inRef.get(sha) || inRef.set(sha, new Set()).get(sha)).add(ref); if (!paths.has(sha)) paths.set(sha, path);
    }
  }
  const shas = [...inRef.keys()];
  const kinds = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], cwd, shas.join('\n') + '\n').toString('utf8').split('\n');
  const hits = []; let blobs = 0;
  for (const line of kinds) {
    const [sha, type] = line.split(' '); if (type !== 'blob') continue;
    const path = paths.get(sha) || ''; blobs++;
    if (DATA_FILE.test(path)) { hits.push({ path, blob: sha.slice(0, 8), kind: 'data-file', shape: path, refs: [...inRef.get(sha)] }); continue; }
    if (SKIP.test(path)) continue;
    const buf = git(['cat-file', 'blob', sha], cwd);
    if (buf.includes(0)) continue; // tệp nhị phân
    for (const f of scanText(buf.toString('utf8'))) hits.push({ path, blob: sha.slice(0, 8), kind: f.kind, shape: f.shape, refs: [...inRef.get(sha)] });
  }
  return { blobs, refs, hits: hits.filter(h => !baseline.has(h.blob + ':' + h.kind)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = scanHistory(fileURLToPath(new URL('..', import.meta.url)));
  for (const h of r.hits) console.log(`${h.kind}  ${h.path}  (blob ${h.blob})  ${h.kind === 'data-file' ? '' : h.shape + '  '}trong: ${h.refs.join(', ')}`);
  console.log(r.hits.length ? `\nCó ${r.hits.length} chỗ nghi chứa dữ liệu cá nhân trong ${r.blobs} tệp của ${r.refs.length} nhánh. Kho công khai: xoá nhánh chứa chúng trên GitHub và gỡ khỏi lịch sử trước khi đẩy tiếp.` : `Sạch: không thấy số điện thoại, email hay file dữ liệu trong ${r.blobs} tệp của ${r.refs.length} nhánh.`);
  process.exit(r.hits.length ? 1 : 0);
}
