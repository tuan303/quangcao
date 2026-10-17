/* fbads-core.js — Facebook Ads data engine for the Ngôi Sao Hoàng Mai dashboard.
 * One file, two homes: the dashboard page (window.FBCore) and Node scripts
 * (globalThis.FBCore after require/import). Pure functions only: no DOM, no network.
 *
 *  plan(today)            -> the list of Meta Ads tool calls a sync makes
 *  normalize(raw)         -> raw tool payloads -> compact database documents
 *  mergeDocs(old, fresh)  -> keeps history (daily rows, reach windows) across syncs
 *  model(docs)            -> one in-memory model the page and the analysts read
 *  totals / series / ...  -> aggregations used by the page and by verification
 */
(function (root) {
  'use strict';

  var VERSION = 1;
  var START = '2025-03-01';
  var TZ = 'Asia/Ho_Chi_Minh';

  // Chỉ hai tài khoản quảng cáo của nhà trường được kết nối (các tài khoản khác đã gỡ, số liệu cũ của chúng không hiển thị)
  var ACCOUNTS = [
    { id: '895057262833914', name: 'TK Fanpage Trường (8950…)', short: 'TK Fanpage Trường', role: 'admissions' },
    { id: '1870132100153072', name: 'TK Facebook cô Ngà (1870…)', short: 'TK cô Ngà', role: 'admissions' }
  ];
  /* Chiến dịch thu lead: mục tiêu thu lead (OUTCOME_LEADS / LEAD_GENERATION). Chi phí/lead chỉ tính các chiến dịch này.
   * Chiến dịch thương hiệu, tương tác, tin nhắn… để riêng (otherSpend); lead lẻ của chúng vẫn nằm trong tổng lead nhưng không vào chi phí/lead. */
  function isLeadCampaign(c) { return /LEAD/.test((c && c.obj) || ''); }

  /* Metric columns stored for every daily row, campaign, ad and breakdown row.
   * All are additive counts except reach (people; never summed across windows
   * when an exact value exists). */
  var M = ['spend', 'impr', 'reach', 'clicks', 'link', 'ulink', 'lead', 'mlead', 'results', 'views', 'vplay', 'thru',
    'p25', 'p50', 'p75', 'p100', 'eng', 'react', 'cmt', 'save', 'share', 'lpv', 'outb'];
  var MI = {}; M.forEach(function (k, i) { MI[k] = i; });
  var API_OF = {
    spend: 'amount_spent', impr: 'impressions', reach: 'reach', clicks: 'clicks', link: 'link_click',
    ulink: 'unique_link_click', lead: 'lead', mlead: 'onsite_conversion_lead_grouped', results: 'results',
    views: 'media_views', vplay: 'video_play_actions', thru: 'video_thruplay_watched_actions',
    p25: 'video_p25_watched_actions', p50: 'video_p50_watched_actions', p75: 'video_p75_watched_actions',
    p100: 'video_p100_watched_actions', eng: 'post_engagement', react: 'post_reaction', cmt: 'comment',
    save: 'post_save', share: 'post_shares', lpv: 'landing_page_view', outb: 'outbound_clicks'
  };

  /* ---------------- small utils ---------------- */
  function num(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'object') {
      // {value: "123"} or results-style {indicator, values: [{value: "123"}]}
      if (Array.isArray(v.values)) return v.values.reduce(function (s, x) { return s + num(x && x.value); }, 0);
      return num(v.value);
    }
    var s = String(v).trim();
    if (!s) return 0;
    if (s.indexOf('%') >= 0) s = s.replace('%', '').replace(',', '.');
    var n = Number(s);
    return isFinite(n) ? n : 0;
  }
  function vec(row) { return M.map(function (k) { return num(row[API_OF[k]]); }); }
  function empty(v) { for (var i = 0; i < v.length; i++) if (v[i]) return false; return true; }
  function zero() { return M.map(function () { return 0; }); }
  function addInto(a, b) { for (var i = 0; i < a.length; i++) a[i] += (b[i] || 0); return a; }
  function day(s) { return s ? String(s).slice(0, 10) : ''; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function parseISO(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(s, n) { var d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function diffDays(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
  function monthStart(s) { return s.slice(0, 8) + '01'; }
  function monthEnd(s) { var d = parseISO(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); }
  function prevMonth(s) { var d = parseISO(monthStart(s)); d.setUTCMonth(d.getUTCMonth() - 1); return iso(d); }
  function todayVN(now) {
    var d = now ? new Date(now) : new Date();
    var t = new Date(d.getTime() + 7 * 3600000);
    return iso(t);
  }
  function schoolYearStart(s) { var y = +s.slice(0, 4), m = +s.slice(5, 7); return (m >= 8 ? y : y - 1) + '-08-01'; }

  /* ---------------- payload parsing ---------------- */
  /* Accepts a Meta Ads tool payload in any of the shapes we have seen:
   * {ad_entities:"[...json...]", pagination:{next_cursor}}, an MCP result with
   * {payload}, {structuredContent} or {content:[{type:'text',text}]}, or a JSON string. */
  function unwrap(p) {
    if (p == null) return null;
    if (typeof p === 'string') { try { return unwrap(JSON.parse(p)); } catch (e) { return null; } }
    if (Array.isArray(p)) return { rows: p };
    if (p.payload !== undefined && (p.content || p.cache || p.structuredContent !== undefined)) return unwrap(p.payload);
    if (p.structuredContent && typeof p.structuredContent === 'object' && !p.ad_entities) return unwrap(p.structuredContent);
    if (Array.isArray(p.content) && !p.ad_entities && !p.creatives) {
      for (var i = 0; i < p.content.length; i++) {
        var c = p.content[i];
        if (c && c.type === 'text') { var u = unwrap(c.text); if (u) return u; }
      }
      return null;
    }
    return p;
  }
  function rowsOf(p) {
    var o = unwrap(p);
    if (!o) return [];
    if (o.rows) return o.rows;
    var keys = ['ad_entities', 'creatives', 'ad_creatives', 'data'];
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v == null) continue;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = []; } }
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.data)) return v.data;
    }
    return [];
  }
  function cursorOf(p) {
    var o = unwrap(p);
    if (!o || typeof o !== 'object') return null;
    return (o.pagination && o.pagination.next_cursor) || o.next_cursor || null;
  }

  /* ---------------- sync plan ---------------- */
  var CAMP_STATUS = { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'] };
  var SPENT = { field: 'amount_spent', operator: 'GREATER_THAN', value: ['0'] };
  var AD_STATUS = { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'DISAPPROVED', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO'] };
  var F = {
    daily: ['amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'unique_link_click', 'lead', 'onsite_conversion_lead_grouped', 'media_views', 'video_play_actions', 'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'post_engagement', 'post_reaction', 'comment', 'post_save', 'post_shares', 'landing_page_view', 'outbound_clicks'],
    camps: ['id', 'name', 'objective', 'effective_status', 'start_time', 'stop_time', 'created_time', 'daily_budget', 'lifetime_budget', 'amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'unique_link_click', 'lead', 'onsite_conversion_lead_grouped', 'results', 'cost_per_result', 'media_views', 'video_play_actions', 'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'post_engagement', 'post_reaction', 'comment', 'post_save', 'post_shares', 'landing_page_view', 'outbound_clicks'],
    campm: ['id', 'name', 'amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'lead', 'onsite_conversion_lead_grouped', 'results', 'media_views', 'video_thruplay_watched_actions', 'post_engagement', 'landing_page_view'],
    ads: ['id', 'name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'creative_id', 'effective_status', 'created_time', 'objective', 'amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'lead', 'onsite_conversion_lead_grouped', 'results', 'cost_per_result', 'media_views', 'video_play_actions', 'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'post_engagement', 'post_reaction', 'comment', 'post_save', 'landing_page_view', 'outbound_clicks'],
    adm: ['id', 'name', 'amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'lead', 'onsite_conversion_lead_grouped', 'results', 'media_views', 'video_play_actions', 'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p100_watched_actions', 'post_engagement', 'post_reaction', 'comment', 'post_save', 'landing_page_view'],
    bd: ['id', 'name', 'amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'lead', 'onsite_conversion_lead_grouped', 'results', 'post_engagement', 'media_views', 'video_thruplay_watched_actions', 'landing_page_view'],
    reach: ['amount_spent', 'impressions', 'reach', 'clicks', 'link_click', 'lead'],
    creative: ['id', 'name', 'object_type', 'body', 'title', 'description', 'call_to_action_type', 'link_url', 'video_id', 'effective_object_story_id', 'object_story_id']
  };
  var BD = {
    bd_agegender: ['age', 'gender'],
    bd_region: ['region'],
    bd_platform: ['publisher_platform', 'platform_position'],
    bd_device: ['device_platform']
  };

  /* mode: 'quick' (daily rows of the last 45 days, campaigns, reach windows)
   *       'full'  (everything from START: also ads, breakdowns; creatives follow ads) */
  function plan(today, opts) {
    opts = opts || {};
    var mode = opts.mode || 'full';
    var accts = opts.accounts || ACCOUNTS.map(function (a) { return a.id; });
    var end = today, y1 = addDays(today, -1);
    var TR = JSON.stringify({ since: START, until: end });
    var calls = [];
    accts.forEach(function (acct) {
      function q(name, args) { calls.push({ acct: acct, name: name, tool: 'ads_get_ad_entities', args: Object.assign({ ad_account_id: acct, include_additional_context: false }, args) }); }
      // daily rows: windows of at most 180 days (the API caps a time series at 200 rows)
      var from = mode === 'quick' ? addDays(today, -45) : START, w = 1;
      while (from <= end) {
        var to = addDays(from, 179); if (to > end) to = end;
        q('daily_w' + (w++), { level: 'ad_account', time_range: JSON.stringify({ since: from, until: to }), time_increment: '1', limit: 1000, fields: F.daily });
        from = addDays(to, 1);
      }
      q('camps', { level: 'campaign', time_range: TR, limit: 1000, filtering: [CAMP_STATUS], fields: F.camps });
      q('campm', { level: 'campaign', time_range: TR, time_increment: 'monthly', limit: 1000, filtering: [CAMP_STATUS], fields: F.campm });
      // campaign x day for the last 62 days, only campaigns that spent (the API returns a row per campaign per day)
      [[addDays(today, -61), addDays(today, -31), 'h1'], [addDays(today, -30), end, 'h2']].forEach(function (w) {
        q('campd__' + w[2], { level: 'campaign', time_range: JSON.stringify({ since: w[0], until: w[1] }), time_increment: '1', limit: 1000, filtering: [CAMP_STATUS, SPENT], fields: F.campm });
      });
      var sy = schoolYearStart(today);
      var reachWins = [
        ['reach_7', addDays(today, -14), y1, '7'],
        ['reach_30', addDays(today, -60), y1, '30'],
        ['reach_month', START, end, 'monthly'],
        ['reach_ytd', today.slice(0, 4) + '-01-01', end, 'all_days'],
        ['reach_all', START, end, 'all_days'],
        ['reach_sy', sy, end, 'all_days'],
        ['reach_psy', (+sy.slice(0, 4) - 1) + '-08-01', addDays(sy, -1), 'all_days']
      ];
      reachWins.forEach(function (r) {
        if (r[1] < START) r[1] = START;
        if (r[1] > r[2]) return;
        q(r[0], { level: 'ad_account', time_range: JSON.stringify({ since: r[1], until: r[2] }), time_increment: r[3], fields: F.reach });
      });
      if (mode === 'full') {
        q('ads', { level: 'ad', time_range: TR, limit: 1000, filtering: [AD_STATUS], fields: F.ads });
        q('adm', { level: 'ad', time_range: TR, time_increment: 'monthly', limit: 1000, filtering: [AD_STATUS], fields: F.adm });
        Object.keys(BD).forEach(function (k) {
          q(k, { level: 'campaign', time_range: TR, limit: 1000, filtering: [CAMP_STATUS], breakdowns: BD[k], fields: F.bd });
        });
      }
    });
    return calls;
  }
  function windowsOf(calls) {
    var w = {};
    calls.forEach(function (c) { if (c.args && c.args.time_range) { try { w[c.name] = JSON.parse(c.args.time_range); } catch (e) { /* ignore */ } } });
    return w;
  }
  function creativeCalls(acct, ids) {
    var out = [];
    for (var i = 0; i < ids.length; i += 50) {
      out.push({ acct: acct, name: 'creatives_c' + (i / 50 + 1), tool: 'ads_get_creatives', args: { ad_account_id: acct, creative_ids: ids.slice(i, i + 50), fields: F.creative } });
    }
    return out;
  }

  /* ---------------- normalize ---------------- */
  /* raw: { [acct]: { [datasetName]: [payload, payload, ...] } }
   * dataset names: daily_w*, camps, campm, ads, bd_*, reach_*, creatives_c*
   * (pagination pages and time splits are simply extra payloads in the list). */
  function normalize(raw, opts) {
    opts = opts || {};
    var docs = {};
    Object.keys(raw).forEach(function (acct) {
      var sets = raw[acct];
      var names = Object.keys(sets);
      function rowsFor(prefix, exact) {
        var out = [];
        names.forEach(function (n) {
          var base = n.replace(/__.*$/, '');
          if (exact ? base === prefix : base.indexOf(prefix) === 0) sets[n].forEach(function (p) { out = out.concat(rowsOf(p)); });
        });
        return out;
      }
      var has = function (prefix) { return names.some(function (n) { return n.indexOf(prefix) === 0; }); };

      // account doc: daily rows + exact reach windows
      if (has('daily') || has('reach')) {
        var A = { acct: acct, daily: {}, reach: {} };
        rowsFor('daily').forEach(function (r) {
          var d = day(r.date_start);
          if (!d || r.date_start !== r.date_stop && day(r.date_stop) !== d) return;
          A.daily[d] = vec(r);
          A.reach[d + '|' + d] = [num(r.reach), num(r.impressions), num(r.amount_spent)];
        });
        // whole-window rows (time_increment all_days) come back without dates: use the requested window
        names.forEach(function (n) {
          var base = n.replace(/__.*$/, '');
          if (base.indexOf('reach') !== 0) return;
          var win = (opts.windows || {})[base] || (opts.windows || {})[n];
          sets[n].forEach(function (p) {
            rowsOf(p).forEach(function (r) {
              var s = day(r.date_start) || (win && win.since), e = day(r.date_stop) || (win && win.until);
              if (!s || !e || r.reach == null) return;
              A.reach[s + '|' + e] = [num(r.reach), num(r.impressions), num(r.amount_spent)];
            });
          });
        });
        docs['acct-' + acct] = A;
      }

      // campaigns (+ monthly)
      if (has('camps') || has('campm')) {
        var C = { acct: acct, rows: {}, monthly: {} };
        rowsFor('camps', true).forEach(function (r) {
          C.rows[r.id] = {
            n: r.name || '', obj: r.objective || '', st: r.effective_status || '', s: day(r.start_time), e: day(r.stop_time),
            c: day(r.created_time), db: num(r.daily_budget), lb: num(r.lifetime_budget), cpr: num(r.cost_per_result), m: vec(r)
          };
        });
        rowsFor('campm', true).forEach(function (r) {
          var mk = day(r.date_start).slice(0, 7), v = vec(r);
          if (!mk) return;
          if (!empty(v)) (C.monthly[r.id] = C.monthly[r.id] || {})[mk] = v;
          if (!C.rows[r.id]) C.rows[r.id] = { n: r.name || '', obj: '', st: '', s: '', e: '', c: '', db: 0, lb: 0, cpr: 0, m: null };
        });
        docs['camp-' + acct] = C;
      }

      // campaign daily rows (recent window only; exact 7/30-day views)
      if (has('campd')) {
        var CD = { acct: acct, rows: {} };
        rowsFor('campd', true).forEach(function (r) {
          var d = day(r.date_start), v = vec(r); if (!d || empty(v)) return;
          (CD.rows[r.id] = CD.rows[r.id] || {})[d] = v;
        });
        var ds = [];
        rowsFor('campd', true).forEach(function (r) { var d = day(r.date_start); if (d) ds.push(d); });
        CD.since = opts.campdSince || (ds.length ? ds.sort()[0] : '');
        docs['campd-' + acct] = CD;
      }
      // ad monthly rows
      if (has('adm')) {
        var AM = { acct: acct, rows: {} };
        rowsFor('adm', true).forEach(function (r) {
          var mk = day(r.date_start).slice(0, 7), v = vec(r); if (!mk || empty(v)) return;
          (AM.rows[r.id] = AM.rows[r.id] || {})[mk] = v;
        });
        chunk(Object.keys(AM.rows).map(function (id) { return [id, AM.rows[id]]; }), 200000).forEach(function (part, i) {
          var o = {}; part.forEach(function (x) { o[x[0]] = x[1]; });
          docs['adm-' + acct + (i ? '-' + (i + 1) : '')] = { acct: acct, rows: o };
        });
      }

      // ads (chunked)
      if (has('ads')) {
        var ads = rowsFor('ads', true).map(function (r) {
          return { id: r.id, n: r.name || '', cid: r.campaign_id || '', cn: r.campaign_name || '', as: r.adset_name || '', cr: r.creative_id ? String(r.creative_id) : '',
            st: r.effective_status || '', c: day(r.created_time), obj: r.objective || '', cpr: num(r.cost_per_result), m: vec(r) };
        });
        chunk(ads, 180000).forEach(function (part, i) { docs['ads-' + acct + '-' + (i + 1)] = { acct: acct, part: i + 1, rows: part }; });
      }

      // creatives (chunked; long texts trimmed)
      if (has('creatives')) {
        var cr = rowsFor('creatives').map(function (r) {
          return { id: String(r.id), n: r.name || '', t: clip(r.title, 200), b: clip(r.body, 900), d: clip(r.description, 200), ty: r.object_type || '',
            cta: r.call_to_action_type || '', url: clip(r.link_url, 300), vid: r.video_id ? String(r.video_id) : '', story: r.effective_object_story_id || r.object_story_id || '' };
        });
        chunk(cr, 180000).forEach(function (part, i) { docs['crea-' + acct + '-' + (i + 1)] = { acct: acct, part: i + 1, rows: part }; });
      }

      // breakdowns: sum rows per (campaign, key...) across pages / time splits
      Object.keys(BD).forEach(function (bk) {
        if (!has(bk)) return;
        var keys = BD[bk], acc = {};
        rowsFor(bk, true).forEach(function (r) {
          var kv = keys.map(function (k) { return r[k] == null ? '' : String(r[k]); });
          var id = r.id + '\u0001' + kv.join('\u0001');
          if (!acc[id]) acc[id] = { c: r.id, k: kv, m: zero() };
          addInto(acc[id].m, vec(r));
        });
        var rows = Object.keys(acc).map(function (id) { var o = acc[id]; return [o.c].concat(o.k, bdVals(o.m)); });
        var dim = bk.replace('bd_', '');
        chunk(rows, 200000).forEach(function (part, i) { docs['bd-' + acct + '-' + dim + (i ? '-' + (i + 1) : '')] = { acct: acct, dim: dim, keys: keys, cols: BDM, rows: part }; });
      });
    });
    return docs;
  }
  var BDM = ['spend', 'impr', 'reach', 'clicks', 'link', 'lead', 'mlead', 'results', 'eng', 'views', 'thru', 'lpv'];
  function bdVals(m) { return BDM.map(function (k) { return Math.round(m[MI[k]] * 100) / 100; }); }
  function clip(s, n) { if (!s) return ''; s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function chunk(list, maxBytes) {
    var out = [], cur = [], size = 0;
    list.forEach(function (x) {
      var s = JSON.stringify(x).length + 1;
      if (cur.length && size + s > maxBytes) { out.push(cur); cur = []; size = 0; }
      cur.push(x); size += s;
    });
    if (cur.length || !out.length) out.push(cur);
    return out;
  }

  /* Merge freshly normalized docs into what the store already has.
   * Account docs keep their history; everything else is replaced. */
  function mergeDocs(oldDocs, fresh) {
    var out = {};
    Object.keys(fresh).forEach(function (id) {
      var nv = fresh[id], ov = oldDocs && oldDocs[id];
      if (id.indexOf('acct-') === 0 && ov) {
        out[id] = { acct: nv.acct, daily: Object.assign({}, ov.daily || {}, nv.daily || {}), reach: Object.assign({}, ov.reach || {}, nv.reach || {}) };
      } else if (id.indexOf('campd-') === 0 && ov && nv) {
        var rr = {};
        Object.keys(ov.rows || {}).forEach(function (cid) { rr[cid] = Object.assign({}, ov.rows[cid]); });
        Object.keys(nv.rows || {}).forEach(function (cid) { rr[cid] = Object.assign(rr[cid] || {}, nv.rows[cid]); });
        var keep = nv.since && ov.since && ov.since < nv.since ? ov.since : (nv.since || ov.since);
        out[id] = { acct: nv.acct, since: keep, rows: rr };
      } else if (id.indexOf('camp-') === 0 && ov && nv) {
        // a quick sync re-reads campaigns fully; keep monthly history of campaigns no longer returned
        var mo = Object.assign({}, ov.monthly || {});
        Object.keys(nv.monthly || {}).forEach(function (cid) { mo[cid] = Object.assign({}, mo[cid] || {}, nv.monthly[cid]); });
        var rows = Object.assign({}, ov.rows || {});
        Object.keys(nv.rows || {}).forEach(function (cid) {
          // a row rebuilt only from monthly data (m: null) never replaces a complete one
          if (nv.rows[cid].m == null && rows[cid] && rows[cid].m) return;
          rows[cid] = nv.rows[cid];
        });
        out[id] = { acct: nv.acct, rows: rows, monthly: mo };
      } else out[id] = nv;
    });
    return out;
  }

  /* ---------------- classification ---------------- */
  /* Order = colour slot order (validated categorical palette, adjacent pairs). */
  var SEGMENTS = [
    { k: 'l1', label: 'Lớp 1 · Tiểu học', slot: 1 },
    { k: 'l10', label: 'Lớp 10 · THPT', slot: 2 },
    { k: 'l6', label: 'Lớp 6 · THCS', slot: 3 },
    { k: 'js', label: 'Jolly Steps', slot: 4 },
    { k: 'camp', label: 'Trại hè', slot: 5 },
    { k: 'brand', label: 'Thương hiệu & thành tích', slot: 6 },
    { k: 'mix', label: 'Tuyển sinh chung', slot: 7 },
    { k: 'hr', label: 'Tuyển dụng & nội bộ', slot: 8 },
    { k: 'other', label: 'Khác', slot: 0 }
  ];
  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  }
  /* Rule-based segment from a campaign name (and the account role). Claude's
   * reviewed labels (doc "labels") override this when present. */
  function segmentOf(name, role) {
    if (role === 'recruit') return 'hr';
    var f = fold(name);
    if (/tuyen dung|cbnv|ung vien|viec lam/.test(f)) return 'hr';
    if (/van co nguyet/.test(f)) return 'other';
    if (/jolly|(^|[^a-z0-9])js( ?2\d|\d)?([^a-z0-9]|$)|tien tieu hoc|mam non/.test(f)) return 'js';
    if (/trai he|summer|he 20\d\d/.test(f)) return 'camp';
    var t1 = /(^|[^a-z0-9])(ts|tsk|httsk|k|khoi|tuyen sinh) ?1([^0-9]|$)|lop ?(1|mot)([^0-9a-z]|$)|vao lop 1([^0-9]|$)|sinh nam 20(19|20|21)|tieu hoc/.test(f);
    var t6 = /(^|[^a-z0-9])(ts|tsk|httsk|k|khoi|tuyen sinh) ?6([^0-9]|$)|lop ?6([^0-9]|$)|thcs/.test(f);
    var t10 = /(^|[^a-z0-9])(ts|tsk|httsk|tt|k|khoi|tuyen sinh|tuyen thang|uu tu|diem|hoi ?thao|thi thu vao lop) ?10([^0-9]|$)|lop ?10([^0-9]|$)|thpt|thi chuyen|chuyen cap|diem chuan/.test(f);
    if (/(^|[^0-9])6 ?[-+&,] ?10\b|(^|[^0-9])1 ?[-+&,] ?6\b/.test(f)) return 'mix';
    var n = (t1 ? 1 : 0) + (t6 ? 1 : 0) + (t10 ? 1 : 0);
    if (n > 1) return 'mix';
    if (t1) return 'l1';
    if (t6) return 'l6';
    if (t10) return 'l10';
    if (/tuyen sinh|tu van|landing|dang ky|lead|remarketing|edutalk|nhan tin|messenger/.test(f)) return 'mix';
    return 'brand';
  }
  var OBJECTIVES = {
    OUTCOME_LEADS: 'Thu lead', LEAD_GENERATION: 'Thu lead', OUTCOME_ENGAGEMENT: 'Tương tác', POST_ENGAGEMENT: 'Tương tác',
    OUTCOME_AWARENESS: 'Nhận diện', REACH: 'Nhận diện', BRAND_AWARENESS: 'Nhận diện', OUTCOME_TRAFFIC: 'Lưu lượng',
    LINK_CLICKS: 'Lưu lượng', MESSAGES: 'Tin nhắn', VIDEO_VIEWS: 'Xem video', OUTCOME_SALES: 'Chuyển đổi', CONVERSIONS: 'Chuyển đổi'
  };
  function objectiveLabel(o) { return OBJECTIVES[o] || (o ? o.replace(/^OUTCOME_/, '').toLowerCase() : '—'); }

  /* ---------------- model + aggregation ---------------- */
  /* docs: { [docId]: body } as read from the store */
  function model(docs) {
    var mdl = { meta: docs.meta || null, insights: docs.insights || null, labels: (docs.labels && docs.labels.seg) || {}, themes: (docs.labels && docs.labels.theme) || {},
      accounts: {}, campaigns: {}, ads: {}, creatives: {}, bd: {}, campd: {}, adm: {}, minDate: null, maxDate: null };
    var roles = {}; ACCOUNTS.forEach(function (a) { roles[a.id] = a.role; });
    if (mdl.meta && mdl.meta.accounts) mdl.meta.accounts.forEach(function (a) { roles[a.id] = a.role || roles[a.id]; });
    Object.keys(docs).forEach(function (id) {
      var d = docs[id]; if (!d) return;
      if (id.indexOf('acct-') === 0) {
        mdl.accounts[d.acct] = { daily: d.daily || {}, reach: d.reach || {} };
        Object.keys(d.daily || {}).forEach(function (k) {
          if (!mdl.minDate || k < mdl.minDate) mdl.minDate = k;
          if (!mdl.maxDate || k > mdl.maxDate) mdl.maxDate = k;
        });
      } else if (id.indexOf('camp-') === 0) {
        Object.keys(d.rows || {}).forEach(function (cid) {
          var r = d.rows[cid];
          mdl.campaigns[cid] = Object.assign({ id: cid, acct: d.acct, monthly: (d.monthly || {})[cid] || {} }, r);
          mdl.campaigns[cid].seg = mdl.labels[cid] || segmentOf(r.n, roles[d.acct]);
          if (!mdl.campaigns[cid].m) {
            var t = zero(); var mo = mdl.campaigns[cid].monthly;
            Object.keys(mo).forEach(function (k) { addInto(t, mo[k]); });
            mdl.campaigns[cid].m = t;
          }
        });
      } else if (id.indexOf('campd-') === 0) {
        mdl.campd[d.acct] = { since: d.since || '', rows: d.rows || {} };
      } else if (id.indexOf('adm-') === 0) {
        Object.keys(d.rows || {}).forEach(function (aid) { mdl.adm[aid] = d.rows[aid]; });
      } else if (id.indexOf('ads-') === 0) {
        (d.rows || []).forEach(function (a) { mdl.ads[a.id] = Object.assign({ acct: d.acct }, a); });
      } else if (id.indexOf('crea-') === 0) {
        (d.rows || []).forEach(function (c) { mdl.creatives[c.id] = c; });
      } else if (id.indexOf('bd-') === 0) {
        var bucket = mdl.bd[d.dim] = mdl.bd[d.dim] || { keys: d.keys, cols: d.cols, rows: [] };
        (d.rows || []).forEach(function (r) { bucket.rows.push([d.acct].concat(r)); });
      }
    });
    Object.keys(mdl.ads).forEach(function (aid) {
      var a = mdl.ads[aid], c = mdl.campaigns[a.cid];
      a.seg = c ? c.seg : segmentOf(a.cn, roles[a.acct]);
      a.theme = mdl.themes[aid] || mdl.themes[a.cr] || '';
    });
    mdl.roles = roles;
    return mdl;
  }

  /* totals over [since, until] for a set of accounts. Reach is exact when the store
   * holds that window (summed across accounts: people reached by two accounts count twice). */
  function totals(mdl, accts, since, until) {
    var t = zero(), days = 0, reachExact = true, reach = 0;
    accts.forEach(function (acct) {
      var A = mdl.accounts[acct]; if (!A) return;
      Object.keys(A.daily).forEach(function (d) { if (d >= since && d <= until) { addInto(t, A.daily[d]); days++; } });
      var key = since + '|' + until, rr = A.reach[key];
      if (rr) reach += rr[0];
      else {
        // no exact window: accept it when the account has no spend in the window at all
        var any = Object.keys(A.daily).some(function (d) { return d >= since && d <= until && (A.daily[d][MI.impr] > 0); });
        if (any) reachExact = false;
      }
    });
    var o = toObj(t);
    o.reachSum = o.reach; // sum of daily reach (upper bound)
    o.reach = reachExact ? reach : o.reach;
    o.reachExact = reachExact;
    return splitCpl(mdl, accts, since, until, derive(o));
  }
  /* Chi phí/lead chỉ tính chiến dịch thu lead: chi tiêu của các chiến dịch thu lead ÷ lead của chính các chiến dịch đó.
   * Chi cho thương hiệu, tương tác, tin nhắn… (otherSpend) để riêng, không cộng vào chi phí/lead.
   *   o.cpl        chi phí/lead của chiến dịch thu lead (null khi kỳ không có lead từ chiến dịch thu lead)
   *   o.cplAll     tổng chi tiêu ÷ tổng lead (chỉ để đối chiếu)
   *   o.lcSpend, o.lcLeads, o.otherSpend: phần chiến dịch thu lead / chiến dịch khác, luôn khớp với tổng chi tiêu và tổng lead của tài khoản
   *   o.cplApprox  một phần chỉ có số theo tháng nên được chia theo ngày (ước tính)
   *   o.cplBasis   'lead' | 'all': 'all' khi số theo chiến dịch chưa phủ đủ chi tiêu của tài khoản trong kỳ, lúc đó cpl = tổng chi tiêu ÷ tổng lead. */
  function splitCpl(mdl, accts, since, until, o) {
    var r = splitParts(mdl, accts, since, until, function () { return 'all'; });
    return applySplit(o, r.any, r.P.all, covered(mdl, accts, since, until, r.P.all));
  }
  // cộng số theo chiến dịch vào từng khoảng (key) của kỳ, tách chiến dịch thu lead / chiến dịch khác
  function splitParts(mdl, accts, since, until, keyOf) {
    var set = {}, any = false, P = {};
    accts.forEach(function (a) { set[a] = 1; });
    Object.keys(mdl.campaigns).forEach(function (id) {
      var c = mdl.campaigns[id]; if (!set[c.acct]) return;
      any = true;
      var isLead = isLeadCampaign(c);
      eachPart(mdl, c, since, until, keyOf, function (k, v, f, approx, daily) {
        var p = P[k] || (P[k] = { lead: zero(), other: zero(), cd: {}, approx: false });
        addScaled(isLead ? p.lead : p.other, v, f);
        if (daily) p.cd[c.acct] = (p.cd[c.acct] || 0) + (v[MI.spend] || 0); // chi tiêu theo ngày của chiến dịch, để đối chiếu với tài khoản
        if (approx) p.approx = true;
      });
    });
    return { any: any, P: P };
  }
  /* Số theo chiến dịch chỉ dùng được khi phủ gần đủ chi tiêu của từng tài khoản (80%–125%):
   * phần có số theo ngày của chiến dịch thì đối chiếu ngay trong kỳ, phần chỉ có số theo tháng thì đối chiếu cả tháng
   * (không đối chiếu từng ngày vì số theo tháng được chia đều nên lệch từng ngày là bình thường). */
  var COVER = 0.8, COVER_HI = 1.25;
  function covered(mdl, accts, from, to, p) {
    for (var i = 0; i < accts.length; i++) {
      var a = accts[i], cd = mdl.campd[a], cut = cd && cd.since, hiM = to;
      if (cut) {
        var lo = from > cut ? from : cut;
        if (lo <= to) {
          var s = acctSpendIn(mdl, a, lo, to), c = (p && p.cd[a]) || 0;
          if (s > 0 ? (c < s * COVER || c > s * COVER_HI) : c >= 1) return false;
        }
        if (to >= cut) hiM = addDays(cut, -1);
      }
      if (from <= hiM) {
        for (var m = from.slice(0, 7), last = hiM.slice(0, 7); m <= last; m = nextMonth(m)) if (!monthOK(mdl, a, m, cut)) return false;
      }
    }
    return true;
  }
  function nextMonth(m) { var y = +m.slice(0, 4), mo = +m.slice(5, 7) + 1; if (mo > 12) { mo = 1; y++; } return y + '-' + pad(mo); }
  function monthOK(mdl, acct, m, cut) {
    var cache = mdl._mcov || (mdl._mcov = {}), key = acct + '|' + m + '|' + (cut || ''), r = cache[key];
    if (r !== undefined) return r;
    var ms = m + '-01', me = monthEnd(ms), cutMonth = !!(cut && cut > ms && cut <= me), hi = cutMonth ? addDays(cut, -1) : me;
    if (mdl.maxDate && hi > mdl.maxDate) hi = mdl.maxDate;
    var s = acctSpendIn(mdl, acct, ms, hi), c = 0, cd = mdl.campd[acct];
    Object.keys(mdl.campaigns).forEach(function (id) {
      var cp = mdl.campaigns[id]; if (cp.acct !== acct) return;
      var v = cp.monthly && cp.monthly[m]; if (!v) return;
      var x = v[MI.spend] || 0;
      if (cutMonth && cd) { var rows = cd.rows[id] || {}; Object.keys(rows).forEach(function (d) { if (d >= cut && d <= me) x -= rows[d][MI.spend] || 0; }); }
      c += x > 0 ? x : 0;
    });
    return (cache[key] = s > 0 ? (c >= s * COVER && c <= s * COVER_HI) : c < 1);
  }
  // chi tiêu của một tài khoản trong [from, to] (tổng cộng dồn theo ngày, dùng cho đối chiếu độ phủ)
  function acctSpendIn(mdl, acct, from, to) {
    if (from > to) return 0;
    var cache = mdl._cum || (mdl._cum = {}), c = cache[acct];
    if (!c) {
      var A = mdl.accounts[acct], days = A ? Object.keys(A.daily).sort() : [], cum = [0];
      days.forEach(function (d, i) { cum.push(cum[i] + (A.daily[d][MI.spend] || 0)); });
      c = cache[acct] = { days: days, cum: cum };
    }
    return c.cum[countLE(c.days, to)] - c.cum[countLE(c.days, addDays(from, -1))];
  }
  function countLE(arr, x) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function applySplit(o, any, p, ok) {
    o.cplAll = o.cpl;
    var L = toObj(p ? p.lead : zero()), n = leadsOf(L), no = p ? leadsOf(toObj(p.other)) : 0, lt = o.leads || 0;
    // tài khoản có lead nhưng chiến dịch không báo lead nào: chưa tách được
    if (!any || !ok || (lt >= MINLEAD_CORE && n + no === 0)) { o.cplBasis = 'all'; o.lcSpend = null; o.lcLeads = null; o.otherSpend = null; o.cplApprox = false; return o; }
    var ls = L.spend, os = p ? p.other[MI.spend] : 0, sp = o.spend || 0, tot = ls + os;
    // chia tổng chi tiêu và tổng lead của tài khoản theo cơ cấu giữa chiến dịch thu lead và chiến dịch khác:
    // phần thu lead + phần khác luôn bằng đúng tổng, lead thu lead không vượt tổng lead (kể cả khi số theo tháng được chia theo ngày)
    if (tot > 0) { if (Math.abs(tot - sp) > 1e-9 * Math.max(1, sp)) { ls = sp * ls / tot; os = sp - ls; } } else { ls = 0; os = sp; }
    if (os < 0.5) os = 0; if (ls > sp) ls = sp;
    var all = n + no;
    if (all > 0) { if (Math.abs(all - lt) > 1e-9 * Math.max(1, lt)) n = lt * n / all; } else n = 0;
    o.cplBasis = 'lead'; o.lcSpend = ls; o.lcLeads = n; o.otherSpend = os; o.cplApprox = !!(p && p.approx);
    o.cpl = n > 0 ? ls / n : null;
    return o;
  }
  var MINLEAD_CORE = 5;
  function addScaled(a, b, f) { if (f === 1) return addInto(a, b); for (var i = 0; i < a.length; i++) a[i] += (b[i] || 0) * f; return a; }
  function toObj(v) { var o = {}; M.forEach(function (k, i) { o[k] = v[i] || 0; }); return o; }
  function leadsOf(o) { return Math.max(o.lead || 0, o.mlead || 0); }
  function derive(o) {
    o.leads = leadsOf(o);
    o.cpl = o.leads ? o.spend / o.leads : null;
    o.cpm = o.impr ? o.spend / o.impr * 1000 : null;
    o.ctr = o.impr ? o.clicks / o.impr : null;
    o.lctr = o.impr ? o.link / o.impr : null;
    o.cpc = o.clicks ? o.spend / o.clicks : null;
    o.cpcLink = o.link ? o.spend / o.link : null;
    o.freq = o.reach ? o.impr / o.reach : null;
    o.engRate = o.impr ? o.eng / o.impr : null;
    o.cpe = o.eng ? o.spend / o.eng : null;
    o.lcr = o.link ? o.leads / o.link : null;
    o.hook = o.vplay ? o.p25 / o.vplay : null;
    o.hold = o.vplay ? o.p100 / o.vplay : null;
    o.cpThru = o.thru ? o.spend / o.thru : null;
    return o;
  }
  function vecObj(v) { return derive(toObj(v || zero())); }

  /* time series: grain 'day' | 'week' (Mon–Sun) | 'month' */
  function series(mdl, accts, since, until, grain) {
    var buckets = {}, order = [];
    var kmemo = {};
    function keyOf(d) {
      var r = kmemo[d]; if (r !== undefined) return r;
      if (grain === 'month') r = d.slice(0, 7);
      else if (grain === 'week') { var dt = parseISO(d), wd = (dt.getUTCDay() + 6) % 7; r = addDays(d, -wd); }
      else r = d;
      return (kmemo[d] = r);
    }
    for (var d = since; d <= until; d = addDays(d, 1)) {
      var k = keyOf(d);
      if (!buckets[k]) { buckets[k] = { key: k, from: d, to: d, v: zero(), reach: 0 }; order.push(k); }
      buckets[k].to = d;
    }
    accts.forEach(function (acct) {
      var A = mdl.accounts[acct]; if (!A) return;
      Object.keys(A.daily).forEach(function (d) {
        if (d < since || d > until) return;
        addInto(buckets[keyOf(d)].v, A.daily[d]);
      });
    });
    var sp = splitParts(mdl, accts, since, until, keyOf);
    return order.map(function (k) {
      var b = buckets[k], o = vecObj(b.v);
      // exact reach for whole months when the window is stored
      if (grain === 'month') {
        var s = b.from, e = b.to, ex = 0, ok = true;
        accts.forEach(function (acct) { var A = mdl.accounts[acct]; if (!A) return; var r = A.reach[s + '|' + e]; if (r) ex += r[0]; else if (sumImpr(A, s, e) > 0) ok = false; });
        if (ok) o.reach = ex, o.freq = o.reach ? o.impr / o.reach : null;
      }
      o.key = k; o.from = b.from; o.to = b.to;
      return applySplit(o, sp.any, sp.P[k], covered(mdl, accts, b.from, b.to, sp.P[k]));
    });
  }
  function sumImpr(A, s, e) { var t = 0; Object.keys(A.daily).forEach(function (d) { if (d >= s && d <= e) t += A.daily[d][MI.impr]; }); return t; }

  /* Period metrics for each campaign with spend in [since, until].
   * Exact from campaign-daily rows when the window lies inside their coverage,
   * otherwise from monthly rows (exact for month-aligned windows; flagged approx). */
  function campaignsIn(mdl, accts, since, until) {
    var set = {}; accts.forEach(function (a) { set[a] = 1; });
    var out = [], approx = false;
    Object.keys(mdl.campaigns).forEach(function (id) {
      var c = mdl.campaigns[id];
      if (!set[c.acct]) return;
      var r = periodVec(mdl, c, since, until);
      if (r.approx) approx = true;
      if (r.v[MI.spend] > 0 || r.v[MI.impr] > 0) out.push({ c: c, period: vecObj(r.v), life: vecObj(c.m), approx: r.approx });
    });
    out.approx = approx;
    return out;
  }
  function monthAligned(since, until, maxDate) {
    return since === monthStart(since) && (until === monthEnd(until) || until >= (maxDate || until));
  }
  function periodVec(mdl, c, since, until) {
    var t = zero(), approx = false;
    eachPart(mdl, c, since, until, function () { return 'all'; }, function (k, v, f, ap) { addScaled(t, v, f); if (ap) approx = true; });
    return { v: t, approx: approx };
  }
  var MDAYS = {};
  function monthDays(ms) { var a = MDAYS[ms]; if (!a) { a = MDAYS[ms] = []; for (var d = ms, me = monthEnd(ms); d <= me; d = addDays(d, 1)) a.push(d); } return a; }
  function validDate(x) { return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && x >= '2015-01-01'; }
  /* Số của một chiến dịch trong [since, until], gọi cb(key, vec, hệ số, ước tính?, theo ngày?) cho từng phần:
   *  - ngày có số theo ngày của chiến dịch (campd): lấy đúng từng ngày;
   *  - trước đó lấy số theo tháng: tháng nằm trọn trong một khoảng thì lấy nguyên; tháng không trọn thì chia đều cho các ngày chiến dịch chạy
   *    trong tháng (từ ngày bắt đầu đến ngày dừng) và đánh dấu ước tính;
   *  - tháng chứa mốc campd.since: số theo tháng đã gồm cả các ngày campd cung cấp nên chỉ lấy phần còn lại trước mốc. */
  function eachPart(mdl, c, since, until, keyOf, cb) {
    var cd = mdl.campd[c.acct], cut = cd && cd.since, end = until;
    if (cut && until >= cut) {
      var rows = cd.rows[c.id] || {}, s2 = since > cut ? since : cut;
      Object.keys(rows).forEach(function (d) { if (d >= s2 && d <= until) cb(keyOf(d), rows[d], 1, false, true); });
      if (since >= cut) return;
      end = addDays(cut, -1);
    }
    var mo = c.monthly || {}, cutMonth = cut ? cut.slice(0, 7) : '', maxD = mdl.maxDate || '9999-12-31';
    var s0 = validDate(c.s) ? c.s : '', e0 = validDate(c.e) ? c.e : '';
    Object.keys(mo).forEach(function (k) {
      var ms = k + '-01', me = monthEnd(ms);
      if (me < since || ms > end) return;
      var vec = mo[k], top = me;
      if (cut && k === cutMonth && cut > ms && cut <= me) {
        vec = vec.slice(); var cr = cd.rows[c.id] || {};
        Object.keys(cr).forEach(function (d) { if (d >= cut && d <= me) for (var i = 0; i < vec.length; i++) vec[i] -= cr[d][i] || 0; });
        for (var j = 0; j < vec.length; j++) if (vec[j] < 0) vec[j] = 0;
        top = addDays(cut, -1);
      }
      var hiM = top < maxD ? top : maxD;               // ngày cuối cùng của tháng có thể có chi tiêu
      if (since <= ms && end >= hiM && keyOf(ms) === keyOf(hiM)) { cb(keyOf(ms), vec, 1, false, false); return; }
      var cs = s0 > ms ? s0 : ms, ce = e0 && e0 < hiM ? e0 : hiM;
      if (cs > ce) { cs = ms; ce = hiM; }              // ngày bắt đầu/dừng không khớp số liệu: chia đều cả tháng
      var wa = since > cs ? since : cs, wb = end < ce ? end : ce;
      if (wa > wb) return;
      var days = monthDays(ms), N = +ce.slice(8) - +cs.slice(8) + 1, j1 = +wb.slice(8) - 1, rk = null, run = 0;
      for (var q = +wa.slice(8) - 1; q <= j1; q++) {
        var kk = keyOf(days[q]);
        if (kk !== rk) { if (run) cb(rk, vec, run / N, true, false); rk = kk; run = 0; }
        run++;
      }
      if (run) cb(rk, vec, run / N, true, false);
    });
  }
  /* Ads with spend in the window (monthly granularity) */
  function adsIn(mdl, accts, since, until) {
    var set = {}; accts.forEach(function (a) { set[a] = 1; });
    var ms = since.slice(0, 7), me = until.slice(0, 7), out = [];
    var approx = !monthAligned(since, until, mdl.maxDate);
    Object.keys(mdl.ads).forEach(function (id) {
      var a = mdl.ads[id]; if (!set[a.acct]) return;
      var mo = mdl.adm[id], t = zero(), months = mo ? Object.keys(mo) : [];
      if (!mo && !Object.keys(mdl.adm).length) t = a.m.slice();
      else if (months.length && months.every(function (k) { return k >= ms && k <= me; })) t = a.m.slice(); // ran entirely inside: lifetime is exact
      else if (mo) {
        months.forEach(function (k) { if (k >= ms && k <= me) addInto(t, mo[k]); });
        // fields missing from monthly rows: scale lifetime values by the period's share of spend
        var share = a.m[MI.spend] ? t[MI.spend] / a.m[MI.spend] : 0;
        ['ulink', 'p50', 'p75', 'react', 'cmt', 'save', 'share', 'outb'].forEach(function (k) { if (!t[MI[k]] && a.m[MI[k]]) t[MI[k]] = a.m[MI[k]] * share; });
      }
      if (t[MI.spend] > 0 || t[MI.impr] > 0) out.push({ a: a, period: vecObj(t), life: vecObj(a.m) });
    });
    out.approx = approx;
    return out;
  }

  function segLabel(k) { for (var i = 0; i < SEGMENTS.length; i++) if (SEGMENTS[i].k === k) return SEGMENTS[i].label; return k; }

  var api = {
    VERSION: VERSION, START: START, TZ: TZ, ACCOUNTS: ACCOUNTS, M: M, MI: MI, BDM: BDM, BD: BD, SEGMENTS: SEGMENTS,
    num: num, rowsOf: rowsOf, cursorOf: cursorOf, unwrap: unwrap,
    plan: plan, windowsOf: windowsOf, creativeCalls: creativeCalls, normalize: normalize, mergeDocs: mergeDocs,
    segmentOf: segmentOf, segLabel: segLabel, objectiveLabel: objectiveLabel, fold: fold,
    model: model, totals: totals, series: series, isLeadCampaign: isLeadCampaign, splitCpl: splitCpl, periodVec: periodVec, campaignsIn: campaignsIn, adsIn: adsIn, monthAligned: monthAligned, vecObj: vecObj, derive: derive, zero: zero, addInto: addInto,
    dates: { iso: iso, parseISO: parseISO, addDays: addDays, diffDays: diffDays, monthStart: monthStart, monthEnd: monthEnd, prevMonth: prevMonth, todayVN: todayVN, schoolYearStart: schoolYearStart }
  };
  root.FBCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
