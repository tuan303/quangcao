// POST /api/ingest – Claude (tác vụ đồng bộ hằng ngày trên máy quản trị) đẩy số liệu đã kiểm tra lên Firestore.
//   Authorization: Bearer <INGEST_SECRET>;  body: { docs: { docId: body, … } }  (tối đa ~4 MB mỗi lần gửi)
import { authorize } from '../server/auth.js';
import { send, safeError, readJson } from '../server/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Chỉ hỗ trợ POST.' });
  try {
    const who = await authorize({ authorization: req.headers.authorization, allowSecrets: ['ingest'], verifyIdToken: async () => { throw new Error('no user tokens here'); } });
    if (!who.ok || who.kind !== 'ingest') return send(res, 401, { ok: false, error: 'Sai hoặc thiếu INGEST_SECRET.' });
    const body = await readJson(req);
    const docs = body && body.docs;
    if (!docs || typeof docs !== 'object' || Array.isArray(docs) || !Object.keys(docs).length) return send(res, 400, { ok: false, error: 'Thiếu docs.' });
    const { writeDocs } = await import('../server/store.js');
    const written = await writeDocs(docs, { by: 'claude-ingest' });
    send(res, 200, { ok: true, written });
  } catch (e) {
    console.error('[ingest]', e);
    send(res, e.status || 500, { ok: false, error: safeError(e) });
  }
}
