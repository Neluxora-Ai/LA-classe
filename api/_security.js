// Protections partagées par les routes serveur (le préfixe « _ » évite que Vercel en fasse une route publique).
import crypto from 'node:crypto';

// Refuse les appels venant d'un AUTRE site (un script de page tierce qui utiliserait ton navigateur).
// Les navigateurs envoient toujours l'en-tête Origin sur un POST ; il doit correspondre au site appelé.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  } catch {
    return false;
  }
}

export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'inconnu').split(',')[0].trim();

// Limite d'appels : au plus `max` appels pour cette clé pendant `windowSec` secondes. Renvoie false si la limite est atteinte.
export async function hit(admin, key, max, windowSec) {
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  const { count } = await admin.from('rate_limits').select('id', { count: 'exact', head: true }).eq('key', key).gte('at', since);
  if ((count ?? 0) >= max) return false;
  await admin.from('rate_limits').insert({ key });
  return true;
}

// ---------- Pseudos ----------
const RESERVED = new Set(['admin', 'administrateur', 'administrator', 'moderateur', 'moderator', 'modo', 'staff', 'support', 'system', 'systeme', 'système', 'root', 'delegue', 'délégué', 'prof', 'professeur', 'direction']);
export const isReserved = (name) => RESERVED.has(name.toLowerCase().replace(/[\s_-]+/g, ''));

// « аlice » (a cyrillique) ressemble à « alice » : on refuse de mélanger plusieurs alphabets dans un même pseudo.
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Devanagari'];
export const mixedScripts = (name) => SCRIPTS.filter((s) => new RegExp(`\\p{Script=${s}}`, 'u').test(name)).length > 1;

export function pseudoProblem(name) {
  if (isReserved(name)) return 'Ce pseudo est réservé.';
  if (mixedScripts(name)) return 'Ce pseudo mélange plusieurs alphabets (ex. lettres latines et cyrilliques) : choisis-en un seul.';
  return null;
}

// ---------- Mots de passe ----------
const COMMON = new Set((
  '12345678 123456789 1234567890 password password1 password123 motdepasse motdepasse1 azertyuiop azerty123 azerty1234 qwertyuiop qwerty123 qwerty1234 ' +
  '11111111 00000000 88888888 12341234 123123123 abcd1234 abc12345 iloveyou1 iloveyou123 football1 football123 doudou123 soleil123 bonjour123 bonjour1 ' +
  'admin123 admin1234 letmein123 welcome123 monkey123 dragon123 master123 pokemon123 minecraft1 minecraft123 fortnite1 fortnite123 roblox123 lol12345 ' +
  'chocolat1 chocolat123 marseille1 psgpsg123 lyceelycee cielciel1 notreclasse classe123 classe1234 lycee1234 lycee2024 lycee2025 lycee2026 2024lycee 2025lycee 2026lycee ' +
  'azertyazerty 1q2w3e4r 1qaz2wsx qazwsxedc passw0rd p@ssw0rd p@ssword'
).split(/\s+/));

export function weakPassword(password, pseudo = '') {
  const pw = password.toLowerCase();
  const name = pseudo.toLowerCase().replace(/\s+/g, '');
  if (COMMON.has(pw)) return 'Ce mot de passe est trop courant : choisis-en un moins facile à deviner.';
  if (/^(.)\1+$/.test(pw)) return 'Mot de passe trop simple (le même caractère répété).';
  if (name.length >= 3 && pw.replace(/\s+/g, '').includes(name)) return 'Ton mot de passe ne doit pas contenir ton pseudo.';
  return null;
}

export const safeEqual = (a, b) => {
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(sha(a), sha(b));
};
