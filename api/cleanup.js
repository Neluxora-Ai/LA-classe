// Nettoyage quotidien (tâche planifiée Vercel, voir « crons » dans vercel.json).
// 1) supprime les fichiers du stockage qui ne sont plus utilisés par aucun message, photo de profil ou sticker
//    (messages supprimés par la règle des 50 messages, envois interrompus…) ;
// 2) vide les anciens compteurs de sécurité et garde les 500 dernières lignes du journal des admins.
// Réservé à Vercel : l'appel doit porter l'en-tête « Authorization: Bearer <CRON_SECRET> ».
import { createClient } from '@supabase/supabase-js';
import { safeEqual } from './_security.js';

// on laisse 2 h aux envois en cours avant de juger un fichier orphelin (réglable : CLEANUP_MIN_AGE_MIN, en minutes)
const MIN_AGE_MS = Number(process.env.CLEANUP_MIN_AGE_MIN ?? 120) * 60_000;

async function allRows(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function listBucket(admin, bucket) {
  const files = [];
  const { data: top, error } = await admin.storage.from(bucket).list('', { limit: 1000 });
  if (error) throw error;
  for (const folder of top.filter((e) => !e.id)) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error: e2 } = await admin.storage.from(bucket).list(folder.name, { limit: 1000, offset });
      if (e2) throw e2;
      files.push(...data.filter((f) => f.id).map((f) => ({ path: `${folder.name}/${f.name}`, created: new Date(f.created_at).getTime() })));
      if (data.length < 1000) break;
    }
  }
  return files;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET } = process.env;
  if (!CRON_SECRET || !safeEqual(req.headers.authorization || '', `Bearer ${CRON_SECRET}`)) return res.status(401).json({ error: 'Non autorisé.' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'Serveur mal configuré.' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const report = { orphansRemoved: { images: 0, files: 0 }, kept: { images: 0, files: 0 } };
  try {
    const used = { images: new Set(), files: new Set() };
    for (const m of await allRows(() => admin.from('messages').select('image_path, file_path').or('image_path.not.is.null,file_path.not.is.null'))) {
      if (m.image_path) used.images.add(m.image_path);
      if (m.file_path) used.files.add(m.file_path);
    }
    for (const p of await allRows(() => admin.from('profiles').select('avatar_path').not('avatar_path', 'is', null))) used.images.add(p.avatar_path);
    for (const s of await allRows(() => admin.from('stickers').select('path'))) used.images.add(s.path);

    for (const bucket of ['images', 'files']) {
      const files = await listBucket(admin, bucket);
      const orphans = files.filter((f) => !used[bucket].has(f.path) && Date.now() - f.created > MIN_AGE_MS).map((f) => f.path);
      report.kept[bucket] = files.length - orphans.length;
      for (let i = 0; i < orphans.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(orphans.slice(i, i + 100));
        if (error) throw error;
      }
      report.orphansRemoved[bucket] = orphans.length;
    }

    const day = new Date(Date.now() - 86400_000).toISOString();
    await admin.from('rate_limits').delete().lt('at', day);
    await admin.from('register_attempts').delete().lt('at', day);
    const { data: old } = await admin.from('admin_log').select('id').order('id', { ascending: false }).range(500, 500);
    if (old?.length) await admin.from('admin_log').delete().lte('id', old[0].id);
    return res.status(200).json({ ok: true, ...report });
  } catch (e) {
    console.error('cleanup', e);
    return res.status(500).json({ error: 'Nettoyage interrompu.', detail: String(e.message || e).slice(0, 200) });
  }
}
