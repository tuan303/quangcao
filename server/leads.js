// Lấy lead (phụ huynh đã điền biểu mẫu) từ Facebook qua Graph API: Trang → biểu mẫu → lead, kèm chiến dịch, để đối chiếu với học sinh đã đóng phí.
// Cần token System User (META_ACCESS_TOKEN) có thêm quyền đọc lead: leads_retrieval, pages_show_list, pages_read_engagement, pages_manage_ads,
// và người dùng hệ thống được gán Trang (có quyền Truy cập khách hàng tiềm năng). Meta chỉ giữ lead 90 ngày: số điện thoại, email trong lead
// chỉ nằm trong bộ nhớ lúc đối chiếu, không bao giờ ghi vào kho số liệu hay log.
import { graph, allPages, msLeft } from './meta.js';

const LEAD_FIELDS = ['id', 'created_time', 'ad_id', 'adset_id', 'campaign_id', 'campaign_name', 'form_id', 'is_organic', 'field_data'];
const DROPPABLE = ['campaign_id', 'campaign_name', 'adset_id', 'is_organic']; // trường Graph có thể từ chối (#100): bỏ đi và thử lại
const MAX_LEADS = 40000, MAX_PAGES_PER_FORM = 300;
export const MAX_FORMS = 60;                                    // số biểu mẫu có lead tối đa của một lần đọc (đọc tuần tự trong hạn mức thời gian)
const PROBE_MARGIN_MS = 8000;                                    // không bắt đầu đọc thử biểu mẫu mới khi còn dưới 8 giây (Kiểm tra kết nối)
const FORMS_HINT = ' Xoá các biểu mẫu cũ không còn dùng trong Meta (Quản lý Trang → Công cụ quảng cáo khách hàng tiềm năng; biểu mẫu chỉ lưu trữ vẫn có thể được tính) rồi thử lại, hoặc nhờ người phụ trách nâng giới hạn.';
const FORM_GONE = new Set([100, 200, 10, 299]);   // lỗi chắc chắn của riêng một biểu mẫu (không còn / không đọc được): chỉ khi đó mới được bỏ qua biểu mẫu đã lưu trữ
const PAGE_HINT = ' Nếu Trang này không phải của trường, đặt biến META_PAGE_IDS = ID Trang của trường (nhiều Trang cách nhau bằng dấu phẩy) để bỏ qua các Trang khác.';
const RECENT_DAYS = 80;                            // biểu mẫu tạo trong khoảng này còn đủ mọi lead (Meta giữ lead 90 ngày): dùng để đối chiếu số lead đọc được với leads_count
export const NO_LEADS_HINT = 'thường do ứng dụng Meta đang ở chế độ Development (chỉ thấy lead của người có vai trò trong ứng dụng), thiếu quyền Leads access, hoặc token chưa có leads_retrieval. Chuyển ứng dụng sang chế độ Live, kiểm tra quyền rồi thử lại.';
const formRecent = f => { const t = Date.parse(f && f.created_time); return Number.isFinite(t) && t > Date.now() - RECENT_DAYS * 86400000; };
const fail = (message, extra = {}) => Object.assign(new Error(message), { expose: true, status: 502 }, extra);

/** Lỗi Meta → câu tiếng Việt nói rõ cần làm gì. */
export function explainMeta(e, what) {
  const m = e && e.meta || {}, code = m.code, msg = String(m.message || e && e.message || '');
  const perm = 'Token chưa đủ quyền đọc lead: cần leads_retrieval, pages_show_list, pages_read_engagement, pages_manage_ads, và người dùng hệ thống phải được gán Trang (kèm "Truy cập khách hàng tiềm năng").';
  if (code === 190) return 'Token Meta hết hạn hoặc không hợp lệ: tạo lại token System User rồi cập nhật META_ACCESS_TOKEN.';
  if (code === 200 || code === 10 || code === 299 || /leads_retrieval|pages_read_engagement|pages_manage_ads|pages_show_list|permission/i.test(msg)) return perm + ' (' + what + (typeof code === 'number' ? ', mã ' + code : '') + ')';
  if (code === 100 && /nonexisting field|does not exist|unsupported get request/i.test(msg)) return 'Meta không cho đọc ' + what + ' bằng token này (Trang sai hoặc người dùng hệ thống chưa được gán Trang).';
  if (e && e.meta && e.meta.code === 'timeout') return 'Meta không phản hồi kịp khi lấy ' + what + '.';
  if (e && e.meta && e.meta.code === 'badshape') return 'Meta trả dữ liệu sai dạng khi lấy ' + what + ': thử lại sau.';
  if (e && e.meta && e.meta.code === 'badtoken') return e.message;
  if (e && e.meta && e.meta.code === 'truncated') return 'Danh sách ' + what + ' dài bất thường: dừng để không lấy thiếu. Kiểm tra lại Trang/biểu mẫu hoặc rút ngắn khoảng thời gian.';
  return 'Meta báo lỗi khi lấy ' + what + (code ? ' (mã ' + code + ')' : '') + '.';
}

/** Trang cần đọc lead: META_PAGE_IDS nếu có; không thì các Trang quảng cáo của hai tài khoản (promote_pages); không thì các Trang người dùng hệ thống được gán. */
export async function pagesOf({ token, accts = [], env = process.env }) {
  const listed = [...new Set(String(env.META_PAGE_IDS || '').split(/[\s,;]+/).map(s => s.replace(/\D/g, '')).filter(Boolean))];
  if (listed.length) return { pages: listed.map(id => ({ id, name: '' })), source: 'META_PAGE_IDS', errors: [] };
  // Hoặc đủ hoặc báo lỗi: một tài khoản quảng cáo không liệt kê được Trang thì sẽ thiếu im lặng toàn bộ lead của Trang đó, nên dừng và bảo đặt META_PAGE_IDS.
  const errors = [], seen = new Map(), hint = ' Hoặc đặt biến META_PAGE_IDS (ID Trang Facebook của trường) để không phụ thuộc bước này.';
  for (const a of accts) {
    try { for (const p of await allPages('act_' + a + '/promote_pages', { fields: 'id,name', limit: 100 }, token, 5, { strict: true })) if (p && p.id) seen.set(String(p.id), String(p.name || '')); }
    catch (e) { throw fail(explainMeta(e, 'danh sách Trang của tài khoản quảng cáo ' + a) + hint, { meta: e.meta }); }
  }
  if (seen.size) return { pages: [...seen].map(([id, name]) => ({ id, name })), source: 'tài khoản quảng cáo', errors };
  try { for (const p of await allPages('me/accounts', { fields: 'id,name', limit: 100 }, token, 5, { strict: true })) if (p && p.id) seen.set(String(p.id), String(p.name || '')); }
  catch (e) { throw fail(explainMeta(e, 'danh sách Trang của người dùng hệ thống') + hint, { meta: e.meta }); }
  return { pages: [...seen].map(([id, name]) => ({ id, name })), source: 'người dùng hệ thống', errors };
}
async function pageToken(pageId, token) {
  let j;
  try { j = await graph(pageId, { fields: 'access_token,name' }, token); } catch (e) { throw fail(explainMeta(e, 'quyền của Trang ' + pageId), { meta: e.meta }); }
  if (!j || !j.access_token) throw fail('Meta không cấp quyền Trang cho token này (Trang ' + pageId + '): gán Trang cho người dùng hệ thống trong Business Settings (quyền quản lý Trang và Truy cập khách hàng tiềm năng).');
  return { token: j.access_token, name: String(j.name || '') };
}
async function formsOf(pageId, ptoken) {
  try { return await allPages(pageId + '/leadgen_forms', { fields: 'id,name,status,leads_count,created_time', limit: 100 }, ptoken, 20, { strict: true }); }
  catch (e) { throw fail(explainMeta(e, 'danh sách biểu mẫu của Trang ' + pageId), { meta: e.meta }); }
}
/** Lead của một biểu mẫu từ thời điểm sinceUnix (giây). Trường Graph không có thì bỏ đi và thử lại. */
async function leadsOfForm(formId, ptoken, sinceUnix, fields) {
  const params = { limit: 100, filtering: sinceUnix ? [{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }] : undefined };
  for (let tries = 0; tries < 5; tries++) {
    params.fields = fields.join(',');
    try { return await allPages(formId + '/leads', params, ptoken, MAX_PAGES_PER_FORM, { strict: true }); }
    catch (e) {
      const bad = e.meta && e.meta.code === 100 && DROPPABLE.find(f => fields.includes(f) && new RegExp('\\b' + f + '\\b').test(String(e.meta.message || '')));
      if (bad) { fields.splice(fields.indexOf(bad), 1); continue; }
      throw fail(explainMeta(e, 'lead của biểu mẫu ' + formId), { meta: e.meta });
    }
  }
  throw fail('Meta liên tục từ chối các trường lead.');
}
/* Lead thiếu campaign_id nhưng có ad_id: tra chiến dịch của quảng cáo (một lần cho nhiều quảng cáo). Một quảng cáo không đọc được (đã xoá, không quyền) làm hỏng cả lô,
   nên lô lỗi được chia đôi để các quảng cáo còn lại vẫn tra được (tối đa CAMPAIGN_CALLS lần gọi). Còn không tra được thì để nguyên (lead hiện "chưa rõ chiến dịch"). */
const CAMPAIGN_CALLS = 120;
async function fillCampaigns(leads, token) {
  const need = [...new Set(leads.filter(l => l.ad_id && (!l.campaign_id || !l.campaign_name)).map(l => String(l.ad_id)))];
  if (!need.length) return 0;
  const map = {}; let calls = 0;
  async function look(ids) {
    if (!ids.length || calls >= CAMPAIGN_CALLS) return;
    calls++;
    let j;
    try { j = await graph('', { ids: ids.join(','), fields: 'campaign_id,campaign{id,name}' }, token); }
    catch (e) {
      if (e && e.meta && e.meta.code === 'timeout') return;                    // hết giờ: không thử thêm
      if (ids.length > 1) { const h = Math.ceil(ids.length / 2); await look(ids.slice(0, h)); await look(ids.slice(h)); }
      return;                                                                  // một quảng cáo lẻ không đọc được: bỏ qua
    }
    for (const k of Object.keys(j || {})) if (j[k] && j[k].campaign_id) map[k] = { id: String(j[k].campaign_id), name: String(j[k].campaign && j[k].campaign.name || '') };
  }
  for (let i = 0; i < need.length; i += 50) await look(need.slice(i, i + 50));
  let n = 0;
  for (const l of leads) {
    const m = map[String(l.ad_id)]; if (!m) continue;
    if (!l.campaign_id) { l.campaign_id = m.id; l.campaign_name = l.campaign_name || m.name; n++; }
    else if (!l.campaign_name && m.name && String(l.campaign_id) === m.id) { l.campaign_name = m.name; n++; }
  }
  return n;
}

/**
 * Lấy mọi lead từ ngày `sinceDay` (YYYY-MM-DD, giờ Việt Nam) của các Trang. Hoặc lấy đủ, hoặc báo lỗi: không bao giờ trả một phần
 * (một biểu mẫu thiếu sẽ làm các ngày trong cửa sổ bị ghi đè bằng số hụt).
 * check: số lead mà các biểu mẫu mới tạo báo có (expected) và số lead thật sự đọc được từ chúng (got): got = 0 trong khi expected > 0 là dấu hiệu Meta không cho đọc lead (ứng dụng ở chế độ Development, thiếu quyền Leads access).
 * unresolved: số lead quảng cáo vẫn chưa biết chiến dịch sau khi tra theo quảng cáo.
 * @returns {Promise<{leads: object[], pages: number, forms: number, skippedForms: number, source: string, check: {expected: number, got: number}, unresolved: number}>}
 */
export async function fetchLeads({ token, accts = [], sinceDay, env = process.env }) {
  const sinceUnix = sinceDay ? Math.floor(Date.parse(sinceDay + 'T00:00:00+07:00') / 1000) - 86400 : 0; // lùi một ngày để không sót lead sát mốc
  const { pages, source, errors } = await pagesOf({ token, accts, env });
  if (!pages.length) throw fail(errors[0] || 'Không tìm thấy Trang Facebook nào để đọc lead. Đặt biến META_PAGE_IDS (ID Trang) hoặc gán Trang cho người dùng hệ thống.');
  const leads = [], seenId = new Set(); let forms = 0, counted = 0, skipped = 0, expected = 0, got = 0;       // forms: biểu mẫu có lead; counted: những biểu mẫu tính vào giới hạn MAX_FORMS (không gồm biểu mẫu bị bỏ qua)
  for (const p of pages) {
    let pt, fl;
    try { pt = await pageToken(p.id, token); fl = await formsOf(p.id, pt.token); }
    catch (e) { if (source !== 'META_PAGE_IDS' && e && e.expose) e.message += PAGE_HINT; throw e; }       // Trang tự tìm ra (không phải do quản trị liệt kê) mà token không đọc được: nói cách loại Trang đó ra
    for (const f of fl) {
      if (f.leads_count === 0 || f.leads_count === '0') continue;                  // chỉ bỏ biểu mẫu báo đúng 0 lead (null, rỗng, thiếu thì vẫn đọc)
      forms++;
      if (++counted > MAX_FORMS) throw fail('Có quá nhiều biểu mẫu lead (hơn ' + MAX_FORMS + ' biểu mẫu có lead).' + FORMS_HINT);
      let rows;
      try { rows = await leadsOfForm(f.id, pt.token, sinceUnix, LEAD_FIELDS.slice()); }
      catch (e) { if (/^(ARCHIVED|DELETED)$/i.test(String(f.status || '')) && e && e.meta && FORM_GONE.has(e.meta.code)) { skipped++; counted--; continue; } throw e; }   // biểu mẫu bị bỏ qua không tính vào giới hạn số biểu mẫu
 // biểu mẫu đã lưu trữ mà Meta chắc chắn không cho đọc: bỏ qua; mọi lỗi khác (hết giờ, 5xx, giới hạn tần suất…) hay biểu mẫu đang dùng lỗi thì dừng cả lần
      if (formRecent(f)) { expected += Number(f.leads_count) || 0; got += rows.length; }
      for (const l of rows) { if (!l || !l.id || seenId.has(l.id)) continue; seenId.add(l.id); leads.push(l); }
      if (leads.length > MAX_LEADS) throw fail('Quá nhiều lead (hơn ' + MAX_LEADS + ') trong khoảng thời gian đọc.');
    }
  }
  await fillCampaigns(leads, token);
  const unresolved = leads.filter(l => l.ad_id && !l.campaign_id).length;                 // lead quảng cáo vẫn chưa biết chiến dịch (tra cứu lỗi, hết giờ hay quá hạn mức): để chốt chặn ở runLeadSync quyết định
  return { leads, pages: pages.length, forms, skippedForms: skipped, source, check: { expected, got }, unresolved };
}

/**
 * Kiểm tra từng bước (không in nội dung lead): quyền của token, Trang, biểu mẫu, đọc thử một lead.
 * @returns {Promise<{steps: {id:string, ok:boolean, text:string}[], pages:{id:string,name:string,forms:number,leads:number}[]}>}
 */
export async function checkLeads({ token, accts = [], env = process.env }) {
  const steps = [], out = { steps, pages: [] }, add = (id, ok, text) => steps.push({ id, ok, text });
  if (!token) { add('token', false, 'Chưa cấu hình META_ACCESS_TOKEN.'); return out; }
  add('token', true, 'Có token Meta.');
  try {
    const perms = await allPages('me/permissions', { limit: 100 }, token, 2), granted = new Set(perms.filter(p => p.status === 'granted').map(p => p.permission));
    if (granted.size) {
      const need = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'], miss = need.filter(p => !granted.has(p));
      add('permissions', !miss.length, miss.length ? 'Token còn thiếu quyền: ' + miss.join(', ') + '.' : 'Token có đủ quyền đọc lead.');
    }
  } catch (e) { /* token System User có thể không liệt kê quyền: các bước sau sẽ cho biết */ }
  let found;
  try { found = await pagesOf({ token, accts, env }); } catch (e) { add('pages', false, e && e.expose ? e.message : explainMeta(e, 'danh sách Trang')); return out; }
  if (!found.pages.length) { add('pages', false, found.errors[0] || 'Không tìm thấy Trang Facebook nào. Đặt META_PAGE_IDS hoặc gán Trang cho người dùng hệ thống.'); return out; }
  add('pages', true, 'Thấy ' + found.pages.length + ' Trang (nguồn: ' + found.source + ').');
  let probed = 0, withLeads = 0, notProbed = 0; const problems = [];                                      // đọc thử đủ mọi biểu mẫu mà lần cập nhật thật đọc (tối đa MAX_FORMS), dừng khi sắp hết giờ
  for (const p of found.pages) {
    let pt, fl;
    const hint = found.source !== 'META_PAGE_IDS' ? PAGE_HINT : '';
    try { pt = await pageToken(p.id, token); } catch (e) { add('page-' + p.id, false, e.message + hint); continue; }
    try { fl = await formsOf(p.id, pt.token); } catch (e) { add('page-' + p.id, false, e.message + hint); continue; }
    const total = fl.reduce((s, f) => s + (Number(f.leads_count) || 0), 0);
    out.pages.push({ id: p.id, name: pt.name || p.name, forms: fl.length, leads: total });
    add('page-' + p.id, true, 'Trang "' + (pt.name || p.name || p.id) + '": ' + fl.length + ' biểu mẫu, ' + total + ' lead.');
    // đọc thử một lead của từng biểu mẫu có lead, theo đúng quy tắc của lần cập nhật thật (kể cả giới hạn số biểu mẫu)
    for (const f of fl.filter(x => !(x.leads_count === 0 || x.leads_count === '0'))) {
      withLeads++;
      if (probed >= MAX_FORMS || msLeft() < PROBE_MARGIN_MS) { notProbed++; continue; }
      try {
        const r = await graph(f.id + '/leads', { fields: 'id,created_time', limit: 1 }, pt.token); probed++;
        if (!(r.data || []).length && formRecent(f) && Number(f.leads_count) > 0) problems.push('Biểu mẫu mới tạo báo có ' + (Number(f.leads_count) || 0) + ' lead nhưng Meta không trả lead nào: ' + NO_LEADS_HINT);
      } catch (e) {
        if (/^(ARCHIVED|DELETED)$/i.test(String(f.status || '')) && e && e.meta && FORM_GONE.has(e.meta.code)) { withLeads--; continue; }       // biểu mẫu đã lưu trữ chắc chắn không đọc được: lần cập nhật thật cũng bỏ qua và không tính vào giới hạn
        problems.push(explainMeta(e, 'lead của biểu mẫu'));
      }
    }
  }
  const over = withLeads > MAX_FORMS, cut = !over && notProbed > 0 ? ' Mới đọc thử ' + probed + '/' + withLeads + ' biểu mẫu có lead trước khi hết thời gian nên chưa xác nhận được các biểu mẫu còn lại: bấm Kiểm tra kết nối lại (hoặc Cập nhật ngay: lần cập nhật báo rõ biểu mẫu nào không đọc được).' : '';
  if (over) problems.unshift('Có ' + withLeads + ' biểu mẫu có lead, vượt giới hạn ' + MAX_FORMS + ' của một lần đọc: mọi lần cập nhật sẽ dừng.' + FORMS_HINT);
  if (problems.length) add('leads', false, problems[0] + (problems.length > 1 ? ' (và ' + (problems.length - 1) + ' biểu mẫu khác cùng lỗi)' : '') + cut);
  else if (cut) add('leads', false, cut.trim());
  else if (probed) add('leads', true, 'Đọc thử lead thành công ở ' + probed + ' biểu mẫu.');
  else add('leads', false, 'Chưa có biểu mẫu nào có lead để đọc thử.');
  return out;
}
