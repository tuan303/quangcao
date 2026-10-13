"""Print the unique creative ids found in one or more raw ad-level files, as a JSON list."""
import json, sys
ids = []
for p in sys.argv[1:]:
    d = json.load(open(p, encoding="utf-8"))
    v = d.get("ad_entities")
    rows = json.loads(v) if isinstance(v, str) else (v or [])
    for r in rows:
        c = r.get("creative_id")
        if c and str(c) not in ids:
            ids.append(str(c))
print(json.dumps(ids))
print("count", len(ids), file=sys.stderr)
