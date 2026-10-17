// themes.mjs — performance by content theme (and theme x segment) from reviewed labels.
// usage: node themes.mjs <core.js> <docsDir> <labels.json> <out.json>
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [corePath, docsDir, labelsPath, outFile] = process.argv.slice(2);
const C = require(path.resolve(corePath));
const docs = {};
for (const f of fs.readdirSync(docsDir).filter(f => f.endsWith('.json'))) docs[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
docs.labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
for (const [id, d] of Object.entries(docs)) if (d && d.acct && !C.ACCOUNTS.some(a => a.id === String(d.acct))) delete docs[id]; // chỉ hai tài khoản đang kết nối
const mdl = C.model(docs);
const r0 = x => x == null || !isFinite(x) ? null : Math.round(x), r2 = x => x == null || !isFinite(x) ? null : Math.round(x * 10000) / 100;
const K = o => ({ spend: r0(o.spend), leads: o.leads, cpl: r0(o.cpl), impr: r0(o.impr), ctr_pct: r2(o.ctr), cpc: r0(o.cpc), engagements: r0(o.eng), eng_rate_pct: r2(o.engRate), cost_per_eng: r0(o.cpe), cpm: r0(o.cpm), views: r0(o.views), video_plays: r0(o.vplay), video_complete_pct: r2(o.hold), thruplay: r0(o.thru), cost_per_thruplay: r0(o.cpThru), reactions: r0(o.react), comments: r0(o.cmt), saves: r0(o.save) });
const by = {}, bySeg = {}, unl = [];
for (const a of Object.values(mdl.ads)) {
  if (!(a.m[C.MI.spend] > 0)) continue;
  const t = a.theme || 'Chưa phân loại'; if (!a.theme) unl.push(a.id);
  const lead = C.isLeadCampaign(mdl.campaigns[a.cid] || a); // chi phí/lead chỉ tính quảng cáo của chiến dịch thu lead
  (by[t] ||= { n: 0, v: C.zero(), lv: C.zero() }).n++; C.addInto(by[t].v, a.m); if (lead) C.addInto(by[t].lv, a.m);
  const k = t + ' || ' + C.segLabel(a.seg); (bySeg[k] ||= { n: 0, v: C.zero(), lv: C.zero() }).n++; C.addInto(bySeg[k].v, a.m); if (lead) C.addInto(bySeg[k].lv, a.m);
}
const fmt = o => Object.fromEntries(Object.entries(o).map(([k, x]) => { const v = C.vecObj(x.v), L = C.vecObj(x.lv); v.cpl = L.leads ? L.spend / L.leads : null; return [k, { ads: x.n, ...K(v) }]; }).sort((a, b) => b[1].spend - a[1].spend));
const segChanged = Object.entries(docs.labels.seg || {}).map(([cid, s]) => { const c = mdl.campaigns[cid]; return c ? { campaign: c.n, rule: C.segmentOf(c.n, mdl.roles[c.acct]), label: s } : null; }).filter(Boolean);
fs.writeFileSync(outFile, JSON.stringify({ by_theme: fmt(by), by_theme_segment: fmt(bySeg), unlabeled_ads: unl, segment_overrides: segChanged }, null, 1));
console.log('themes', Object.keys(by).length, 'unlabeled', unl.length);
