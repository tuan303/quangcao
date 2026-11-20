/* admissions.js – Chuyển đổi tuyển sinh: từ lead Facebook đến học sinh đăng ký và đã đóng phí (ĐP).
 *
 * Đọc file "DATA TUYỂN SINH" (tab "Danh sách đăng ký" và các tab "(ĐP)"), chỉ giữ SỐ TỔNG HỢP: không lưu tên, ngày sinh,
 * số điện thoại hay bất kỳ chuỗi nào của học sinh. Ghép chương trình tuyển sinh (TS1, JS, TS6, TS10, HB) với chiến dịch
 * Facebook theo tên chiến dịch rồi tính tỷ lệ chuyển đổi và chi phí cho mỗi học sinh đã đóng phí.
 *
 * Một tệp, ba nơi dùng: trang và luồng đọc file (window/self.FBAdm) và máy chủ/kiểm thử Node (globalThis.FBAdm).
 * Chỉ là hàm thuần, không DOM, không mạng.
 */
(function (root) {
  'use strict';

  var PROGRAMS = [
    { k: 'TS1', label: 'Lớp 1', code: 'TS1' },
    { k: 'JS', label: 'Jolly Steps', code: 'JS' },
    { k: 'TS6', label: 'Lớp 6', code: 'TS6' },
    { k: 'TS10', label: 'Lớp 10', code: 'TS10' },
    { k: 'HB', label: 'Học bổng', code: 'HB' }
  ];
  var KNOWN = {}; PROGRAMS.forEach(function (p) { KNOWN[p.k] = p; });
  var UNKNOWN = 'KHAC'; // dòng không có mã chương trình
  var MIN_BASE = 10;    // dưới mức này không tính tỷ lệ phần trăm
  var MIN_DATED = 0.9;  // chỉ xem theo kỳ khi từ 90% học sinh có Ngày đăng ký đọc được

  /* ---------------- chuỗi ---------------- */
  function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'); }
  function norm(s) { return fold(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.trim()); }
  /** Khoá MDT chuẩn: số nguyên dương (nhận 123, "123", "123.0", "0123"); ngược lại ''. */
  function mdtKey(v) {
    if (typeof v === 'number') { if (!isFinite(v)) return ''; var r = Math.round(v); return r > 0 && r < 1e12 && Math.abs(v - r) < 1e-6 ? String(r) : ''; }
    if (typeof v === 'string') { var m = v.trim().match(/^(\d{1,12})(?:[.,]0+)?$/); return m && +m[1] > 0 ? String(+m[1]) : ''; }
    return '';
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- ngày ---------------- */
  function ymd(y, m, d) { // ngày có thật trong lịch, năm 2020–2040
    if (!(y >= 2020 && y <= 2040 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? y + '-' + pad(m) + '-' + pad(d) : '';
  }
  /** Giá trị ô → 'YYYY-MM-DD' hoặc ''. Nhận số seri Excel (kể cả hệ ngày 1904), chữ số seri, 'dd/mm/yyyy', 'dd/mm/yy', 'yyyy-mm-dd'. */
  function parseDate(v, date1904) {
    if (blank(v)) return '';
    if (typeof v === 'number') {
      var x = date1904 ? v + 1462 : v; // hệ ngày 1904 lệch 1462 ngày so với hệ 1900
      if (!(x > 40000 && x < 60000)) return '';
      var dt = new Date(Math.round((Math.floor(x) - 25569) * 86400000)); // 25569 = 01/01/1970 theo số seri Excel
      return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    var s = String(v).replace(/ /g, ' ').trim(), m;
    if ((m = s.match(/^(\d{5})(\.\d+)?$/))) return parseDate(+m[1], date1904);
    if ((m = s.match(/^(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?!\d)/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4}|\d{2})(?!\d)/))) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    return '';
  }
  function vnDate(iso) { var t = Date.parse(iso || ''); return isFinite(t) ? new Date(t + 7 * 3600000).toISOString().slice(0, 10) : ''; }
  function addDays(day, n) { var t = Date.parse(day + 'T00:00:00Z'); return isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : ''; }
  function daysBetween(a, b) { var x = Date.parse(a + 'T00:00:00Z'), y = Date.parse(b + 'T00:00:00Z'); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : null; }
  function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  /** Ngày bắt đầu mùa quảng cáo (01/08) của mùa chứa ngày `day` khi file không ghi mùa. */
  function seasonStartOf(day) { var y = +day.slice(0, 4), m = +day.slice(5, 7); return (m >= 8 ? y : y - 1) + '-08-01'; }
  var EARLY_DAYS = 92; // đăng ký sớm hơn đầu mùa quảng cáo tối đa chừng ba tháng vẫn được nhận

  /* ---------------- bảng tính ---------------- */
  /** Dòng tiêu đề: dòng trong 20 dòng đầu có ô "MDT" ở cột bất kỳ. */
  function findHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 20); i++) { var r = rows[i]; if (!r) continue; for (var j = 0; j < r.length; j++) if (norm(r[j]) === 'mdt') return i; }
    return -1;
  }
  function isInternalHeader(n) { return /(^| )(hs|h s|hoc sinh) ?(noi bo|nb)( |$)/.test(n) || /^(hsnb|noi bo)( |$)/.test(n); }
  function columnsOf(header) {
    var c = {};
    for (var j = 0; j < header.length; j++) {
      var n = norm(header[j]); if (!n) continue;
      if (n === 'mdt' && c.mdt == null) c.mdt = j;
      else if (isInternalHeader(n) && c.internal == null) c.internal = j;
      else if (/^khoi/.test(n) && c.khoi == null) { c.khoi = j; c.khoiHeader = String(header[j]); }
      else if (/^ho (va )?ten/.test(n)) { // ưu tiên cột họ tên của học sinh, không lấy cột họ tên phụ huynh
        var strict = /^ho (va )?ten (hoc sinh|hs)( |$)/.test(n);
        if (c.name == null || (strict && !c.nameStrict)) { c.name = j; c.nameStrict = strict; }
      }
      else if (n === 'chien dich' && c.program == null) c.program = j;
      else if (/(^| )ngay (nhan )?(dang k[yi]|dk)( |$)/.test(n) && c.regDate == null) c.regDate = j;
      else if (/(^| )ngay ((dong|nop|thu) (hoc )?phi|dp|da dong phi)( |$)/.test(n) && c.paidDate == null) c.paidDate = j;
    }
    return c;
  }
  function filledCells(r, skip) { var n = 0; for (var j = 0; j < r.length; j++) if (j !== skip && !blank(r[j])) n++; return n; }
  /* Dòng học sinh: có MDT và có họ tên (dòng đếm tổng hay dòng tiêu đề phụ chỉ có số/nhãn nên bị loại). Không tìm thấy cột họ tên thì cần từ 2 ô có dữ liệu. */
  function isStudent(r, cols, mc) {
    if (!r || !mdtKey(r[mc])) return false;
    if (cols.name != null) return typeof r[cols.name] === 'string' && !!r[cols.name].trim();
    return filledCells(r, mc) >= 2;
  }
  /* Dòng có dữ liệu nhưng không thành học sinh (MDT sai hoặc thiếu họ tên): chỉ đếm, không lưu nội dung. Tab ĐP có dòng đếm tổng nên chỉ đếm dòng có họ tên. */
  function lostRow(r, cols, isReg) {
    if (!r) return false;
    if (cols.name != null && typeof r[cols.name] === 'string' && r[cols.name].trim()) return true;
    return !!isReg && filledCells(r, -1) > 0;
  }

  /* Ô Chiến dịch của học sinh → mã chương trình. Hiểu cùng cách với tên chiến dịch Facebook ("Học bổng", "TS 6", "HB27" đều gộp vào mã chuẩn);
   * mã lạ ngắn (≤ 8 ký tự) giữ nguyên làm mã riêng, ô trống hoặc chữ dài là "chưa rõ". */
  function programCode(v) {
    var k = programOf(v); if (k) return k;
    var s = fold(v).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^TS0+(?=\d)/, 'TS');
    return s && s.length <= 8 ? s : UNKNOWN;
  }
  /** Mã mùa bốn chữ số trong tên tab ("LỚP 6 2728 (ĐP)" → "2728"); rỗng khi không có hoặc hai năm không liên tiếp. */
  function seasonCodeOf(text) {
    var re = /(?:^|\D)(\d{2})(\d{2})(?!\d)/g, m, s = String(text == null ? '' : text);
    while ((m = re.exec(s))) if ((+m[1] + 1) % 100 === +m[2]) return m[1] + m[2];
    return '';
  }
  function khoiLabel(v) { var m = String(v == null ? '' : v).match(/(\d{1,2})/); return m && +m[1] >= 1 && +m[1] <= 12 ? 'Khối ' + (+m[1]) : 'Khác'; }
  function seasonOf(header) { var m = String(header || '').match(/(\d{2})\D+(\d{2})\b/); return m && +m[1] >= 20 && +m[1] <= 40 && (+m[1] + 1) % 100 === +m[2] ? '20' + m[1] + '–' + m[2] : ''; }
  function newCount() { return { reg: 0, regInt: 0, paid: 0, paidInt: 0 }; }
  function bump(map, key, rec) {
    var o = map[key] || (map[key] = newCount());
    o.reg++; if (rec.int) o.regInt++;
    if (rec.paid) { o.paid++; if (rec.int) o.paidInt++; }
  }
  function bumpDay(map, day, prog, int) { var d = map[day] || (map[day] = {}), a = d[prog] || (d[prog] = [0, 0]); a[int ? 1 : 0]++; }
  function tabLabel(name, taken) { // tên tab dùng để hiện: bỏ ký tự lạ, tối đa 40 ký tự, không trùng nhau
    var base = String(name || 'ĐP').normalize('NFC').replace(/[^\p{L}\p{N} ()._\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 36) || 'ĐP', out = base, k = 2;
    while (taken[out]) out = base + ' ' + (k++);
    return out;
  }

  /**
   * Tổng hợp từ các bảng (mảng các dòng).
   * @param {{reg: any[][], paid: {name:string, rows:any[][]}[], skipped?: string[], date1904?: boolean}} input
   * @returns {{ok:true, summary:object}|{ok:false, error:string}}
   */
  function aggregate(input) {
    var reg = input && input.reg || [], d1904 = !!(input && input.date1904);
    var h = findHeader(reg);
    if (h < 0) return { ok: false, error: 'Không thấy tab "Danh sách đăng ký" (dòng tiêu đề có cột MDT).' };
    var c = columnsOf(reg[h]);
    if (c.mdt == null || c.program == null) return { ok: false, error: 'Tab "Danh sách đăng ký" cần có cột MDT và cột Chiến dịch.' };

    // Ngày nhập tay có thể gõ nhầm năm. Khi biết ngày hôm nay, ngày sau hôm nay hoặc sớm hơn đầu mùa quảng cáo hơn ba tháng bị coi là không đọc được
    // (được đếm và báo), để một ô sai không kéo cả khoảng thời gian của báo cáo.
    var season = seasonOf(c.khoiHeader), seasonCode = season ? season.slice(2, 4) + season.slice(5, 7) : '';
    var today = isDay(input && input.today) ? input.today : '', lo = '', hi = '';
    if (today) { var sp0 = seasonSpan({ season: season }); lo = addDays(sp0 ? sp0.start : seasonStartOf(today), -EARLY_DAYS); hi = addDays(today, 1); }
    var dayOf = function (v) { // [ngày, có chữ nhưng không dùng được]
      if (blank(v)) return ['', false];
      var d = parseDate(v, d1904);
      return !d || (lo && d < lo) || (hi && d > hi) ? ['', true] : [d, false];
    };

    var students = {}, dup = 0, n = 0, lostReg = 0, lostPaid = 0, regBad = 0, paidBad = 0;
    for (var i = h + 1; i < reg.length; i++) {
      var r = reg[i];
      if (!isStudent(r, c, c.mdt)) { if (lostRow(r, c, true)) lostReg++; continue; }
      var id = mdtKey(r[c.mdt]);
      if (students[id]) { dup++; continue; }
      var rd = '', pd = '', t;
      if (c.regDate != null) { t = dayOf(r[c.regDate]); rd = t[0]; if (t[1]) regBad++; }
      if (c.paidDate != null) { t = dayOf(r[c.paidDate]); pd = t[0]; if (t[1]) paidBad++; }
      students[id] = { p: programCode(r[c.program]), k: c.khoi != null ? khoiLabel(r[c.khoi]) : 'Khác', int: c.internal != null && !blank(r[c.internal]), rd: rd, pd: pd, paid: false };
      n++;
    }
    if (!n) return { ok: false, error: 'Tab "Danh sách đăng ký" chưa có học sinh nào.' };
    if (c.internal == null) return { ok: false, error: 'Tab "Danh sách đăng ký" cần có cột HS nội bộ (để tách học sinh nội bộ khỏi tỷ lệ từ lead Facebook). Không đọc được cột này nên chưa cập nhật.' };

    var paidSheets = {}, missing = {}, skippedTabs = (input.skipped || []).map(function (x) { return tabLabel(x, {}); }), paidDateInPaidSheet = false;
    (input.paid || []).forEach(function (sh) {
      var rows = sh.rows || [], hh = findHeader(rows), code = seasonCodeOf(sh.name);
      if (hh < 0 || (code && seasonCode && code !== seasonCode)) { skippedTabs.push(tabLabel(sh.name, {})); return; } // tab ĐP của mùa khác để lại trong file không được cộng vào mùa này
      var cc = columnsOf(rows[hh]), mc = cc.mdt, seen = {}, cnt = 0;
      for (var i = hh + 1; i < rows.length; i++) {
        var r = rows[i];
        if (!isStudent(r, cc, mc)) { if (lostRow(r, cc, false)) lostPaid++; continue; }
        var id = mdtKey(r[mc]); if (seen[id]) continue; seen[id] = 1; cnt++;
        if (students[id]) {
          students[id].paid = true;
          if (cc.paidDate != null) { var pt = dayOf(r[cc.paidDate]); if (pt[0]) { if (!students[id].pd) students[id].pd = pt[0]; paidDateInPaidSheet = true; } else if (pt[1]) paidBad++; } // cột Ngày đóng phí đặt ngay ở tab ĐP cũng dùng được
        } else missing[id] = 1;
      }
      paidSheets[tabLabel(sh.name, paidSheets)] = cnt;
    });
    if (!Object.keys(paidSheets).length && c.paidDate == null) return { ok: false, error: 'Không đọc được tab (ĐP) nào (tên tab phải kết thúc bằng "(ĐP)" và có cột MDT) và cũng chưa có cột Ngày đóng phí, nên chưa biết học sinh nào đã đóng phí. Chưa cập nhật.' };
    // cột "Ngày đóng phí" có giá trị cũng coi là đã đóng phí
    var hasRegDate = c.regDate != null, hasPaidDate = c.paidDate != null || paidDateInPaidSheet;
    Object.keys(students).forEach(function (id) { var s = students[id]; if (!s.paid && s.pd) s.paid = true; });

    var total = newCount(), programs = {}, khoi = {}, regByDay = {}, regPaidByDay = {}, paidByDay = {}, regNoDate = 0, paidNoDate = 0;
    Object.keys(students).forEach(function (id) {
      var s = students[id];
      bump({ t: total }, 't', s); bump(programs, s.p, s); bump(khoi, s.k, s);
      if (hasRegDate) { if (s.rd) { bumpDay(regByDay, s.rd, s.p, s.int); if (s.paid) bumpDay(regPaidByDay, s.rd, s.p, s.int); } else regNoDate++; }
      if (s.paid && hasPaidDate) { if (s.pd) bumpDay(paidByDay, s.pd, s.p, s.int); else paidNoDate++; }
    });
    return {
      ok: true,
      summary: {
        v: 1, season: season, total: total, programs: programs, khoi: khoi, paidSheets: paidSheets,
        rows: { reg: n, paid: total.paid }, hasRegDate: hasRegDate, hasPaidDate: hasPaidDate,
        regByDay: hasRegDate ? regByDay : {}, regPaidByDay: hasRegDate ? regPaidByDay : {}, paidByDay: hasPaidDate ? paidByDay : {},
        checks: {
          dupMdt: dup, paidNotInRegistration: Object.keys(missing).length, regNoDate: hasRegDate ? regNoDate : null, paidNoDate: hasPaidDate ? paidNoDate : null,
          regBadDate: hasRegDate ? regBad : null, paidBadDate: hasPaidDate ? paidBad : null, skippedReg: lostReg, skippedPaid: lostPaid, paidTabsSkipped: skippedTabs.slice(0, 12)
        }
      }
    };
  }

  /* Ô gộp (merge): lấy giá trị của ô trên cùng bên trái cho các ô còn lại, để cột Chiến dịch, Khối, Ngày… gộp ô không mất dữ liệu. */
  function expandMerges(X, ws) {
    var ms = ws && ws['!merges'], enc = X.utils && X.utils.encode_cell; if (!ms || !ms.length || ms.length > 5000 || !enc) return;
    ms.forEach(function (m) {
      var tl = ws[enc(m.s)]; if (!tl || tl.v == null || (m.e.r - m.s.r + 1) * (m.e.c - m.s.c + 1) > 100000) return;
      for (var r = m.s.r; r <= m.e.r; r++) for (var c = m.s.c; c <= m.e.c; c++) { if (r === m.s.r && c === m.s.c) continue; var a = enc({ r: r, c: c }); if (!ws[a]) ws[a] = { t: tl.t, v: tl.v }; }
    });
  }
  /* Tên tệp trong gói zip (chữ thường ASCII) nằm nguyên văn ở tiêu đề tệp và thư mục trung tâm, nên tìm được mà không cần giải nén. */
  function hasEntry(u8, name) {
    var n = name.length, first = name.charCodeAt(0);
    outer: for (var i = 0, end = u8.length - n; i <= end; i++) {
      if (u8[i] !== first) continue;
      for (var j = 1; j < n; j++) if (u8[i + j] !== name.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  }
  var NOT_XLSX = 'Chỉ đọc được file Excel .xlsx (Google Sheets: Tệp → Tải xuống → Microsoft Excel). File .xls, .xlsb, .ods, .csv hoặc file có mật khẩu không đọc được.';
  /** Đọc workbook bằng thư viện SheetJS (đối tượng X) từ ArrayBuffer rồi tổng hợp. `today` (YYYY-MM-DD, giờ Việt Nam) dùng để loại ngày nhập sai năm; mặc định là hôm nay. */
  function readWorkbook(X, buf, today) {
    var u8 = buf instanceof Uint8Array ? buf : (buf && typeof buf.byteLength === 'number' ? new Uint8Array(buf) : null);
    if (!u8 || u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4b || !hasEntry(u8, 'xl/workbook.xml')) return { ok: false, error: NOT_XLSX };
    if (!isDay(today)) today = vnDate(new Date().toISOString());
    try {
      var names = X.read(buf, { type: 'array', bookSheets: true }).SheetNames || [];
      var regName = names.filter(function (n) { return norm(n) === 'danh sach dang ky'; })[0] || names.filter(function (n) { return /dang k[yi]/.test(norm(n)); })[0];
      if (!regName) return { ok: false, error: 'Không thấy tab "Danh sách đăng ký" trong file.' };
      var paidNames = names.filter(function (n) { return n !== regName && /(^| )dp$/.test(norm(n)); });
      var skipped = names.filter(function (n) { return n !== regName && paidNames.indexOf(n) < 0 && /(^| )(dp|da dong phi)( |$)/.test(norm(n)); });
      var wb = X.read(buf, { type: 'array', cellDates: false, sheets: [regName].concat(paidNames) });
      var rowsOf = function (nm) { expandMerges(X, wb.Sheets[nm]); return X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null, blankrows: false }); };
      var d1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
      return aggregate({ reg: rowsOf(regName), paid: paidNames.map(function (nm) { return { name: nm, rows: rowsOf(nm) }; }), skipped: skipped, date1904: d1904, today: today });
    } catch (e) {
      return { ok: false, error: 'Không đọc được file Excel (' + String(e && e.message || e).slice(0, 80) + '). Hãy tải lại bằng Tệp → Tải xuống → Microsoft Excel (.xlsx).' };
    }
  }

  /* ---------------- kiểm tra dữ liệu gửi lên máy chủ ---------------- */
  function int0(v, max) { if (typeof v !== 'number' || !isFinite(v)) return null; v = Math.round(v); return v >= 0 && v <= (max || 1e6) ? v : null; } // chỉ nhận số, không ép kiểu chuỗi/mảng/null
  function cleanCount(o) {
    var out = {}, ok = o && typeof o === 'object';
    ['reg', 'regInt', 'paid', 'paidInt'].forEach(function (k) { var v = ok ? int0(o[k]) : null; out[k] = v; });
    return out.reg != null && out.regInt != null && out.paid != null && out.paidInt != null && out.regInt <= out.reg && out.paidInt <= out.paid && out.paid <= out.reg ? out : null;
  }
  function sumCounts(map) { var t = newCount(); Object.keys(map).forEach(function (k) { ['reg', 'regInt', 'paid', 'paidInt'].forEach(function (f) { t[f] += map[k][f]; }); }); return t; }
  function sameCounts(a, b) { return a.reg === b.reg && a.regInt === b.regInt && a.paid === b.paid && a.paidInt === b.paidInt; }
  function validSeason(s) { var m = typeof s === 'string' && /^20(\d{2})–(\d{2})$/.exec(s); return !!m && +m[1] >= 20 && +m[1] <= 40 && (+m[1] + 1) % 100 === +m[2]; }
  function cleanDays(m) {
    var out = {}, keys = Object.keys(m || {});
    if (keys.length > 900) return null;
    for (var i = 0; i < keys.length; i++) {
      var d = keys[i]; if (!/^20\d{2}-\d{2}-\d{2}$/.test(d) || ymd(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10)) !== d) return null; // phải là ngày có thật
      var o = {}, ps = Object.keys(m[d] || {}); if (ps.length > 12) return null;
      for (var j = 0; j < ps.length; j++) {
        var p = ps[j], a = m[d][p]; if (!/^[A-Z0-9]{1,8}$/.test(p) || !Array.isArray(a) || a.length !== 2) return null;
        var x = int0(a[0]), y = int0(a[1]); if (x == null || y == null) return null;
        o[p] = [x, y];
      }
      out[d] = o;
    }
    return out;
  }
  function nul(v) { return v == null ? null : int0(v); }
  function validateRaw(s) {
    var bad = function (m) { return { ok: false, error: m }; };
    if (!s || typeof s !== 'object' || s.v !== 1) return bad('Dữ liệu tổng hợp không đúng định dạng.');
    var out = { v: 1 };
    out.season = validSeason(s.season) ? s.season : '';
    out.total = cleanCount(s.total); if (!out.total) return bad('Tổng số không hợp lệ.');
    if (!out.total.reg) return bad('Chưa có học sinh nào trong số tổng hợp.');
    out.programs = {}; var pk = Object.keys(s.programs || {}); if (!pk.length || pk.length > 12) return bad('Danh sách chương trình không hợp lệ (tối đa 12 mã trong cột Chiến dịch).');
    for (var i = 0; i < pk.length; i++) { if (!/^[A-Z0-9]{1,8}$/.test(pk[i])) return bad('Mã chương trình không hợp lệ.'); var c = cleanCount(s.programs[pk[i]]); if (!c) return bad('Số theo chương trình không hợp lệ.'); out.programs[pk[i]] = c; }
    out.khoi = {}; var kk = Object.keys(s.khoi || {}); if (kk.length > 14) return bad('Danh sách khối không hợp lệ.');
    for (i = 0; i < kk.length; i++) { if (!/^(Khối \d{1,2}|Khác)$/.test(kk[i])) return bad('Tên khối không hợp lệ.'); var ck = cleanCount(s.khoi[kk[i]]); if (!ck) return bad('Số theo khối không hợp lệ.'); out.khoi[kk[i]] = ck; }
    if (!sameCounts(sumCounts(out.programs), out.total)) return bad('Tổng theo chương trình không khớp tổng số.');
    if (!sameCounts(sumCounts(out.khoi), out.total)) return bad('Tổng theo khối không khớp tổng số.');
    out.paidSheets = {}; var sk = Object.keys(s.paidSheets || {}); if (sk.length > 12) return bad('Quá nhiều tab ĐP (tối đa 12).');
    for (i = 0; i < sk.length; i++) { if (!/^[\p{L}\p{N} ()._\-]{1,40}$/u.test(sk[i])) return bad('Tên tab ĐP không hợp lệ.'); var cnt = int0(s.paidSheets[sk[i]]); if (cnt == null) return bad('Số ĐP của tab không hợp lệ.'); out.paidSheets[sk[i]] = cnt; }
    out.rows = { reg: out.total.reg, paid: out.total.paid };
    out.hasRegDate = !!s.hasRegDate; out.hasPaidDate = !!s.hasPaidDate;
    out.regByDay = out.hasRegDate ? cleanDays(s.regByDay) : {}; if (!out.regByDay) return bad('Số đăng ký theo ngày không hợp lệ.');
    out.regPaidByDay = out.hasRegDate ? cleanDays(s.regPaidByDay) : {}; if (!out.regPaidByDay) return bad('Số đăng ký đã đóng phí theo ngày không hợp lệ.');
    out.paidByDay = out.hasPaidDate ? cleanDays(s.paidByDay) : {}; if (!out.paidByDay) return bad('Số đóng phí theo ngày không hợp lệ.');
    var ch = s.checks || {}, skippedTabs = [];
    if (Array.isArray(ch.paidTabsSkipped)) {
      if (ch.paidTabsSkipped.length > 12) return bad('Quá nhiều tab ĐP không đọc được.');
      for (i = 0; i < ch.paidTabsSkipped.length; i++) { if (typeof ch.paidTabsSkipped[i] !== 'string' || !/^[\p{L}\p{N} ()._\-]{1,40}$/u.test(ch.paidTabsSkipped[i])) return bad('Tên tab ĐP không đọc được không hợp lệ.'); skippedTabs.push(ch.paidTabsSkipped[i]); }
    }
    out.checks = {
      dupMdt: int0(ch.dupMdt) || 0, paidNotInRegistration: int0(ch.paidNotInRegistration) || 0, regNoDate: nul(ch.regNoDate), paidNoDate: nul(ch.paidNoDate),
      regBadDate: nul(ch.regBadDate), paidBadDate: nul(ch.paidBadDate), skippedReg: int0(ch.skippedReg) || 0, skippedPaid: int0(ch.skippedPaid) || 0, paidTabsSkipped: skippedTabs
    };
    return { ok: true, summary: out };
  }
  /** Dựng lại bản tổng hợp chỉ từ các trường và dạng đã biết: mọi chuỗi lạ (tên, số điện thoại…) bị loại hoặc bị từ chối. Không bao giờ ném lỗi. */
  function validate(s) {
    try { return validateRaw(s); } catch (e) { return { ok: false, error: 'Dữ liệu tổng hợp không đọc được.' }; }
  }

  /* ---------------- ghép với Facebook ---------------- */
  /** Tên chiến dịch Facebook → mã chương trình. Mã TS10/TS6/TS1/JS đứng gần đầu tên thắng; chiến dịch mang hai mã TS khác nhau (nhiều khối) để ở "chưa ghép";
   *  "học bổng"/"HB" chỉ tính khi chưa có mã nào. Chịu được "TS 6", "TS-6", "học_bổng", khoảng trắng lạ. */
  function programOf(name) {
    var n = norm(name), hits = [];
    [['TS10', /(^| )ts ?10(?![0-9])/], ['TS6', /(^| )ts ?6(?![0-9])/], ['TS1', /(^| )ts ?1(?![0-9])/], ['JS', /(^| )js(?![a-z])|jolly/]].forEach(function (p) {
      var m = p[1].exec(n); if (m) hits.push({ k: p[0], at: m.index });
    });
    if (hits.length) {
      if (hits.filter(function (h) { return h.k !== 'JS'; }).length > 1) return null;
      return hits.sort(function (a, b) { return a.at - b.at; })[0].k;
    }
    return /hoc bong/.test(n) || /(^| )hb(?![a-z])/.test(n) ? 'HB' : null; // "HB", "HB 27", "HB27" đều là học bổng; "hbo" thì không
  }
  /** Lead, chi tiêu Facebook theo chương trình trong [since, until]; phần không gắn chương trình nằm ở khoá 'other'. */
  function fbByProgram(C, mdl, accts, since, until) {
    var out = { other: { leads: 0, spend: 0, camps: 0 } }, list = C.campaignsIn(mdl, accts, since, until);
    PROGRAMS.forEach(function (p) { out[p.k] = { leads: 0, spend: 0, camps: 0 }; });
    list.forEach(function (x) {
      var k = programOf(x.c.n) || 'other', o = out[k];
      o.leads += x.period.leads || 0; o.spend += x.period.spend || 0; o.camps++;
    });
    out.approx = !!list.approx;
    return out;
  }

  /* ---------------- chuyển đổi ---------------- */
  function sumDays(map, since, until, prog) {
    var ext = 0, int = 0;
    Object.keys(map || {}).forEach(function (d) {
      if (d < since || d > until) return;
      var a = map[d][prog]; if (a) { ext += a[0]; int += a[1]; }
    });
    return { ext: ext, int: int };
  }
  /** Tỷ lệ học sinh có Ngày đăng ký đọc được (null khi file chưa có cột). */
  function datedShare(sum) {
    var n = sum && sum.total && sum.total.reg, no = sum && sum.checks && sum.checks.regNoDate;
    if (!sum || !sum.hasRegDate || !(n > 0)) return null;
    return no == null ? 1 : Math.max(0, (n - no) / n);
  }
  /** 'dated' khi từ 90% học sinh có Ngày đăng ký đọc được: lấy nhóm học sinh đăng ký trong kỳ và xem bao nhiêu em trong nhóm đó đã đóng phí.
   *  Ngược lại 'season': số tích luỹ cả mùa. (Cột Ngày đóng phí chỉ dùng cho biểu đồ thời điểm đóng phí.) */
  function modeOf(sum) {
    var d = datedShare(sum);
    return d != null && d >= MIN_DATED && Object.keys(sum.regByDay || {}).length ? 'dated' : 'season';
  }
  /** Mùa tuyển sinh trong file ("2027–28") → khoảng ngày của quảng cáo: từ 01/08 năm trước đến 31/07 năm đầu của mùa; null khi file không ghi mùa. */
  function seasonSpan(sum) {
    var m = sum && /^(20\d{2})–\d{2}$/.exec(sum.season || ''); if (!m) return null;
    return { start: (+m[1] - 1) + '-08-01', end: m[1] + '-07-31' };
  }
  /** Khoảng ngày file có số đăng ký (theo Ngày đăng ký) và ngày tải lên; null khi không có theo ngày.
   *  Bỏ qua ngày lẻ loi quá xa: sớm hơn đầu mùa hơn ba tháng hoặc sau ngày tải file (hay sau `today` khi chưa biết ngày tải), phòng khi số liệu cũ còn lẫn ngày gõ sai năm. */
  function coverage(sum, seasonStart, today) {
    var up = vnDate(sum && sum.uploadedAt), ref = up || today || '', lo = addDays(seasonStart, -EARLY_DAYS), hi = ref ? addDays(ref, 1) : '9999-12-31';
    var days = Object.keys(sum && sum.regByDay || {}).filter(function (d) { return d >= lo && d <= hi; }).sort(); if (!days.length) return null;
    var first = days[0], last = days[days.length - 1];
    return { first: first, last: last, uploaded: up, from: first < seasonStart ? first : seasonStart, to: up && up > last ? up : last };
  }
  /**
   * Khoảng thời gian dùng cho lead, chi tiêu Facebook và đếm tuyển sinh. Lead và chi tiêu luôn chỉ tính đến ngày file tuyển sinh được tải lên,
   * để tử số (đăng ký, ĐP trong file) và mẫu số (lead) cùng một mốc thời gian.
   *  'season': từ đầu mùa đến ngày tải file (hoặc hết mùa), không theo kỳ chọn.
   *  'dated': kỳ đang chọn, cắt theo khoảng file có số đăng ký (đầu mùa → ngày tải lên, hoặc hết mùa); kỳ nằm ngoài khoảng đó trả outside = true.
   *  Mùa ghi trong file chưa bắt đầu (nhầm năm trong tiêu đề) cũng trả outside = true, future = true.
   * Kết quả luôn có uploaded (ngày tải file) và staleDays (số ngày từ lúc tải đến `today`).
   */
  function windowOf(sum, since, until, today) {
    var span = seasonSpan(sum), mode = modeOf(sum), up = vnDate(sum && sum.uploadedAt);
    var seasonStart = span ? span.start : seasonStartOf(today), e0 = until > today ? today : until, stale = up ? daysBetween(up, today) : null;
    var base = { mode: mode, seasonStart: seasonStart, uploaded: up, staleDays: stale == null ? null : Math.max(0, stale), atUpload: false, future: false, seasonMismatch: false };
    if (span && span.start > today) return Object.assign(base, { s: since, e: e0, outside: true, clipped: false, cov: null, future: true });
    var seasonEnd = span && span.end < today ? span.end : today;
    if (mode === 'season') {
      var e = up && up >= seasonStart && up < seasonEnd ? up : seasonEnd;
      return Object.assign(base, { s: seasonStart, e: e, outside: false, clipped: false, atUpload: e !== seasonEnd });
    }
    var cov = coverage(sum, seasonStart, today), mismatch = !!(cov && span && cov.first > span.end); // mọi ngày đăng ký đều sau hết mùa ghi ở tiêu đề: nhiều khả năng quên đổi tiêu đề cột Khối
    if (cov && span && cov.to > span.end) cov = Object.assign({}, cov, { to: span.end });
    if (!cov || e0 < cov.from || since > cov.to) return Object.assign(base, { s: since, e: e0, outside: true, clipped: false, cov: cov, seasonMismatch: mismatch });
    var s = since < cov.from ? cov.from : since, e2 = e0 > cov.to ? cov.to : e0;
    return Object.assign(base, { s: s, e: e2, outside: false, clipped: s !== since || e2 !== e0, cov: cov });
  }
  function ratio(a, b, min) { return b >= (min == null ? MIN_BASE : min) && b > 0 ? a / b : null; }

  /**
   * Bảng chuyển đổi theo chương trình. Đã đóng phí = học sinh (trong nhóm đăng ký của kỳ) có mặt ở các tab ĐP hoặc có Ngày đóng phí.
   * Chỉ năm chương trình TS1, JS, TS6, TS10, HB (có chiến dịch Facebook để ghép) vào dòng Tổng. Học sinh mang mã khác (extra) hoặc để trống
   * ô Chiến dịch (unknown) hiện riêng và không cộng vào Tổng; apart cộng gộp hai nhóm đó để báo.
   * @param sum   bản tổng hợp (validate().summary)
   * @param fb    kết quả fbByProgram cho cùng kỳ
   * @returns {{mode, rows, extra, unknown, apart, total, other}}
   */
  function funnel(sum, fb, since, until) {
    var mode = modeOf(sum);
    var extraKeys = Object.keys(sum.programs).filter(function (k) { return !KNOWN[k] && k !== UNKNOWN; });
    function counts(k) {
      var base = sum.programs[k] || newCount();
      if (mode === 'dated') {
        var r = sumDays(sum.regByDay, since, until, k), p = sumDays(sum.regPaidByDay, since, until, k);
        return { regExt: r.ext, regInt: r.int, paidExt: p.ext, paidInt: p.int };
      }
      return { regExt: base.reg - base.regInt, regInt: base.regInt, paidExt: base.paid - base.paidInt, paidInt: base.paidInt };
    }
    function row(k, label) {
      var c = counts(k), f = fb && fb[k] || { leads: 0, spend: 0, camps: 0 };
      return {
        k: k, label: label, leads: f.leads, spend: f.spend, camps: f.camps || 0, regExt: c.regExt, regInt: c.regInt, paidExt: c.paidExt, paidInt: c.paidInt,
        leadToReg: ratio(c.regExt, f.leads), regToPaid: ratio(c.paidExt, c.regExt), leadToPaid: ratio(c.paidExt, f.leads),
        costPerReg: c.regExt > 0 && f.spend > 0 ? f.spend / c.regExt : null, costPerPaid: c.paidExt > 0 && f.spend > 0 ? f.spend / c.paidExt : null
      };
    }
    var rows = PROGRAMS.map(function (p) { return row(p.k, p.label); });
    var extra = extraKeys.map(function (k) { return row(k, k); });
    var unknown = sum.programs[UNKNOWN] ? row(UNKNOWN, 'Chưa rõ chương trình') : null;
    // Tổng chỉ cộng năm chương trình có chiến dịch Facebook để ghép. Mã khác và ô trống không có lead hay chi tiêu tương ứng,
    // cộng vào sẽ làm tỷ lệ lead → đăng ký/ĐP cao giả và chi phí cho mỗi học sinh thấp giả; các dòng đó hiện riêng, kèm ghi chú.
    var t = { k: 'total', label: 'Tổng', leads: 0, spend: 0, camps: 0, regExt: 0, regInt: 0, paidExt: 0, paidInt: 0 };
    rows.forEach(function (r) { ['leads', 'spend', 'camps', 'regExt', 'regInt', 'paidExt', 'paidInt'].forEach(function (f) { t[f] += r[f]; }); });
    t.leadToReg = ratio(t.regExt, t.leads); t.regToPaid = ratio(t.paidExt, t.regExt); t.leadToPaid = ratio(t.paidExt, t.leads);
    t.costPerReg = t.regExt > 0 && t.spend > 0 ? t.spend / t.regExt : null; t.costPerPaid = t.paidExt > 0 && t.spend > 0 ? t.spend / t.paidExt : null;
    var apart = { regExt: 0, paidExt: 0, regInt: 0, paidInt: 0, codes: extraKeys.slice(), blank: !!unknown }; // học sinh ngoài Tổng
    extra.concat(unknown ? [unknown] : []).forEach(function (r) { apart.regExt += r.regExt; apart.paidExt += r.paidExt; apart.regInt += r.regInt; apart.paidInt += r.paidInt; });
    return { mode: mode, rows: rows, extra: extra, unknown: unknown, apart: apart, total: t, other: fb && fb.other || { leads: 0, spend: 0, camps: 0 }, minBase: MIN_BASE };
  }

  /** Gói số liệu cho phần Phân tích của Claude (chỉ số tổng hợp, không có thông tin cá nhân). */
  function packOf(C, mdl, accts, sum, today) {
    var D = C.dates, r2 = function (x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 10; }, r0 = function (x) { return x == null || !isFinite(x) ? null : Math.round(x); };
    function block(since, until) {
      var w = windowOf(sum, since, until, today);
      if (w.outside) return { since: since, until: until, outside_registration_data: true, note: w.future ? 'Mùa tuyển sinh ghi trong file chưa bắt đầu; không có số chuyển đổi.' : w.seasonMismatch ? 'Ngày đăng ký trong file nằm sau khi mùa ghi ở tiêu đề cột Khối kết thúc (nhiều khả năng chưa đổi tiêu đề); không có số chuyển đổi.' : 'Kỳ này nằm ngoài khoảng file tuyển sinh có số đăng ký' + (w.cov ? ' (' + w.cov.from + ' đến ' + w.cov.to + ')' : '') + '; không có số chuyển đổi.' };
      var f = funnel(sum, fbByProgram(C, mdl, accts, w.s, w.e), w.s, w.e);
      var one = function (r) {
        return { program: r.k, label: r.label, fb_leads: r0(r.leads), fb_spend: r0(r.spend), registered_external: r.regExt, registered_internal: r.regInt, paid_external: r.paidExt, paid_internal: r.paidInt,
          lead_to_registered_pct: r2(r.leadToReg), registered_to_paid_pct: r2(r.regToPaid), lead_to_paid_pct: r2(r.leadToPaid), cost_per_registered: r0(r.costPerReg), cost_per_paid: r0(r.costPerPaid) };
      };
      var b = { since: w.s, until: w.e, programs: f.rows.map(one), total: one(f.total), fb_spend_other_programs: r0(f.other.spend), fb_leads_other_programs: r0(f.other.leads) };
      var apart = f.extra.concat(f.unknown ? [f.unknown] : []);
      if (apart.length) b.programs_not_in_total = apart.map(one);
      if (w.clipped) b.note = 'Kỳ được cắt theo khoảng file có số đăng ký.';
      else if (w.atUpload) b.note = 'Lead và chi tiêu chỉ tính đến ngày tải file tuyển sinh (' + w.e + '), cùng mốc với số đăng ký.';
      return b;
    }
    var mode = modeOf(sum), ds = datedShare(sum), ck = sum.checks || {}, age = windowOf(sum, today, today, today).staleDays;
    var out = {
      updated_at: sum.uploadedAt || null, file_age_days: age, season: sum.season || null, mode: mode,
      notes: [
        'Đã đóng phí (ĐP) = học sinh có trong các tab (ĐP) của file DATA TUYỂN SINH. "external" là học sinh bên ngoài; học sinh nội bộ (đang học ở trường) được tách riêng vì không đến từ quảng cáo.',
        'Số đăng ký có thể đến cả từ nguồn ngoài Facebook (giới thiệu, sự kiện…), nên tỷ lệ lead → đăng ký/ĐP là ước tính gộp và cost_per_paid thấp hơn thực tế nếu một phần học sinh không đến từ Facebook.',
        'Chương trình ghép với chiến dịch Facebook theo tên chiến dịch: TS1, JS, TS6, TS10; HB là chiến dịch có chữ học bổng/HB mà chưa mang mã TS. Chiến dịch khác nằm ở fb_*_other_programs, không vào tỷ lệ. Học sinh mang mã chương trình khác hoặc để trống ô Chiến dịch nằm ở programs_not_in_total và không cộng vào total.',
        'Lead và chi tiêu Facebook chỉ tính đến ngày tải file tuyển sinh (file càng cũ thì số đăng ký càng chưa theo kịp lead mới)' + (age != null && age > 3 ? '; file này cập nhật ' + age + ' ngày trước' : '') + '.',
        mode === 'dated'
          ? 'Theo kỳ: nhóm học sinh đăng ký trong kỳ và số em trong nhóm đã đóng phí tính đến nay; học sinh đăng ký gần đây có thể chưa kịp đóng phí.' + (ck.regNoDate > 0 ? ' ' + ck.regNoDate + ' học sinh chưa có Ngày đăng ký nên không nằm trong số theo kỳ.' : '')
          : 'Số tuyển sinh là tích luỹ cả mùa' + (sum.hasRegDate ? ' (cột Ngày đăng ký mới có ở ' + Math.round((ds || 0) * 100) + '% học sinh, chưa đủ 90% để xem theo kỳ)' : ' (file chưa có cột Ngày đăng ký)') + '; lead và chi tiêu Facebook tính từ đầu mùa.'
      ],
      school_year_to_date: block(D.schoolYearStart(today), today)
    };
    if (mode === 'dated') { out.last30d = block(D.addDays(today, -30), D.addDays(today, -1)); out.prev30d = block(D.addDays(today, -60), D.addDays(today, -31)); }
    out.by_grade = Object.keys(sum.khoi).map(function (k) { var o = sum.khoi[k]; return { grade: k, registered_external: o.reg - o.regInt, paid_external: o.paid - o.paidInt, registered_internal: o.regInt, paid_internal: o.paidInt }; });
    return out;
  }

  var api = {
    PROGRAMS: PROGRAMS, UNKNOWN: UNKNOWN, MIN_BASE: MIN_BASE, MIN_DATED: MIN_DATED, fold: fold, norm: norm, parseDate: parseDate, mdtKey: mdtKey, programOf: programOf, aggregate: aggregate,
    readWorkbook: readWorkbook, validate: validate, fbByProgram: fbByProgram, funnel: funnel, modeOf: modeOf, datedShare: datedShare, coverage: coverage, windowOf: windowOf, seasonSpan: seasonSpan, packOf: packOf,
    programCode: programCode, seasonCodeOf: seasonCodeOf, addDays: addDays
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FBAdm = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
