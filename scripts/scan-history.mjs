// Quét MỌI ref đang có trên máy (nhánh, nhánh theo dõi từ GitHub, tag…) và toàn bộ lịch sử của chúng, tìm số điện thoại, email thật hay file dữ liệu:
// `npm run privacy`. Thoát mã 1 khi thấy, mã 2 khi CHƯA KẾT LUẬN được (kho nông, chỉ có một nhánh…), mã 0 chỉ khi đã quét đủ và sạch.
// Kho mã này CÔNG KHAI: thứ đã đẩy lên là ai cũng tải được, kể cả ở nhánh cũ quên xoá. Chỉ in đường dẫn, mã rút gọn và dạng đã che chữ số, không in giá trị.
// Trước khi chạy hãy `git fetch --all --prune --tags` để có đủ nhánh trên GitHub. Không phát hiện được mã học sinh (dãy số thường), chuỗi số ghép bằng
// phép nối chuỗi, ảnh hay commit GitHub còn lưu đệm sau khi xoá nhánh (nhờ GitHub Support gỡ).
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Số điện thoại Việt Nam: viết liền (9–10 số, có thể có +84, 84 hay 0 đứng đầu) hoặc chia nhóm kiểu 0xxx xxx xxx, 0xx-xxx-xxxx, +84 xxx.xxx.xxx; không nằm trong một số dài hơn.
// Dấu phẩy KHÔNG tính là một phần của số: "A,0xxxxxxxxx,6" (CSV) hay "[xxxxxxxxx,xxxxxxxxx]" (JSON) phải bị bắt.
const PHONE = new RegExp([
  '(?<![0-9.])(?:\\+?84|0)?[35789][0-9]{8}(?![0-9]|\\.[0-9])',
  '(?<![0-9.,\\-])(?:\\+?84|0)[ .\\-]?[35789][0-9]{1,2}[ .\\-][0-9]{3}[ .\\-][0-9]{3,4}(?![0-9]|[.,\\-][0-9])'
].join('|'), 'g');
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// miền dùng làm ví dụ hoặc công khai (tài khoản dịch vụ Google trong JWKS), không phải hộp thư thật
const EMAIL_OK = /@(?:example\.(?:com|org|net|edu|test)|[A-Za-z0-9-]*\.?gserviceaccount\.com|users\.noreply\.github\.com)$/i;
export const DATA_FILE = /\.(xlsx?|xlsb|xlsm|ods|csv|tsv)$/i;
const SKIP = /^(vendor\/|package-lock\.json$)|\.(png|jpe?g|gif|ico|woff2?)$/i;

/** Giải mã nội dung tệp thành chữ: UTF-16LE (có BOM, như "Unicode Text" của Excel) hoặc UTF-8; null cho tệp nhị phân. */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.includes(0) ? null : buf.toString('utf8');
}
/** Các chuỗi giống số điện thoại hoặc email trong `text`, đã che chữ số: [{ kind, shape }]. Số lặp chữ số (0900000000, 999999999) là dữ liệu giả nên bỏ qua. */
export function scanText(text) {
  const t = String(text).replace(/[    \t]+/g, ' '); // dấu cách không ngắt, dấu tab… như khi chép từ web hay Zalo
  const out = [];
  for (const m of t.matchAll(PHONE)) {
    const d = m[0].replace(/\D/g, '').replace(/^84/, '');
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
  const spec = gitText(['config', '--get-all', 'remote.origin.fetch'], cwd);
  if (spec && !/\+?refs\/heads\/\*:refs\/remotes\/origin\/\*/.test(spec)) warnings.push('Kho chỉ theo dõi một số nhánh của origin. Chạy `git remote set-branches origin "*"` rồi `git fetch --all --prune --tags` và quét lại.');
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
  const kinds = shas.length ? git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], cwd, shas.join('\n') + '\n').toString('utf8').split('\n') : [];
  const found = []; let blobs = 0;
  for (const line of kinds) {
    const [sha, type] = line.split(' '); if (type !== 'blob') continue;
    const path = paths.get(sha) || ''; blobs++;
    if (DATA_FILE.test(path)) { found.push({ path, blobFull: sha, blob: sha.slice(0, 8), kind: 'data-file', shape: path, refs: [...inRef.get(sha)] }); continue; }
    if (SKIP.test(path)) continue;
    const text = decodeText(git(['cat-file', 'blob', sha], cwd)); if (text == null) continue; // tệp nhị phân
    for (const f of scanText(text)) found.push({ path, blobFull: sha, blob: sha.slice(0, 8), kind: f.kind, shape: f.shape, refs: [...inRef.get(sha)] });
  }
  const hits = found.filter(h => !(h.kind === 'email' && baseline.has(h.blobFull + ':email')));
  return { blobs, refs, hits, suppressed: found.length - hits.length, warnings };
}

// So sánh qua realpath để chạy được cả khi gọi qua đường dẫn có liên kết mềm
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const r = scanHistory(fileURLToPath(new URL('..', import.meta.url)));
  for (const h of r.hits) console.log(`${h.kind}  ${h.path}  (blob ${h.blob})  ${h.kind === 'data-file' ? '' : h.shape + '  '}trong: ${h.refs.join(', ')}`);
  for (const w of r.warnings) console.log('CHƯA ĐỦ: ' + w);
  const scope = `${r.blobs} tệp của ${r.refs.length} ref trên máy` + (r.suppressed ? `, bỏ qua ${r.suppressed} chỗ đã chấp nhận trong scripts/privacy-baseline.json` : '');
  if (r.hits.length) console.log(`\nCó ${r.hits.length} chỗ nghi chứa dữ liệu cá nhân (${scope}). Kho công khai: xoá nhánh chứa chúng trên GitHub, \`git fetch --all --prune\`, rồi nhờ GitHub Support gỡ mã commit khỏi bộ nhớ đệm.`);
  else if (r.warnings.length) console.log(`\nChưa kết luận: không thấy gì trong ${scope}, nhưng chưa quét đủ (xem các dòng "CHƯA ĐỦ").`);
  else console.log(`\nSạch trong ${scope}. Chưa kiểm tra được: nhánh trên GitHub chưa fetch (chạy git fetch --all --prune --tags trước), refs/pull/*, commit GitHub còn lưu đệm sau khi xoá nhánh.`);
  process.exit(r.hits.length ? 1 : r.warnings.length ? 2 : 0);
}
