// Quét MỌI ref đang có trên máy (nhánh, nhánh theo dõi từ GitHub, tag…) và toàn bộ lịch sử của chúng, tìm số điện thoại, email thật hay file dữ liệu:
// `npm run privacy`. Thoát mã 1 khi thấy, mã 2 khi CHƯA KẾT LUẬN được (kho nông, chỉ có một nhánh…), mã 0 chỉ khi đã quét đủ và sạch.
// Kho mã này CÔNG KHAI: thứ đã đẩy lên là ai cũng tải được, kể cả ở nhánh cũ quên xoá. Chỉ in đường dẫn, mã rút gọn và dạng đã che chữ số, không in giá trị.
// Trước khi chạy hãy `git fetch --all --prune --tags` để có đủ nhánh trên GitHub. Chỉ nhận số di động Việt Nam (đầu 03/05/07/08/09, viết với 0, 84, +84 hoặc 0084, liền hoặc chia
// nhóm, có thể có ngoặc đơn). KHÔNG phát hiện: số bàn 02x và số 01x cũ, số ghép bằng dấu phẩy hay bị ngắt dòng, mã học sinh (dãy số thường), chuỗi ghép bằng phép nối chuỗi,
// nội dung file nén hay mã hoá (chỉ nhận ra file Excel/zip/pdf/sqlite đổi tên), ảnh, refs/pull/* và commit GitHub còn lưu đệm sau khi xoá nhánh (nhờ GitHub Support gỡ).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Số điện thoại di động Việt Nam: viết liền (9 số sau đầu 0, 84, +84 hay 0084) hoặc chia nhóm bằng đúng một dấu cách, chấm hay gạch ngang giữa hai chữ số bất kỳ
// (0xxx xxx xxx, 0xx-xxxx-xxx, +84 xxx.xxx.xxx…); không nằm trong một số dài hơn. Dấu phẩy KHÔNG tính là một phần của số: "A,0xxxxxxxxx,6" (CSV) phải bị bắt.
// Điều kiện loại bỏ ba nhóm một chữ số liên tiếp để dữ liệu đường vẽ SVG ("M0 9.5 3 7.5 3 5 8 3 1") không bị tưởng là số điện thoại.
const SEP = '[ .\\-]';
const PHONE = new RegExp([
  '(?<![0-9.])(?:(?:\\+|00)?84|0)?[35789][0-9]{8}(?![0-9]|\\.[0-9])',
  `(?<![0-9.\\-])(?:(?:\\+|00)?84|0)${SEP}?(?=[35789](?:${SEP}?[0-9]){8}(?![0-9]|[.\\-][0-9]))(?![0-9]${SEP}[0-9]${SEP}[0-9])[0-9](?:${SEP}?[0-9]){8}`
].join('|'), 'g');
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// miền dùng làm ví dụ hoặc công khai (tài khoản dịch vụ Google trong JWKS), không phải hộp thư thật
const EMAIL_OK = /(?:@(?:example\.(?:com|org|net|edu|test)|[A-Za-z0-9-]*\.?gserviceaccount\.com|users\.noreply\.github\.com)|^noreply@anthropic\.com)$/i; // noreply@anthropic.com: dòng Co-Authored-By trong lời nhắn commit
export const DATA_FILE = /\.(xlsx?|xlsb|xlsm|ods|csv|tsv)$/i;
const MAX_BLOB = 64 << 20; // tệp lớn hơn mức này không đọc nội dung
const SKIP = /^(vendor\/|package-lock\.json$)|\.(png|jpe?g|gif|ico|woff2?)$/i;

/** Giải mã nội dung tệp thành chữ: UTF-16LE (có BOM, như "Unicode Text" của Excel) hoặc UTF-8; null cho tệp nhị phân. */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.includes(0) ? null : buf.toString('utf8');
}
/** File dữ liệu đổi tên (đuôi .dat, .bak…): nhận ra qua chữ ký đầu tệp của zip (xlsx, ods, docx), xls cũ, SQLite và PDF. */
export function sniffData(buf) {
  const h = buf.subarray(0, 16);
  return (h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04) || (h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0)
    || h.toString('latin1').startsWith('SQLite format 3') || h.toString('latin1').startsWith('%PDF');
}
/** Các chuỗi giống số điện thoại hoặc email trong `text`, đã che chữ số: [{ kind, shape }]. Số lặp chữ số (0900000000, 999999999) là dữ liệu giả nên bỏ qua. */
export function scanText(text) {
  const t = String(text).normalize('NFKC')                                    // chữ số toàn chiều rộng; dấu cách không ngắt, U+2002–U+200A, U+202F, U+3000 thành dấu cách thường
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')                                // ký tự độ rộng bằng không
    .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\t\f\v]/g, ' ')           // các kiểu gạch ngang, tab
    .replace(/\(\s*0\s*\)/g, ' ').replace(/[()]/g, ' ').replace(/ {2,}/g, ' ');   // "(091) …", "(+84) …", "+84 (0)91…"
  const out = [];
  for (const m of t.matchAll(PHONE)) {
    const d = m[0].replace(/\D/g, '').replace(/^(?:00)?84/, '');
    if (new Set(d).size > 2) out.push({ kind: 'phone', shape: m[0].replace(/[0-9]/g, '#') });
  }
  for (const m of t.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) out.push({ kind: 'email', shape: m[0].replace(/[^@.]/g, '#') });
  return out;
}

const git = (args, cwd, input) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28, input, stdio: ['pipe', 'pipe', 'ignore'] });
const gitText = (args, cwd) => { try { return git(args, cwd).toString('utf8').trim(); } catch { return ''; } };

// Những chỗ đã biết và chấp nhận: chỉ email nằm sẵn trong lịch sử của main (chỉ xoá được bằng cách viết lại lịch sử, việc của chủ kho). Dạng "mã tệp đầy đủ:email".
// Số điện thoại và file dữ liệu KHÔNG bao giờ được chấp nhận ở đây, dù có ghi vào tệp.
export function accepted() {
  try { return new Set((JSON.parse(readFileSync(new URL('./privacy-baseline.json', import.meta.url), 'utf8')).accepted || []).filter(k => /^[0-9a-f]{40}:email$/.test(k))); } catch { return new Set(); }
}
/** Quét mọi ref trên máy. Trả về { blobs, refs, hits: [{ path, blob, kind, shape, refs }], suppressed, warnings }; hits bỏ các chỗ đã chấp nhận (chỉ email) trong baseline. */
export function scanHistory(cwd, baseline = accepted()) {
  const refList = git(['for-each-ref', '--format=%(refname)\t%(refname:short)'], cwd).toString('utf8').split('\n').filter(Boolean).map(l => l.split('\t')).filter(([full]) => !/\/HEAD$/.test(full));
  const refs = refList.map(([, short]) => short);
  const warnings = [];
  if (!refList.length) warnings.push('Không có ref nào để quét.');
  if (gitText(['rev-parse', '--is-shallow-repository'], cwd) === 'true') warnings.push('Kho nông (shallow): lịch sử bị cắt cụt. Chạy `git fetch --unshallow --tags` rồi quét lại.');
  for (const rn of gitText(['remote'], cwd).split('\n').filter(Boolean)) {
    const spec = gitText(['config', '--get-all', 'remote.' + rn + '.fetch'], cwd), esc = rn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (spec && !new RegExp('\\+?refs/heads/\\*:refs/remotes/' + esc + '/\\*').test(spec) && !/\+?refs\/\*:refs\/\*/.test(spec)) warnings.push('Kho chỉ theo dõi một số nhánh của ' + rn + '. Chạy `git remote set-branches ' + rn + ' "*"` rồi `git fetch --all --prune --tags` và quét lại.');
  }
  const inRef = new Map(); // đối tượng → các ref chứa nó
  const paths = new Map();
  for (const [full, short] of refList) {
    for (const line of git(['rev-list', '--objects', full], cwd).toString('utf8').split('\n')) {
      const i = line.indexOf(' '); if (i < 0) continue;
      const sha = line.slice(0, i), path = line.slice(i + 1);
      (inRef.get(sha) || inRef.set(sha, new Set()).get(sha)).add(short); if (!paths.has(sha)) paths.set(sha, path);
    }
  }
  const shas = [...inRef.keys()];
  const kinds = shas.length ? git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], cwd, shas.join('\n') + '\n').toString('utf8').split('\n') : [];
  const found = []; let blobs = 0; const tooBig = new Set();
  for (const line of kinds) {
    const [sha, type, size] = line.split(' '); if (type !== 'blob') continue;
    const path = paths.get(sha) || ''; blobs++;
    if (DATA_FILE.test(path)) { found.push({ path, blobFull: sha, blob: sha.slice(0, 8), kind: 'data-file', shape: path, refs: [...inRef.get(sha)] }); continue; }
    for (const f of scanText(path)) found.push({ path: '(tên tệp)', blobFull: sha, blob: sha.slice(0, 8), kind: f.kind, shape: f.shape, refs: [...inRef.get(sha)] }); // số điện thoại hay email nằm ngay trong tên tệp
    if (SKIP.test(path)) continue;
    if (+size > MAX_BLOB) { tooBig.add(path); continue; }
    const buf = git(['cat-file', 'blob', sha], cwd);
    if (sniffData(buf)) { found.push({ path, blobFull: sha, blob: sha.slice(0, 8), kind: 'data-file', shape: path, refs: [...inRef.get(sha)] }); continue; }
    const text = decodeText(buf); if (text == null) continue; // tệp nhị phân khác
    for (const f of scanText(text)) found.push({ path, blobFull: sha, blob: sha.slice(0, 8), kind: f.kind, shape: f.shape, refs: [...inRef.get(sha)] });
  }
  if (tooBig.size) warnings.push(tooBig.size + ' tệp lớn hơn ' + (MAX_BLOB >> 20) + ' MiB không được quét nội dung (đã quét tên).');
  // nội dung các commit (một số điện thoại gõ vào lời nhắn commit cũng công khai như tệp)
  if (refList.length) for (const entry of git(['log', '--all', '-z', '--format=%H%x1f%B'], cwd).toString('utf8').split('\0')) {
    const [hash, msg] = entry.split('\x1f'); if (!hash || !msg) continue;
    for (const f of scanText(msg)) found.push({ path: '(nội dung commit)', blobFull: hash.trim(), blob: hash.trim().slice(0, 8), kind: f.kind, shape: f.shape, refs: ['(commit)'] });
  }
  const hits = found.filter(h => !(h.kind === 'email' && baseline.has(h.blobFull + ':email')));
  return { blobs, refs, hits, suppressed: found.length - hits.length, warnings };
}

// So sánh qua realpath để chạy được cả khi gọi qua đường dẫn có liên kết mềm
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  try {
    const r = scanHistory(fileURLToPath(new URL('..', import.meta.url)));
    for (const h of r.hits) console.log(`${h.kind}  ${h.path}  (${h.kind === 'data-file' || h.path.startsWith('(') ? 'mã ' : 'blob '}${h.blob})  ${h.kind === 'data-file' ? '' : h.shape + '  '}trong: ${h.refs.join(', ')}`);
    for (const w of r.warnings) console.log('CHƯA ĐỦ: ' + w);
    const scope = `${r.blobs} tệp của ${r.refs.length} ref trên máy` + (r.suppressed ? `, bỏ qua ${r.suppressed} chỗ đã chấp nhận trong scripts/privacy-baseline.json` : '');
    if (r.hits.length) console.log(`\nCó ${r.hits.length} chỗ nghi chứa dữ liệu cá nhân (${scope}). Kho công khai: xoá nhánh chứa chúng trên GitHub, \`git fetch --all --prune\`, rồi nhờ GitHub Support gỡ mã commit khỏi bộ nhớ đệm.`);
    else if (r.warnings.length) console.log(`\nChưa kết luận: không thấy gì trong ${scope}, nhưng chưa quét đủ (xem các dòng "CHƯA ĐỦ").`);
    else console.log(`\nKhông thấy gì trong ${scope}. Bộ quét chỉ nhận số di động Việt Nam và email, file Excel/zip/pdf/sqlite; không thấy số bàn 02x hay 01x cũ, số ghép bằng dấu phẩy hoặc ngắt dòng, mã học sinh, nội dung nén hay mã hoá, nhánh trên GitHub chưa fetch (chạy git fetch --all --prune --tags trước), refs/pull/*, commit GitHub còn lưu đệm sau khi xoá nhánh.`);
    process.exit(r.hits.length ? 1 : r.warnings.length ? 2 : 0);
  } catch (e) { // lỗi git hay tệp quá lớn: không được lẫn với mã 1 ("thấy dữ liệu cá nhân")
    console.log('Không quét được: ' + String(e && e.message || e).split('\n')[0].slice(0, 200));
    process.exit(2);
  }
}
