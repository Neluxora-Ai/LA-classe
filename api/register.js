// Fonction serverless Vercel : création de compte protégée par le code de classe.
// Les inscriptions publiques de Supabase doivent être DÉSACTIVÉES : c'est cette route qui crée les comptes.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const PSEUDO_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;
const MAX_FAILS = 10; // essais ratés par IP
const WINDOW_MIN = 10;

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
// Doit rester identique à pseudoToEmail() côté navigateur (public/js/shared.js).
const pseudoToEmail = (p) =>
  `${crypto.createHash('sha256').update(p.normalize('NFC').trim().toLowerCase()).digest('hex').slice(0, 40)}@pseudo.classe.app`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLASS_CODE } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CLASS_CODE)
    return res.status(500).json({ error: 'Serveur mal configuré (variables d\'environnement manquantes).' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const { pseudo, password, code } = body || {};
  if (typeof pseudo !== 'string' || typeof password !== 'string' || typeof code !== 'string')
    return res.status(400).json({ error: 'Champs manquants.' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'inconnu').split(',')[0].trim();

  // Anti-bruteforce du code de classe
  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();
  await admin.from('register_attempts').delete().lt('at', since);
  const { count } = await admin
    .from('register_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('at', since);
  if ((count ?? 0) >= MAX_FAILS) return res.status(429).json({ error: 'Trop d\'essais, réessaie dans quelques minutes.' });

  if (!safeEqual(code.trim(), CLASS_CODE)) {
    await admin.from('register_attempts').insert({ ip });
    await new Promise((r) => setTimeout(r, 800));
    return res.status(403).json({ error: 'Code de classe incorrect.' });
  }

  const name = pseudo.trim();
  if (!PSEUDO_RE.test(name)) return res.status(400).json({ error: 'Pseudo : 2 à 20 lettres, chiffres, espaces, - ou _.' });
  if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'Mot de passe : entre 6 et 72 caractères.' });

  const { data, error } = await admin.auth.admin.createUser({
    email: pseudoToEmail(name),
    password,
    email_confirm: true,
    app_metadata: { via: 'class-register' }, // exigé par le déclencheur only_class_signups
  });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    console.error('createUser', error);
    return res.status(500).json({ error: 'Impossible de créer le compte.' });
  }

  const { error: pErr } = await admin.from('profiles').insert({ id: data.user.id, pseudo: name });
  if (pErr) {
    await admin.auth.admin.deleteUser(data.user.id);
    if (pErr.code === '23505') return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
    console.error('profile', pErr);
    return res.status(500).json({ error: 'Impossible de créer le profil.' });
  }

  res.status(200).json({ ok: true });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
