// Fonction serverless Vercel : changer de pseudo.
// Le pseudo sert aussi à se connecter (l'e-mail technique du compte en est dérivé), donc il faut passer par le serveur.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const PSEUDO_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;
const COOLDOWN_H = 24; // un changement de pseudo par jour

// Doit rester identique à pseudoToEmail() de api/register.js et public/js/shared.js.
const pseudoToEmail = (p) =>
  `${crypto.createHash('sha256').update(p.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 40)}@pseudo.classe.app`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
    return res.status(500).json({ error: 'Serveur mal configuré (variables d\'environnement manquantes).' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Connecte-toi d\'abord.' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  if (typeof body?.pseudo !== 'string') return res.status(400).json({ error: 'Champs manquants.' });
  const name = body.pseudo.trim();
  if (!PSEUDO_RE.test(name)) return res.status(400).json({ error: 'Pseudo : 2 à 20 lettres, chiffres, espaces, - ou _.' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u?.user) return res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  const uid = u.user.id;

  const { data: me } = await admin.from('profiles').select('pseudo, pseudo_changed_at').eq('id', uid).maybeSingle();
  if (!me) return res.status(403).json({ error: 'Compte introuvable.' });
  if (name === me.pseudo) return res.status(200).json({ ok: true, pseudo: name });

  if (me.pseudo_changed_at) {
    const wait = COOLDOWN_H * 3600_000 - (Date.now() - new Date(me.pseudo_changed_at).getTime());
    if (wait > 0) {
      const h = Math.ceil(wait / 3600_000);
      return res.status(429).json({ error: `Tu pourras changer de pseudo dans ${h} h (une fois par jour).` });
    }
  }

  const { data: banned } = await admin.from('banned_users').select('pseudo_key').eq('pseudo_key', name.toLowerCase()).maybeSingle();
  if (banned) return res.status(403).json({ error: 'Ce pseudo est interdit dans la classe.' });

  const { data: taken } = await admin.from('profiles').select('id').neq('id', uid).ilike('pseudo', name.replace(/[\\%_]/g, (c) => `\\${c}`)).maybeSingle();
  if (taken) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });

  const oldEmail = pseudoToEmail(me.pseudo);
  const newEmail = pseudoToEmail(name);
  const emailChanges = oldEmail !== newEmail; // changer seulement les majuscules ne change pas l'e-mail technique
  if (emailChanges) {
    const { error } = await admin.auth.admin.updateUserById(uid, { email: newEmail, email_confirm: true });
    if (error) {
      if (/already|exists|registered/i.test(error.message)) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
      console.error('rename email', error);
      return res.status(500).json({ error: 'Impossible de changer le pseudo.' });
    }
  }

  const { error: pErr } = await admin.from('profiles').update({ pseudo: name, pseudo_changed_at: new Date().toISOString() }).eq('id', uid);
  if (pErr) {
    if (emailChanges) await admin.auth.admin.updateUserById(uid, { email: oldEmail, email_confirm: true }); // on annule
    if (pErr.code === '23505') return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    console.error('rename profile', pErr);
    return res.status(500).json({ error: 'Impossible de changer le pseudo.' });
  }

  await admin.from('pseudo_changes').insert({ user_id: uid, old_pseudo: me.pseudo, new_pseudo: name });
  res.status(200).json({ ok: true, pseudo: name });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
