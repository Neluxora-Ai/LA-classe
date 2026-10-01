export const PSEUDO_RE = /^[\p{L}\p{N}_\- ]{2,20}$/u;
export const MAX_IMAGE = 5 * 1024 * 1024;
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
