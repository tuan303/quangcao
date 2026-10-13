// pack.mjs — compute every figure the analysts may quote, so no arithmetic is done by hand.
// usage: node pack.mjs <core.js> <docsDir> <outFile> [--today=YYYY-MM-DD]
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [corePath, docsDir, outFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const C = require(path.resolve(corePath));
const today = (process.argv.find(a => a.startsWith('--today=')) || '').split('=')[1] || C.dates.todayVN();
const docs = {};
for (const f of fs.readdirSync(docsDir).filter(f => f.endsWith('.json'))) docs[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
const mdl = C.model(docs); const D = C.dates; const MI = C.MI;
const ADM = C.ACCOUNTS.filter(a => a.role !== 'recruit').map(a => a.id);
const r0 = x => x == null || !isFinite(x) ? null : Math.round(x);
const r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 10000) / 100; // ratio -> percent with 2 decimals
const r1 = x => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
function K(o) { return o && { spend: r0(o.spend), leads: o.leads, cpl: r0(o.cpl), reach: r0(o.reach), reach_exact: o.reachExact, impr: r0(o.impr), cpm: r0(o.cpm), clicks: r0(o.clicks), ctr_pct: r2(o.ctr), cpc: r0(o.cpc), link_clicks: r0(o.link), cpc_link: r0(o.cpcLink), link_ctr_pct: r2(o.lctr), views: r0(o.views), thruplay: r0(o.thru), engagements: r0(o.eng), eng_rate_pct: r2(o.engRate), cost_per_eng: r0(o.cpe), freq: r1(o.freq), lpv: r0(o.lpv), video_hook_p25_pct: r2(o.hook), video_complete_p100_pct: r2(o.hold) }; }
const y1 = D.addDays(today, -1), sy = D.schoolYearStart(today), psy = (+sy.slice(0, 4) - 1) + '-08-01';
const shiftY = (s, n) => (+s.slice(0, 4) + n) + s.slice(4);
const P = {
  last7d: [D.addDays(today, -7), y1], prev7d: [D.addDays(today, -14), D.addDays(today, -8)],
  last30d: [D.addDays(today, -30), y1], prev30d: [D.addDays(today, -60), D.addDays(today, -31)],
  month_to_date: [D.monthStart(today), today], last_month: [D.prevMonth(today), D.monthEnd(D.prevMonth(today))],
  school_year_to_date: [sy, today], same_span_prev_school_year: [psy, shiftY(today, -1)],
  prev_school_year_full: [psy, D.addDays(sy, -1)], year_to_date: [today.slice(0, 4) + '-01-01', today], all_time: [C.START, today]
};
const periods = {}; for (const [k, [s, e]] of Object.entries(P)) periods[k] = Object.assign({ since: s, until: e }, K(C.totals(mdl, ADM, s, e)));
const perAccount = {}; for (const a of C.ACCOUNTS) perAccount[a.id] = { name: a.name, role: a.role, all_time: K(C.totals(mdl, [a.id], C.START, today)), school_year_to_date: K(C.totals(mdl, [a.id], sy, today)), last30d: K(C.totals(mdl, [a.id], ...P.last30d)) };
const monthly = C.series(mdl, ADM, C.START, today, 'month').map(r => Object.assign({ month: r.key }, K(r)));
const monthlyRecruit = C.series(mdl, ['900002142818933'], '2026-03-01', '2026-04-30', 'month').map(r => Object.assign({ month: r.key }, K(r)));
// weekday pattern, last 365 days
const wd = Array.from({ length: 7 }, () => ({ spend: 0, leads: 0, clicks: 0, impr: 0, days: 0 }));
for (const r of C.series(mdl, ADM, D.addDays(today, -365), y1, 'day')) { const i = (D.parseISO(r.key).getUTCDay() + 6) % 7; wd[i].spend += r.spend; wd[i].leads += r.leads; wd[i].clicks += r.clicks; wd[i].impr += r.impr; wd[i].days++; }
const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((n, i) => ({ day: n, avg_spend: r0(wd[i].spend / wd[i].days), avg_leads: r1(wd[i].leads / wd[i].days), cpl: r0(wd[i].leads ? wd[i].spend / wd[i].leads : null), ctr_pct: r2(wd[i].clicks / wd[i].impr) }));
// campaigns
const camps = Object.values(mdl.campaigns).filter(c => ADM.includes(c.acct) || c.acct === '900002142818933').map(c => {
  const L = C.vecObj(c.m);
  return { id: c.id, account: c.acct, name: c.n, segment: c.seg, objective: c.obj, status: c.st, start: c.s, stop: c.e,
    daily_budget: r0(c.db), results: r0(L.results), months: Object.keys(c.monthly || {}).sort(), ...K(L) };
}).filter(c => c.spend > 0).sort((a, b) => b.spend - a.spend);
// segments: all-time, previous school year, school year to date, by month
function segAgg(s, e) {
  const out = {};
  for (const x of C.campaignsIn(mdl, ADM.concat(['900002142818933']), s, e)) { const k = x.c.seg; out[k] ||= C.zero(); C.addInto(out[k], C.M.map(m => x.period[m] || 0)); }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => { const o = C.vecObj(v); return [k, { label: C.segLabel(k), ...K(o), reach: undefined, reach_exact: undefined, freq: undefined }]; }));
}
const segments = { all_time: segAgg(C.START, today), prev_school_year: segAgg(psy, D.addDays(sy, -1)), school_year_to_date: segAgg(sy, today), last30d: segAgg(...P.last30d) };
const segMonthly = {};
for (const c of Object.values(mdl.campaigns)) for (const [mk, v] of Object.entries(c.monthly || {})) { const o = (segMonthly[mk] ||= {}); const t = (o[c.seg] ||= { spend: 0, leads: 0 }); t.spend += v[MI.spend]; t.leads += Math.max(v[MI.lead], v[MI.mlead]); }
for (const mk of Object.keys(segMonthly)) for (const k of Object.keys(segMonthly[mk])) segMonthly[mk][k].spend = r0(segMonthly[mk][k].spend);
// objectives
const objAgg = {};
for (const c of Object.values(mdl.campaigns)) { if (!ADM.includes(c.acct) || !c.m) continue; const k = C.objectiveLabel(c.obj); objAgg[k] ||= C.zero(); C.addInto(objAgg[k], c.m); }
const objectives = Object.fromEntries(Object.entries(objAgg).map(([k, v]) => [k, K(C.vecObj(v))]));
// ads with creative text
const ads = Object.values(mdl.ads).map(a => {
  const L = C.vecObj(a.m), cr = mdl.creatives[a.cr] || {};
  return { id: a.id, account: a.acct, campaign_id: a.cid, campaign: a.cn, segment: a.seg, objective: a.obj, status: a.st, created: a.c, months_active: Object.keys(mdl.adm[a.id] || {}).sort(),
    title: cr.t || '', body: (cr.b || '').slice(0, 700), cta: cr.cta || '', creative_type: cr.ty || '', has_video: !!cr.vid, ...K(L) };
}).filter(a => a.spend > 0).sort((a, b) => b.spend - a.spend);
// breakdowns aggregated
function bd(dim, filterSeg) {
  const b = mdl.bd[dim]; if (!b) return [];
  const nk = b.keys.length, ci = Object.fromEntries(b.cols.map((c, i) => [c, 2 + nk + i])), acc = {};
  for (const r of b.rows) {
    if (!ADM.includes(r[0])) continue;
    const camp = mdl.campaigns[r[1]]; if (filterSeg && (!camp || camp.seg !== filterSeg)) continue;
    const key = r.slice(2, 2 + nk).join(' | ');
    const o = (acc[key] ||= { key, spend: 0, impr: 0, clicks: 0, link: 0, lead: 0, mlead: 0, eng: 0 });
    for (const m of ['spend', 'impr', 'clicks', 'link', 'lead', 'mlead', 'eng']) o[m] += r[ci[m]] || 0;
  }
  const tot = Object.values(acc).reduce((s, o) => s + o.spend, 0);
  return Object.values(acc).map(o => { const leads = Math.max(o.lead, o.mlead); return { key: o.key, spend: r0(o.spend), spend_share_pct: r2(o.spend / tot), leads, cpl: r0(leads ? o.spend / leads : null), ctr_pct: r2(o.impr ? o.clicks / o.impr : null), impr: r0(o.impr) }; }).sort((a, b) => b.spend - a.spend);
}
const breakdowns = { age_gender_all: bd('agegender'), platform_position_all: bd('platform').slice(0, 20), region_all: bd('region').slice(0, 20), device_all: bd('device') };
for (const s of ['l1', 'l6', 'l10', 'js', 'mix']) breakdowns['age_gender_' + s] = bd('agegender', s);
// recent campaign x day (last 30 days) for active campaigns
const recent = [];
for (const [acct, cd] of Object.entries(mdl.campd)) for (const [cid, byDay] of Object.entries(cd.rows)) {
  const c = mdl.campaigns[cid]; const days = Object.keys(byDay).filter(d => d >= P.last30d[0]).sort(); if (!days.length) continue;
  const t = C.zero(); days.forEach(d => C.addInto(t, byDay[d])); const o = C.vecObj(t);
  recent.push({ campaign: c ? c.n : cid, segment: c && c.seg, objective: c && c.obj, status: c && c.st, active_days: days.length, first_day: days[0], last_day: days[days.length - 1], ...K(o), reach: undefined, reach_exact: undefined, freq: undefined });
}
recent.sort((a, b) => b.spend - a.spend);
const pack = { generated_for: 'Trường Tiểu học, THCS & THPT Ngôi Sao Hoàng Mai (Hà Nội) — Facebook/Instagram ads', today, data_start: C.START,
  notes: ['Money in VND. Leads = max(lead, onsite Meta leads) per row (lead forms + Messenger leads).', 'reach for multi-account totals is the sum of per-account exact reach (people reached by two accounts count twice); reach_exact=false means the window had no exact figure and daily reach was summed.', 'Admissions accounts = 1870132100153072 (school fanpage boosts + lead ads), 895057262833914 (Đông Đô company account, mostly lead ads), 163604412431952 (small secondary). Recruitment account 900002142818933 is excluded from admissions totals.', 'Segments come from campaign names: l1=Lớp 1/Tiểu học, l10=Lớp 10/THPT, l6=Lớp 6/THCS, js=Jolly Steps (preschool-to-primary bridge experience), camp=Trại hè (summer camp), brand=thương hiệu/thành tích (boosted posts), mix=tuyển sinh chung/multi-grade, hr=tuyển dụng, other=khác (e.g. a teacher class page).', 'Today\'s data is partial.'],
  accounts: C.ACCOUNTS, periods, per_account: perAccount, monthly_admissions: monthly, monthly_recruitment: monthlyRecruit, weekday_last365: weekday,
  segments, segment_by_month: segMonthly, objectives, campaigns: camps, recent_campaigns_last30d: recent, breakdowns, ads };
fs.writeFileSync(outFile, JSON.stringify(pack, null, 1));
console.log('pack bytes', fs.statSync(outFile).size, 'campaigns', camps.length, 'ads', ads.length);
