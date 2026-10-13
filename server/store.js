// Kho số liệu: collection Firestore `fbads` (mặc định), mỗi tài liệu lưu nguyên văn JSON của một "doc" dashboard
// trong trường `json` (Firestore không cho mảng lồng mảng; lưu chuỗi giữ nguyên định dạng mà trang đã dùng).
// Chỉ máy chủ đọc/ghi (firebase-admin bỏ qua security rules); trình duyệt không truy cập trực tiếp collection này.
import { getDb } from './firebase.js';

export const COLLECTION = () => (process.env.FBADS_COLLECTION || 'fbads').trim();
const MAX = 1000 * 1000; // tài liệu Firestore tối đa 1 MiB

export async function readAll() {
  const snap = await getDb().collection(COLLECTION()).get();
  const docs = {};
  snap.forEach(d => { const v = d.data(); try { docs[d.id] = typeof v.json === 'string' ? JSON.parse(v.json) : v; } catch { /* bỏ qua tài liệu hỏng */ } });
  return docs;
}
export async function writeDocs(docs, { by = 'unknown' } = {}) {
  const db = getDb(), col = db.collection(COLLECTION()), ids = Object.keys(docs);
  const at = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const batch = db.batch();
    for (const id of ids.slice(i, i + 20)) {
      if (!/^[A-Za-z0-9_.~:@+-]{1,200}$/.test(id)) throw Object.assign(new Error('Tên tài liệu không hợp lệ: ' + id), { expose: true, status: 400 });
      const json = JSON.stringify(docs[id]);
      if (json.length > MAX) throw Object.assign(new Error('Tài liệu quá lớn: ' + id), { expose: true, status: 413 });
      batch.set(col.doc(id), { json, at, by });
      written++;
    }
    await batch.commit();
  }
  return written;
}
