export const PSEUDO_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const MIN_PASSWORD = 8;
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
