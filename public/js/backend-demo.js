// Mode démo : tout est stocké dans le navigateur (localStorage), synchronisé entre onglets.
// Sert à tester l'interface sans Supabase. Pas sécurisé, ne pas utiliser en vrai.
import { IMAGE_EXT, MAX_IMAGE, PSEUDO_RE, mkEmitter } from './shared.js';

const KEY = 'classe-demo-v1';
const SESSION = 'classe-demo-session'; // sessionStorage : un onglet = un utilisateur
const COMMON = 'common';

export function createDemoBackend() {
  const { on, emit } = mkEmitter();
  const bc = new BroadcastChannel('classe-demo');
  const clientId = crypto.randomUUID();
  let me = null;
  let heartbeat = null;
  const seen = new Map(); // pseudo -> dernier signe de vie

  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s) return s;
    } catch {}
    return {
      users: [],
      rooms: [{ id: COMMON, name: 'général', emoji: '💬', is_common: true, created_at: 0 }],
      members: [],
      messages: [],
      nextId: 1,
    };
  };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const pseudoOf = (s, id) => s.users.find((u) => u.id === id)?.pseudo || '???';
  const isMember = (s, roomId, uid) =>
    s.rooms.find((r) => r.id === roomId)?.is_common || s.members.some((m) => m.room_id === roomId && m.user_id === uid);
  const ping = (msg) => bc.postMessage({ from: clientId, ...msg });

  bc.onmessage = ({ data }) => {
    if (!me || data.from === clientId) return;
    const s = load();
    if (data.t === 'message' && isMember(s, data.msg.room_id, me.id)) emit('message', data.msg);
    else if (data.t === 'deleted') emit('deleted', { id: data.id });
    else if (data.t === 'rooms') emit(data.user_id === me.id ? 'rooms' : 'members', { room_id: data.room_id });
    else if (data.t === 'hb') {
      seen.set(data.pseudo, Date.now());
      emitPresence();
    } else if (data.t === 'typing') emit('typing', data.payload);
  };
  const emitPresence = () => {
    const now = Date.now();
    const list = [...seen].filter(([, t]) => now - t < 9000).map(([p]) => p);
    emit('presence', list.sort((a, b) => a.localeCompare(b)));
  };

  return {
    mode: 'demo',
    on,

    async getSession() {
      const id = sessionStorage.getItem(SESSION);
      const u = id && load().users.find((x) => x.id === id);
      return (me = u ? { id: u.id, pseudo: u.pseudo } : null);
    },
    async register(pseudo, password, code) {
      if (code.trim() !== 'demo') throw new Error('En mode démo, le code de classe est : demo');
      pseudo = pseudo.trim();
      if (!PSEUDO_RE.test(pseudo)) throw new Error('Pseudo : 2 à 20 lettres, chiffres, espaces, - ou _.');
      if (password.length < 6) throw new Error('Mot de passe : 6 caractères minimum.');
      const s = load();
      if (s.users.some((u) => u.pseudo.toLowerCase() === pseudo.toLowerCase())) throw new Error('Ce pseudo est déjà pris.');
      s.users.push({ id: crypto.randomUUID(), pseudo, password });
      save(s);
      return this.login(pseudo, password);
    },
    async login(pseudo, password) {
      const u = load().users.find((x) => x.pseudo.toLowerCase() === pseudo.trim().toLowerCase() && x.password === password);
      if (!u) throw new Error('Pseudo ou mot de passe incorrect.');
      sessionStorage.setItem(SESSION, u.id);
      return (me = { id: u.id, pseudo: u.pseudo });
    },
    async logout() {
      this.stop();
      sessionStorage.removeItem(SESSION);
    },

    people: () => load().users.map((u) => ({ id: u.id, pseudo: u.pseudo })).sort((a, b) => a.pseudo.localeCompare(b.pseudo)),
    async refreshPeople() {},

    async rooms() {
      const s = load();
      return s.rooms
        .filter((r) => isMember(s, r.id, me.id))
        .sort((a, b) => Number(b.is_common) - Number(a.is_common) || a.created_at - b.created_at);
    },
    async members(room) {
      const s = load();
      if (room.is_common) return this.people();
      return s.members.filter((m) => m.room_id === room.id).map((m) => ({ id: m.user_id, pseudo: pseudoOf(s, m.user_id) }));
    },
    async createRoom(name, emoji, memberIds) {
      name = name.trim();
      if (!name || name.length > 30) throw new Error('Nom invalide.');
      const s = load();
      const id = crypto.randomUUID();
      s.rooms.push({ id, name, emoji: emoji || '💬', is_common: false, created_at: Date.now() });
      for (const uid of new Set([me.id, ...memberIds])) {
        if (s.users.some((u) => u.id === uid)) s.members.push({ room_id: id, user_id: uid });
      }
      save(s);
      for (const uid of memberIds) ping({ t: 'rooms', room_id: id, user_id: uid });
      return id;
    },
    async addMember(roomId, userId) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      if (!s.members.some((m) => m.room_id === roomId && m.user_id === userId)) s.members.push({ room_id: roomId, user_id: userId });
      save(s);
      ping({ t: 'rooms', room_id: roomId, user_id: userId });
    },
    async leaveRoom(roomId) {
      const s = load();
      s.members = s.members.filter((m) => !(m.room_id === roomId && m.user_id === me.id));
      if (!s.members.some((m) => m.room_id === roomId)) {
        s.rooms = s.rooms.filter((r) => r.id !== roomId);
        s.messages = s.messages.filter((m) => m.room_id !== roomId);
      }
      save(s);
    },

    async history(roomId) {
      const s = load();
      return s.messages.filter((m) => m.room_id === roomId).slice(-100).map((m) => ({ ...m, pseudo: pseudoOf(s, m.user_id) }));
    },
    async send(roomId, text, imagePath = null) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      const msg = { id: s.nextId++, room_id: roomId, user_id: me.id, text, image_path: imagePath, created_at: new Date().toISOString() };
      s.messages.push(msg);
      save(s);
      const full = { ...msg, pseudo: me.pseudo };
      emit('message', full);
      ping({ t: 'message', msg: full });
    },
    async remove(msg) {
      const s = load();
      s.messages = s.messages.filter((m) => !(m.id === msg.id && m.user_id === me.id));
      save(s);
      emit('deleted', { id: msg.id });
      ping({ t: 'deleted', id: msg.id });
    },

    async upload(file) {
      if (!IMAGE_EXT[file.type]) throw new Error('Format non supporté (png, jpg, gif, webp).');
      if (file.size > Math.min(MAX_IMAGE, 1024 * 1024)) throw new Error('Mode démo : image de 1 Mo maximum.');
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Lecture impossible.'));
        r.readAsDataURL(file);
      });
    },
    async imageUrl(path) {
      return path; // en démo, le chemin est déjà une data: URL
    },

    start() {
      this.stop();
      const beat = () => {
        seen.set(me.pseudo, Date.now());
        ping({ t: 'hb', pseudo: me.pseudo });
        emitPresence();
      };
      beat();
      heartbeat = setInterval(beat, 4000);
      setTimeout(() => emit('status', true), 0);
      ping({ t: 'hb', pseudo: me.pseudo });
    },
    stop() {
      clearInterval(heartbeat);
    },
    typing(roomId) {
      ping({ t: 'typing', payload: { room_id: roomId, pseudo: me.pseudo } });
    },
  };
}
