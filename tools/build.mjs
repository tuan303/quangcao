// build.mjs — raw Meta Ads payload files -> database documents (+ cross-checks)
// usage: node build.mjs <core.js> <rawDir> <outDir> [existingDocsDir] [--today=YYYY-MM-DD] [--by=label]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [corePath, rawDir, outDir, oldDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const C = require(path.resolve(corePath));
const today = flag('today', C.dates.todayVN());
const by = flag('by', 'claude');

// group raw files: <acct>__<dataset>[__pN|__hN|__cN].json  (creatives: <acct>__creatives__cN.json)
const raw = {};
for (const f of fs.readdirSync(rawDir).filter(f => f.endsWith('.json')).sort()) {
  const m = f.match(/^(\d+)__([a-z0-9_]+?)(?:__([a-z0-9]+))?\.json$/);
  if (!m) { console.warn('skip', f); continue; }
  let [, acct, ds, part] = m;
  if (ds === 'creatives') ds = 'creatives_' + (part || 'c1');
  const payload = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  ((raw[acct] ||= {})[ds] ||= []).push(payload);
}
const windows = Object.assign(C.windowsOf(C.plan(today)), {
  reach_season: { since: '2025-12-01', until: '2026-07-31' }, reach_lq: { since: '2026-07-01', until: '2026-09-30' }
});
let docs = C.normalize(raw, { windows });
const old = {};
if (oldDir && fs.existsSync(oldDir)) {
  for (const f of fs.readdirSync(oldDir).filter(f => f.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(oldDir, f), 'utf8'));
    old[f.replace(/\.json$/, '')] = j.data || j;
  }
  docs = C.mergeDocs(old, docs);
}
const accounts = C.ACCOUNTS.filter(a => raw[a.id]).map(a => ({ id: a.id, name: a.name, short: a.short, role: a.role }));
docs.meta = { v: C.VERSION, syncedAt: new Date().toISOString(), syncedBy: by, dataUntil: today, start: C.START, accounts };

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
let maxSize = 0;
for (const [id, body] of Object.entries(docs)) {
  const s = JSON.stringify(body);
  maxSize = Math.max(maxSize, s.length);
  if (s.length > 250000) console.error('DOC TOO LARGE', id, s.length);
  fs.writeFileSync(path.join(outDir, id + '.json'), s);
}
console.log('docs', Object.keys(docs).length, 'max bytes', maxSize);
// --full=<dir>: every document the page will have after the write (stored ones overlaid by fresh ones)
const fullDir = flag('full', '');
if (fullDir) {
  fs.mkdirSync(fullDir, { recursive: true });
  for (const f of fs.readdirSync(fullDir)) fs.unlinkSync(path.join(fullDir, f));
  for (const [id, body] of Object.entries(Object.assign({}, old, docs))) fs.writeFileSync(path.join(fullDir, id + '.json'), JSON.stringify(body));
  console.log('full set written to', fullDir);
}

// ---------- cross-checks ----------
const mdl = C.model(docs);
const MI = C.MI;
const fmt = n => Math.round(n).toLocaleString('en-US');
let problems = 0;
function check(label, a, b, tolPct = 0.0001) {
  const ok = Math.abs(a - b) <= Math.max(1, Math.abs(b) * tolPct);
  if (!ok) problems++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${fmt(a)} vs ${fmt(b)}${ok ? '' : `  (diff ${fmt(a - b)})`}`);
}
for (const acct of Object.keys(raw)) {
  const A = mdl.accounts[acct];
  if (!A) { console.log('no account doc', acct); continue; }
  console.log(`\n== ${acct} == daily rows ${Object.keys(A.daily).length}, reach windows ${Object.keys(A.reach).length}`);
  // monthly windows from reach_month vs sum of daily rows
  const monthRows = (raw[acct].reach_month || []).flatMap(p => C.rowsOf(p));
  for (const r of monthRows) {
    const s = r.date_start, e = r.date_stop;
    const t = C.totals(mdl, [acct], s, e);
    const tol = s.slice(0, 7) === today.slice(0, 7) ? 0.01 : 0.0001; // today's figures still move during the day
    check(`daily spend ${s.slice(0, 7)}`, t.spend, C.num(r.amount_spent), tol);
    check(`daily impr  ${s.slice(0, 7)}`, t.impr, C.num(r.impressions), tol);
  }
  const allRow = (raw[acct].reach_all || []).flatMap(p => C.rowsOf(p))[0];
  if (allRow) {
    const total = C.num(allRow.amount_spent);
    const camps = Object.values(mdl.campaigns).filter(c => c.acct === acct);
    check('campaigns lifetime spend vs account', camps.reduce((s, c) => s + (c.m ? c.m[MI.spend] : 0), 0), total, 0.002);
    const cm = camps.reduce((s, c) => s + Object.values(c.monthly || {}).reduce((x, v) => x + v[MI.spend], 0), 0);
    check('campaign-month spend vs account', cm, total, 0.002);
    const ads = Object.values(mdl.ads).filter(a => a.acct === acct);
    if (ads.length) check(`ads spend (${ads.length} ads) vs account`, ads.reduce((s, a) => s + a.m[MI.spend], 0), total, 0.002);
    for (const [dim, b] of Object.entries(mdl.bd)) {
      const rows = b.rows.filter(r => r[0] === acct);
      if (!rows.length) continue;
      const si = 2 + b.keys.length; // [acct, campId, ...keys, spend...]
      check(`breakdown ${dim} spend (${rows.length} rows) vs account`, rows.reduce((s, r) => s + r[si], 0), total, 0.01);
    }
    const crs = new Set(ads.map(a => a.cr).filter(Boolean));
    const have = [...crs].filter(id => mdl.creatives[id]).length;
    console.log(`creatives: ${have}/${crs.size} ad creatives have text`);
  }
  const cd = mdl.campd[acct];
  if (cd && cd.since) {
    const days = Object.keys(A.daily).filter(d => d >= cd.since && d < today);
    const accSpend = days.reduce((s, d) => s + A.daily[d][MI.spend], 0);
    const cdSpend = Object.values(cd.rows).reduce((s, byDay) => s + Object.entries(byDay).filter(([d]) => d >= cd.since && d < today).reduce((x, [, v]) => x + v[MI.spend], 0), 0);
    check(`campaign-day spend since ${cd.since} vs account daily`, cdSpend, accSpend, 0.002);
  }
  const lead = Object.values(A.daily).reduce((s, v) => s + v[MI.lead], 0), mlead = Object.values(A.daily).reduce((s, v) => s + v[MI.mlead], 0);
  console.log(`leads (lead field) ${lead}, Meta leads ${mlead}`);
}
console.log(`\n${problems ? problems + ' CHECK(S) FAILED' : 'ALL CHECKS PASSED'}`);
process.exitCode = problems ? 2 : 0;
