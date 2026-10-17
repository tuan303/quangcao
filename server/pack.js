// Gói số liệu cho phần Phân tích & đề xuất: tính sẵn mọi con số mà bài phân tích được phép trích dẫn, để mô hình không phải tự tính.
// Cùng cách tính với tools/pack.mjs (bản dùng cho tác vụ Claude trên máy quản trị), nhưng chạy trong hàm Vercel và gọn hơn
// (giới hạn số chiến dịch, mẫu quảng cáo và dòng khán giả để vừa một lần gọi mô hình).

const LIMITS = { campaigns: 40, recent: 25, ads: 30, adBody: 400, bdRows: 15 };

/** @param C globalThis.FBCore   @param docs tài liệu dashboard (acct-*, camp-*, …)   @param today YYYY-MM-DD giờ Hà Nội */
export function buildPack(C, docs, today) {
  const mdl = C.model(docs), D = C.dates, MI = C.MI;
  const roles = Object.fromEntries(C.ACCOUNTS.map(a => [a.id, a.role]));
  const connected = new Set(((docs.meta || {}).accounts || C.ACCOUNTS).map(a => a.id));
  const accounts = C.ACCOUNTS.filter(a => connected.has(a.id)); // chỉ các tài khoản đang kết nối và đang đồng bộ
  const ADM = accounts.filter(a => (a.role || roles[a.id]) !== 'recruit').map(a => a.id);
  const RECRUIT = accounts.filter(a => (a.role || roles[a.id]) === 'recruit').map(a => a.id);
  const r0 = x => x == null || !isFinite(x) ? null : Math.round(x);
  const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 10000) / 100; // tỉ lệ → % (2 chữ số)
  const r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
  // cpl = chi tiêu chiến dịch thu lead ÷ lead của chính các chiến dịch đó; spend_other = chi thương hiệu, tương tác… (không tính vào cpl)
  const K = o => o && { spend: r0(o.spend), leads: o.leads, cpl: r0(o.cpl), spend_lead_campaigns: o.lcSpend == null ? undefined : r0(o.lcSpend), leads_lead_campaigns: o.lcLeads == null ? undefined : r0(o.lcLeads),
    spend_other: o.otherSpend == null ? undefined : r0(o.otherSpend), cpl_all_spend: o.cplAll == null ? undefined : r0(o.cplAll), cpl_basis: o.cplBasis, cpl_estimated: o.cplApprox ? true : undefined, reach: r0(o.reach), impr: r0(o.impr), cpm: r0(o.cpm), clicks: r0(o.clicks), ctr_pct: r2(o.ctr), cpc: r0(o.cpc),
    link_clicks: r0(o.link), cpc_link: r0(o.cpcLink), link_ctr_pct: r2(o.lctr), thruplay: r0(o.thru), engagements: r0(o.eng), eng_rate_pct: r2(o.engRate), freq: r1(o.freq), lpv: r0(o.lpv) };

  const y1 = D.addDays(today, -1), sy = D.schoolYearStart(today), psy = (+sy.slice(0, 4) - 1) + '-08-01';
  const shiftY = (s, n) => (+s.slice(0, 4) + n) + s.slice(4);
  const P = {
    last7d: [D.addDays(today, -7), y1], prev7d: [D.addDays(today, -14), D.addDays(today, -8)],
    last30d: [D.addDays(today, -30), y1], prev30d: [D.addDays(today, -60), D.addDays(today, -31)],
    month_to_date: [D.monthStart(today), today], last_month: [D.prevMonth(today), D.monthEnd(D.prevMonth(today))],
    school_year_to_date: [sy, today], same_span_prev_school_year: [psy, shiftY(today, -1)], prev_school_year_full: [psy, D.addDays(sy, -1)]
  };
  const periods = {};
  for (const [k, [s, e]] of Object.entries(P)) periods[k] = Object.assign({ since: s, until: e }, K(C.totals(mdl, ADM, s, e)));
  const perAccount = {};
  for (const a of accounts) perAccount[a.id] = { name: a.name, role: a.role || roles[a.id], last30d: K(C.totals(mdl, [a.id], ...P.last30d)), school_year_to_date: K(C.totals(mdl, [a.id], sy, today)) };
  const monthly = C.series(mdl, ADM, D.addDays(today, -400), today, 'month').map(r => Object.assign({ month: r.key }, K(r)));
  const daily30 = C.series(mdl, ADM, P.last30d[0], y1, 'day').map(r => ({ day: r.key, spend: r0(r.spend), leads: r.leads, cpl: r0(r.cpl) }));

  const camps = Object.values(mdl.campaigns).filter(c => ADM.includes(c.acct) || RECRUIT.includes(c.acct)).map(c => {
    const L = C.vecObj(c.m || C.zero());
    return { id: c.id, account: c.acct, name: c.n, segment: c.seg, objective: c.obj, status: c.st, start: c.s, stop: c.e, daily_budget: r0(c.db), ...K(L) };
  }).filter(c => c.spend > 0).sort((a, b) => b.spend - a.spend);

  const recent = [];
  for (const cd of Object.values(mdl.campd)) for (const [cid, byDay] of Object.entries(cd.rows)) {
    const c = mdl.campaigns[cid], days = Object.keys(byDay).filter(d => d >= P.last30d[0]).sort();
    if (!days.length) continue;
    const t = C.zero(); days.forEach(d => C.addInto(t, byDay[d]));
    const o = C.vecObj(t), w7 = C.zero(), w7p = C.zero();
    days.filter(d => d >= P.last7d[0]).forEach(d => C.addInto(w7, byDay[d]));
    days.filter(d => d >= P.prev7d[0] && d <= P.prev7d[1]).forEach(d => C.addInto(w7p, byDay[d]));
    recent.push({ campaign: c ? c.n : cid, segment: c && c.seg, objective: c && c.obj, status: c && c.st, active_days: days.length, first_day: days[0], last_day: days[days.length - 1],
      ...K(o), reach: undefined, freq: undefined, last7d: K(C.vecObj(w7)), prev7d: K(C.vecObj(w7p)) });
  }
  recent.sort((a, b) => b.spend - a.spend);

  function segAgg(s, e) {
    const out = {};
    const lead = {};
    for (const x of C.campaignsIn(mdl, ADM, s, e)) {
      const k = x.c.seg, vec = C.M.map(m => x.period[m] || 0);
      out[k] ||= C.zero(); C.addInto(out[k], vec);
      if (C.isLeadCampaign(x.c)) { lead[k] ||= C.zero(); C.addInto(lead[k], vec); }
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => {
      const o = C.vecObj(v), L = C.vecObj(lead[k] || C.zero());
      o.cpl = L.leads ? L.spend / L.leads : null; // chi phí/lead của khối: chỉ chiến dịch thu lead
      return [k, { label: C.segLabel(k), ...K(o), spend_lead_campaigns: r0(L.spend), leads_lead_campaigns: r0(L.leads), reach: undefined, freq: undefined }];
    }));
  }
  const segments = { last30d: segAgg(...P.last30d), school_year_to_date: segAgg(sy, today), prev_school_year: segAgg(psy, D.addDays(sy, -1)) };

  const objAgg = {};
  for (const c of Object.values(mdl.campaigns)) { if (!ADM.includes(c.acct) || !c.m) continue; const k = C.objectiveLabel(c.obj); objAgg[k] ||= C.zero(); C.addInto(objAgg[k], c.m); }
  const objectives = Object.fromEntries(Object.entries(objAgg).map(([k, v]) => [k, K(C.vecObj(v))]));

  const ads = Object.values(mdl.ads).filter(a => ADM.includes(a.acct)).map(a => {
    const L = C.vecObj(a.m), cr = mdl.creatives[a.cr] || {};
    return { campaign: a.cn, segment: a.seg, objective: a.obj, status: a.st, created: a.c, title: cr.t || '', body: (cr.b || '').slice(0, LIMITS.adBody), creative_type: cr.ty || '', has_video: !!cr.vid, ...K(L), reach: undefined };
  }).filter(a => a.spend > 0).sort((a, b) => b.spend - a.spend);

  function bd(dim) {
    const b = mdl.bd[dim]; if (!b) return [];
    const nk = b.keys.length, ci = Object.fromEntries(b.cols.map((c, i) => [c, 2 + nk + i])), acc = {};
    for (const r of b.rows) {
      if (!ADM.includes(r[0])) continue;
      const key = r.slice(2, 2 + nk).join(' | ');
      const o = (acc[key] ||= { key, spend: 0, impr: 0, clicks: 0, lead: 0, mlead: 0, ls: 0, ll: 0, lm: 0 });
      for (const m of ['spend', 'impr', 'clicks', 'lead', 'mlead']) o[m] += r[ci[m]] || 0;
      if (C.isLeadCampaign(mdl.campaigns[r[1]])) { o.ls += r[ci.spend] || 0; o.ll += r[ci.lead] || 0; o.lm += r[ci.mlead] || 0; }
    }
    const tot = Object.values(acc).reduce((s, o) => s + o.spend, 0) || 1;
    return Object.values(acc).map(o => { const leads = Math.max(o.lead, o.mlead); const ll = Math.max(o.ll, o.lm); return { key: o.key, spend_share_pct: r2(o.spend / tot), leads, cpl: r0(ll ? o.ls / ll : null), ctr_pct: r2(o.impr ? o.clicks / o.impr : null) }; })
      .sort((a, b) => b.spend_share_pct - a.spend_share_pct).slice(0, LIMITS.bdRows);
  }
  const breakdowns = { age_gender: bd('agegender'), platform_position: bd('platform'), region: bd('region'), device: bd('device') };

  const meta = docs.meta || {};
  return {
    school: 'Trường Tiểu học, THCS & THPT Ngôi Sao Hoàng Mai (Hà Nội)', today, data_start: C.START, data_until: meta.dataUntil || today,
    sync: { syncedAt: meta.syncedAt || null, accounts_missing: Object.entries(meta.perAccount || {}).filter(([, x]) => x && (x.failed || x.skipped)).map(([a]) => a), lead_loss: meta.leadLoss || [] },
    notes: [
      'Tiền tệ VND. Lead = max(lead, lead trên Meta) theo từng dòng (form + Messenger), không cộng trùng.',
      'cpl (chi phí/lead) = chi tiêu của chiến dịch thu lead ÷ lead của chính các chiến dịch đó (chiến dịch thu lead = mục tiêu thu lead, hoặc chiến dịch khác đã thu được lead như tin nhắn Messenger); spend_other là chi cho thương hiệu, tương tác… không tính vào cpl; cpl_all_spend = tổng chi tiêu ÷ tổng lead, chỉ để đối chiếu, không dùng làm chi phí/lead. Cpl theo khối, theo khán giả (breakdowns) cũng chỉ tính chiến dịch thu lead.',
      'cpl_basis = "all": kỳ đó chưa đủ số theo chiến dịch nên cpl tạm tính bằng tổng chi tiêu ÷ tổng lead; không so cpl giữa hai kỳ khác cpl_basis. cpl_estimated = true: một phần số theo chiến dịch được ước tính từ số theo tháng.',
      'Chỉ có hai tài khoản đang kết nối: TK Fanpage Trường (895057262833914) và TK Facebook cô Ngà (1870132100153072).',
      'Số của hôm nay chưa trọn ngày. Tiếp cận cộng nhiều tài khoản có thể đếm trùng người.',
      'Phân khúc theo tên chiến dịch: l1=Lớp 1/Tiểu học, l6=Lớp 6/THCS, l10=Lớp 10/THPT, js=Jolly Steps (cầu nối mầm non–tiểu học), camp=Trại hè, brand=thương hiệu/thành tích (bài đẩy), mix=tuyển sinh chung, hr=tuyển dụng.'
    ],
    accounts, periods, per_account: perAccount, monthly_admissions: monthly, daily_last30d: daily30,
    segments, objectives,
    campaigns: camps.slice(0, LIMITS.campaigns), campaigns_total: camps.length,
    recent_campaigns_last30d: recent.slice(0, LIMITS.recent),
    ads: ads.slice(0, LIMITS.ads), ads_total: ads.length,
    breakdowns
  };
}
