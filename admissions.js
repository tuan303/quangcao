/* admissions.js – Chuyển đổi tuyển sinh: từ lead Facebook đến học sinh đăng ký và đã đóng phí (ĐP).
 *
 * Đọc file "DATA TUYỂN SINH" (tab "Danh sách đăng ký" và các tab "(ĐP)"), chỉ giữ SỐ TỔNG HỢP: không lưu tên, ngày sinh,
 * số điện thoại hay bất kỳ chuỗi nào của học sinh. Ghép chương trình tuyển sinh (TS1, JS, TS6, TS10, HB) với chiến dịch
 * Facebook theo tên chiến dịch rồi tính tỷ lệ chuyển đổi và chi phí cho mỗi học sinh đã đóng phí.
 *
 * Một tệp, hai nơi dùng: trang (window.FBAdm) và máy chủ/kiểm thử Node (globalThis.FBAdm). Chỉ là hàm thuần, không DOM, không mạng.
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
  var MIN_BASE = 10; // dưới mức này không tính tỷ lệ phần trăm

  /* ---------------- chuỗi ---------------- */
  function fold(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'); }
  function norm(s) { return fold(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function blank(v) { return v == null || (typeof v === 'string' && !v.trim()); }
  function validMdt(v) { return (typeof v === 'number' && isFinite(v) && v > 0 && Math.floor(v) === v) || (typeof v === 'string' && /^\d{1,12}$/.test(v.trim())); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- ngày ---------------- */
  function validYMD(y, m, d) { return y >= 2020 && y <= 2040 && m >= 1 && m <= 12 && d >= 1 && d <= 31; }
  /** Giá trị ô → 'YYYY-MM-DD' hoặc ''. Nhận số seri Excel, 'dd/mm/yyyy', 'yyyy-mm-dd'. */
  function parseDate(v) {
    if (blank(v)) return '';
    if (typeof v === 'number') {
      if (!(v > 40000 && v < 60000)) return '';
      var dt = new Date(Math.round((Math.floor(v) - 25569) * 86400000)); // 25569 = 01/01/1970 theo số seri Excel
      return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
    }
    var s = String(v).trim(), m;
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/)) && validYMD(+m[3], +m[2], +m[1])) return m[3] + '-' + pad(+m[2]) + '-' + pad(+m[1]);
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)) && validYMD(+m[1], +m[2], +m[3])) return m[1] + '-' + m[2] + '-' + m[3];
    return '';
  }

  /* ---------------- bảng tính ---------------- */
  function findHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 20); i++) { var r = rows[i]; if (r && norm(r[0]) === 'mdt') return i; }
    return -1;
  }
  function columnsOf(header) {
    var c = {};
    for (var j = 0; j < header.length; j++) {
      var n = norm(header[j]); if (!n) continue;
      if (n === 'mdt' && c.mdt == null) c.mdt = j;
      else if (/^hs noi bo/.test(n) && c.internal == null) c.internal = j;
      else if (/^khoi/.test(n) && c.khoi == null) { c.khoi = j; c.khoiHeader = String(header[j]); }
      else if (/^ho ten/.test(n) && c.name == null) c.name = j;
      else if (n === 'chien dich' && c.program == null) c.program = j;
      else if (/ngay (dang ky|dk)\b/.test(n) && c.regDate == null) c.regDate = j;
      else if (/ngay (dong phi|nop phi|dp)\b/.test(n) && c.paidDate == null) c.paidDate = j;
    }
    return c;
  }
  function filledCells(r, skip) { var n = 0; for (var j = 0; j < r.length; j++) if (j !== skip && !blank(r[j])) n++; return n; }
  /* Dòng học sinh: có MDT và có họ tên (dòng đếm tổng hay dòng tiêu đề phụ chỉ có số/nhãn nên bị loại). Không tìm thấy cột họ tên thì cần từ 2 ô có dữ liệu. */
  function isStudent(r, cols, mc) {
    if (!r || !validMdt(r[mc])) return false;
    if (cols.name != null) return typeof r[cols.name] === 'string' && !!r[cols.name].trim();
    return filledCells(r, mc) >= 2;
  }

  function programCode(v) {
    var s = fold(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s && s.length <= 8 ? s : 'KHAC';
  }
  function khoiLabel(v) { var m = String(v == null ? '' : v).match(/(\d{1,2})/); return m && +m[1] >= 1 && +m[1] <= 12 ? 'Khối ' + (+m[1]) : 'Khác'; }
  function seasonOf(header) { var m = String(header || '').match(/(\d{2})\D+(\d{2})\b/); return m ? '20' + m[1] + '–' + m[2] : ''; }
  function newCount() { return { reg: 0, regInt: 0, paid: 0, paidInt: 0 }; }
  function bump(map, key, rec) {
    var o = map[key] || (map[key] = newCount());
    o.reg++; if (rec.int) o.regInt++;
    if (rec.paid) { o.paid++; if (rec.int) o.paidInt++; }
  }
  function bumpDay(map, day, prog, int) { var d = map[day] || (map[day] = {}), a = d[prog] || (d[prog] = [0, 0]); a[int ? 1 : 0]++; }

  /**
   * Tổng hợp từ các bảng (mảng các dòng).
   * @param {{reg: any[][], paid: {name:string, rows:any[][]}[]}} input
   * @returns {{ok:true, summary:object}|{ok:false, error:string}}
   */
  function aggregate(input) {
    var reg = input && input.reg || [];
    var h = findHeader(reg);
    if (h < 0) return { ok: false, error: 'Không thấy tab "Danh sách đăng ký" (dòng tiêu đề có cột MDT).' };
    var c = columnsOf(reg[h]);
    if (c.mdt == null || c.program == null) return { ok: false, error: 'Tab "Danh sách đăng ký" cần có cột MDT và cột Chiến dịch.' };

    var students = {}, dup = 0, n = 0;
    for (var i = h + 1; i < reg.length; i++) {
      var r = reg[i]; if (!isStudent(r, c, c.mdt)) continue;
      var id = String(r[c.mdt]).trim();
      if (students[id]) { dup++; continue; }
      students[id] = {
        p: programCode(r[c.program]), k: c.khoi != null ? khoiLabel(r[c.khoi]) : 'Khác',
        int: c.internal != null && !blank(r[c.internal]),
        rd: c.regDate != null ? parseDate(r[c.regDate]) : '', pd: c.paidDate != null ? parseDate(r[c.paidDate]) : '', paid: false
      };
      n++;
    }
    if (!n) return { ok: false, error: 'Tab "Danh sách đăng ký" chưa có học sinh nào.' };

    var paidSheets = {}, notInReg = 0, nPaidRows = 0, paidDateInPaidSheet = false;
    (input.paid || []).forEach(function (sh) {
      var rows = sh.rows || [], hh = findHeader(rows); if (hh < 0) return;
      var cc = columnsOf(rows[hh]), mc = cc.mdt == null ? 0 : cc.mdt, seen = {}, cnt = 0;
      for (var i = hh + 1; i < rows.length; i++) {
        var r = rows[i]; if (!isStudent(r, cc, mc)) continue;
        var id = String(r[mc]).trim(); if (seen[id]) continue; seen[id] = 1; cnt++;
        if (students[id]) {
          if (!students[id].paid) { students[id].paid = true; nPaidRows++; }
          if (cc.paidDate != null && !students[id].pd) { students[id].pd = parseDate(r[cc.paidDate]); if (students[id].pd) paidDateInPaidSheet = true; } // cột Ngày đóng phí đặt ngay ở tab ĐP cũng dùng được
        } else notInReg++;
      }
      paidSheets[String(sh.name || 'ĐP').replace(/[^\p{L}\p{N} ()._\-]/gu, '').slice(0, 40) || 'ĐP'] = cnt;
    });
    // cột "Ngày đóng phí" có giá trị cũng coi là đã đóng phí
    var hasRegDate = c.regDate != null, hasPaidDate = c.paidDate != null || paidDateInPaidSheet;
    Object.keys(students).forEach(function (id) { var s = students[id]; if (!s.paid && s.pd) { s.paid = true; nPaidRows++; } });

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
        v: 1, season: seasonOf(c.khoiHeader), total: total, programs: programs, khoi: khoi, paidSheets: paidSheets,
        rows: { reg: n, paid: total.paid }, hasRegDate: hasRegDate, hasPaidDate: hasPaidDate,
        regByDay: hasRegDate ? regByDay : {}, regPaidByDay: hasRegDate ? regPaidByDay : {}, paidByDay: hasPaidDate ? paidByDay : {},
        checks: { dupMdt: dup, paidNotInRegistration: notInReg, regNoDate: hasRegDate ? regNoDate : null, paidNoDate: hasPaidDate ? paidNoDate : null }
      }
    };
  }

  /** Đọc workbook bằng thư viện SheetJS (đối tượng X) từ ArrayBuffer rồi tổng hợp. */
  function readWorkbook(X, buf) {
    var names = X.read(buf, { type: 'array', bookSheets: true }).SheetNames || [];
    var regName = names.filter(function (n) { return norm(n) === 'danh sach dang ky'; })[0] || names.filter(function (n) { return /dang ky/.test(norm(n)); })[0];
    var paidNames = names.filter(function (n) { return /(^| )dp$/.test(norm(n)); });
    if (!regName) return { ok: false, error: 'Không thấy tab "Danh sách đăng ký" trong file.' };
    var wb = X.read(buf, { type: 'array', cellDates: false, sheets: [regName].concat(paidNames) });
    var rowsOf = function (nm) { return X.utils.sheet_to_json(wb.Sheets[nm], { header: 1, raw: true, defval: null, blankrows: false }); };
    return aggregate({ reg: rowsOf(regName), paid: paidNames.map(function (nm) { return { name: nm, rows: rowsOf(nm) }; }) });
  }

  /* ---------------- kiểm tra dữ liệu gửi lên máy chủ ---------------- */
  function int0(v, max) { v = Math.round(Number(v)); return isFinite(v) && v >= 0 && v <= (max || 1e6) ? v : null; }
  function cleanCount(o) {
    var out = {}, ok = o && typeof o === 'object';
    ['reg', 'regInt', 'paid', 'paidInt'].forEach(function (k) { var v = ok ? int0(o[k]) : null; out[k] = v; });
    return out.reg != null && out.regInt != null && out.paid != null && out.paidInt != null && out.regInt <= out.reg && out.paidInt <= out.paid && out.paid <= out.reg ? out : null;
  }
  function cleanDays(m) {
    var out = {}, keys = Object.keys(m || {});
    if (keys.length > 900) return null;
    for (var i = 0; i < keys.length; i++) {
      var d = keys[i]; if (!/^20\d{2}-\d{2}-\d{2}$/.test(d)) return null;
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
  /** Dựng lại bản tổng hợp chỉ từ các trường và dạng đã biết: mọi chuỗi lạ (tên, số điện thoại…) bị loại hoặc bị từ chối. */
  function validate(s) {
    var bad = function (m) { return { ok: false, error: m }; };
    if (!s || typeof s !== 'object' || s.v !== 1) return bad('Dữ liệu tổng hợp không đúng định dạng.');
    var out = { v: 1 };
    out.season = /^20\d{2}–\d{2}$/.test(s.season) ? s.season : '';
    out.total = cleanCount(s.total); if (!out.total) return bad('Tổng số không hợp lệ.');
    out.programs = {}; var pk = Object.keys(s.programs || {}); if (!pk.length || pk.length > 12) return bad('Danh sách chương trình không hợp lệ.');
    for (var i = 0; i < pk.length; i++) { if (!/^[A-Z0-9]{1,8}$/.test(pk[i])) return bad('Mã chương trình không hợp lệ.'); var c = cleanCount(s.programs[pk[i]]); if (!c) return bad('Số theo chương trình không hợp lệ.'); out.programs[pk[i]] = c; }
    out.khoi = {}; var kk = Object.keys(s.khoi || {}); if (kk.length > 14) return bad('Danh sách khối không hợp lệ.');
    for (i = 0; i < kk.length; i++) { if (!/^(Khối \d{1,2}|Khác)$/.test(kk[i])) return bad('Tên khối không hợp lệ.'); var ck = cleanCount(s.khoi[kk[i]]); if (!ck) return bad('Số theo khối không hợp lệ.'); out.khoi[kk[i]] = ck; }
    out.paidSheets = {}; var sk = Object.keys(s.paidSheets || {}); if (sk.length > 12) return bad('Quá nhiều tab ĐP.');
    for (i = 0; i < sk.length; i++) { if (!/^[\p{L}\p{N} ()._\-]{1,40}$/u.test(sk[i])) return bad('Tên tab ĐP không hợp lệ.'); var cnt = int0(s.paidSheets[sk[i]]); if (cnt == null) return bad('Số ĐP của tab không hợp lệ.'); out.paidSheets[sk[i]] = cnt; }
    out.rows = { reg: out.total.reg, paid: out.total.paid };
    out.hasRegDate = !!s.hasRegDate; out.hasPaidDate = !!s.hasPaidDate;
    out.regByDay = out.hasRegDate ? cleanDays(s.regByDay) : {}; if (!out.regByDay) return bad('Số đăng ký theo ngày không hợp lệ.');
    out.regPaidByDay = out.hasRegDate ? cleanDays(s.regPaidByDay) : {}; if (!out.regPaidByDay) return bad('Số đăng ký đã đóng phí theo ngày không hợp lệ.');
    out.paidByDay = out.hasPaidDate ? cleanDays(s.paidByDay) : {}; if (!out.paidByDay) return bad('Số đóng phí theo ngày không hợp lệ.');
    var ch = s.checks || {};
    out.checks = { dupMdt: int0(ch.dupMdt) || 0, paidNotInRegistration: int0(ch.paidNotInRegistration) || 0, regNoDate: ch.regNoDate == null ? null : int0(ch.regNoDate), paidNoDate: ch.paidNoDate == null ? null : int0(ch.paidNoDate) };
    return { ok: true, summary: out };
  }

  /* ---------------- ghép với Facebook ---------------- */
  /** Tên chiến dịch Facebook → mã chương trình. Tiền tố TS10/TS6/TS1/JS đi trước; "học bổng"/"HB" chỉ tính khi chưa có tiền tố. */
  function programOf(name) {
    var n = fold(name).toUpperCase();
    if (/(^|[^A-Z0-9])TS10(?![0-9])/.test(n)) return 'TS10';
    if (/(^|[^A-Z0-9])TS6(?![0-9])/.test(n)) return 'TS6';
    if (/(^|[^A-Z0-9])TS1(?![0-9])/.test(n)) return 'TS1';
    if (/(^|[^A-Z0-9])JS(?![A-Z])/.test(n) || /JOLLY/.test(n)) return 'JS';
    if (/HOC BONG/.test(n) || /(^|[^A-Z0-9])HB([^A-Z0-9]|$)/.test(n)) return 'HB';
    return null;
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
  /** 'dated' khi có cột Ngày đăng ký: lấy nhóm học sinh đăng ký trong kỳ và xem bao nhiêu em trong nhóm đó đã đóng phí.
   *  Ngược lại 'season': số tích luỹ cả mùa. (Cột Ngày đóng phí chỉ dùng cho biểu đồ thời điểm đóng phí.) */
  function modeOf(sum) { return sum && sum.hasRegDate ? 'dated' : 'season'; }
  function ratio(a, b, min) { return b >= (min == null ? MIN_BASE : min) && b > 0 ? a / b : null; }

  /**
   * Bảng chuyển đổi theo chương trình. Đã đóng phí = học sinh (trong nhóm đăng ký của kỳ) có mặt ở các tab ĐP hoặc có Ngày đóng phí.
   * @param sum   bản tổng hợp (validate().summary)
   * @param fb    kết quả fbByProgram cho cùng kỳ
   * @returns {{mode, rows, total, other, extra}}
   */
  function funnel(sum, fb, since, until) {
    var mode = modeOf(sum), keys = PROGRAMS.map(function (p) { return p.k; });
    var extraKeys = Object.keys(sum.programs).filter(function (k) { return !KNOWN[k]; });
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
    var t = { k: 'total', label: 'Tổng', leads: 0, spend: 0, camps: 0, regExt: 0, regInt: 0, paidExt: 0, paidInt: 0 };
    rows.concat(extra).forEach(function (r) { ['leads', 'spend', 'camps', 'regExt', 'regInt', 'paidExt', 'paidInt'].forEach(function (f) { t[f] += r[f]; }); });
    t.leadToReg = ratio(t.regExt, t.leads); t.regToPaid = ratio(t.paidExt, t.regExt); t.leadToPaid = ratio(t.paidExt, t.leads);
    t.costPerReg = t.regExt > 0 && t.spend > 0 ? t.spend / t.regExt : null; t.costPerPaid = t.paidExt > 0 && t.spend > 0 ? t.spend / t.paidExt : null;
    return { mode: mode, rows: rows, extra: extra, total: t, other: fb && fb.other || { leads: 0, spend: 0, camps: 0 }, minBase: MIN_BASE };
  }

  /** Gói số liệu cho phần Phân tích của Claude (chỉ số tổng hợp, không có thông tin cá nhân). */
  function packOf(C, mdl, accts, sum, today) {
    var D = C.dates, r2 = function (x) { return x == null || !isFinite(x) ? null : Math.round(x * 1000) / 10; }, r0 = function (x) { return x == null || !isFinite(x) ? null : Math.round(x); };
    function block(since, until) {
      var f = funnel(sum, fbByProgram(C, mdl, accts, since, until), since, until);
      var one = function (r) {
        return { program: r.k, label: r.label, fb_leads: r0(r.leads), fb_spend: r0(r.spend), registered_external: r.regExt, registered_internal: r.regInt, paid_external: r.paidExt, paid_internal: r.paidInt,
          lead_to_registered_pct: r2(r.leadToReg), registered_to_paid_pct: r2(r.regToPaid), lead_to_paid_pct: r2(r.leadToPaid), cost_per_registered: r0(r.costPerReg), cost_per_paid: r0(r.costPerPaid) };
      };
      return { since: since, until: until, programs: f.rows.concat(f.extra).map(one), total: one(f.total), fb_spend_other_programs: r0(f.other.spend), fb_leads_other_programs: r0(f.other.leads) };
    }
    var mode = modeOf(sum), sy = D.schoolYearStart(today);
    var out = {
      updated_at: sum.uploadedAt || null, season: sum.season || null, mode: mode,
      notes: [
        'Đã đóng phí (ĐP) = học sinh có trong các tab (ĐP) của file DATA TUYỂN SINH. "external" là học sinh bên ngoài; học sinh nội bộ (đang học ở trường) được tách riêng vì không đến từ quảng cáo.',
        'Số đăng ký có thể đến cả từ nguồn ngoài Facebook (giới thiệu, sự kiện…), nên tỷ lệ lead → đăng ký/ĐP là ước tính gộp và cost_per_paid thấp hơn thực tế nếu một phần học sinh không đến từ Facebook.',
        'Chương trình ghép với chiến dịch Facebook theo tên chiến dịch: TS1, JS, TS6, TS10; HB là chiến dịch có chữ học bổng/HB mà chưa mang mã TS.',
        mode === 'dated' ? 'Theo kỳ: nhóm học sinh đăng ký trong kỳ và số em trong nhóm đã đóng phí tính đến nay; học sinh đăng ký gần đây có thể chưa kịp đóng phí.' : 'Chưa có cột ngày đăng ký trong file: số liệu tuyển sinh là tích luỹ cả mùa, lead và chi tiêu Facebook tính từ đầu năm học.'
      ],
      school_year_to_date: block(sy, today)
    };
    if (mode === 'dated') { out.last30d = block(D.addDays(today, -30), D.addDays(today, -1)); out.prev30d = block(D.addDays(today, -60), D.addDays(today, -31)); }
    out.by_grade = Object.keys(sum.khoi).map(function (k) { var o = sum.khoi[k]; return { grade: k, registered_external: o.reg - o.regInt, paid_external: o.paid - o.paidInt, registered_internal: o.regInt, paid_internal: o.paidInt }; });
    return out;
  }

  var api = { PROGRAMS: PROGRAMS, packOf: packOf, MIN_BASE: MIN_BASE, fold: fold, norm: norm, parseDate: parseDate, programOf: programOf, aggregate: aggregate, readWorkbook: readWorkbook, validate: validate, fbByProgram: fbByProgram, funnel: funnel, modeOf: modeOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FBAdm = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
