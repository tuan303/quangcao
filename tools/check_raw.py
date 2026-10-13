"""Validate one raw Meta Ads result file. Prints row count, pagination cursor and a short fingerprint."""
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception as e:
    print("INVALID_JSON", e); sys.exit(1)
rows = None
for key in ("ad_entities", "creatives", "data", "ad_creatives"):
    if key in d:
        v = d[key]
        rows = json.loads(v) if isinstance(v, str) else v
        break
cursor = None
pg = d.get("pagination") if isinstance(d, dict) else None
if isinstance(pg, dict):
    cursor = pg.get("next_cursor")
cursor = cursor or (d.get("next_cursor") if isinstance(d, dict) else None)
spend = 0.0
if isinstance(rows, list):
    for r in rows:
        a = r.get("amount_spent") if isinstance(r, dict) else None
        if isinstance(a, dict) and a.get("value"):
            spend += float(a["value"])
print(json.dumps({"file": p.split("/")[-1], "keys": list(d.keys()) if isinstance(d, dict) else None,
                  "rows": len(rows) if isinstance(rows, list) else None, "spend_sum": round(spend),
                  "next_cursor": bool(cursor)}, ensure_ascii=False))
