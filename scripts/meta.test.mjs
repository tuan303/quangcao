// Kiểm thử offline: Graph API (giả lập) → server/meta.js → fbads-core.normalize()
import test from 'node:test';
import assert from 'node:assert/strict';
import '../fbads-core.js';
import { runCall, runCreatives, mapRow } from '../server/meta.js';
const C = globalThis.FBCore;

function fakeGraph(routes) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url); seen.push(u);
    assert.equal(opts.headers.Authorization, 'Bearer TEST');
    for (const r of routes) { const out = r(u); if (out) return { ok: !out.error, status: out.error ? 400 : 200, json: async () => out }; }
    throw new Error('no route for ' + u.pathname + u.search);
  };
  return seen;
}
const acts = o => Object.entries(o).map(([action_type, value]) => ({ action_type, value: String(value) }));

test('daily account insights: paging, actions mapping, dropped unsupported field', async () => {
  let first = true;
  const seen = fakeGraph([
    u => u.pathname.endsWith('/act_111/insights') && u.searchParams.get('after') !== 'P2' && (first ? (first = false, { error: { code: 100, message: '(#100) results is not valid for fields param' } }) : {
      data: [{ date_start: '2026-10-01', date_stop: '2026-10-01', account_id: '111', spend: '1000', impressions: '100', reach: '80', clicks: '10', inline_link_clicks: '4',
        actions: acts({ link_click: 5, lead: 2, 'onsite_conversion.lead_grouped': 2, post_engagement: 30, post_reaction: 3, comment: 1, 'onsite_conversion.post_save': 1, post: 2, landing_page_view: 1 }),
        video_play_actions: acts({ video_view: 50 }), video_p100_watched_actions: acts({ video_view: 5 }) }],
      paging: { next: 'https://graph.facebook.com/v23.0/act_111/insights?after=P2' } }),
    u => u.searchParams.get('after') === 'P2' && { data: [{ date_start: '2026-10-02', date_stop: '2026-10-02', account_id: '111', spend: '500', impressions: '50', reach: '40', clicks: '5' }] }
  ]);
  const call = C.plan('2026-10-03', { mode: 'quick', accounts: ['111'] }).find(c => c.name.startsWith('daily'));
  const payload = await runCall(call, 'TEST');
  assert.equal(payload.ad_entities.length, 2);
  const q = seen[1];
  assert.equal(q.searchParams.get('level'), 'account');
  assert.equal(q.searchParams.get('time_increment'), '1');
  assert.ok(!q.searchParams.get('fields').split(',').includes('results'), 'results dropped after #100');
  const docs = C.normalize({ 111: { [call.name]: [payload] } }, { windows: C.windowsOf([call]) });
  const d1 = docs['acct-111'].daily['2026-10-01'];
  const g = k => d1[C.MI[k]];
  assert.equal(g('spend'), 1000); assert.equal(g('link'), 5); assert.equal(g('lead'), 2); assert.equal(g('mlead'), 2);
  assert.equal(g('eng'), 30); assert.equal(g('react'), 3); assert.equal(g('cmt'), 1); assert.equal(g('save'), 1); assert.equal(g('share'), 2);
  assert.equal(g('vplay'), 50); assert.equal(g('p100'), 5); assert.equal(g('views'), 100, 'views fall back to impressions');
  assert.equal(docs['acct-111'].daily['2026-10-02'][C.MI.spend], 500);
});

test('campaign rows get status/objective; filters are translated', async () => {
  const seen = fakeGraph([
    u => u.pathname.endsWith('/act_111/insights') && { data: [{ campaign_id: 'c1', campaign_name: 'LEAD PH TS1', spend: '2000', impressions: '200', clicks: '20', actions: acts({ lead: 4 }), results: [{ indicator: 'actions:lead', values: [{ value: '4' }] }], date_start: '2025-03-01', date_stop: '2026-10-03' }] },
    u => u.pathname.endsWith('/act_111/campaigns') && { data: [{ id: 'c1', name: 'LEAD PH TS1', objective: 'OUTCOME_LEADS', effective_status: 'ARCHIVED', start_time: '2026-01-02T10:00:00+0700', created_time: '2026-01-01T10:00:00+0700', daily_budget: '300000' }] }
  ]);
  const call = C.plan('2026-10-03', { mode: 'quick', accounts: ['111'] }).find(c => c.name === 'camps');
  const payload = await runCall(call, 'TEST', {});
  const f = JSON.parse(seen[0].searchParams.get('filtering'));
  assert.equal(f[0].field, 'campaign.effective_status');
  const docs = C.normalize({ 111: { camps: [payload] } });
  const c = docs['camp-111'].rows.c1;
  assert.equal(c.obj, 'OUTCOME_LEADS'); assert.equal(c.st, 'ARCHIVED'); assert.equal(c.s, '2026-01-02'); assert.equal(c.db, 300000);
  assert.equal(c.m[C.MI.results], 4); assert.equal(c.m[C.MI.lead], 4);
  const mdl = C.model(docs); assert.equal(mdl.campaigns.c1.seg, 'l1');
});

test('campaign x day spend filter and ad rows with creative ids; creatives by ids', async () => {
  const seen = fakeGraph([
    u => u.pathname.endsWith('/act_111/insights') && u.searchParams.get('level') === 'campaign' && { data: [] },
    u => u.pathname.endsWith('/act_111/insights') && u.searchParams.get('level') === 'ad' && { data: [{ ad_id: 'a1', ad_name: 'Ad 1', campaign_id: 'c1', campaign_name: 'JS26-LEAD', adset_id: 's1', adset_name: 'Set', spend: '700', impressions: '70', clicks: '7', date_start: '2025-03-01', date_stop: '2026-10-03' }] },
    u => u.pathname.endsWith('/act_111/ads') && { data: [{ id: 'a1', creative: { id: 'cr1' }, effective_status: 'ACTIVE', created_time: '2026-09-22T10:00:00+0700', adset: { name: 'Set' } }] },
    u => u.pathname.endsWith('/act_111/campaigns') && { data: [{ id: 'c1', objective: 'OUTCOME_LEADS' }] },
    u => u.searchParams.get('ids') && { cr1: { id: 'cr1', title: 'Jolly Steps 2026', body: 'Cha mẹ có con sinh năm 2021…' } }
  ]);
  const plan = C.plan('2026-10-03', { mode: 'full', accounts: ['111'] });
  const cd = plan.find(c => c.name === 'campd__h2');
  await runCall(cd, 'TEST');
  const spentFilter = JSON.parse(seen[0].searchParams.get('filtering')).find(x => x.field === 'spend');
  assert.deepEqual(spentFilter, { field: 'spend', operator: 'GREATER_THAN', value: 0 });
  const ads = await runCall(plan.find(c => c.name === 'ads'), 'TEST', {});
  assert.equal(ads.ad_entities[0].creative_id, 'cr1');
  const cr = await runCreatives(['cr1'], 'TEST');
  const docs = C.normalize({ 111: { ads: [ads], creatives_c1: [cr] } });
  const mdl = C.model(docs);
  assert.equal(mdl.ads.a1.cr, 'cr1'); assert.equal(mdl.creatives.cr1.t, 'Jolly Steps 2026'); assert.equal(mdl.ads.a1.seg, 'js');
});

test('mapRow keeps breakdown keys', () => {
  const r = mapRow({ campaign_id: 'c', spend: '5', age: '25-34', gender: 'female', publisher_platform: 'facebook', platform_position: 'feed' }, 'campaign');
  assert.equal(r.age, '25-34'); assert.equal(r.platform_position, 'feed'); assert.equal(r.amount_spent.value, '5');
});
