/* leadmatch.js – Đối chiếu TỪNG PHỤ HUYNH: người đã điền form lead trên Facebook ↔ học sinh đã đóng phí (ĐP).
 *
 * Khớp theo số điện thoại (và email) của phụ huynh: lead Facebook (SĐT, email trong biểu mẫu) với SĐT/email bố, mẹ trong file DATA TUYỂN SINH.
 * SĐT và email chỉ nằm trong bộ nhớ lúc tính. Kết quả lưu lại là SỐ TỔNG HỢP theo ngày điền form và chiến dịch: không có tên, SĐT hay email.
 *
 * Quy tắc tính (đều có kiểm thử):
 *  - Một phụ huynh = một khoá liên hệ (SĐT đầu tiên; không có SĐT thì email). Điền form nhiều lần chỉ tính một lần, lấy lần ĐẦU TIÊN (first touch) làm ngày và chiến dịch.
 *  - Một học sinh chỉ được tính cho một lead (lead sớm nhất khớp được em). Bố và mẹ cùng điền form cho một em: tính một gia đình, không tính hai lead.
 *  - Học sinh nội bộ (HS nội bộ) không phải từ quảng cáo: lead chỉ khớp học sinh nội bộ được ghi riêng và không nằm trong mẫu số của tỷ lệ.
 *  - Học sinh đã đăng ký (hoặc đóng phí) TRƯỚC ngày điền form không tính cho form đó (quảng cáo không gây ra việc đã xảy ra); được ghi riêng và không nằm trong mẫu số.
 *  - Số điện thoại khớp quá nhiều học sinh (> MAX_SIBLINGS) là số dùng chung: coi như chưa khớp.
 *
 * Một tệp, hai nơi dùng: máy chủ/kiểm thử Node và trang (globalThis.FBMatch). Cần admissions.js (FBAdm) nạp trước. Chỉ là hàm thuần, không DOM, không mạng.
 */
(function (root) {
  'use strict';

  var PROGRAMS = ['TS1', 'JS', 'TS6', 'TS10', 'HB', 'OTHER'];   // OTHER: chiến dịch không ghép được chương trình
  var MAX_SIBLINGS = 6;          // một số điện thoại khớp quá nhiều học sinh: số dùng chung, không khớp
  var KEEP_DAYS = 88;            // Meta chỉ cho đọc lead trong 90 ngày (lần đọc lấy từ 90 ngày trước); ngày cũ hơn 88 ngày mới đóng băng, để còn vài lần chạy sửa được nếu một lần đọc bị hụt
  var ORGANIC = 'organic', NONE = 'none';
  /* Ô số liệu theo ngày điền form × chiến dịch, thứ tự cố định:
   *  l  phụ huynh (gia đình) điền form        i  chỉ khớp học sinh nội bộ          b  chỉ khớp học sinh đã đăng ký trước form
   *  r  có con đăng ký (do form)             p  có con đã đóng phí (do form)
   *  rs số học sinh đăng ký (do form)        ps số học sinh đã đóng phí (do form) */
  var CELL = ['l', 'i', 'b', 'r', 'p', 'rs', 'ps'], N = CELL.length;

  function adm() { return root.FBAdm; }
  function isDay(s) { return typeof s === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
  function vnDay(iso) { // thời điểm Meta ghi (UTC, có thể dạng +0000) → ngày giờ Việt Nam
    var t = Date.parse(String(iso || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); if (!isFinite(t)) return { day: '', at: '' };
    var v = new Date(t + 7 * 3600000).toISOString(); return { day: v.slice(0, 10), at: v.slice(0, 19) };
  }
  function daysBetween(a, b) { var x = Date.parse(a + 'T00:00:00Z'), y = Date.parse(b + 'T00:00:00Z'); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : null; }
  function cleanName(s) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} _\-|·()\[\].,+&/:%#]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120); }

  /* ---------------- lead ---------------- */
  var PHONE_FIELD = /(phone|sdt|dien.?thoai|di.?dong|zalo|mobile)/, MAIL_FIELD = /e.?mail/;
  /** Lead từ Graph API (mục leads của biểu mẫu) → { id, day, at, cid, cname, organic, ph, em }. ph/em là khoá đã chuẩn hoá, chỉ để khớp và không bao giờ được lưu. */
  function leadFromGraph(l) {
    var A = adm(), ph = [], em = [], push = function (arr, k) { if (k && arr.indexOf(k) < 0) arr.push(k); };
    (l && Array.isArray(l.field_data) ? l.field_data : []).forEach(function (f) {
      var name = A.fold(String(f && f.name || '')).toLowerCase();
      (f && Array.isArray(f.values) ? f.values : []).forEach(function (v) {
        if (typeof v !== 'string' && typeof v !== 'number') return;
        var s = String(v);
        if (MAIL_FIELD.test(name) || s.indexOf('@') >= 0) A.emailKeys(s).forEach(function (k) { push(em, k); });
        if (PHONE_FIELD.test(name) || /^[+()\d\s.\-p:]{9,24}$/.test(s)) A.phoneKeys(s).forEach(function (k) { push(ph, k); }); // ô tự đặt tên khác nhưng giá trị là số điện thoại
      });
    });
    var t = vnDay(l && l.created_time), cid = String(l && l.campaign_id || '').replace(/\D/g, '');
    var organic = !!(l && (l.is_organic === true || l.is_organic === 'true'));
    return { id: String(l && l.id || '').slice(0, 40), day: t.day, at: t.at, cid: organic ? ORGANIC : (cid && cid.length <= 20 ? cid : NONE), cname: cleanName(l && l.campaign_name), organic: organic, ph: ph, em: em };
  }

  /* ---------------- học sinh ---------------- */
  /** Chỉ mục học sinh theo SĐT/email; students là kết quả aggregate({collect:true}).students. */
  function indexStudents(students) {
    var byPh = Object.create(null), byEm = Object.create(null);
    var st = { students: 0, withPhone: 0, ext: 0, extWithPhone: 0, paidExt: 0, paidExtWithPhone: 0, extWithRegDate: 0, paidByProg: Object.create(null), paidPhoneByProg: Object.create(null) };
    Object.keys(students || {}).forEach(function (id) {
      var s = students[id], hasPh = !!(s.ph && s.ph.length) || !!(s.em && s.em.length); st.students++; if (hasPh) st.withPhone++;
      if (!s.int) {
        st.ext++; if (s.rd) st.extWithRegDate++; if (hasPh) st.extWithPhone++;
        if (s.paid) { st.paidExt++; st.paidByProg[s.p] = (st.paidByProg[s.p] || 0) + 1; if (hasPh) { st.paidExtWithPhone++; st.paidPhoneByProg[s.p] = (st.paidPhoneByProg[s.p] || 0) + 1; } }
      }
      (s.ph || []).forEach(function (k) { (byPh[k] || (byPh[k] = [])).push(id); });
      (s.em || []).forEach(function (k) { (byEm[k] || (byEm[k] = [])).push(id); });
    });
    return { byPh: byPh, byEm: byEm, stats: st };
  }

  function quant(arr) { // [số mẫu, trung vị, phân vị 90] của số ngày; không có mẫu → [0, 0, 0]
    if (!arr.length) return [0, 0, 0];
    var a = arr.slice().sort(function (x, y) { return x - y; }), at = function (q) { return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))]; };
    return [a.length, at(0.5), at(0.9)];
  }
  function zero() { var o = []; for (var i = 0; i < N; i++) o.push(0); return o; }
  /* Học sinh đã đăng ký hoặc đã đóng phí trước ngày điền form: không phải do form này. Không biết ngày thì tính là sau form (không loại). */
  function before(s, day) { return !!((s.rd && s.rd < day) || (s.pd && s.pd < day)); }

  /**
   * Khớp lead với học sinh.
   * @param {object[]} leads  kết quả leadFromGraph
   * @param {object} students aggregate({collect:true}).students
   * @returns {object} kết quả chưa gộp: { v, from, to, winFrom, leads, cov, lag, days, camps, unmatchedPaid, paidNoPhone } (không có SĐT, email, tên)
   */
  function matchLeads(leads, students) {
    var A = adm(), S = students || {}, idx = indexStudents(S);
    var all = (leads || []).filter(function (l) { return l && typeof l === 'object'; });
    var dated = all.filter(function (l) { return isDay(l.day) && l.at; });
    dated.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }); // ổn định: cùng giờ thì theo mã lead
    // Một phụ huynh = các lead nối với nhau bằng bất kỳ SĐT hay email chung (nhiều số trong một form, hoặc lead sau có thêm số/email đã gặp ở lead trước).
    // Duyệt theo thời gian nên phụ huynh được lập bởi lead sớm nhất; khi một lead nối hai phụ huynh đã lập, giữ phụ huynh sớm hơn (first touch).
    var P = [], uf = [], keyOwner = Object.create(null), noContact = all.length - dated.length;
    var find = function (i) { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    dated.forEach(function (l) {
      var keys = l.ph.map(function (k) { return 'p' + k; }).concat(l.em.map(function (k) { return 'e' + k; }));
      if (!keys.length) { noContact++; return; }
      var roots = [];
      keys.forEach(function (k) { if (keyOwner[k] != null) { var r = find(keyOwner[k]); if (roots.indexOf(r) < 0) roots.push(r); } });
      var id;
      if (!roots.length) { id = P.length; P.push({ day: l.day, cid: l.cid, cname: l.cname, ph: [], em: [] }); uf.push(id); } // lead đầu tiên (đã sắp theo thời gian) là first touch
      else {
        id = Math.min.apply(null, roots);
        roots.forEach(function (r) { if (r === id) return; uf[r] = id; P[r].ph.forEach(function (k) { if (P[id].ph.indexOf(k) < 0) P[id].ph.push(k); }); P[r].em.forEach(function (k) { if (P[id].em.indexOf(k) < 0) P[id].em.push(k); }); });
      }
      l.ph.forEach(function (k) { if (P[id].ph.indexOf(k) < 0) P[id].ph.push(k); });
      l.em.forEach(function (k) { if (P[id].em.indexOf(k) < 0) P[id].em.push(k); });
      keys.forEach(function (k) { keyOwner[k] = id; });
    });
    var order = [], organic = 0, parents = {};
    P.forEach(function (q, i) { if (uf[i] === i) { parents[i] = q; order.push(i); if (q.cid === ORGANIC) organic++; } });
    var days = Object.create(null), camps = Object.create(null), claimed = Object.create(null), lagReg = [], lagPaid = [];
    var st = { rows: all.length, parents: order.length, noContact: noContact, organic: organic, dupFamily: 0, ambiguous: 0, matched: 0, internalOnly: 0, preRegistered: 0, crossProgram: 0 };
    var cellOf = function (q) {
      var cell = (days[q.day] || (days[q.day] = Object.create(null)))[q.cid] || (days[q.day][q.cid] = zero());
      var cp = camps[q.cid];
      if (!cp) camps[q.cid] = { n: q.cid === ORGANIC ? 'Lead tự nhiên (không từ quảng cáo)' : q.cid === NONE ? 'Chưa rõ chiến dịch' : q.cname, p: q.cid === ORGANIC || q.cid === NONE ? 'OTHER' : (A.programOf(q.cname) || 'OTHER') };
      else if (!cp.n && q.cname) { cp.n = q.cname; cp.p = A.programOf(q.cname) || 'OTHER'; }
      return cell;
    };
    order.forEach(function (pid) {
      var q = parents[pid], seen = Object.create(null), ids = [];
      q.ph.forEach(function (k) { (idx.byPh[k] || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); });
      q.em.forEach(function (k) { (idx.byEm[k] || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); });
      var ext = ids.filter(function (id) { return !S[id].int; }), fresh = ext.filter(function (id) { return !claimed[id]; });
      if (ids.length <= MAX_SIBLINGS && ext.length && !fresh.length) { st.dupFamily++; return; } // mọi em đã tính cho lead sớm hơn (bố/mẹ khác của cùng gia đình): không tính thêm một lead
      var cell = cellOf(q); cell[0]++;
      if (ids.length > MAX_SIBLINGS) { st.ambiguous++; return; }                      // số dùng chung: coi là chưa khớp
      if (!ext.length) { if (ids.length) { cell[1]++; st.internalOnly++; } return; }  // chỉ khớp học sinh nội bộ: ghi riêng, không tính chuyển đổi
      var mine = fresh.filter(function (id) { return !before(S[id], q.day); });
      if (!mine.length) { cell[2]++; st.preRegistered++; return; }                    // chỉ khớp học sinh đã đăng ký/đóng phí trước form
      cell[3]++; st.matched++;
      var paidAny = false, cprog = camps[q.cid].p;
      mine.forEach(function (id) {
        var s = S[id]; claimed[id] = 1; cell[5]++;
        if (cprog !== 'OTHER' && s.p !== cprog) st.crossProgram++;
        if (s.rd) { var lr = daysBetween(q.day, s.rd); if (lr != null) lagReg.push(Math.max(0, lr)); }
        if (s.paid) { paidAny = true; cell[6]++; if (s.pd) { var lp = daysBetween(q.day, s.pd); if (lp != null) lagPaid.push(Math.max(0, lp)); } }
      });
      if (paidAny) cell[4]++;
    });
    var unmatchedPaid = {}, paidNoPhone = {};
    Object.keys(S).forEach(function (id) {
      var s = S[id]; if (s.int || !s.paid || claimed[id]) return;
      var tgt = (s.ph && s.ph.length) || (s.em && s.em.length) ? unmatchedPaid : paidNoPhone; tgt[s.p] = (tgt[s.p] || 0) + 1;
    });
    var dayKeys = Object.keys(days).sort(), outDays = {}, outCamps = {}, outCp = {};
    dayKeys.forEach(function (d) { outDays[d] = {}; Object.keys(days[d]).forEach(function (c) { outDays[d][c] = days[d][c]; }); });
    Object.keys(camps).forEach(function (c) { outCamps[c] = camps[c]; });
    Object.keys(idx.stats.paidByProg).forEach(function (k) { outCp[k] = [idx.stats.paidByProg[k], idx.stats.paidPhoneByProg[k] || 0]; });
    return {
      v: 1, from: dayKeys[0] || '', to: dayKeys[dayKeys.length - 1] || '', winFrom: dated.length ? dated[0].day : '',
      leads: st,
      cov: { students: idx.stats.students, withPhone: idx.stats.withPhone, ext: idx.stats.ext, extWithPhone: idx.stats.extWithPhone, extWithRegDate: idx.stats.extWithRegDate, paidExt: idx.stats.paidExt, paidExtWithPhone: idx.stats.paidExtWithPhone, paidByProg: outCp },
      lag: { reg: quant(lagReg), paid: quant(lagPaid) },
      days: outDays, camps: outCamps, unmatchedPaid: unmatchedPaid, paidNoPhone: paidNoPhone
    };
  }

  /** Gộp lần đối chiếu mới với lần trước: ngày từ `windowFrom` trở đi lấy theo lần mới (số cập nhật khi phụ huynh đăng ký/đóng phí), ngày cũ hơn giữ nguyên số của lần trước
   *  (Meta chỉ cho đọc lead trong 90 ngày nên lead cũ hơn không còn để tính lại). Khác mùa tuyển sinh thì không gộp (prev = null). */
  function mergeMatch(prev, next, windowFrom) {
    var out = { v: 1, season: next.season || '', leads: next.leads, cov: next.cov, lag: next.lag, unmatchedPaid: next.unmatchedPaid, paidNoPhone: next.paidNoPhone, days: {}, camps: {} };
    if (prev && prev.days) Object.keys(prev.days).forEach(function (d) { if (d < windowFrom) out.days[d] = prev.days[d]; });
    Object.keys(next.days).forEach(function (d) { if (d >= windowFrom || !out.days[d]) out.days[d] = next.days[d]; });
    var pc = prev && prev.camps || {}; Object.keys(pc).forEach(function (c) { out.camps[c] = pc[c]; }); Object.keys(next.camps).forEach(function (c) { out.camps[c] = next.camps[c]; });
    Object.keys(out.days).forEach(function (d) { Object.keys(out.days[d]).forEach(function (c) { if (!out.camps[c]) out.camps[c] = { n: '', p: 'OTHER' }; }); });
    var ks = Object.keys(out.days).sort(); out.from = ks[0] || ''; out.to = ks[ks.length - 1] || '';
    out.winFrom = [prev && prev.winFrom, next.winFrom].filter(isDay).sort()[0] || '';
    out.frozenBefore = windowFrom;
    return out;
  }
  function windowFrom(today) { return adm().addDays(today, -KEEP_DAYS); }

  /* ---------------- tổng hợp để hiển thị ---------------- */
  function blankCell() { var o = {}; CELL.forEach(function (k) { o[k] = 0; }); return o; }
  function sumInto(o, a) { for (var i = 0; i < N; i++) o[CELL[i]] += a[i]; }
  /** Cộng các ô theo ngày điền form trong [since, until] (bỏ trống = không giới hạn). Lead tự nhiên (không từ quảng cáo) tách riêng, không nằm trong `total`.
   *  skip (tuỳ chọn): { mãChươngTrình: true } — chương trình bị bỏ khỏi `total` và `months` (vẫn có ở `programs` và `campaigns`).
   *  → { total, organic, programs: {TS6:{l,i,b,r,p,rs,ps}}, campaigns: {cid:{…,n,prog}}, months: {'2026-09':{…}}, days } */
  function summarize(m, since, until, skip) {
    var out = { total: blankCell(), organic: blankCell(), programs: {}, campaigns: {}, months: {}, days: 0 };
    if (!m || !m.days) return out;
    Object.keys(m.days).sort().forEach(function (d) {
      if ((since && d < since) || (until && d > until)) return;
      out.days++;
      Object.keys(m.days[d]).forEach(function (c) {
        var a = m.days[d][c], info = m.camps && m.camps[c] || { n: '', p: 'OTHER' }, prog = info.p || 'OTHER';
        if (c === ORGANIC) { sumInto(out.organic, a); return; }
        if (!(skip && skip[prog])) sumInto(out.total, a);
        sumInto(out.programs[prog] || (out.programs[prog] = blankCell()), a);
        var cc = out.campaigns[c] || (out.campaigns[c] = Object.assign(blankCell(), { n: info.n, prog: prog })); sumInto(cc, a);
        if (!(skip && skip[prog])) sumInto(out.months[d.slice(0, 7)] || (out.months[d.slice(0, 7)] = blankCell()), a);
      });
    });
    return out;
  }
  /** Các tỷ lệ của một ô cộng dồn. Mẫu số là phụ huynh trừ người chỉ khớp học sinh nội bộ hoặc học sinh đã đăng ký trước form; dưới `min` thì null. */
  function rates(c, min) {
    min = min == null ? 10 : min; var base = c.l - c.i - c.b;
    return { base: base, leadToReg: base >= min ? c.r / base : null, leadToPaid: base >= min ? c.p / base : null, regToPaid: c.r >= min ? c.p / c.r : null };
  }

  /* ---------------- số liệu hiển thị: theo kỳ, chương trình, chiến dịch, tháng ---------------- */
  var PHONE_OK = 0.9;            // từ 90% học sinh có SĐT/email thì mới tin kết quả khớp của giai đoạn đó
  var MIN_COST = 3;              // chi phí cho mỗi học sinh chỉ tính khi có từ 3 học sinh (ít hơn thì quá nhiễu)
  function progLabel(k) {
    var P = adm() && adm().PROGRAMS || []; for (var i = 0; i < P.length; i++) if (P[i].k === k) return P[i].label;
    return k === 'OTHER' ? 'Chưa ghép chương trình' : k;
  }
  function withRates(c, spend, min) {
    var r = rates(c, min), o = Object.assign({}, c, { base: r.base, leadToReg: r.leadToReg, leadToPaid: r.leadToPaid, regToPaid: r.regToPaid, spend: spend > 0 ? spend : 0 });
    o.costPerReg = spend > 0 && c.rs >= MIN_COST ? spend / c.rs : null; o.costPerPaid = spend > 0 && c.ps >= MIN_COST ? spend / c.ps : null;
    return o;
  }
  /**
   * Số liệu để hiển thị cho khoảng ngày điền form [since, until] (bỏ trống = tất cả).
   * @param {object} m   tài liệu fbmatch đã qua validate
   * @param {{byProgram?: object, byCampaign?: object}|null} spend  chi tiêu quảng cáo cùng khoảng ngày: theo mã chương trình và theo mã chiến dịch (số đồng)
   * @returns {{since, until, days, total, organic, programs, campaigns, months, spend}} mỗi nhóm có l,i,b,r,p,rs,ps cộng với base, leadToReg, leadToPaid, regToPaid, spend, costPerReg, costPerPaid
   */
  function view(m, since, until, spend) {
    var cov = m && m.cov || {}, bp = spend && spend.byProgram || {}, bc = spend && spend.byCampaign || {};
    // Đăng ký mà chưa đóng phí chỉ khớp được khi học sinh ngoài nội bộ có SĐT/email trong Sheet; thiếu thì "đã đăng ký" chỉ gồm em đã đóng phí (có SĐT ở tab ĐP) và sẽ bằng "đã đóng phí".
    var regOk = cov.ext > 0 && (cov.extWithPhone || 0) / cov.ext >= PHONE_OK;
    // Chương trình mà học sinh đã đóng phí phần lớn chưa có SĐT: không khớp được nên không tính tỷ lệ, chi phí; cũng không đưa vào Tổng.
    var low = {}; Object.keys(cov.paidByProg || {}).forEach(function (k) { var x = cov.paidByProg[k]; if (x[0] >= 5 && x[1] / x[0] < PHONE_OK) low[k] = [x[1], x[0]]; });
    var s = summarize(m, since, until, low);
    var gate = function (o, prog) {
      if (!regOk) { o.leadToReg = null; o.regToPaid = null; o.costPerReg = null; }
      if (prog && low[prog]) { o.leadToPaid = null; o.costPerPaid = null; o.lowPhone = true; }
      return o;
    };
    var five = ['TS1', 'JS', 'TS6', 'TS10', 'HB'], okFive = five.filter(function (k) { return !low[k]; }), totalSpend = 0; okFive.forEach(function (k) { totalSpend += bp[k] > 0 ? bp[k] : 0; });
    var progs = [];
    five.concat(['OTHER']).forEach(function (k) { var c = s.programs[k], sp = k === 'OTHER' ? 0 : bp[k] || 0; if ((c && c.l > 0) || sp > 0) progs.push(Object.assign({ k: k, label: progLabel(k) }, gate(withRates(c || blankCell(), sp), k))); });
    var camps = Object.keys(s.campaigns).map(function (id) { var c = s.campaigns[id]; return Object.assign({ id: id, n: c.n, prog: c.prog }, gate(withRates(c, bc[id] || 0), c.prog)); }).sort(function (a, b) { return b.l - a.l || (a.id < b.id ? -1 : 1); });
    var months = Object.keys(s.months).sort().map(function (k) { return Object.assign({ m: k }, gate(withRates(s.months[k], 0))); });
    // chi phí của dòng Tổng: chi tiêu của chiến dịch đã ghép chương trình (trừ chương trình thiếu SĐT) ÷ học sinh của chính các chương trình đó; chiến dịch chưa ghép như thương hiệu không có chi tiêu trong số này
    var mapped = blankCell(); okFive.forEach(function (k) { var c = s.programs[k]; if (c) CELL.forEach(function (x) { mapped[x] += c[x]; }); });
    var total = gate(withRates(s.total, totalSpend));
    total.costPerReg = regOk && totalSpend > 0 && mapped.rs >= MIN_COST ? totalSpend / mapped.rs : null; total.costPerPaid = totalSpend > 0 && mapped.ps >= MIN_COST ? totalSpend / mapped.ps : null;
    return { since: since || '', until: until || '', days: s.days, total: total, mapped: mapped, unmapped: s.programs.OTHER || blankCell(), organic: s.organic, programs: progs, campaigns: camps, months: months, spend: totalSpend, regOk: regOk, lowPhone: low };
  }
  /** Độ trưởng thành của các nhóm lead: lead mới điền form chưa kịp đóng phí. Dựa trên số ngày từ lúc điền form đến lúc đóng phí của các em đã khớp (cần từ 10 em);
   *  chưa đủ mẫu thì dùng 30 ngày. recentFrom = ngày sớm nhất mà nhóm lead từ đó trở đi còn chưa đủ thời gian. */
  function maturity(m, today) {
    var lag = m && m.lag && m.lag.paid || [0, 0, 0], known = lag[0] >= 10, days = known ? Math.max(7, lag[2]) : 30;
    return { known: known, n: lag[0], p50: lag[1], p90: lag[2], days: days, recentFrom: adm().addDays(today, -days), regP50: m && m.lag && m.lag.reg ? m.lag.reg[1] : 0 };
  }
  /** Học sinh đã đóng phí (ngoài nội bộ) khớp được với một phụ huynh điền form Facebook quảng cáo, so với tổng số: dùng để biết kết quả đáng tin đến đâu. */
  function attribution(m) {
    var cov = m && m.cov || {}, ps = 0, organicPs = 0, noPhone = 0, unmatched = 0;
    Object.keys(m && m.days || {}).forEach(function (d) { Object.keys(m.days[d]).forEach(function (c) { if (c === ORGANIC) organicPs += m.days[d][c][6]; else ps += m.days[d][c][6]; }); });
    Object.keys(m && m.paidNoPhone || {}).forEach(function (k) { noPhone += m.paidNoPhone[k]; });
    Object.keys(m && m.unmatchedPaid || {}).forEach(function (k) { unmatched += m.unmatchedPaid[k]; });
    var paid = cov.paidExt || 0, attributed = Math.min(paid, ps);
    return { paidExt: paid, fromAds: attributed, fromOrganic: organicPs, noPhone: noPhone, unmatched: unmatched, share: paid > 0 ? attributed / paid : null,
      phoneShare: paid > 0 ? (cov.paidExtWithPhone || 0) / paid : null, regPhoneShare: cov.ext > 0 ? (cov.extWithPhone || 0) / cov.ext : null, regDateShare: cov.ext > 0 ? (cov.extWithRegDate || 0) / cov.ext : null };
  }
  /**
   * Gói số liệu cho phần Phân tích (chỉ số tổng hợp, không có dữ liệu cá nhân): 30 ngày gần nhất, 30 ngày trước đó và toàn bộ thời gian đọc được.
   * spendOf(since, until) → { byProgram, byCampaign } hoặc null.
   */
  function packOf(m, today, spendOf) {
    var A = adm(), mat = maturity(m, today), at = attribution(m), round = function (v) { return v == null ? null : Math.round(v * 1000) / 1000; }, v0 = view(m, '', '', null);
    // số không đáng tin vì thiếu SĐT trong Sheet thì để null (không phải 0), để Claude không nhận định từ số hụt
    var cellOut = function (c) { return { parents: c.l, only_internal_students: c.i, already_registered_before_form: c.b, registered: v0.regOk ? c.r : null, students_registered: v0.regOk ? c.rs : null, parent_to_registered: round(c.leadToReg), registered_to_paid: round(c.regToPaid),
      paid: c.lowPhone ? null : c.p, students_paid: c.lowPhone ? null : c.ps, parent_to_paid: round(c.leadToPaid), spend_vnd: Math.round(c.spend || 0), cost_per_paid_student_vnd: c.costPerPaid == null ? null : Math.round(c.costPerPaid) }; };
    var win = function (since, until) {
      var v = view(m, since, until, spendOf && since && until ? spendOf(since, until) : null);
      return { from: since, to: until, total: cellOut(v.total), by_program: v.programs.filter(function (p) { return p.l > 0; }).map(function (p) { return Object.assign({ program: p.k }, cellOut(p)); }),
        top_campaigns: v.campaigns.filter(function (c) { return c.l >= 5; }).slice(0, 8).map(function (c) { return Object.assign({ campaign: c.n, program: c.prog }, cellOut(c)); }), organic_parents: v.organic.l };
    };
    var out = { as_of: today, method: 'Mỗi phụ huynh điền form lead Facebook được đối chiếu với học sinh trong file tuyển sinh theo số điện thoại hoặc email; lead đầu tiên của phụ huynh quyết định ngày và chiến dịch; học sinh nội bộ và học sinh đã đăng ký trước khi điền form không tính cho quảng cáo.',
      lead_history_from: m && m.winFrom || null, last_30d: win(A.addDays(today, -30), A.addDays(today, -1)), prev_30d: win(A.addDays(today, -60), A.addDays(today, -31)), all_time: win('', ''),
      data_quality: { registration_stage_reliable: v0.regOk, phone_share_of_external_registered: round(at.regPhoneShare), phone_share_of_paid: round(at.phoneShare), registration_date_share: round(at.regDateShare), programs_without_paid_phone: Object.keys(v0.lowPhone),
        note: 'Khi registration_stage_reliable = false thì không nhận định về số đăng ký hay tỷ lệ đăng ký → đóng phí. Chương trình trong programs_without_paid_phone không có tỷ lệ và không nằm trong tổng. registration_date_share thấp nghĩa là chưa loại được học sinh đã đăng ký trước khi phụ huynh điền form nên tỷ lệ có thể cao hơn thực tế.' },
      attribution: { paid_students_external: at.paidExt, matched_to_facebook_ads: at.fromAds, matched_share: round(at.share), paid_without_phone_in_sheet: at.noPhone, phone_share_of_paid: round(at.phoneShare) },
      maturity: { days_from_form_to_payment_median: mat.known ? mat.p50 : null, days_p90: mat.known ? mat.p90 : null, parents_filling_form_after: mat.recentFrom, note: 'Phụ huynh điền form sau mốc này chưa đủ thời gian để đóng phí nên tỷ lệ của nhóm đó thấp hơn thực tế.' } };
    return out;
  }

  /* ---------------- kiểm tra dữ liệu lưu/gửi ---------------- */
  function int0(v, max) { return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= (max || 1e7) ? v : null; } // chỉ nhận số nguyên thật, không làm tròn hay ép kiểu
  var PROG_KEY = /^[A-Z0-9]{1,8}$/;
  function validate(m) { try { return validateRaw(m); } catch (e) { return { ok: false, error: 'Dữ liệu đối chiếu không đọc được.' }; } }
  function validateRaw(m) {
    var bad = function (t) { return { ok: false, error: t }; }, i, j;
    if (!m || typeof m !== 'object' || m.v !== 1) return bad('Dữ liệu đối chiếu không đúng định dạng.');
    var out = { v: 1 }, L = m.leads && typeof m.leads === 'object' ? m.leads : {}, cv = m.cov && typeof m.cov === 'object' ? m.cov : {};
    out.season = typeof m.season === 'string' && /^20\d{2}–\d{2}$/.test(m.season) ? m.season : '';
    out.leads = {}; ['rows', 'parents', 'noContact', 'organic', 'dupFamily', 'ambiguous', 'matched', 'internalOnly', 'preRegistered', 'crossProgram'].forEach(function (k) { out.leads[k] = int0(L[k]) || 0; });
    out.cov = {}; ['students', 'withPhone', 'ext', 'extWithPhone', 'extWithRegDate', 'paidExt', 'paidExtWithPhone'].forEach(function (k) { out.cov[k] = int0(cv[k]) || 0; });
    if (out.cov.withPhone > out.cov.students || out.cov.extWithPhone > out.cov.ext || out.cov.paidExtWithPhone > out.cov.paidExt || out.cov.extWithRegDate > out.cov.ext || out.cov.paidExt > out.cov.ext) return bad('Độ phủ số điện thoại không hợp lệ.');
    out.cov.paidByProg = {};
    var pb = cv.paidByProg && typeof cv.paidByProg === 'object' ? cv.paidByProg : {}, pk = Object.keys(pb); if (pk.length > 12) return bad('Quá nhiều chương trình.');
    for (i = 0; i < pk.length; i++) { var a = pb[pk[i]]; if (!PROG_KEY.test(pk[i]) || !Array.isArray(a) || a.length !== 2 || int0(a[0]) == null || int0(a[1]) == null || a[1] > a[0]) return bad('Độ phủ số điện thoại theo chương trình không hợp lệ.'); out.cov.paidByProg[pk[i]] = [int0(a[0]), int0(a[1])]; }
    out.lag = {}; var lg = m.lag && typeof m.lag === 'object' ? m.lag : {};
    ['reg', 'paid'].forEach(function (k) { var a = lg[k]; out.lag[k] = Array.isArray(a) && a.length === 3 && a.every(function (t) { return int0(t, 5000) != null; }) ? a.map(function (t) { return int0(t, 5000); }) : [0, 0, 0]; });
    var mapInt = function (o) { var r = {}, ks = Object.keys(o && typeof o === 'object' ? o : {}); if (ks.length > 12) return null; for (var k = 0; k < ks.length; k++) { var v = int0(o[ks[k]]); if (!PROG_KEY.test(ks[k]) || v == null) return null; r[ks[k]] = v; } return r; };
    out.unmatchedPaid = mapInt(m.unmatchedPaid); out.paidNoPhone = mapInt(m.paidNoPhone); if (!out.unmatchedPaid || !out.paidNoPhone) return bad('Số đã đóng phí chưa khớp không hợp lệ.');
    out.camps = {}; var ck = Object.keys(m.camps && typeof m.camps === 'object' ? m.camps : {}); if (ck.length > 300) return bad('Quá nhiều chiến dịch (tối đa 300).');
    for (i = 0; i < ck.length; i++) {
      var c = m.camps[ck[i]]; if (!/^(\d{5,20}|organic|none)$/.test(ck[i]) || !c || typeof c !== 'object' || PROGRAMS.indexOf(c.p) < 0 || typeof (c.n == null ? '' : c.n) !== 'string') return bad('Chiến dịch không hợp lệ.');
      out.camps[ck[i]] = { n: cleanName(c.n), p: c.p };
    }
    out.days = {}; var dk = Object.keys(m.days && typeof m.days === 'object' ? m.days : {}), cells = 0; if (dk.length > 800) return bad('Quá nhiều ngày.');
    for (i = 0; i < dk.length; i++) {
      if (!isDay(dk[i])) return bad('Ngày không hợp lệ.');
      var row = m.days[dk[i]], rk = Object.keys(row && typeof row === 'object' ? row : {}), o = {}; cells += rk.length; if (cells > 8000) return bad('Quá nhiều ô số liệu.');
      for (j = 0; j < rk.length; j++) {
        var v = row[rk[j]]; if (!out.camps[rk[j]] || !Array.isArray(v) || v.length !== N) return bad('Số theo ngày không hợp lệ.');
        var x = v.map(function (t) { return int0(t); });
        // l ≥ i + b + r; mỗi gia đình khớp có ít nhất một em: r ≤ rs, p ≤ ps; đóng phí ⊂ đăng ký: p ≤ r, ps ≤ rs
        if (x.indexOf(null) >= 0 || x[1] + x[2] + x[3] > x[0] || x[4] > x[3] || x[3] > x[5] || x[4] > x[6] || x[6] > x[5]) return bad('Số theo ngày không nhất quán.');
        o[rk[j]] = x;
      }
      out.days[dk[i]] = o;
    }
    var ds = Object.keys(out.days).sort(); out.from = ds[0] || ''; out.to = ds[ds.length - 1] || '';
    out.winFrom = isDay(m.winFrom) ? m.winFrom : ''; out.frozenBefore = isDay(m.frozenBefore) ? m.frozenBefore : '';
    out.syncedAt = typeof m.syncedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(m.syncedAt) && isFinite(Date.parse(m.syncedAt)) ? m.syncedAt : '';
    return { ok: true, match: out };
  }

  /** Tỷ lệ học sinh có SĐT/email (độ phủ): dùng để quyết định có tin số khớp hay không. */
  function phoneCoverage(m) {
    var c = m && m.cov || {}; return { registered: c.students > 0 ? c.withPhone / c.students : 0, paid: c.paidExt > 0 ? c.paidExtWithPhone / c.paidExt : 0 };
  }

  var api = {
    PROGRAMS: PROGRAMS, KEEP_DAYS: KEEP_DAYS, ORGANIC: ORGANIC, NONE: NONE, MAX_SIBLINGS: MAX_SIBLINGS, CELL: CELL, leadFromGraph: leadFromGraph, indexStudents: indexStudents, matchLeads: matchLeads, mergeMatch: mergeMatch,
    windowFrom: windowFrom, summarize: summarize, view: view, maturity: maturity, attribution: attribution, packOf: packOf, progLabel: progLabel, MIN_COST: MIN_COST, rates: rates, validate: validate, phoneCoverage: phoneCoverage, cleanName: cleanName, vnDay: vnDay
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FBMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
