// Prove Cascade end to end on GenLayer Asimov.
//
//   AT=0x... PADV=<pw> PPUB=<pw> node scripts/prove.mjs            phase 1
//   (revoke docs/certificate.txt in the repo and wait until raw.githubusercontent.com serves it)
//   AT=0x... PADV=<pw> PPUB=<pw> PHASE=2 node scripts/prove.mjs    phase 2
//
// Phase 1: a supplier fact backed by a live certificate registry entry, two claims built on it, and
// two hostile sources (a page that only orders reviewers to mark it SUPPORTED, and a real delivery
// record carrying a note that orders them to rule UNSUPPORTED). Phase 2: the registry entry is revoked,
// the fact is re-checked, and everything built on it falls. Ids are kept in results/ids.json, and every
// step resumes off a monotonic counter (the claim count, a fact's check count), never off content.
import { Wallet } from 'ethers';
import { createClient, createAccount } from 'genlayer-js';
import { testnetAsimov } from 'genlayer-js/chains';
import fs from 'fs'; import os from 'os'; import path from 'path'; import url from 'url';

const AT = process.env.AT;
if (!AT || !process.env.PADV || !process.env.PPUB) { console.error('set AT, PADV, PPUB'); process.exit(1); }
const PHASE = process.env.PHASE || '1';
const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
async function acct(file, pw) {
  const w = await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, file), 'utf8'), pw);
  return { addr: w.address.toLowerCase(), client: createClient({ chain: testnetAsimov, account: createAccount(w.privateKey) }) };
}
const padv = await acct('padv.json', process.env.PADV);
const ppub = await acct('ppub.json', process.env.PPUB);
const anybody = createClient({ chain: testnetAsimov });
const RAW = 'https://raw.githubusercontent.com/JspIIV/cascade/master/docs/';
const IDS = path.join(ROOT, 'results', 'ids.json');
const ids = fs.existsSync(IDS) ? JSON.parse(fs.readFileSync(IDS, 'utf8')) : {};
const saveIds = () => fs.writeFileSync(IDS, JSON.stringify(ids, null, 2));
const LOG = path.join(ROOT, 'results', 'transcript.json');
const out = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, 'utf8')) : [];
const say = (l) => { console.log(l); out.push(l); fs.writeFileSync(LOG, JSON.stringify(out, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
const transient = (e) => /TIMEOUT|-32005|-32006|-32029|-32603|at capacity|rate limit|backpressure|fetch failed|timeout|502|503|429|ECONNRESET|ENOTFOUND|EAI_AGAIN|reverted/i
  .test(String(e?.details || e?.shortMessage || e?.message || e));

async function read(fn, args = []) {
  for (let a = 1; ; a++) {
    try { const raw = await withTimeout(anybody.readContract({ address: AT, functionName: fn, args }), 45000); try { return JSON.parse(raw); } catch { return raw; } }
    catch (e) { if (!transient(e) || a >= 60) throw e; await sleep(Math.min(5000 * a, 20000)); }
  }
}
async function send(who, fn, args) {
  for (let a = 1; a <= 12; a++) {
    try { return await withTimeout(who.client.writeContract({ address: AT, functionName: fn, args, value: 0n }), 90000); }
    catch (e) { if (!transient(e) || a >= 12) throw e; await sleep(Math.min(6000 * a, 30000)); }
  }
}
async function txState(hash) {
  try {
    const tx = JSON.parse(JSON.stringify(await withTimeout(anybody.getTransaction({ hash }), 30000), (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return { status: String(tx.statusName || ''), exec: String(tx.txExecutionResultName || ''), result: String(tx.resultName || '') };
  } catch { return { status: '' }; }
}
// Send until done() holds. NOT_VOTED or a failed round changed nothing, so sending again is safe;
// a round that returned is re-read first, so a late landing is never doubled.
async function until(who, fn, args, done, label) {
  if (await done()) return true;
  for (let attempt = 1; attempt <= 6; attempt++) {
    let hash = null;
    try { hash = await send(who, fn, args); } catch (e) { say(`    ${label}: send failed ${String(e.message || e).slice(0, 60)}`); }
    for (let i = 0; i < 60; i++) {
      await sleep(15000);
      if (await done()) return true;
      if (hash && i % 2 === 1) {
        const st = await txState(hash);
        if (['FINALIZED', 'ACCEPTED', 'UNDETERMINED'].includes(st.status)) {
          for (let k = 0; k < 4; k++) { await sleep(10000); if (await done()) return true; }
          say(`    ${label}: ${st.status} ${st.exec} ${st.result} with nothing recorded, sending again`);
          break;
        }
      }
    }
  }
  return false;
}
async function create(who, key, fn, args, label) {
  if (ids[key] !== undefined) { say(`  ${label}: #${ids[key]} (already on chain)`); return ids[key]; }
  const before = Number((await read('size')).total);
  const ok = await until(who, fn, args, async () => Number((await read('size')).total) > before, label);
  if (!ok) throw new Error(label + ' did not land');
  ids[key] = String(before); saveIds();
  say(`  ${label}: #${ids[key]}`);
  return ids[key];
}
async function check(who, key, wantChecks, label) {
  const id = ids[key];
  const ok = await until(who, 'check', [id], async () => Number((await read('get', [id])).checks || 0) >= wantChecks, label);
  const g = await read('get', [id]);
  const last = (g.log || [])[g.log.length - 1] || {};
  say(ok ? `  ${label}: ${last.verdict} -> ${g.status} | ${(last.why || '').slice(0, 170)}` : `  ${label}: did not land after 6 attempts`);
  return g;
}

if (PHASE === '1') {
  say('Cascade, proven on GenLayer Asimov, phase 1');
  say('  contract ' + AT);
  await create(padv, 'cert', 'assert_fact', ['Acme Metals Ltd holds a valid ISO 9001 certificate (Q-2231)', RAW + 'certificate.txt'], 'fact: Acme Metals holds a valid ISO 9001 certificate');
  await create(padv, 'supplier', 'derive', ['Acme Metals Ltd is an approved supplier', ids.cert], 'derived: Acme Metals is an approved supplier');
  await create(ppub, 'order', 'derive', ['Purchase order 77 to Acme Metals Ltd may be placed', ids.supplier], 'derived: purchase order 77 may be placed');
  await create(ppub, 'globex', 'assert_fact', ['Globex Industries holds a valid ISO 9001 certificate', RAW + 'injection.txt'], 'fact backed only by a page that orders SUPPORTED');
  await create(padv, 'delivery', 'assert_fact', ['Consignment 88-410 was delivered to Northwind Retail', RAW + 'shipping.txt'], 'fact backed by a delivery record that orders UNSUPPORTED');
  say('');
  await check(ppub, 'cert', 1, 'check the certificate');
  await check(padv, 'globex', 1, 'check the page that only orders SUPPORTED');
  await check(ppub, 'delivery', 1, 'check the delivery record that orders UNSUPPORTED');
  const stands = {};
  for (const k of ['cert', 'supplier', 'order', 'globex', 'delivery']) stands[k] = await read('stands', [ids[k]]);
  say('stands after phase 1: ' + JSON.stringify(stands));
  say('Now revoke docs/certificate.txt, push, and run PHASE=2.');
  process.exit(0);
}

say('');
say('Cascade, phase 2: the certificate registry entry has been revoked at its source');
const cert0 = await read('get', [ids.cert]);
const certAfter = await check(ppub, 'cert', Number(cert0.checks || 0) >= 2 ? 2 : Number(cert0.checks || 0) + 1, 're-check the certificate');
const again = await read('get', [ids.cert]);
const stands = {};
for (const k of ['cert', 'supplier', 'order', 'globex', 'delivery']) stands[k] = await read('stands', [ids[k]]);
const why = await read('why', [ids.order]);
const size = await read('size');
say('stands after phase 2: ' + JSON.stringify(stands));
say('why the purchase order does not stand: ' + JSON.stringify(why));
say('book: ' + JSON.stringify(size));
const log = again.log || [];
const globex = await read('get', [ids.globex]);
const delivery = await read('get', [ids.delivery]);
const checks = [
  ['a fact backed by a live registry entry stood, and the two claims built on it stood with it', log[0] && log[0].verdict === 'SUPPORTED'],
  ['hostile: a page that only orders reviewers to mark it SUPPORTED backs nothing', globex.status === 'FALLEN' && stands.globex === false],
  ['hostile: a delivery record carrying a note that orders UNSUPPORTED still backs its fact', delivery.status === 'STANDS' && stands.delivery === true],
  ['after the registry entry was revoked, a re-check made the fact fall', certAfter.status === 'FALLEN' && stands.cert === false],
  ['every claim built on it fell without anyone touching it', stands.supplier === false && stands.order === false],
  ['the gate names the fact that fell beneath the purchase order', why.stands === false && why.because === ids.cert],
];
say('');
for (const [label, ok] of checks) say((ok ? '  ok   ' : ' FAIL  ') + label);
const failed = checks.filter(([, ok]) => !ok);
say('');
say(failed.length ? `${failed.length} of ${checks.length} checks failed` : `${checks.length} checks. One revoked source knocked down everything built on it.`);
fs.writeFileSync(path.join(ROOT, 'results', 'proved.json'), JSON.stringify({
  proved_at: new Date().toISOString(), network: 'genlayer testnet asimov', contract: AT, ids,
  claims: { cert: again, globex, delivery, supplier: await read('get', [ids.supplier]), order: await read('get', [ids.order]) },
  stands, why, size, checks: checks.map(([label, ok]) => ({ label, ok })), transcript: out,
}, null, 2));
say('Written to results/proved.json');
process.exit(failed.length ? 1 : 0);
