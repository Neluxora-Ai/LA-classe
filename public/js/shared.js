export const PSEUDO_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MAX_FILE = 10 * 1024 * 1024;
export const MIN_PASSWORD = 8;

// Documents acceptés (extension -> type MIME). Pas d'exécutables, pas de HTML/SVG.
export const FILE_TYPES = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  md: 'text/markdown',
  json: 'application/json',
  rtf: 'application/rtf',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  weba: 'audio/webm', // enregistrement vocal fait dans le navigateur
  mp4: 'video/mp4',
  webm: 'video/webm',
};
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map((e) => `.${e}`).join(',');
export const AUDIO_EXT = ['mp3', 'm4a', 'wav', 'ogg', 'weba']; // lus directement dans le chat
export const isAudioName = (name) => AUDIO_EXT.includes(fileExt(name));
export const VOICE_MAX_SECS = 60;

// ---------- Dossiers : on les envoie en un seul fichier .zip, fabriqué ici (sans compression) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// entries : [{ name: 'dossier/sous/fichier.txt', data: Uint8Array, mtime?: Date }] -> Blob (archive ZIP, stockage sans compression)
export function buildZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const d = e.mtime instanceof Date ? e.mtime : new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // noms en UTF-8
    local.setUint16(8, 0, true); // méthode 0 : stocké
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.git|node_modules|__MACOSX)(\/|$)/;
export const MAX_FOLDER_FILES = 300;
// files : [{ path: 'dossier/a.txt', file: File }] -> File « dossier.zip » (refuse si trop gros ou trop de fichiers)
export async function zipFolder(folderName, files) {
  const kept = files.filter((f) => !JUNK.test(f.path));
  if (!kept.length) throw new Error('Ce dossier est vide (ou ne contient que des fichiers système).');
  if (kept.length > MAX_FOLDER_FILES) throw new Error(`Ce dossier contient ${kept.length} fichiers (${MAX_FOLDER_FILES} maximum).`);
  const total = kept.reduce((n, f) => n + f.file.size, 0);
  if (total > MAX_FILE) throw new Error(`Ce dossier fait ${formatSize(total)} : la limite est de ${formatSize(MAX_FILE)}. Envoie-le en plusieurs parties.`);
  const entries = [];
  for (const f of kept) {
    const name = f.path.replace(/\\/g, '/').split('/').filter((s) => s && s !== '..' && s !== '.').join('/');
    entries.push({ name, data: new Uint8Array(await f.file.arrayBuffer()), mtime: new Date(f.file.lastModified || Date.now()) });
  }
  const safe = folderName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 100) || 'dossier';
  return new File([buildZip(entries)], `${safe}.zip`, { type: 'application/zip' });
}
// Lit un dossier déposé par glisser-déposer (API FileSystemEntry). À appeler dès le « drop », avant tout await.
export function dropEntries(dataTransfer) {
  return [...(dataTransfer?.items || [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() || i.getAsFile() : null)).filter(Boolean);
}
async function walk(entry, prefix, out) {
  if (entry.isFile) {
    out.push({ path: prefix + entry.name, file: await new Promise((res, rej) => entry.file(res, rej)) });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}
// -> { files: [File], folders: [{ name, files: [{ path, file }] }] }
export async function readDropped(entries) {
  const files = [];
  const folders = [];
  for (const e of entries) {
    if (e instanceof File) files.push(e);
    else if (e.isFile) files.push(await new Promise((res, rej) => e.file(res, rej)));
    else if (e.isDirectory) {
      const list = [];
      await walk(e, '', list);
      folders.push({ name: e.name, files: list });
    }
  }
  return { files, folders };
}
export const fileExt = (name) => (String(name).split('.').pop() || '').toLowerCase();
export const fileIcon = (name) => {
  const e = fileExt(name);
  if (e === 'pdf') return '📕';
  if (['doc', 'docx', 'odt', 'txt'].includes(e)) return '📄';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(e)) return '📊';
  if (['ppt', 'pptx', 'odp'].includes(e)) return '📽️';
  if (e === 'zip') return '🗜️';
  return '📎';
};
export const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// « 03-15 » -> « 15 mars »
export const birthdayLabel = (mmdd) => (/^\d\d-\d\d$/.test(mmdd || '') ? `${Number(mmdd.slice(3))} ${MONTHS[Number(mmdd.slice(0, 2)) - 1]}` : '');
// Jours avant le prochain anniversaire (0 = aujourd'hui)
export function daysUntilBirthday(mmdd, now = new Date()) {
  if (!/^\d\d-\d\d$/.test(mmdd || '')) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(3)));
  if (next < today) next = new Date(now.getFullYear() + 1, next.getMonth(), next.getDate());
  return Math.round((next - today) / 86400000);
}
// « il y a 5 min », « il y a 3 h », « hier »…
export function relTime(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'hier' : d < 30 ? `il y a ${d} j` : 'il y a plus d\'un mois';
}
// Un message composé de 1 à 3 emojis seulement s'affiche en grand (« sticker emoji »)
export const isBigEmoji = (text) => /^(?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*\s*){1,3}$/u.test((text || '').trim());
export const BIG_EMOJIS = ['😂', '😍', '🥳', '😎', '🤩', '😭', '😡', '🤯', '🥺', '😴', '🤔', '🙄', '👍', '👏', '🙌', '💪', '🙏', '❤️', '🔥', '💯', '🎉', '💀', '👀', '🤝', '🍕', '☕', '🏆', '📚'];

// Recadre un sticker : PNG (transparence gardée), 256 px maximum
export async function resizeSticker(file) {
  if (!IMAGE_EXT[file.type]) throw new Error('Format non supporté (png, jpg, gif, webp).');
  if (file.size > MAX_IMAGE) throw new Error('Image trop grosse (5 Mo max).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Impossible de lire cette image.'));
      i.src = url;
    });
    const k = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Impossible de préparer le sticker.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export const formatSize = (n) => (n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`);
export const AVATAR_COLORS = ['#7c5cff', '#ff5fa2', '#ff8a3d', '#f5c542', '#3ddc84', '#2fc4c4', '#3d9bff', '#b05cff', '#ff5555', '#8d99ae', '#a0522d', '#14b8a6'];
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
export const AVATAR_SIZE = 256;

// Recadre une image en carré (centre) et la réduit à AVATAR_SIZE px en JPEG : photo légère, EXIF retiré.
export async function resizeAvatar(file) {
  if (!IMAGE_EXT[file.type]) throw new Error('Format non supporté (png, jpg, gif, webp).');
  if (file.size > MAX_IMAGE) throw new Error('Image trop grosse (5 Mo max).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Impossible de lire cette image."));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Impossible de préparer la photo.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Force d'un mot de passe : 0 (vide) à 4 (très fort), avec un libellé.
export function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= MIN_PASSWORD) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  else if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += 0.5;
  score = Math.min(4, Math.floor(score));
  if (pw.length < MIN_PASSWORD) score = Math.min(score, 1);
  return { score: Math.max(score, 1), label: ['', 'Faible', 'Moyen', 'Bien', 'Très fort'][Math.max(score, 1)] };
}
export const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// Les comptes Supabase sont identifiés par un e-mail technique dérivé du pseudo.
// Doit rester identique à pseudoToEmail() dans api/register.js.
export async function pseudoToEmail(pseudo) {
  const data = new TextEncoder().encode(pseudo.normalize('NFC').trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 40)}@pseudo.classe.app`;
}

export function mkEmitter() {
  const handlers = {};
  return {
    on(event, fn) {
      (handlers[event] ||= new Set()).add(fn);
      return () => handlers[event].delete(fn);
    },
    emit(event, data) {
      handlers[event]?.forEach((fn) => fn(data));
    },
  };
}
