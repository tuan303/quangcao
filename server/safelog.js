// Ghi log lỗi bất ngờ mà không lộ dữ liệu: tên lỗi, mã, thông điệp đã xoá phần trong ngoặc kép, dãy chữ số/ngày/số điện thoại (kể cả viết cách nhau) và email, cùng hai dòng đầu của ngăn xếp.
// Dùng cho mọi chỗ in lỗi không do mình viết (lỗi của thư viện, Firestore, mã). Tên người viết trơn trong thông điệp không thể nhận ra được nên không bao giờ được ghép nội dung ô vào thông điệp lỗi.
// Cắt độ dài trước khi lọc (các biểu thức chính quy không bị chậm trên chuỗi rất dài), bỏ mọi thứ sau dấu nháy đầu tiên của lỗi phân tích JSON (Node chèn một đoạn của đầu vào vào thông điệp),
// và coi mọi chữ số Unicode (kể cả số toàn chiều rộng) là chữ số.
const cutJson = t => /JSON|Unexpected (?:token|end)/.test(t) ? t.replace(/\s*["'`][\s\S]*$/, ' …') : t;
export const scrub = s => cutJson(String(s).slice(0, 600)).replace(/"[^"]*(?:"|$)/g, '"…"').replace(/\p{Nd}[\p{Nd}\s.\-()+/]{4,}\p{Nd}/gu, '#').replace(/\p{Nd}{6,}/gu, '#').replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '@').slice(0, 160);
// Chỉ lấy các dòng khung gọi thật của ngăn xếp ("at …"): một thông điệp nhiều dòng không được lọt vào log qua phần ngăn xếp; tên lỗi và mã cũng qua bộ lọc.
export const describeUnknown = e => [e && scrub(String(e.name || '')).slice(0, 40), e && e.code != null && scrub(String(e.code)).slice(0, 40), scrub(e && e.message || '')].filter(Boolean).join(' | ') + ' @ ' + String(e && e.stack || '').split('\n').filter(l => /^\s*at /.test(l)).slice(0, 2).map(l => scrub(l.trim()).slice(0, 100)).join(' <- ');
