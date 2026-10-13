// plan.mjs — print the Meta Ads calls for a sync as JSON: [{acct, name, tool, args, file}]
// usage: node plan.mjs <core.js> --today=YYYY-MM-DD --mode=quick|full
import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require(path.resolve(process.argv[2]));
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const today = arg('today') || C.dates.todayVN(), mode = arg('mode') || 'quick';
const COMMON = { advertiser_job: 'report_measure_or_look_up', advertiser_request: 'Đồng bộ dashboard báo cáo quảng cáo Facebook hằng ngày (Số tiền đã chi tiêu, số lead thu được, chi phí trung bình/lead, số lượng tiếp cận, số lượng xem, chi phí trên lượt click)' };
const calls = C.plan(today, { mode }).map(c => ({ ...c, args: { ...c.args, ...COMMON }, file: `${c.acct}__${c.name}.json` }));
console.log(JSON.stringify({ today, mode, count: calls.length, calls }, null, 1));
