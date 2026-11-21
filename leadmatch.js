/* leadmatch.js – Đối chiếu TỪNG PHỤ HUYNH: người đã điền form lead trên Facebook ↔ học sinh đã đóng phí (ĐP).
 *
 * Khớp theo số điện thoại (và email) của phụ huynh: lead Facebook (SĐT, email trong biểu mẫu) với SĐT/email bố, mẹ trong file DATA TUYỂN SINH.
 * SĐT và email chỉ nằm trong bộ nhớ lúc tính. Kết quả lưu lại là SỐ TỔNG HỢP theo ngày điền form và chiến dịch: không có tên, SĐT hay email.
 *
 * Quy tắc tính (đều có kiểm thử):
 *  - Một phụ huynh = một khoá liên hệ (SĐT đầu tiên; không có SĐT thì email). Điền form nhiều lần chỉ tính một lần, lấy lần ĐẦU TIÊN (first touch) làm ngày và chiến dịch.
 *  - Mỗi phụ huynh là một phụ huynh điền form: bố và mẹ cùng điền form cho một em đều là phụ huynh có con đã đăng ký/đóng phí (nên tỷ lệ là của phụ huynh, không lệch thấp). Học sinh thì chỉ được tính một lần, cho lead sớm nhất khớp được em, để chi phí cho mỗi học sinh không bị nhân đôi.
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
  var KEEP_DAYS = 60;            // Ngày điền form cũ hơn 60 ngày được đóng băng (giữ số của lần chạy trước). Meta chỉ cho đọc lead trong 90 ngày; khoảng 60–90 ngày chỉ dùng để nhận ra phụ huynh đã điền form từ trước.
                                 // Cửa sổ ngắn hơn 90 ngày để một phụ huynh điền form hai lần không bị tính hai lần khi lần đầu đã quá hạn 90 ngày mà lần sau còn trong cửa sổ (chỉ còn xảy ra khi hai lần cách nhau hơn 30 ngày).
  var HISTORY_DAYS = 400;        // số đã chốt giữ tối đa chừng này ngày kể từ hôm nay (hơn một mùa tuyển sinh); cũ hơn thì bỏ
  var ORGANIC = 'organic', NONE = 'none';
  /* Ô số liệu theo ngày điền form × chiến dịch, thứ tự cố định:
   *  l  phụ huynh điền form                   i  chỉ khớp học sinh nội bộ          b  chỉ khớp học sinh đã đăng ký trước form
   *  r  có con đăng ký (do form)             p  có con đã đóng phí (do form)
   *  rs số học sinh đăng ký (do form)        ps số học sinh đã đóng phí (do form)
   *  (rs, ps tính mỗi em một lần cho lead sớm nhất khớp em, còn r, p tính từng phụ huynh nên r, p có thể lớn hơn rs, ps khi bố và mẹ cùng điền form) */
  var CELL = ['l', 'i', 'b', 'r', 'p', 'rs', 'ps'], N = CELL.length;

  function adm() { return root.FBAdm; }
  function isDay(s) { return typeof s === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
  function vnDay(iso) { // thời điểm Meta ghi (UTC, có thể dạng +0000) → ngày giờ Việt Nam
    var t = Date.parse(String(iso || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); if (!isFinite(t)) return { day: '', at: '' };
    var v = new Date(t + 7 * 3600000).toISOString(); return { day: v.slice(0, 10), at: v.slice(0, 19) };
  }
  function daysBetween(a, b) { var x = Date.parse(a + 'T00:00:00Z'), y = Date.parse(b + 'T00:00:00Z'); return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : null; }
  function cleanName(s) { return String(s == null ? '' : s).normalize('NFC').replace(/[^\p{L}\p{N} _\-|·()\[\].,+&/:%#]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }

  /* ---------------- lead ---------------- */
  var PHONE_FIELD = /(phone|sdt|dien.?thoai|di.?dong|zalo|mobile)/, MAIL_FIELD = /e.?mail/;
  /** Lead từ Graph API (mục leads của biểu mẫu) → { id, day, at, cid, cname, prog, organic, ph, em } (prog: chương trình theo tên chiến dịch nguyên văn, cùng cách ghép với chi tiêu). ph/em là khoá đã chuẩn hoá, chỉ để khớp và không bao giờ được lưu. */
  function leadFromGraph(l) {
    var A = adm(), ph = [], em = [], push = function (arr, k) { if (k && arr.indexOf(k) < 0) arr.push(k); };
    (l && Array.isArray(l.field_data) ? l.field_data : []).forEach(function (f) {
      var name = A.fold(String(f && f.name || '')).toLowerCase();
      (f && Array.isArray(f.values) ? f.values : []).forEach(function (v) {
        if (typeof v !== 'string' && typeof v !== 'number') return;
        var s = String(v);
        if (MAIL_FIELD.test(name) || s.indexOf('@') >= 0) A.emailKeys(s).forEach(function (k) { push(em, k); });
        if (PHONE_FIELD.test(name) || (/^(p:)?[+()\d\s.\-]{9,24}$/.test(s) && !/^\d{4}-\d{2}-\d{2}/.test(s))) A.phoneKeys(s).forEach(function (k) { push(ph, k); }); // ô tự đặt tên khác nhưng giá trị là số điện thoại
      });
    });
    var t = vnDay(l && l.created_time), cid = String(l && l.campaign_id || '').replace(/\D/g, '');
    var organic = !!(l && (l.is_organic === true || l.is_organic === 'true'));
    var raw = String(l && l.campaign_name || '');
    return { id: String(l && l.id || '').slice(0, 40), day: t.day, at: t.at, cid: organic ? ORGANIC : (/^\d{5,20}$/.test(cid) ? cid : NONE), cname: cleanName(raw), prog: raw ? A.programOf(raw) || '' : '', organic: organic, ph: ph, em: em };
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
    // Khoá "trung tâm": một email/SĐT đi cùng từ HUB khoá khác nhau trở lên trong các lead (chữ giữ chỗ như abc@..., số dùng chung của người khác) không xác định một phụ huynh:
    // bỏ khỏi việc nối phụ huynh và tra học sinh, nếu không nhiều gia đình không liên quan bị gộp làm một (mất chuyển đổi hoặc co mẫu số).
    var HUB = 4, byKey = Object.create(null), hub = Object.create(null), hubOnly = 0;
    var keysOf = function (l) { return l.ph.map(function (k) { return 'p' + k; }).concat(l.em.map(function (k) { return 'e' + k; })); };
    dated.forEach(function (l, i) { keysOf(l).forEach(function (k) { (byKey[k] || (byKey[k] = [])).push(i); }); });
    // Khoá dùng chung (địa chỉ giữ chỗ, số của văn phòng) không xác định một phụ huynh: các lead chứa khoá đó thuộc từ HUB người khác nhau trở lên, trong đó hai lead là cùng một người nếu còn chung một khoá khác.
    // (Một phụ huynh điền form nhiều lần với Zalo hay email khác nhau vẫn là một người nên không làm số điện thoại chính của họ thành khoá dùng chung.)
    Object.keys(byKey).forEach(function (k) {
      var L = byKey[k]; if (L.length < HUB) return;
      var u = L.map(function (_, j) { return j; }), f2 = function (j) { while (u[j] !== j) { u[j] = u[u[j]]; j = u[j]; } return j; }, owner = Object.create(null);
      L.forEach(function (li, j) { keysOf(dated[li]).forEach(function (o) { if (o === k) return; if (owner[o] == null) owner[o] = j; else { var a = f2(owner[o]), b = f2(j); if (a !== b) u[a] = b; } }); });
      var roots = Object.create(null); L.forEach(function (_, j) { roots[f2(j)] = 1; });
      if (Object.keys(roots).length >= HUB) hub[k] = 1;
    });
    var P = [], uf = [], keyOwner = Object.create(null), noContact = all.length - dated.length;
    var find = function (i) { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    dated.forEach(function (l) {
      var allKeys = keysOf(l), keys = allKeys.filter(function (k) { return !hub[k]; });
      l = Object.assign({}, l, { ph: l.ph.filter(function (k) { return !hub['p' + k]; }), em: l.em.filter(function (k) { return !hub['e' + k]; }) });
      if (!keys.length) { if (allKeys.length) hubOnly++; noContact++; return; }
      var roots = [];
      keys.forEach(function (k) { if (keyOwner[k] != null) { var r = find(keyOwner[k]); if (roots.indexOf(r) < 0) roots.push(r); } });
      var id;
      if (!roots.length) { id = P.length; P.push({ day: l.day, cid: l.cid, cname: l.cname, prog: l.prog, ph: [], em: [] }); uf.push(id); } // lead đầu tiên (đã sắp theo thời gian) là first touch
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
    var st = { rows: all.length, parents: order.length, noContact: noContact, hubKeys: Object.keys(hub).length, organic: organic, dupFamily: 0, ambiguous: 0, matched: 0, internalOnly: 0, preRegistered: 0, crossProgram: 0 };
    var cellOf = function (q) {
      var cell = (days[q.day] || (days[q.day] = Object.create(null)))[q.cid] || (days[q.day][q.cid] = zero());
      var cp = camps[q.cid];
      if (!cp) camps[q.cid] = { n: q.cid === ORGANIC ? 'Lead tự nhiên (không từ quảng cáo)' : q.cid === NONE ? 'Chưa rõ chiến dịch' : q.cname, p: q.cid === ORGANIC || q.cid === NONE ? 'OTHER' : (q.prog || 'OTHER') };
      else if (!cp.n && q.cname) { cp.n = q.cname; cp.p = q.prog || 'OTHER'; }
      return cell;
    };
    order.forEach(function (pid) {
      var q = parents[pid], seen = Object.create(null), ids = [];
      q.ph.forEach(function (k) { (idx.byPh[k] || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); });
      q.em.forEach(function (k) { (idx.byEm[k] || []).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } }); });
      var ext = ids.filter(function (id) { return !S[id].int; }), fresh = ext.filter(function (id) { return !claimed[id]; });
      // Mỗi phụ huynh là một phụ huynh điền form (bố và mẹ cùng điền form cho một em đều có con đã đăng ký/đóng phí); học sinh thì chỉ tính một lần, cho lead sớm nhất khớp em, để chi phí cho mỗi học sinh không bị nhân đôi.
      if (ids.length <= MAX_SIBLINGS && ext.length && !fresh.length) st.dupFamily++;   // mọi em đã tính cho lead sớm hơn (bố/mẹ khác của cùng gia đình): chỉ ghi để báo
      var cell = cellOf(q); cell[0]++;
      if (ids.length > MAX_SIBLINGS) { st.ambiguous++; return; }                      // số dùng chung: coi là chưa khớp
      if (!ext.length) { if (ids.length) { cell[1]++; st.internalOnly++; } return; }  // chỉ khớp học sinh nội bộ: ghi riêng, không tính chuyển đổi
      var reg = ext.filter(function (id) { return !before(S[id], q.day); });          // em đăng ký sau ngày điền form (kể cả em đã tính cho lead sớm hơn)
      if (!reg.length) { cell[2]++; st.preRegistered++; return; }                     // chỉ khớp học sinh đã đăng ký/đóng phí trước form
      cell[3]++; st.matched++;
      if (reg.some(function (id) { return S[id].paid; })) cell[4]++;
      var cprog = camps[q.cid].p;
      reg.filter(function (id) { return !claimed[id]; }).forEach(function (id) {
        var s = S[id]; claimed[id] = 1; cell[5]++;
        if (cprog !== 'OTHER' && s.p !== cprog) st.crossProgram++;
        if (s.rd) { var lr = daysBetween(q.day, s.rd); if (lr != null) lagReg.push(Math.max(0, lr)); }
        if (s.paid) { cell[6]++; if (s.pd) { var lp = daysBetween(q.day, s.pd); if (lp != null) lagPaid.push(Math.max(0, lp)); } }
      });
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

  /** Gộp lần đối chiếu mới với lần trước: ngày từ `windowFrom` trở đi lấy theo lần mới (số cập nhật khi phụ huynh đăng ký/đóng phí), ngày cũ hơn giữ nguyên số của lần trước (kể cả khi lần trước không có ô ngày đó)
   *  (Meta chỉ cho đọc lead trong 90 ngày nên lead cũ hơn không còn để tính lại). Khác mùa tuyển sinh thì không gộp (prev = null). */
  function mergeMatch(prev, next, windowFrom) {
    var out = { v: 1, season: next.season || '', leads: next.leads, cov: next.cov, lag: next.lag, unmatchedPaid: next.unmatchedPaid, paidNoPhone: next.paidNoPhone, days: {}, camps: {} };
    if (prev && prev.days) Object.keys(prev.days).forEach(function (d) { if (d < windowFrom) out.days[d] = prev.days[d]; });
    // Ngày cũ hơn mốc đóng băng chỉ lấy từ lần mới khi chưa có lần trước (lần đầu). Có lần trước mà ngày đó không có ô thì giữ không có ô: lần mới chỉ thấy các lead còn trong 90 ngày nên một phụ huynh
    // đã điền form từ trước đó (lần đầu đã hết hạn) hiện ra như phụ huynh mới ở ngày này và sẽ bị tính hai lần.
    Object.keys(next.days).forEach(function (d) { if (d >= windowFrom || !prev) out.days[d] = next.days[d]; });
    // Số đã chốt cũ hơn HISTORY_DAYS thì bỏ (hơn một mùa tuyển sinh): giữ kích thước tài liệu và giới hạn của validate() không bị chạm dù tiêu đề mùa nhiều năm không đổi.
    var oldest = adm().addDays(windowFrom, -(HISTORY_DAYS - KEEP_DAYS)); Object.keys(out.days).forEach(function (d) { if (d < oldest) delete out.days[d]; });
    var pc = prev && prev.camps || {}; Object.keys(pc).forEach(function (c) { out.camps[c] = pc[c]; }); Object.keys(next.camps).forEach(function (c) { var nc = next.camps[c], oc = out.camps[c]; out.camps[c] = oc && oc.n && (!nc.n || nc.p === 'OTHER') ? oc : nc; }); // lần mới không tra được tên hay chương trình thì không đè lên chiến dịch đã biết (chương trình lưu theo chiến dịch nên cũng đổi cả các ngày đã chốt)
    var used = {}; Object.keys(out.days).forEach(function (d) { Object.keys(out.days[d]).forEach(function (c) { used[c] = 1; }); });
    Object.keys(out.camps).forEach(function (c) { if (!used[c]) delete out.camps[c]; });
    Object.keys(used).forEach(function (c) { if (!out.camps[c]) out.camps[c] = { n: '', p: 'OTHER' }; });
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
  var FIVE = ['TS1', 'JS', 'TS6', 'TS10', 'HB'];
  /** Độ phủ SĐT/ngày của lần đối chiếu: regOk (đủ SĐT cho học sinh chưa đóng phí), low (chương trình có từ 5 em đóng phí mà dưới 90% có SĐT; chỉ năm chương trình có chiến dịch), dated (đủ Ngày đăng ký). */
  function gates(cov) {
    cov = cov || {}; var low = {};
    Object.keys(cov.paidByProg || {}).forEach(function (k) { var x = cov.paidByProg[k]; if (FIVE.indexOf(k) >= 0 && x[0] >= 5 && x[1] / x[0] < PHONE_OK) low[k] = [x[1], x[0]]; });
    return { regOk: cov.ext > 0 && (cov.extWithPhone || 0) / cov.ext >= PHONE_OK, low: low, dated: cov.ext > 0 && (cov.extWithRegDate || 0) / cov.ext >= PHONE_OK };
  }
  /** Lần đọc mới đủ SĐT hoặc ngày hơn lần trước (một cổng độ phủ vừa mở): số của các ngày đã chốt trước đó được tính khi còn thiếu nên cần tính lại. */
  function coverageGain(prevCov, nextCov) {
    if (!prevCov || !nextCov) return false;
    var a = gates(prevCov), b = gates(nextCov);
    return (!a.regOk && b.regOk) || (!a.dated && b.dated) || Object.keys(a.low).some(function (k) { return !b.low[k]; });
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
    var g = gates(cov), regOk = g.regOk;
    // Chương trình mà học sinh đã đóng phí phần lớn chưa có SĐT: không khớp được nên không tính số đăng ký, đóng phí, tỷ lệ, chi phí; cũng không đưa vào Tổng.
    var low = g.low;
    var s = summarize(m, since, until, low);
    var gate = function (o, prog) {
      if (!regOk) { o.leadToReg = null; o.regToPaid = null; o.costPerReg = null; }
      if (prog && low[prog]) { o.leadToPaid = null; o.costPerPaid = null; o.leadToReg = null; o.regToPaid = null; o.costPerReg = null; o.lowPhone = true; }
      return o;
    };
    var five = FIVE, okFive = five.filter(function (k) { return !low[k]; }), totalSpend = 0; okFive.forEach(function (k) { totalSpend += bp[k] > 0 ? bp[k] : 0; });
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
    // binding: nhóm lead bị chốt sau KEEP_DAYS ngày, nên đóng phí muộn hơn mốc đó không được tính và số ngày đo được bị cắt (thấp hơn thực tế) khi phân vị 90 đã gần mốc chốt
    return { known: known, n: lag[0], p50: lag[1], p90: lag[2], days: days, binding: known && lag[2] >= KEEP_DAYS * 0.8, closeAfter: KEEP_DAYS, recentFrom: adm().addDays(today, -days), regP50: m && m.lag && m.lag.reg ? m.lag.reg[1] : 0 };
  }
  /** Học sinh đã đóng phí (ngoài nội bộ) khớp được với một phụ huynh điền form Facebook quảng cáo, so với tổng số: dùng để biết kết quả đáng tin đến đâu. */
  function attribution(m) {
    var cov = m && m.cov || {}, ps = 0, organicPs = 0, noPhone = 0, unmatched = 0;
    Object.keys(m && m.days || {}).forEach(function (d) { Object.keys(m.days[d]).forEach(function (c) { if (c === ORGANIC) organicPs += m.days[d][c][6]; else ps += m.days[d][c][6]; }); });
    Object.keys(m && m.paidNoPhone || {}).forEach(function (k) { noPhone += m.paidNoPhone[k]; });
    Object.keys(m && m.unmatchedPaid || {}).forEach(function (k) { unmatched += m.unmatchedPaid[k]; });
    var paid = cov.paidExt || 0, attributed = Math.min(paid, ps);
    return { paidExt: paid, fromAds: attributed, fromOrganic: organicPs, noPhone: noPhone, unmatched: unmatched, share: paid > 0 ? attributed / paid : null,
      phoneShare: paid > 0 ? (cov.paidExtWithPhone || 0) / paid : null, regPhoneShare: cov.ext > 0 ? (cov.extWithPhone || 0) / cov.ext : null, regDateShare: cov.ext > 0 ? (cov.extWithRegDate || 0) / cov.ext : null, unlinkedPaid: cov.unlinkedPaid || 0 };
  }
  /**
   * Gói số liệu cho phần Phân tích (chỉ số tổng hợp, không có dữ liệu cá nhân): 30 ngày gần nhất, 30 ngày trước đó và toàn bộ thời gian đọc được.
   * spendOf(since, until) → { byProgram, byCampaign } hoặc null. info (tuỳ chọn): { leadsync: tài liệu trạng thái lần chạy gần nhất } để ghi độ mới của số liệu.
   */
  /** Độ mới của số đối chiếu: ngày (giờ Việt Nam) của lần cập nhật thành công gần nhất, số ngày so với hôm nay, kết quả lần chạy gần nhất (chỉ ok và tên bước). Lead chỉ có đến lần cập nhật đó trong khi chi tiêu tính đến hôm nay. */
  function freshness(m, today, info) {
    var d = adm().vnDate(m && m.syncedAt), t = Date.parse(today + 'T00:00:00Z'), s = Date.parse(d + 'T00:00:00Z'), ls = info && info.leadsync && typeof info.leadsync === 'object' ? info.leadsync : null;
    return { synced_at: d || null, age_days: isFinite(t) && isFinite(s) ? Math.max(0, Math.round((t - s) / 86400000)) : null, last_update_ok: ls && typeof ls.ok === 'boolean' ? ls.ok : null, last_update_stage: ls && ls.ok === false && typeof ls.stage === 'string' && /^[a-z]{1,10}$/.test(ls.stage) ? ls.stage : null,
      note: 'Lead chỉ có đến ngày synced_at nhưng chi tiêu tính đến hôm nay: khi age_days >= 2 hoặc last_update_ok = false thì phụ huynh của những ngày gần đây còn thiếu và chi phí / học sinh ĐP cao hơn thực tế; nói rõ số tính đến ngày synced_at và không kết luận về những tuần gần nhất.' };
  }
  function packOf(m, today, spendOf, info) {
    var A = adm(), mat = maturity(m, today), at = attribution(m), round = function (v) { return v == null ? null : Math.round(v * 1000) / 1000; }, v0 = view(m, '', '', null);
    // số không đáng tin vì thiếu SĐT trong Sheet thì để null (không phải 0), để Claude không nhận định từ số hụt
    var cellOut = function (c, hasSpend) { var rg = v0.regOk && !c.lowPhone; return { parents: c.l, only_internal_students: c.i, already_registered_before_form: c.b, registered: rg ? c.r : null, students_registered: rg ? c.rs : null, parent_to_registered: rg ? round(c.leadToReg) : null, registered_to_paid: rg ? round(c.regToPaid) : null,
      paid: c.lowPhone ? null : c.p, students_paid: c.lowPhone ? null : c.ps, parent_to_paid: round(c.leadToPaid), spend_vnd: hasSpend ? Math.round(c.spend || 0) : null, cost_per_paid_student_vnd: c.costPerPaid == null ? null : Math.round(c.costPerPaid) }; };
    var win = function (since, until) {
      // như trang: lead chỉ đọc được từ winFrom nên chi tiêu của những ngày trước đó không được tính (nếu không chi phí / học sinh ĐP bị đẩy lên)
      var s = since && m && m.winFrom && since < m.winFrom ? m.winFrom : since;
      var hasSpend = !!(spendOf && s && until && s <= until), v = view(m, s, until, hasSpend ? spendOf(s, until) : null);
      var empty = !!(s && until && s > until);                      // cửa sổ nằm hết trước khoảng lead đọc được: không có lead, không tra chi tiêu
      return { from: empty ? null : s, to: empty ? null : until, total: Object.assign(cellOut(v.total, hasSpend), { students_paid_in_costed_programs: hasSpend ? v.mapped.ps : null }), by_program: v.programs.filter(function (p) { return p.l > 0; }).map(function (p) { return Object.assign({ program: p.k }, cellOut(p, hasSpend)); }),
        top_campaigns: v.campaigns.filter(function (c) { return c.l >= 5; }).slice(0, 8).map(function (c) { return Object.assign({ campaign: c.n, program: c.prog }, cellOut(c, hasSpend)); }), organic_parents: v.organic.l };
    };
    var out = { as_of: today, method: 'Mỗi phụ huynh điền form lead Facebook được đối chiếu với học sinh trong file tuyển sinh theo số điện thoại hoặc email; lead đầu tiên của phụ huynh quyết định ngày và chiến dịch; học sinh nội bộ và học sinh đã đăng ký trước khi điền form không tính cho quảng cáo.',
      data_freshness: freshness(m, today, info), lead_history_from: m && m.winFrom || null, last_30d: win(A.addDays(today, -30), A.addDays(today, -1)), prev_30d: win(A.addDays(today, -60), A.addDays(today, -31)), all_time: win('', ''),
      data_quality: { registration_stage_reliable: v0.regOk, phone_share_of_external_registered: round(at.regPhoneShare), phone_share_of_paid: round(at.phoneShare), registration_date_share: round(at.regDateShare), paid_rows_not_linked_to_registration: at.unlinkedPaid, low_coverage_before: m && m.lowCovUntil || null, programs_without_paid_phone: Object.keys(v0.lowPhone),
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
    out.leads = {}; ['rows', 'parents', 'noContact', 'hubKeys', 'organic', 'dupFamily', 'ambiguous', 'matched', 'internalOnly', 'preRegistered', 'crossProgram'].forEach(function (k) { out.leads[k] = int0(L[k]) || 0; });
    out.cov = {}; ['students', 'withPhone', 'ext', 'extWithPhone', 'extWithRegDate', 'paidExt', 'paidExtWithPhone', 'unlinkedPaid'].forEach(function (k) { out.cov[k] = int0(cv[k]) || 0; });
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
        // l ≥ i + b + r; đóng phí ⊂ đăng ký: p ≤ r, ps ≤ rs; học sinh chỉ tính một lần nên mỗi phụ huynh có tối đa MAX_SIBLINGS em: rs ≤ 6r, ps ≤ 6p (r có thể lớn hơn rs khi bố và mẹ cùng điền form)
        if (x.indexOf(null) >= 0 || x[1] + x[2] + x[3] > x[0] || x[4] > x[3] || x[6] > x[5] || x[5] > MAX_SIBLINGS * x[3] || x[6] > MAX_SIBLINGS * x[4]) return bad('Số theo ngày không nhất quán.');
        o[rk[j]] = x;
      }
      out.days[dk[i]] = o;
    }
    var ds = Object.keys(out.days).sort(); out.from = ds[0] || ''; out.to = ds[ds.length - 1] || '';
    out.winFrom = isDay(m.winFrom) ? m.winFrom : ''; out.frozenBefore = isDay(m.frozenBefore) ? m.frozenBefore : '';
    if (isDay(m.lowCovUntil)) out.lowCovUntil = m.lowCovUntil;      // các ngày trước mốc này được chốt khi Sheet còn thiếu SĐT/ngày (không tính lại được)
    out.syncedAt = typeof m.syncedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(m.syncedAt) && isFinite(Date.parse(m.syncedAt)) ? m.syncedAt : '';
    return { ok: true, match: out };
  }

  /** Tỷ lệ học sinh có SĐT/email (độ phủ): dùng để quyết định có tin số khớp hay không. */
  function phoneCoverage(m) {
    var c = m && m.cov || {}; return { registered: c.students > 0 ? c.withPhone / c.students : 0, paid: c.paidExt > 0 ? c.paidExtWithPhone / c.paidExt : 0 };
  }

  var api = {
    PROGRAMS: PROGRAMS, KEEP_DAYS: KEEP_DAYS, ORGANIC: ORGANIC, NONE: NONE, MAX_SIBLINGS: MAX_SIBLINGS, CELL: CELL, leadFromGraph: leadFromGraph, indexStudents: indexStudents, matchLeads: matchLeads, mergeMatch: mergeMatch, coverageGain: coverageGain, gates: gates,
    windowFrom: windowFrom, summarize: summarize, view: view, maturity: maturity, attribution: attribution, packOf: packOf, progLabel: progLabel, MIN_COST: MIN_COST, rates: rates, validate: validate, phoneCoverage: phoneCoverage, cleanName: cleanName, vnDay: vnDay
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FBMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
