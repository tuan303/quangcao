// Viết phần "Phân tích & đề xuất" bằng Claude từ gói số liệu (server/pack.js) và mặt bằng ngành (benchmarks.js).
// Cần ANTHROPIC_API_KEY trên Vercel. Mô hình mặc định claude-opus-5-5 (đổi bằng INSIGHTS_MODEL nếu cần).
import Anthropic from '@anthropic-ai/sdk';
import baseSchema from './insights-schema.js';

export const MODEL = (process.env.INSIGHTS_MODEL || 'claude-opus-5-5').trim();
// medium: đủ sâu cho bài phân tích và viết xong trong giới hạn 300 giây của Vercel; đổi bằng INSIGHTS_EFFORT (low | medium | high)
const EFFORT = /^(low|medium|high)$/.test(String(process.env.INSIGHTS_EFFORT || '').trim()) ? process.env.INSIGHTS_EFFORT.trim() : 'medium';
const SERVER_FIELDS = ['v', 'updatedAt', 'updatedLabel', 'dataUntil']; // do máy chủ điền, không để mô hình tự viết

/** Schema cho structured outputs: mọi object có additionalProperties:false; bỏ các ràng buộc API không hỗ trợ (minItems/maxItems…) – kiểm tra lại ở validate(). */
function strictify(s) {
  if (Array.isArray(s)) return s.map(strictify);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictify(pv)])) : strictify(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}
export function outputSchema() {
  const props = Object.fromEntries(Object.entries(baseSchema.properties).filter(([k]) => !SERVER_FIELDS.includes(k)));
  props.benchmark = {
    type: 'object', required: ['summary', 'points'],
    description: 'So sánh với mặt bằng quảng cáo ngành giáo dục, dựa trên benchmark_comparison trong gói số liệu',
    properties: {
      summary: { type: 'string', description: '1–2 câu: nhìn chung trường đang tốt hơn hay kém hơn mặt bằng ngành, ở chỉ số nào' },
      points: { type: 'array', items: { type: 'string' }, description: '3–5 ý, mỗi ý nêu chỉ số, số của trường, khoảng tham chiếu, nguồn và ý nghĩa' }
    }
  };
  return strictify({ type: 'object', required: baseSchema.required.filter(k => !SERVER_FIELDS.includes(k)).concat(['benchmark']), properties: props });
}

const SYSTEM = `Bạn là chuyên gia phân tích quảng cáo Facebook/Instagram cho một trường tư thục liên cấp ở Hà Nội (Trường Tiểu học, THCS & THPT Ngôi Sao Hoàng Mai).
Người đọc: Chủ tịch Hội đồng quản trị (đọc lướt, cần kết luận và việc phải làm) và Ban Truyền thông (cần chi tiết để làm). Bản phân tích này thay cho báo cáo hằng ngày gửi Chủ tịch.

Quy tắc:
- Viết tiếng Việt, câu ngắn, rõ, giọng chuyên nghiệp, không sáo rỗng, không dùng thuật ngữ tiếng Anh khi có từ tiếng Việt (giữ CPM, CTR, CPC nếu cần, giải thích lần đầu).
- Mọi con số phải lấy đúng từ gói số liệu (JSON) được cung cấp. Không tự tính phép tính mới ngoài so sánh phần trăm đơn giản giữa hai số có sẵn; không bịa số, không bịa sự kiện về trường.
- Tiền viết dạng 48.083 ₫ hoặc 10,26 triệu ₫. Tỉ lệ viết 4,45%. Ngày viết dd/mm/yyyy.
- Luôn so sánh: 7 ngày qua với 7 ngày trước đó, 30 ngày qua với 30 ngày trước đó, năm học này với cùng kỳ năm học trước khi có số.
- So sánh với mặt bằng ngành giáo dục chỉ dựa trên benchmark_comparison; luôn nêu nguồn và lưu ý đây là khoảng tham chiếu, không phải chuẩn tuyệt đối (khác thị trường, mục tiêu chiến dịch, thời điểm). Nhà trường chỉ muốn so với ngành giáo dục tại Việt Nam: dùng benchmark_comparison.meta (so sánh của chính Meta với các trường học, mầm non cùng chạy quảng cáo thu lead; rel là % cao/thấp hơn mặt bằng, chỉ cho một nhóm quảng cáo, ghi rõ ngày) và các khoảng tham chiếu tại Việt Nam trong benchmark_comparison.rows; không đưa số toàn cầu hay của nước khác. Các nguồn Việt Nam là blog agency, độ tin cậy thấp, phải nói rõ; dòng có kind = 'case' chỉ là một ví dụ (một trung tâm), không gọi là mặt bằng. Chỉ số có school = null là chưa đủ số, không kết luận.
- Nếu sync.accounts_missing hoặc sync.lead_loss có tài khoản, nói rõ số liệu của tài khoản đó có thể chưa đầy đủ, và đừng kết luận mạnh từ phần thiếu đó.
- Đề xuất phải cụ thể: làm gì, ai làm, khi nào, kỳ vọng tác động (bằng số khi có cơ sở). Ưu tiên việc tác động lớn tới số lead và chi phí/lead.
- Tiêu đề (headline) ≤ 110 ký tự, nêu điều quan trọng nhất của hôm nay.
- highlights đúng 4 mục; evaluations đúng 6 mục theo thứ tự đã mô tả; recommendations 6–8 mục; pillars 5–6; calendar 4 tuần bắt đầu từ tuần sau; tests 3–4; audience 4–6; targets 4–6; method 3–5 (nêu nguồn số liệu, cách tính lead, giới hạn).`;

/** Kiểm tra số lượng mục mà schema của API không ràng buộc được. Trả về danh sách lỗi (rỗng nếu ổn). */
export function validate(o) {
  const errs = [], len = k => (Array.isArray(o[k]) ? o[k].length : -1);
  const want = { highlights: [4, 4], evaluations: [6, 6], recommendations: [6, 8], pillars: [5, 6], calendar: [4, 4], tests: [3, 4], audience: [4, 6], targets: [4, 6], method: [3, 5] };
  for (const [k, [a, b]] of Object.entries(want)) { const n = len(k); if (n < a || n > b) errs.push(k + ': ' + n + ' mục (cần ' + a + (a === b ? '' : '–' + b) + ')'); }
  if (!o.headline || !o.summary) errs.push('thiếu headline/summary');
  if (o.budget && Array.isArray(o.budget.split)) { const t = o.budget.split.reduce((s, x) => s + (Number(x.pct) || 0), 0); if (Math.abs(t - 100) > 2) errs.push('budget.split cộng ' + t + '%'); }
  return errs;
}

/** Gọi Claude, trả về object nhận định (chưa có các trường máy chủ). */
export async function writeInsights(pack, { timeoutMs = 240000, effort = EFFORT } = {}) {
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 2 });
  const signal = AbortSignal.timeout(timeoutMs); // hạn chung cho cả các lần thử lại, để hàm Vercel không bị cắt giữa chừng
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // Meta quảng cáo trường học: hiếm khi bị từ chối, nhưng nếu có thì Anthropic tự chuyển sang mô hình dự phòng
    output_config: { effort, format: { type: 'json_schema', schema: outputSchema() } },
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Gói số liệu hôm nay (JSON):\n' + JSON.stringify(pack) + '\n\nViết bản phân tích theo đúng schema.' }]
  }, { signal });
  let msg;
  try { msg = await stream.finalMessage(); } catch (e) {
    if (signal.aborted) throw Object.assign(new Error('Claude chưa viết xong trong ' + Math.round(timeoutMs / 1000) + ' giây. Thử lại sau ít phút.'), { expose: true, status: 504 });
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude từ chối viết phân tích (' + ((msg.stop_details && msg.stop_details.category) || 'không rõ lý do') + ').'), { expose: true, status: 502 });
  if (msg.stop_reason === 'max_tokens') throw Object.assign(new Error('Bản phân tích bị cắt do quá dài. Thử lại.'), { expose: true, status: 502 });
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw Object.assign(new Error('Claude trả về dữ liệu không đọc được. Thử lại.'), { expose: true, status: 502 }); }
  return { insights: out, usage: msg.usage, model: msg.model };
}
