// batches.mjs — group docs into ArtifactData batch writes (<=50 entries, <=~900 KB each).
// usage: node batches.mjs <outDir> [versions.json]   versions.json: {"<docId>": <version>} for docs that already exist
import fs from 'node:fs'; import path from 'node:path';
const [outDir, verPath] = process.argv.slice(2);
// versions: a JSON map, or a folder written by ArtifactData list/get with out_dir (files hold {id, data, version})
let versions = {};
if (verPath && fs.existsSync(verPath)) {
  if (fs.statSync(verPath).isDirectory()) {
    for (const f of fs.readdirSync(verPath).filter(f => f.endsWith('.json'))) { const j = JSON.parse(fs.readFileSync(path.join(verPath, f), 'utf8')); if (j && j.version) versions[j.id || f.replace(/\.json$/, '')] = j.version; }
  } else versions = JSON.parse(fs.readFileSync(verPath, 'utf8'));
}
const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json')).sort((a, b) => (a === 'meta.json') - (b === 'meta.json')); // meta last
const batches = []; let cur = [], size = 0;
for (const f of files) {
  const id = f.replace(/\.json$/, ''), s = fs.statSync(path.join(outDir, f)).size + 200;
  if (cur.length && (cur.length >= 50 || size + s > 900000)) { batches.push(cur); cur = []; size = 0; }
  const e = { op: 'set', collection: 'fb', doc_id: id, file_path: path.resolve(outDir, f) };
  if (versions[id]) e.if_version = versions[id];
  cur.push(e); size += s;
}
if (cur.length) batches.push(cur);
console.log(JSON.stringify(batches));
