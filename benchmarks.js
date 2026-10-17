/* Mặt bằng quảng cáo Facebook/Instagram ngành giáo dục – khoảng tham chiếu để so sánh khách quan, ngoài so với kỳ trước.
 * Dùng chung cho trang (window.FBBench) và máy chủ (globalThis.FBBench, api/insights.js).
 * Mỗi mục ghi rõ phạm vi, nguồn và thời điểm. Đây là khoảng tham chiếu từ báo cáo công khai, không phải chuẩn tuyệt đối:
 * khác thị trường, mục tiêu chiến dịch, mùa tuyển sinh thì số khác nhau. Cập nhật tệp này khi có báo cáo mới.
 * Đợt 15/10/2026: số được đối chiếu qua kết quả tìm kiếm của từng nguồn (chưa mở được trang gốc); nên mở đường dẫn để kiểm tra trước khi trích dẫn chính thức.
 * Chỉ giữ mặt bằng ngành giáo dục tại Việt Nam; số toàn cầu và Mỹ đã bỏ vì chi phí quảng cáo ở đó cao hơn nhiều, không so được.
 * Quy đổi USD → VND theo 25.900 ₫/USD (giữa giá mua chuyển khoản và giá bán Vietcombank ngày 10/10/2026).
 */
(function (root) {
  'use strict';
  var AS_OF = '2026-10-15';
  // better: 'lower' | 'higher' – chiều nào là tốt hơn cho trường. basis: 'all' (mọi chiến dịch) | 'lead' (chiến dịch thu lead).
  // market: 'vn' (thị trường Việt Nam: có đánh giá tốt/kém) | 'global' (thị trường khác, chi phí cao hơn nhiều: chỉ để tham khảo, không gắn nhãn).
  // kind: 'range' (khoảng mặt bằng, mặc định) | 'case' (một trường hợp cụ thể) | 'mixed' (gộp nhiều ngành): hai loại sau chỉ để tham khảo, không đánh giá tốt/kém.
  var ITEMS = [
    // Chỉ mặt bằng quảng cáo ngành giáo dục tại Việt Nam (theo yêu cầu của nhà trường). Chưa có báo cáo nào có phương pháp rõ ràng
    // cho riêng giáo dục ở Việt Nam, nên các khoảng dưới đây lấy từ blog agency trong nước: độ tin cậy thấp, chỉ là mốc tham khảo.
    { metric: 'cpl', market: 'vn', kind: 'mixed', low: 38900, high: 181300, scope: 'Form thu lead của Meta tại Việt Nam, gộp giáo dục, bất động sản, bán lẻ (không riêng giáo dục)', source: 'Sotros Infotech – Facebook Ads CPL benchmarks', url: 'https://sotrosinfotech.com/blog/average-cost-per-lead-facebook-ads-benchmarks/', period: '2026',
      note: '1,50–7 USD. Blog của agency, không nêu phương pháp; độ tin cậy thấp. Gộp nhiều ngành nên chỉ để tham khảo, không đánh giá tốt/kém.' },
    { metric: 'cpl', market: 'vn', kind: 'case', low: 90000, high: 150000, scope: 'Một trung tâm tiếng Anh tại Việt Nam (một trường hợp cụ thể)', source: 'Fchat – Chi phí chạy quảng cáo Facebook', url: 'https://fchat.vn/blog/chi-phi-chay-quang-cao-facebook.html', period: '2025–2026',
      note: 'Chi phí/lead Facebook tới 150.000 ₫, giảm còn 90.000 ₫ sau khi tối ưu. Chỉ là một ví dụ, không phải số bình quân ngành.' },
    { metric: 'cpcLink', market: 'vn', low: 5000, high: 25000, scope: 'Giáo dục và đào tạo tại Việt Nam', source: 'GK Digital (5.000–15.000 ₫); Fchat (5.000–25.000 ₫)', url: 'https://gkdigital.vn/chia-se/facebook/chi-phi-quang-cao-facebook-la-bao-nhieu', period: '2025–2026',
      note: 'Gộp hai blog agency trong nước (Fchat: fchat.vn/blog/chi-phi-chay-quang-cao-facebook.html); không nêu phương pháp và không nói rõ loại lượt nhấp; độ tin cậy thấp.' }
  ];

  var METRICS = {
    cpm: { label: 'CPM (chi phí 1.000 lượt hiển thị)', unit: 'VND', better: 'lower', basis: 'all' },
    ctr: { label: 'CTR (tỉ lệ nhấp, tất cả)', unit: '%', better: 'higher', basis: 'all' },
    lctr: { label: 'CTR liên kết', unit: '%', better: 'higher', basis: 'all' },
    cpc: { label: 'CPC (chi phí/lượt nhấp)', unit: 'VND', better: 'lower', basis: 'all' },
    cpcLink: { label: 'Chi phí/lượt nhấp liên kết', unit: 'VND', better: 'lower', basis: 'all' },
    cpl: { label: 'Chi phí/lead (chiến dịch thu lead)', unit: 'VND', better: 'lower', basis: 'lead' },
    lcr: { label: 'Tỉ lệ ra lead / lượt nhấp liên kết', unit: '%', better: 'higher', basis: 'lead' },
    freq: { label: 'Tần suất (chiến dịch thu lead)', unit: 'lần', better: 'lower', basis: 'lead' }
  };

  /* So sánh của chính Meta (Industry benchmark): nhóm quảng cáo của trường so với các nhà quảng cáo tương tự trong ngành.
   * Meta chỉ cho biết cao/thấp hơn bao nhiêu % so với mặt bằng nhóm, không cho giá trị tuyệt đối, và chỉ cho nhóm quảng cáo đủ số liệu.
   * rel = (số của trường − mặt bằng) / mặt bằng × 100. Lấy thủ công qua công cụ Meta Ads; cập nhật bằng cách thay khối này. */
  var META = {
    asOf: '2026-10-15', since: '2026-09-15', until: '2026-10-14', account: '895057262833914',
    vertical: 'Giáo dục › Trường học và giáo dục mầm non', cohort: 'mục tiêu thu lead bằng form của Meta, khách hàng mới',
    rows: [
      { adset: 'JS26-LEAD | Lạnh | Trường 10km', metric: 'cpl', rel: -85.54 },
      { adset: 'JS26-LEAD | Lạnh | Trường 10km', metric: 'cpc', rel: -73.57 },
      { adset: 'JS26-LEAD | Lạnh | Trường 10km', metric: 'cpm', rel: -48.34 },
      { adset: 'JS26-LEAD | Lạnh | Trường 10km', metric: 'ctr', rel: 97.95 }
    ]
  };
  function metaRows() {
    return META.rows.map(function (r) {
      var m = METRICS[r.metric] || { label: r.metric, better: 'lower' };
      var good = m.better === 'lower' ? r.rel < 0 : r.rel > 0;
      return { metric: r.metric, label: m.label.replace(/ \(.*\)$/, ''), adset: r.adset, rel: r.rel, verdict: Math.abs(r.rel) < 5 ? 'within' : good ? 'better' : 'worse' };
    });
  }

  function add(o, p) { ['spend', 'impr', 'clicks', 'link', 'lead', 'mlead', 'reach'].forEach(function (k) { o[k] = (o[k] || 0) + (p[k] || 0); }); return o; }

  /* Số của trường trong kỳ: mọi chiến dịch, và riêng chiến dịch thu lead. */
  function schoolFigures(C, mdl, opt) {
    var all = C.totals(mdl, opt.accts, opt.since, opt.until);
    var lead = {}, n = 0;
    // cùng định nghĩa chiến dịch thu lead với chi phí/lead trên dashboard
    C.campaignsIn(mdl, opt.accts, opt.since, opt.until).forEach(function (x) { if (C.isLeadCampaign(x.c)) { add(lead, x.period); n++; } });
    return { all: all, lead: n ? C.derive(lead) : null, leadCampaigns: n };
  }

  /* So sánh số của trường với từng khoảng tham chiếu. opt: {since, until, accts}; mặc định 30 ngày qua, các tài khoản tuyển sinh. */
  function compare(C, mdl, today, opt) {
    opt = opt || {};
    var accts = opt.accts || C.ACCOUNTS.filter(function (a) { return a.role !== 'recruit'; }).map(function (a) { return a.id; });
    var until = opt.until || C.dates.addDays(today, -1), since = opt.since || C.dates.addDays(today, -30);
    var f = schoolFigures(C, mdl, { accts: accts, since: since, until: until });
    var rows = ITEMS.map(function (b) {
      var m = METRICS[b.metric]; if (!m) return null;
      var src = (b.basis || m.basis) === 'lead' ? f.lead : f.all;
      var v = src ? src[b.metric] : null;
      if (v != null && m.unit === '%') v = v * 100;
      var verdict = null;
      var fewLeads = (b.basis || m.basis) === 'lead' && (!src || (src.leads || 0) < 5); // dưới 5 lead thì chi phí/lead chưa đủ tin cậy
      if (v != null && !fewLeads && (!b.kind || b.kind === 'range') && (b.low != null || b.high != null)) { // ví dụ hoặc số gộp nhiều ngành: không đánh giá
        var lo = b.low != null ? b.low : b.high, hi = b.high != null ? b.high : b.low;
        var good = m.better === 'lower' ? v < lo : v > hi, bad = m.better === 'lower' ? v > hi : v < lo;
        verdict = good ? 'better' : bad ? 'worse' : 'within';
      }
      return { metric: b.metric, market: b.market || 'global', kind: b.kind || 'range', label: m.label, unit: m.unit, better: m.better, basis: b.basis || m.basis, school: v == null ? null : Math.round(v * 100) / 100,
        low: b.low, high: b.high, scope: b.scope, source: b.source, url: b.url, period: b.period, note: b.note || '', verdict: verdict };
    }).filter(Boolean);
    return { asOf: AS_OF, since: since, until: until, leadCampaigns: f.leadCampaigns, rows: rows,
      meta: META.rows.length ? { asOf: META.asOf, since: META.since, until: META.until, account: META.account, vertical: META.vertical, cohort: META.cohort, rows: metaRows() } : null };
  }
  function sources() { return ITEMS.map(function (b) { return { metric: b.metric, scope: b.scope, source: b.source, url: b.url, period: b.period }; }); }

  var api = { AS_OF: AS_OF, ITEMS: ITEMS, METRICS: METRICS, META: META, compare: compare, sources: sources };
  root.FBBench = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
