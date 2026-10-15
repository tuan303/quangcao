/* Mặt bằng quảng cáo Facebook/Instagram ngành giáo dục – khoảng tham chiếu để so sánh khách quan, ngoài so với kỳ trước.
 * Dùng chung cho trang (window.FBBench) và máy chủ (globalThis.FBBench, api/insights.js).
 * Mỗi mục ghi rõ phạm vi, nguồn và thời điểm. Đây là khoảng tham chiếu từ báo cáo công khai, không phải chuẩn tuyệt đối:
 * khác thị trường, mục tiêu chiến dịch, mùa tuyển sinh thì số khác nhau. Cập nhật tệp này khi có báo cáo mới.
 * Đợt 15/10/2026: số được đối chiếu qua kết quả tìm kiếm của từng nguồn (chưa mở được trang gốc); nên mở đường dẫn để kiểm tra trước khi trích dẫn chính thức.
 * Quy đổi USD → VND theo 25.900 ₫/USD (giữa giá mua chuyển khoản và giá bán Vietcombank ngày 10/10/2026).
 */
(function (root) {
  'use strict';
  var AS_OF = '2026-10-15';
  // better: 'lower' | 'higher' – chiều nào là tốt hơn cho trường. basis: 'all' (mọi chiến dịch) | 'lead' (chiến dịch thu lead).
  var ITEMS = [
    // Việt Nam
    { metric: 'cpm', low: 38900, high: 72500, scope: 'Facebook tại Việt Nam, mọi ngành', source: 'Adligator – Meta Ads CPM by Country', url: 'https://adligator.com/blog/meta-ads-cpm-by-country-benchmarks', period: '2026',
      note: '1,50–2,80 USD. Instagram cao hơn (2,00–3,80 USD). Chưa có số riêng cho ngành giáo dục tại Việt Nam.' },
    { metric: 'cpcLink', low: 5000, high: 15000, scope: 'Giáo dục (cùng nhóm spa, nha khoa) tại Việt Nam', source: 'GK Digital – Chi phí quảng cáo Facebook', url: 'https://gkdigital.vn/chia-se/facebook/chi-phi-quang-cao-facebook-la-bao-nhieu', period: '2025–2026',
      note: 'Blog của agency, không nêu phương pháp và không nói rõ loại lượt nhấp; độ tin cậy thấp.' },
    { metric: 'cpl', low: 38900, high: 181300, scope: 'Form thu lead của Meta tại Việt Nam (bất động sản, giáo dục, bán lẻ)', source: 'Sotros Infotech – Facebook Ads CPL benchmarks', url: 'https://sotrosinfotech.com/blog/average-cost-per-lead-facebook-ads-benchmarks/', period: '2026',
      note: '1,50–7 USD. Blog của agency, không nêu phương pháp; độ tin cậy thấp. Agency trong nước nêu 100.000–300.000 ₫/lead tuỳ ngành.' },
    // Toàn cầu
    { metric: 'cpl', low: 381200, high: 766900, scope: 'Ngành giáo dục, mọi quốc gia (chủ yếu Mỹ, châu Âu)', source: 'Superads – Education cost per lead', url: 'https://www.superads.ai/facebook-ads-costs/cost-per-lead/education', period: '07/2025–07/2026',
      note: 'Theo tháng: 14,72 USD (07/2026) đến đỉnh 29,61 USD (02/2026); bình quân 21,31 USD (≈ 552.000 ₫), khoảng một nửa mức mọi ngành. Mỹ (WordStream 2026): 26,31 USD.' },
    { metric: 'ctr', low: 1.38, high: 2.39, scope: 'Ngành giáo dục, mọi quốc gia', source: 'Superads – Education CTR', url: 'https://www.superads.ai/facebook-ads-costs/ctr-click-through-rate/education', period: '07/2025–07/2026',
      note: 'Trung vị theo tháng; bình quân 1,80% (mọi ngành 2,04%). Nguồn không nói rõ tính mọi lượt nhấp hay chỉ lượt nhấp liên kết.' },
    { metric: 'lctr', low: 1.18, high: 1.18, scope: 'Mọi ngành, hơn 2.800 doanh nghiệp', source: 'Databox – Facebook Ads benchmarks', url: 'https://databox.com/fb-ads-benchmarks-by-industry', period: 'cập nhật 08/2026',
      note: 'Trung vị CTR liên kết (CTR mọi lượt nhấp: 1,9%).' },
    { metric: 'lcr', low: 10.08, high: 15.87, scope: 'Ngành giáo dục tại Mỹ, chiến dịch thu lead', source: 'WordStream/LocaliQ – Facebook Ads Benchmarks', url: 'https://www.wordstream.com/blog/facebook-ads-benchmarks-2026', period: '2025–2026',
      note: '10,08% (bản 2025) đến 15,87% (bản 2026, mới thấy ở nguồn thứ cấp). Cao nhất trong các ngành. WordStream tính trên lượt nhấp, không riêng lượt nhấp liên kết.' }
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
  var LEAD_OBJ = { OUTCOME_LEADS: 1, LEAD_GENERATION: 1 };

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
    C.campaignsIn(mdl, opt.accts, opt.since, opt.until).forEach(function (x) { if (LEAD_OBJ[x.c.obj]) { add(lead, x.period); n++; } });
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
      if (v != null && (b.low != null || b.high != null)) {
        var lo = b.low != null ? b.low : b.high, hi = b.high != null ? b.high : b.low;
        var good = m.better === 'lower' ? v < lo : v > hi, bad = m.better === 'lower' ? v > hi : v < lo;
        verdict = good ? 'better' : bad ? 'worse' : 'within';
      }
      return { metric: b.metric, label: m.label, unit: m.unit, better: m.better, basis: b.basis || m.basis, school: v == null ? null : Math.round(v * 100) / 100,
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
