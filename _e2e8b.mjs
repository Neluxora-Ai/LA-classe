import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import fs from 'node:fs';
process.loadEnvFile('.env');
const { default: register } = await import('./api/register.js');
const URL_ = process.env.SUPABASE_URL;
const anon = fs.readFileSync('public/config.js', 'utf8').match(/SUPABASE_ANON_KEY: '([^']+)'/)[1];
const admin = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const mail = (p) => crypto.createHash('sha256').update(p.toLowerCase()).digest('hex').slice(0, 40) + '@pseudo.classe.app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, failc = 0;
const check = (n, c, x = '') => { c ? pass++ : failc++; console.log((c ? 'OK   ' : 'FAIL ') + n + (x ? '  -> ' + x : '')); };
const PW = 'motdepasse-e2e-9';
const limitsBefore = (await admin.from('app_limits').select('key, value')).data;
async function cleanup() {
  await admin.from('app_limits').upsert(limitsBefore, { onConflict: 'key' });
  for (const u of (await admin.auth.admin.listUsers({ perPage: 200 })).data.users) {
    const t = await admin.from('profiles').select('pseudo').eq('id', u.id).maybeSingle();
    if (t.data?.pseudo?.toLowerCase().startsWith('zz-')) await admin.auth.admin.deleteUser(u.id);
  }
  console.log(`\nResultat : ${pass} reussis, ${failc} echecs. Limites restaurees : ${JSON.stringify((await admin.from('app_limits').select('key, value')).data)}. Comptes : ${(await admin.auth.admin.listUsers({ perPage: 200 })).data.users.length}.`);
}
process.on('uncaughtException', async (e) => { console.log('ERREUR NON PREVUE :', String(e.message).slice(0, 120)); failc++; await cleanup(); process.exit(1); });
try {
  await admin.from('app_limits').update({ value: 40 }).eq('key', 'max_accounts');
  const o = {}; const res = { setHeader() {}, status(c) { o.s = c; return res; }, json(b) { o.b = b; return res; } };
  await register({ method: 'POST', body: JSON.stringify({ pseudo: 'zz-rt', password: PW, code: process.env.CLASS_CODE }), headers: {} }, res);
  if (o.s !== 200) throw new Error('register ' + JSON.stringify(o));
  const authC = createClient(URL_, anon, { auth: { persistSession: false } });
  const { data } = await authC.auth.signInWithPassword({ email: mail('zz-rt'), password: PW });
  const uid = data.user.id;
  await authC.realtime.setAuth(data.session.access_token);

  // join helper : on attend l'etat, puis on ferme APRES (pas dans le callback)
  const join = (client, name, priv) => new Promise((resolve) => {
    const chn = client.channel(name, { config: { private: priv } });
    const t = setTimeout(() => resolve({ status: 'timeout', chn }), 7000);
    chn.subscribe((s, err) => { if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) { clearTimeout(t); resolve({ status: s, err: err?.message, chn }); } });
  });
  const anonC = createClient(URL_, anon, { auth: { persistSession: false } });
  const ra = await join(anonC, 'presence-v2', true);
  check('Visiteur SANS compte : canal PRIVE refuse', ra.status !== 'SUBSCRIBED', `${ra.status} ${ra.err || ''}`);
  const rb = await join(authC, 'presence-v2', true);
  check('Compte connecte : canal PRIVE accepte', rb.status === 'SUBSCRIBED', `${rb.status} ${rb.err || ''}`);
  setTimeout(() => { anonC.removeChannel(ra.chn); authC.removeChannel(rb.chn); }, 50);
  await sleep(300);

  // presence reelle (comme le site) puis un espion en canal public
  const legit = authC.channel('presence-v2', { config: { private: true, presence: { key: uid } } });
  await new Promise((r) => legit.subscribe((s) => s === 'SUBSCRIBED' && r()));
  await legit.track({ uid });
  await sleep(1000);
  const spyC = createClient(URL_, anon, { auth: { persistSession: false } });
  let seen = '', joined = false;
  const sp = spyC.channel('presence-v2', { config: { presence: { key: 'espion' } } });
  sp.on('presence', { event: 'sync' }, () => { seen = JSON.stringify(sp.presenceState()); }).subscribe((s) => { if (s === 'SUBSCRIBED') joined = true; });
  await sleep(3500);
  check('Espion en canal public : AUCUN pseudo visible', !/zz-rt/i.test(seen), `rejoint=${joined} vu=${seen.slice(0, 160) || 'rien'}`);
  check('Ce que l espion verrait (s il rejoint) ne contient que des identifiants', !/pseudo/i.test(seen), seen.slice(0, 160) || 'rien');

  const oldC = createClient(URL_, anon, { auth: { persistSession: false } });
  let oldSeen = [];
  const oc = oldC.channel('presence');
  oc.on('presence', { event: 'sync' }, () => { oldSeen = Object.values(oc.presenceState()).map((x) => x[0]?.pseudo).filter(Boolean); }).subscribe();
  await sleep(3000);
  check('Ancien canal « presence » : plus aucun pseudo dedans', oldSeen.length === 0, JSON.stringify(oldSeen));
  setTimeout(() => { legit.untrack(); spyC.removeAllChannels(); oldC.removeAllChannels(); authC.removeAllChannels(); }, 50);
  await sleep(500);
} catch (e) { console.log('ERREUR :', e.message); failc++; }
finally { await cleanup(); process.exit(0); }
