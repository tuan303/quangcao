// Meta Marketing API (Graph) → payload cùng dạng với connector "Facebook Ads" của Claude ({ad_entities: [...]}),
// để fbads-core.normalize() xử lý y hệt dữ liệu Claude đã kiểm chứng.
// Cần META_ACCESS_TOKEN: token System User (quyền ads_read) được gán vào các tài khoản quảng cáo.
const VERSION = (process.env.META_API_VERSION || 'v25.0').trim(); // v23.0 hết hạn cho Marketing API từ 09/06/2026
const BASE = 'https://graph.facebook.com/' + VERSION + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80003, 80004]);

export function metaError(e, status) {
  const m = (e && e.message) || ('HTTP ' + status);
  const hint = e && (e.code === 190 ? ' (token hết hạn hoặc không hợp lệ: tạo lại token System User rồi cập nhật META_ACCESS_TOKEN)'
    : e.code === 200 || e.code === 10 ? ' (token chưa được cấp quyền ads_read cho tài khoản quảng cáo này)'
    : e.code === 100 && e.error_subcode === 33 ? ' (người dùng hệ thống chưa được chỉ định tài khoản quảng cáo này, hoặc sai ID tài khoản)' : '');
  return Object.assign(new Error('Meta API: ' + m + (hint || '')), { meta: e, status, expose: true });
}

// Hạn chót chung của cả lần đồng bộ (api/sync.js đặt): mọi yêu cầu, kể cả đang chạy dở, dừng trước mốc này để còn thời gian ghi.
let deadlineAt = 0;
export function setDeadline(ts) { deadlineAt = ts || 0; }
const timeoutError = why => Object.assign(new Error('Meta API: ' + why), { status: 504, expose: true, meta: { code: 'timeout' } });

async function graph(pathOrUrl, params, token) {
  const url = /^https?:/.test(pathOrUrl) ? new URL(pathOrUrl) : new URL(BASE + pathOrUrl);
  if (!/^https?:/.test(pathOrUrl)) for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  url.searchParams.delete('access_token');
  for (let attempt = 0; ; attempt++) {
    const left = deadlineAt ? deadlineAt - Date.now() : 20000;
    if (left < 1500) throw timeoutError('hết thời gian của lần đồng bộ này');
    let res, j;
    try {
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(Math.min(20000, left)) });
      const text = await res.text(); // đọc hết thân phản hồi trong cùng giới hạn thời gian
      try { j = text ? JSON.parse(text) : {}; } catch { j = null; }
    } catch (e) {
      // hết giờ hoặc mất kết nối: thử lại nếu còn thời gian, nếu không thì báo lỗi (không bao giờ coi là thành công rỗng)
      if (attempt < 2 && (!deadlineAt || deadlineAt - Date.now() > 5000)) { await sleep(800 * (attempt + 1)); continue; }
      throw timeoutError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'hết thời gian chờ phản hồi' : 'mất kết nối (' + String(e && e.message || e).slice(0, 80) + ')');
    }
    if (res.ok && j && !j.error) return j;
    if (res.ok && !j) { if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; } throw timeoutError('phản hồi không đọc được'); }
    const e = (j && j.error) || {};
    if (attempt < 2 && (RETRY_CODES.has(e.code) || res.status >= 500) && (!deadlineAt || deadlineAt - Date.now() > 5000)) { await sleep(1200 * (attempt + 1) + Math.random() * 500); continue; }
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
// các trường Graph từ chối (#100) – bỏ đi và thử lại, nhớ cho các lần gọi sau. Nhớ riêng theo cấp (account/campaign/ad):
// cấp tài khoản thường không trả `results`, nhưng cấp chiến dịch vẫn cần trường này.
const unsupportedByLevel = {};
const DROPPABLE = ['results', 'views', 'unique_inline_link_clicks', 'frequency', 'reach', 'objective']; // trường không bắt buộc: Meta từ chối thì bỏ đi và thử lại

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
  const unsupported = unsupportedByLevel[level] ||= new Set();
  for (let tries = 0; tries < 4; tries++) {
    params.fields = INSIGHT_FIELDS.filter(f => !unsupported.has(f)).join(',');
    try { return await allPages('act_' + acct + '/insights', params, token); }
    catch (e) {
      const msg = String(e.meta && e.meta.message || '');
      // không lọc theo `unsupported`: nhiều lời gọi chạy song song có thể cùng gửi trường đó trước khi một lời gọi kịp ghi nhận nó bị từ chối
      const bad = e.meta && e.meta.code === 100 && DROPPABLE.find(f => new RegExp('\\b' + f + '\\b').test(msg));
      if (bad) { unsupported.add(bad); continue; }
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
  for (const it of items) {
    // mỗi kết quả có thể kèm nhiều cửa sổ phân bổ: chỉ lấy giá trị 'default', không cộng các cửa sổ với nhau
    if (Array.isArray(it && it.values)) { const x = it.values.find(w => !w || !w.attribution_windows || w.attribution_windows.includes('default')) || it.values[0]; t += Number(x && x.value) || 0; }
    else t += Number(it && it.value) || 0;
  }
  return { values: [{ value: String(t) }] };
}

// ---- lead ----
// 'lead' là tổng lead của Meta (trên Meta + website). Các loại còn lại chồng lên nhau, nên trong mỗi nhóm chỉ lấy MỘT loại theo thứ tự ưu tiên:
//   trên Meta (form, Messenger, Instagram): lead_grouped ⊇ leadgen.other (chỉ form);   website: fb_pixel_lead = onsite_web_lead (trùng nhau)
// Không bao giờ cộng lead với loại khác, và không coi 'messaging_conversation_started' là lead.
const LEAD_ON_META = ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'leadgen.other', 'onsite_conversion.lead'];
const LEAD_WEB = ['offsite_conversion.fb_pixel_lead', 'onsite_web_lead'];
function actionMap(arr) {
  const m = {};
  if (Array.isArray(arr)) for (const a of arr) if (a && a.action_type) m[a.action_type] = (m[a.action_type] || 0) + (Number(a.value) || 0);
  return m;
}
const firstOf = (m, keys) => { for (const k of keys) if (Object.hasOwn(m, k)) return m[k]; return null; };
/** Lead của một dòng Graph → { lead, mlead } (chuỗi số, hoặc null khi Meta không trả loại lead nào). */
export function leadsOfRow(actions) {
  const m = actionMap(actions), onMeta = firstOf(m, LEAD_ON_META), web = firstOf(m, LEAD_WEB);
  // khi có 'lead' vẫn giữ lead ≥ lead trên Meta, để tổng nhiều ngày/tài khoản (max của các tổng) không bị hụt
  const lead = Object.hasOwn(m, 'lead') ? Math.max(m.lead, onMeta || 0) : onMeta == null && web == null ? null : (onMeta || 0) + (web || 0);
  return { lead: lead == null ? null : String(lead), mlead: onMeta == null ? null : String(onMeta) };
}
/** Ghi lại các loại hành động có chữ "lead" mà Meta trả về, để biết ngay khi Meta đổi tên. */
function noteLeadTypes(diag, r) {
  diag.rows++;
  if (!Array.isArray(r.actions)) { diag.noActions++; return; }
  for (const a of r.actions) if (a && /lead/i.test(a.action_type || '')) diag.leadTypes[a.action_type] = (diag.leadTypes[a.action_type] || 0) + (Number(a.value) || 0);
}
/** Một dòng Graph → một dòng cùng tên trường như connector (amount_spent, link_click, lead, …). */
export function mapRow(r, level) {
  const id = level === 'campaign' ? r.campaign_id : level === 'ad' ? r.ad_id : r.account_id;
  const name = level === 'campaign' ? r.campaign_name : level === 'ad' ? r.ad_name : r.account_id;
  const L = leadsOfRow(r.actions);
  const o = {
    id, name, date_start: r.date_start, date_stop: r.date_stop,
    amount_spent: { value: r.spend || '0', unit: 'VND' }, impressions: r.impressions, reach: r.reach, frequency: r.frequency, clicks: r.clicks,
    link_click: act(r.actions, 'link_click') ?? r.inline_link_clicks ?? null, unique_link_click: r.unique_inline_link_clicks ?? null,
    lead: L.lead, onsite_conversion_lead_grouped: L.mlead,
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
  const diag = { rows: 0, noActions: 0, leadTypes: {} };
  const rows = (await insights(call.acct, q, token)).map(r => (noteLeadTypes(diag, r), mapRow(r, level)));
  if (call.name === 'camps') {
    const attrs = cache['c' + call.acct] ||= await campaignAttrs(call.acct, token);
    for (const r of rows) { const a = attrs[r.id] || {}; Object.assign(r, { objective: a.objective || '', effective_status: a.effective_status || '', start_time: a.start_time || '', stop_time: a.stop_time || '', created_time: a.created_time || '', daily_budget: a.daily_budget || null, lifetime_budget: a.lifetime_budget || null }); }
  }
  if (call.name === 'ads') {
    const attrs = cache['a' + call.acct] ||= await adAttrs(call.acct, token);
    const cattrs = cache['c' + call.acct] ||= await campaignAttrs(call.acct, token);
    for (const r of rows) { const a = attrs[r.id] || {}; Object.assign(r, { creative_id: a.creative && a.creative.id || '', effective_status: a.effective_status || '', created_time: a.created_time || '', adset_name: r.adset_name || (a.adset && a.adset.name) || '', objective: (cattrs[r.campaign_id] || {}).objective || '' }); }
  }
  return { ad_entities: rows, diag };
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
