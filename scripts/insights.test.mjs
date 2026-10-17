// Kiểm thử offline cho phần Phân tích tự động: gói số liệu, schema đầu ra, kiểm tra kết quả, so sánh mặt bằng ngành.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../fbads-core.js';
import '../benchmarks.js';
import { buildPack } from '../server/pack.js';
import { outputSchema, validate } from '../server/insights-ai.js';
import schemaJs from '../server/insights-schema.js';
import { mapRow } from '../server/meta.js';
const C = globalThis.FBCore, B = globalThis.FBBench;
const acts = o => Object.entries(o).map(([action_type, value]) => ({ action_type, value: String(value) }));

function sampleDocs() {
  const daily = [], camps = [], campd = [];
  for (let i = 0; i < 70; i++) {
    const d = C.dates.addDays('2026-10-14', -i);
    daily.push(mapRow({ account_id: '895057262833914', date_start: d, date_stop: d, spend: '500000', impressions: '10000', reach: '8000', clicks: '400', inline_link_clicks: '150', actions: acts({ lead: 5, 'onsite_conversion.lead_grouped': 5, link_click: 150 }) }, 'account'));
  }
  // the lead campaign, day by day for the last 40 days: 400.000 ₫, 8.000 impressions, 320 clicks, 120 link clicks, 4 leads a day
  for (let i = 0; i < 40; i++) {
    const d = C.dates.addDays('2026-10-14', -i);
    campd.push(mapRow({ campaign_id: 'c1', campaign_name: 'JS26-LEAD | Form', date_start: d, date_stop: d, spend: '400000', impressions: '8000', clicks: '320', inline_link_clicks: '120', actions: acts({ lead: 4, link_click: 120 }) }, 'campaign'));
  }
  camps.push(Object.assign(mapRow({ campaign_id: 'c1', campaign_name: 'JS26-LEAD | Form', spend: '35000000', impressions: '700000', clicks: '28000', inline_link_clicks: '10500', actions: acts({ lead: 350, link_click: 10500 }), date_start: '2025-03-01', date_stop: '2026-10-14' }, 'campaign'), { objective: 'OUTCOME_LEADS', effective_status: 'ACTIVE' }));
  const docs = C.normalize({ '895057262833914': { daily_w1: [{ ad_entities: daily }], camps: [{ ad_entities: camps }], campd__h2: [{ ad_entities: campd }] } }, { windows: {} });
  docs.meta = { dataUntil: '2026-10-14', accounts: C.ACCOUNTS, perAccount: { '1870132100153072': { failed: 1, skipped: 0 } } };
  return docs;
}

test('the JS schema copy matches tools/insights.schema.json', () => {
  assert.deepEqual(schemaJs, JSON.parse(fs.readFileSync(new URL('../tools/insights.schema.json', import.meta.url), 'utf8')));
});

test('output schema: strict objects, no unsupported constraints, server fields left out, benchmark added', () => {
  const s = outputSchema(), txt = JSON.stringify(s);
  assert.equal(s.additionalProperties, false);
  for (const k of ['minItems', 'maxItems', 'minimum', 'maximum']) assert.ok(!txt.includes('"' + k + '"'), k);
  for (const k of ['v', 'updatedAt', 'updatedLabel', 'dataUntil']) assert.ok(!(k in s.properties) && !s.required.includes(k), k);
  assert.ok(s.required.includes('benchmark'));
  const walk = o => { if (o && typeof o === 'object') { if (o.type === 'object') assert.equal(o.additionalProperties, false); Object.values(o).forEach(walk); } };
  walk(s);
});

test('pack: periods, campaigns and missing accounts are computed from stored docs', () => {
  const p = buildPack(C, sampleDocs(), '2026-10-15');
  assert.equal(p.periods.last30d.leads, 150); // 30 days × 5
  assert.equal(p.periods.last30d.spend, 15000000);
  assert.equal(p.periods.last7d.leads, 35);
  assert.deepEqual(p.sync.accounts_missing, ['1870132100153072']);
  assert.equal(p.campaigns[0].name, 'JS26-LEAD | Form');
  assert.ok(JSON.stringify(p).length < 400000);
});

test('validate catches wrong item counts and a budget split that does not add up', () => {
  const ok = { headline: 'x', summary: 'y', highlights: [1, 2, 3, 4], evaluations: [1, 2, 3, 4, 5, 6], recommendations: [1, 2, 3, 4, 5, 6], pillars: [1, 2, 3, 4, 5], calendar: [1, 2, 3, 4], tests: [1, 2, 3], audience: [1, 2, 3, 4], targets: [1, 2, 3, 4], method: [1, 2, 3], budget: { split: [{ pct: 60 }, { pct: 40 }] } };
  assert.deepEqual(validate(ok), []);
  const bad = Object.assign({}, ok, { highlights: [1, 2, 3], budget: { split: [{ pct: 60 }, { pct: 20 }] } });
  const errs = validate(bad);
  assert.ok(errs.some(e => e.startsWith('highlights')) && errs.some(e => e.startsWith('budget')));
});

test('benchmark compare: lead metrics use lead campaigns only, verdict follows the better direction', () => {
  const saved = B.ITEMS.splice(0);
  B.ITEMS.push({ metric: 'cpl', low: 80000, high: 150000, scope: 'test', source: 'test' }, { metric: 'ctr', low: 1, high: 2, scope: 'test', source: 'test' }, { metric: 'cpm', low: 10000, high: 20000, scope: 'test', source: 'test' });
  try {
    const docs = sampleDocs(), mdl = C.model(docs);
    const r = B.compare(C, mdl, '2026-10-15', { since: '2026-09-15', until: '2026-10-14', accts: ['895057262833914'] });
    const by = Object.fromEntries(r.rows.map(x => [x.metric, x]));
    assert.equal(r.leadCampaigns, 1);
    assert.equal(by.cpl.school, 100000);       // 30 days × 400.000 ₫ / 30 days × 4 leads – lead campaign only
    assert.equal(by.cpl.verdict, 'within');    // 80.000–150.000 ₫
    assert.equal(by.ctr.school, 4);            // account-wide: 400 clicks / 10.000 impressions
    assert.equal(by.ctr.verdict, 'better');    // higher than 1–2 %
    assert.equal(by.cpm.school, 50000);        // 500.000 ₫ / 10 thousand impressions
    assert.equal(by.cpm.verdict, 'worse');     // above 10.000–20.000 ₫
  } finally { B.ITEMS.splice(0, B.ITEMS.length, ...saved); }
});

test('benchmark compare: no lead-campaign data means lead metrics stay empty, never a guessed verdict', () => {
  const saved = B.ITEMS.splice(0);
  B.ITEMS.push({ metric: 'cpl', low: 80000, high: 150000, scope: 'test', source: 'test' });
  try {
    const docs = sampleDocs();
    delete docs['campd-895057262833914'];
    const r = B.compare(C, C.model(docs), '2026-10-15', { since: '2026-09-15', until: '2026-10-14', accts: ['895057262833914'] });
    assert.equal(r.rows[0].school, null);
    assert.equal(r.rows[0].verdict, null);
  } finally { B.ITEMS.splice(0, B.ITEMS.length, ...saved); }
});

test('benchmarks.js: every reference range is complete, sourced and in the right direction', () => {
  assert.ok(B.ITEMS.length > 0);
  for (const b of B.ITEMS) {
    assert.ok(B.METRICS[b.metric], b.metric);
    assert.ok(b.scope && b.source && /^https:\/\//.test(b.url) && b.period, b.metric + ' ' + b.source);
    assert.ok(b.low != null && b.high != null && b.low <= b.high, b.metric + ' range');
    assert.equal(b.market, 'vn', b.metric + ': nhà trường chỉ so với ngành giáo dục tại Việt Nam');
    if (B.METRICS[b.metric].unit === '%') assert.ok(b.high < 100, b.metric + ' is in percent, not a fraction');
  }
  const m = B.META;
  assert.ok(m.since <= m.until && m.until <= m.asOf && m.rows.every(r => B.METRICS[r.metric] && typeof r.rel === 'number'));
});

test('only the two connected ad accounts are used; cost per lead counts lead campaigns only', async () => {
  assert.deepEqual(C.ACCOUNTS.map(a => a.id), ['895057262833914', '1870132100153072']);
  const { scopeDocs, syncAccounts } = await import('../server/scope.js');
  const docs = { 'acct-163604412431952': { acct: '163604412431952', daily: {} }, 'acct-895057262833914': { acct: '895057262833914', daily: {} }, 'crea-x': { rows: [] },
    meta: { accounts: [{ id: '163604412431952' }], perAccount: { '163604412431952': { failed: 1 }, '895057262833914': { ok: 1 } }, failed: ['163604412431952|daily_w1'], leadLoss: ['163604412431952'] } };
  const s = scopeDocs(C, docs);
  assert.ok(!s['acct-163604412431952'] && s['acct-895057262833914'] && s['crea-x']);
  assert.deepEqual(Object.keys(s.meta.perAccount), ['895057262833914']);
  assert.deepEqual(s.meta.failed, []); assert.deepEqual(s.meta.leadLoss, []);
  assert.deepEqual(s.meta.accounts.map(a => a.id), C.ACCOUNTS.map(a => a.id));
  assert.deepEqual(syncAccounts(C, { META_AD_ACCOUNTS: 'act_163604412431952, 1870132100153072' }), { accts: ['1870132100153072'], ignored: ['163604412431952'] });
  assert.deepEqual(syncAccounts(C, {}).accts, C.ACCOUNTS.map(a => a.id));
  // brand spend is reported apart and does not enter the cost per lead
  const day = '2026-10-10', vec = (spend, lead) => { const v = C.zero(); v[C.MI.spend] = spend; v[C.MI.lead] = lead; v[C.MI.impr] = 1000; return v; };
  const A = '895057262833914';
  const m = C.model({
    ['acct-' + A]: { acct: A, daily: { [day]: (() => { const v = vec(1500000, 10); return v; })() } },
    ['camp-' + A]: { acct: A, rows: { L: { n: 'TS1-LEAD', obj: 'OUTCOME_LEADS', m: vec(1000000, 10) }, B: { n: 'Thương hiệu', obj: 'OUTCOME_AWARENESS', m: vec(500000, 0) } }, monthly: {} },
    ['campd-' + A]: { acct: A, since: '2026-09-01', rows: { L: { [day]: vec(1000000, 10) }, B: { [day]: vec(500000, 0) } } }
  });
  const t = C.totals(m, [A], day, day);
  assert.equal(t.spend, 1500000); assert.equal(t.leads, 10);
  assert.equal(t.cpl, 100000);        // 1.000.000 ₫ of the lead campaign / 10 leads
  assert.equal(t.cplAll, 150000);     // what the old formula showed
  assert.equal(t.otherSpend, 500000); assert.equal(t.cplBasis, 'lead');
  assert.equal(C.series(m, [A], day, day, 'day')[0].cpl, 100000);
});

test('cost per lead: only lead-objective campaigns count, missing campaign data falls back, partial months are prorated', () => {
  const A = '895057262833914', vec = (spend, lead, impr = 1000) => { const v = C.zero(); v[C.MI.spend] = spend; v[C.MI.lead] = lead; v[C.MI.impr] = impr; return v; };
  const days = ['2026-10-09', '2026-10-10'], daily = {}, campd = { L: {}, M: {}, B: {} };
  for (const d of days) { daily[d] = vec(1800000, 14); campd.L[d] = vec(1000000, 10); campd.M[d] = vec(300000, 4); campd.B[d] = vec(500000, 0); }
  const docs = {
    ['acct-' + A]: { acct: A, daily },
    ['camp-' + A]: { acct: A, rows: { L: { n: 'TS1-LEAD', obj: 'OUTCOME_LEADS', m: vec(2000000, 20) }, M: { n: 'Tin nhắn tư vấn', obj: 'OUTCOME_ENGAGEMENT', m: vec(600000, 8) }, B: { n: 'Thương hiệu', obj: 'OUTCOME_AWARENESS', m: vec(1000000, 0) } }, monthly: {} },
    ['campd-' + A]: { acct: A, since: '2026-09-01', rows: campd }
  };
  const t = C.totals(C.model(docs), [A], days[0], days[1]);
  assert.equal(t.leads, 28); assert.equal(t.lcLeads, 20); assert.equal(t.lcSpend, 2000000); // the Messenger (engagement) campaign is apart, its leads stay in the total
  assert.equal(t.otherSpend, 1600000); assert.equal(t.cpl, 100000); assert.equal(Math.round(t.cplAll), Math.round(3600000 / 28));
  // series buckets add up to the window
  const ser = C.series(C.model(docs), [A], days[0], days[1], 'day');
  assert.equal(ser.reduce((s, r) => s + r.lcSpend, 0), t.lcSpend); assert.equal(ser.reduce((s, r) => s + r.otherSpend, 0), t.otherSpend);
  // campaign rows missing for a day the account spent → that day is not split, it is labelled
  delete campd.L[days[1]]; delete campd.M[days[1]]; delete campd.B[days[1]];
  const d1 = C.totals(C.model(docs), [A], days[1], days[1]);
  assert.equal(d1.cplBasis, 'all'); assert.equal(d1.cpl, d1.cplAll); assert.equal(d1.otherSpend, null);
  // before the campaign-daily rows: a partial month is prorated by the account's daily spend, not counted whole
  const m = C.model({
    ['acct-' + A]: { acct: A, daily: { '2026-03-01': vec(100, 0), '2026-03-02': vec(300, 0) } },
    ['camp-' + A]: { acct: A, rows: { L: { n: 'TS1-LEAD', obj: 'OUTCOME_LEADS', m: vec(400, 4) } }, monthly: { L: { '2026-03': vec(400, 4) } } },
    ['campd-' + A]: { acct: A, since: '2026-09-01', rows: {} }
  });
  const pv = C.periodVec(m, m.campaigns.L, '2026-03-02', '2026-03-02');
  assert.equal(pv.v[C.MI.spend], 300); assert.equal(pv.v[C.MI.lead], 3); assert.equal(pv.approx, true);
});
