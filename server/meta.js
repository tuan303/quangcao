// Meta Marketing API (Graph) → payload cùng dạng với connector "Facebook Ads" của Claude ({ad_entities: [...]}),
// để fbads-core.normalize() xử lý y hệt dữ liệu Claude đã kiểm chứng.
// Cần META_ACCESS_TOKEN: token System User (quyền ads_read) được gán vào các tài khoản quảng cáo.
const VERSION = (process.env.META_API_VERSION || 'v23.0').trim();
const BASE = 'https://graph.facebook.com/' + VERSION + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004]);

export function metaError(e, status) {
  const m = (e && e.message) || ('HTTP ' + status);
  const hint = e && (e.code === 190 ? ' (token hết hạn hoặc không hợp lệ: tạo lại token System User rồi cập nhật META_ACCESS_TOKEN)'
    : e.code === 200 || e.code === 10 ? ' (token chưa được cấp quyền ads_read cho tài khoản quảng cáo này)' : '');
  return Object.assign(new Error('Meta API: ' + m + (hint || '')), { meta: e, status, expose: true });
}

async function graph(pathOrUrl, params, token) {
  const url = /^https?:/.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(BASE + pathOrUrl);
  if (!/^https?:/.test(pathOrUrl)) for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.delete('access_token');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const j = await res.json().catch(() => ({}));
    if (res.ok && !j.error) return j;
    const e = j.error || {};
    if (attempt < 2 && (RETRY_CODES.has(e.code) || res.status >= 500)) { await sleep(1200 * (attempt + 1) + Math.random() * 500); continue; }
    throw metaError(e, res.status);
  }
}
async function allPages(path, params, token, maxPages = 40) {
  let j = await graph(path, params, token), out = (j.data || []).slice(), n = 1;
  while (j.paging && j.paging.next && n < maxPages) { j = await graph(j.paging.next, null, token); out = out.concat(j.data || []); n++; }
  return out;
}

// ---- insights ----
const INSIGHT_FIELDS = ['date_start', 'date_stop', 'account_id', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name', 'objective',
  'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'unique_inline_link_clicks', 'actions', 'video_play_actions',
  'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions',
  'outbound_clicks', 'results', 'views'];
const unsupported = new Set(); // các trường Graph từ chối (#100) – bỏ đi và thử lại, nhớ cho các lần gọi sau

async function insights(acct, q, token) {
  const level = q.level === 'ad_account' || q.level === 'account' ? 'account' : q.level;
  const params = { level, time_range: q.time_range, limit: 500 };
  if (q.time_increment) params.time_increment = String(q.time_increment);
  if (q.breakdowns && q.breakdowns.length) params.breakdowns = q.breakdowns.join(',');
  const filtering = (q.filtering || []).map(f => {
    if (f.field === 'effective_status') return { field: (level === 'ad' ? 'ad' : 'campaign') + '.effective_status', operator: f.operator, value: f.value };
    if (f.field === 'amount_spent') return { field: 'spend', operator: f.operator, value: Number(f.value[0]) };
    return f;
  }).filter(f => !(level === 'account' && /effective_status/.test(f.field)));
  if (filtering.length) params.filtering = filtering;
  for (let tries = 0; tries < 4; tries++) {
    params.fields = INSIGHT_FIELDS.filter(f => !unsupported.has(f)).join(',');
    try { return await allPages('act_' + acct + '/insights', params, token); }
    catch (e) {
      const msg = String(e.meta && e.meta.message || '');
      const bad = INSIGHT_FIELDS.find(f => !unsupported.has(f) && e.meta && e.meta.code === 100 && new RegExp('\\b' + f + '\\b').test(msg));
      if (bad && ['results', 'views', 'unique_inline_link_clicks', 'frequency', 'reach', 'objective'].includes(bad)) { unsupported.add(bad); continue; }
      throw e;
    }
  }
  throw new Error('Meta API: không lấy được insights');
}

const act = (arr, type) => { if (!Array.isArray(arr)) return null; let t = 0, hit = false; for (const a of arr) if (!type || a.action_type === type) { t += Number(a.value) || 0; hit = true; } return hit ? String(t) : null; };
function resultsOf(r) {
  const v = r.results;
  if (!v) return null;
  const items = Array.isArray(v) ? v : [v];
  let t = 0;
  for (const it of items) { if (Array.isArray(it && it.values)) for (const x of it.values) t += Number(x && x.value) || 0; else t += Number(it && it.value) || 0; }
  return { values: [{ value: String(t) }] };
}
/** Một dòng Graph → một dòng cùng tên trường như connector (amount_spent, link_click, lead, …). */
export function mapRow(r, level) {
  const id = level === 'campaign' ? r.campaign_id : level === 'ad' ? r.ad_id : r.account_id;
  const name = level === 'campaign' ? r.campaign_name : level === 'ad' ? r.ad_name : r.account_id;
  const o = {
    id, name, date_start: r.date_start, date_stop: r.date_stop,
    amount_spent: { value: r.spend || '0', unit: 'VND' }, impressions: r.impressions, reach: r.reach, frequency: r.frequency, clicks: r.clicks,
    link_click: act(r.actions, 'link_click') ?? r.inline_link_clicks ?? null, unique_link_click: r.unique_inline_link_clicks ?? null,
    lead: act(r.actions, 'lead'), onsite_conversion_lead_grouped: act(r.actions, 'onsite_conversion.lead_grouped'),
    results: resultsOf(r), media_views: r.views ?? r.impressions ?? null,
    video_play_actions: act(r.video_play_actions), video_thruplay_watched_actions: act(r.video_thruplay_watched_actions),
    video_p25_watched_actions: act(r.video_p25_watched_actions), video_p50_watched_actions: act(r.video_p50_watched_actions),
    video_p75_watched_actions: act(r.video_p75_watched_actions), video_p100_watched_actions: act(r.video_p100_watched_actions),
    post_engagement: act(r.actions, 'post_engagement'), post_reaction: act(r.actions, 'post_reaction'), comment: act(r.actions, 'comment'),
    post_save: act(r.actions, 'onsite_conversion.post_save'), post_shares: act(r.actions, 'post'),
    landing_page_view: act(r.actions, 'landing_page_view'), outbound_clicks: act(r.outbound_clicks)
  };
  if (level === 'ad') Object.assign(o, { campaign_id: r.campaign_id, campaign_name: r.campaign_name, adset_id: r.adset_id, adset_name: r.adset_name });
  for (const k of ['age', 'gender', 'region', 'publisher_platform', 'platform_position', 'device_platform']) if (r[k] != null) o[k] = r[k];
  return o;
}

const ALL_STATUS = ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'];
async function campaignAttrs(acct, token) {
  const rows = await allPages('act_' + acct + '/campaigns', { fields: 'id,name,objective,effective_status,start_time,stop_time,created_time,daily_budget,lifetime_budget', filtering: [{ field: 'effective_status', operator: 'IN', value: ALL_STATUS }], limit: 500 }, token);
  return Object.fromEntries(rows.map(c => [c.id, c]));
}
async function adAttrs(acct, token) {
  const rows = await allPages('act_' + acct + '/ads', { fields: 'id,name,campaign_id,adset{name},creative{id},effective_status,created_time', filtering: [{ field: 'effective_status', operator: 'IN', value: ALL_STATUS.concat(['CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'DISAPPROVED', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO']) }], limit: 500 }, token);
  return Object.fromEntries(rows.map(a => [a.id, a]));
}

/** Thực hiện một lời gọi trong kế hoạch của fbads-core.plan() và trả payload dạng connector. */
export async function runCall(call, token, cache = {}) {
  const q = call.args, level = q.level === 'ad_account' ? 'account' : q.level;
  const rows = (await insights(call.acct, q, token)).map(r => mapRow(r, level));
  if (call.name === 'camps') {
    const attrs = cache['c' + call.acct] ||= await campaignAttrs(call.acct, token);
    for (const r of rows) { const a = attrs[r.id] || {}; Object.assign(r, { objective: a.objective || '', effective_status: a.effective_status || '', start_time: a.start_time || '', stop_time: a.stop_time || '', created_time: a.created_time || '', daily_budget: a.daily_budget || null, lifetime_budget: a.lifetime_budget || null }); }
  }
  if (call.name === 'ads') {
    const attrs = cache['a' + call.acct] ||= await adAttrs(call.acct, token);
    const cattrs = cache['c' + call.acct] ||= await campaignAttrs(call.acct, token);
    for (const r of rows) { const a = attrs[r.id] || {}; Object.assign(r, { creative_id: a.creative && a.creative.id || '', effective_status: a.effective_status || '', created_time: a.created_time || '', adset_name: r.adset_name || (a.adset && a.adset.name) || '', objective: (cattrs[r.campaign_id] || {}).objective || '' }); }
  }
  return { ad_entities: rows };
}
export async function runCreatives(ids, token) {
  const fields = 'id,name,object_type,body,title,description,call_to_action_type,link_url,video_id,effective_object_story_id,object_story_id';
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await graph('', { ids: ids.slice(i, i + 50).join(','), fields }, token);
    for (const k of Object.keys(j)) if (j[k] && j[k].id) out.push(j[k]);
  }
  return { ad_creatives: out };
}
