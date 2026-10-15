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
