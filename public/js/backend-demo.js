// Mode démo : tout est stocké dans le navigateur (localStorage), synchronisé entre onglets.
// Sert à tester l'interface sans Supabase. Pas sécurisé, ne pas utiliser en vrai.
// Dans la démo, le PREMIER compte créé est admin.
import { IMAGE_EXT, MAX_IMAGE, MIN_PASSWORD, PSEUDO_RE, mkEmitter } from './shared.js';

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
    let s = null;
    try {
      s = JSON.parse(localStorage.getItem(KEY));
    } catch {}
    s ||= {
      users: [],
      rooms: [{ id: COMMON, name: 'général', emoji: '💬', is_common: true, created_at: 0 }],
      members: [],
      messages: [],
      nextId: 1,
    };
    s.reactions ||= []; // anciennes données de démo
    return s;
  };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const userOf = (s, id) => s.users.find((u) => u.id === id);
  const pseudoOf = (s, id) => userOf(s, id)?.pseudo || '???';
  const isMember = (s, roomId, uid) =>
    s.rooms.find((r) => r.id === roomId)?.is_common || s.members.some((m) => m.room_id === roomId && m.user_id === uid);
  const ping = (msg) => bc.postMessage({ from: clientId, ...msg });
  const pub = (u) => ({ id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin });
  const replyInfo = (s, id) => {
    if (!id) return null;
    const m = s.messages.find((x) => x.id === id);
    return m ? { id, pseudo: pseudoOf(s, m.user_id), text: m.text, image: !!m.image_path } : null;
  };
  const view = (s, m) => ({
    ...m,
    pseudo: pseudoOf(s, m.user_id),
    reactions: s.reactions.filter((r) => r.message_id === m.id).map(({ user_id, emoji }) => ({ user_id, emoji })),
    reply: replyInfo(s, m.reply_to),
  });
  const refreshMe = (s) => {
    const u = userOf(s, me.id);
    if (u) me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin };
  };

  bc.onmessage = ({ data }) => {
    if (!me || data.from === clientId) return;
    const s = load();
    if (data.t === 'message' && isMember(s, data.msg.room_id, me.id)) emit('message', view(s, data.msg));
    else if (data.t === 'deleted') emit('deleted', { id: data.id });
    else if (data.t === 'reaction') emit('reaction', data.r);
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
    me: () => me,

    async getSession() {
      const id = sessionStorage.getItem(SESSION);
      const s = load();
      const u = id && userOf(s, id);
      if (!u) return (me = null);
      me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin };
      return me;
    },
    async register(pseudo, password, code) {
      if (code.trim() !== 'demo') throw new Error('En mode démo, le code de classe est : demo');
      pseudo = pseudo.trim();
      if (!PSEUDO_RE.test(pseudo)) throw new Error('Pseudo : 2 à 20 lettres, chiffres, espaces, - ou _.');
      if (password.length < MIN_PASSWORD) throw new Error(`Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
      const s = load();
      if (s.users.some((u) => u.pseudo.toLowerCase() === pseudo.toLowerCase())) throw new Error('Ce pseudo est déjà pris.');
      s.users.push({ id: crypto.randomUUID(), pseudo, password, color: '', is_admin: s.users.length === 0 });
      save(s);
      return this.login(pseudo, password);
    },
    async login(pseudo, password) {
      const s = load();
      const u = s.users.find((x) => x.pseudo.toLowerCase() === pseudo.trim().toLowerCase() && x.password === password);
      if (!u) throw new Error('Pseudo ou mot de passe incorrect.');
      sessionStorage.setItem(SESSION, u.id);
      return (me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin });
    },
    async logout() {
      this.stop();
      sessionStorage.removeItem(SESSION);
    },
    async changePassword(oldPassword, newPassword) {
      if (newPassword.length < MIN_PASSWORD) throw new Error(`Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
      const s = load();
      const u = userOf(s, me.id);
      if (!u || u.password !== oldPassword) throw new Error('Mot de passe actuel incorrect.');
      u.password = newPassword;
      save(s);
    },
    async setColor(color) {
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Couleur invalide.');
      const s = load();
      userOf(s, me.id).color = color;
      save(s);
      refreshMe(s);
    },

    people: () => load().users.map(pub).sort((a, b) => a.pseudo.localeCompare(b.pseudo)),
    color: (pseudo) => load().users.find((u) => u.pseudo === pseudo)?.color || '',
    async refreshPeople() {
      refreshMe(load());
    },

    async rooms() {
      const s = load();
      return s.rooms
        .filter((r) => isMember(s, r.id, me.id))
        .map((r) => {
          if (!r.is_dm) return r;
          const other = s.members.find((m) => m.room_id === r.id && m.user_id !== me.id);
          return { ...r, peer: other ? { id: other.user_id, pseudo: pseudoOf(s, other.user_id) } : null };
        })
        .sort((a, b) => Number(b.is_common) - Number(a.is_common) || a.created_at - b.created_at);
    },
    async members(room) {
      const s = load();
      if (room.is_common) return this.people();
      return s.members.filter((m) => m.room_id === room.id).map((m) => pub(userOf(s, m.user_id) || { id: m.user_id, pseudo: '???' }));
    },
    async createRoom(name, emoji, memberIds) {
      name = name.trim();
      if (!name || name.length > 30) throw new Error('Nom invalide.');
      const s = load();
      const id = crypto.randomUUID();
      s.rooms.push({ id, name, emoji: emoji || '💬', is_common: false, is_dm: false, created_at: Date.now() });
      for (const uid of new Set([me.id, ...memberIds])) {
        if (s.users.some((u) => u.id === uid)) s.members.push({ room_id: id, user_id: uid });
      }
      save(s);
      for (const uid of memberIds) ping({ t: 'rooms', room_id: id, user_id: uid });
      return id;
    },
    async createDm(userId) {
      const s = load();
      if (userId === me.id) throw new Error("Tu ne peux pas t'écrire à toi-même.");
      if (!userOf(s, userId)) throw new Error('Utilisateur inconnu.');
      const has = (rid, uid) => s.members.some((m) => m.room_id === rid && m.user_id === uid);
      const existing = s.rooms.find((r) => r.is_dm && has(r.id, me.id) && has(r.id, userId));
      if (existing) return existing.id;
      const id = crypto.randomUUID();
      s.rooms.push({ id, name: 'message privé', emoji: '💬', is_common: false, is_dm: true, created_at: Date.now() });
      s.members.push({ room_id: id, user_id: me.id }, { room_id: id, user_id: userId });
      save(s);
      ping({ t: 'rooms', room_id: id, user_id: userId });
      return id;
    },
    async addMember(roomId, userId) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      if (s.rooms.find((r) => r.id === roomId)?.is_dm) throw new Error("On ne peut pas ajouter quelqu'un à un message privé.");
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
    async kick(userId) {
      const s = load();
      if (!userOf(s, me.id)?.is_admin) throw new Error('Interdit.');
      if (userId === me.id) throw new Error("Tu ne peux pas t'exclure toi-même.");
      if (userOf(s, userId)?.is_admin) throw new Error("Impossible d'exclure un admin.");
      s.users = s.users.filter((u) => u.id !== userId);
      s.members = s.members.filter((m) => m.user_id !== userId);
      s.messages = s.messages.filter((m) => m.user_id !== userId);
      s.reactions = s.reactions.filter((r) => r.user_id !== userId && s.messages.some((m) => m.id === r.message_id));
      save(s);
    },

    async history(roomId) {
      const s = load();
      return s.messages.filter((m) => m.room_id === roomId).slice(-100).map((m) => view(s, m));
    },
    async send(roomId, text, imagePath = null, replyTo = null) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      if (replyTo && s.messages.find((m) => m.id === replyTo)?.room_id !== roomId) replyTo = null;
      const msg = { id: s.nextId++, room_id: roomId, user_id: me.id, text, image_path: imagePath, reply_to: replyTo, created_at: new Date().toISOString() };
      s.messages.push(msg);
      save(s);
      emit('message', view(s, msg));
      ping({ t: 'message', msg });
    },
    async remove(msg) {
      const s = load();
      const admin = userOf(s, me.id)?.is_admin;
      s.messages = s.messages.filter((m) => !(m.id === msg.id && (m.user_id === me.id || admin)));
      s.reactions = s.reactions.filter((r) => r.message_id !== msg.id || s.messages.some((m) => m.id === msg.id));
      save(s);
      emit('deleted', { id: msg.id });
      ping({ t: 'deleted', id: msg.id });
    },
    async react(messageId, emoji, add) {
      const s = load();
      const m = s.messages.find((x) => x.id === messageId);
      if (!m || !isMember(s, m.room_id, me.id)) throw new Error('Interdit.');
      const same = (r) => r.message_id === messageId && r.user_id === me.id && r.emoji === emoji;
      if (add) {
        if (s.reactions.filter((r) => r.message_id === messageId && r.user_id === me.id).length >= 10) throw new Error('10 réactions maximum par message.');
        if (!s.reactions.some(same)) s.reactions.push({ message_id: messageId, user_id: me.id, emoji });
      } else s.reactions = s.reactions.filter((r) => !same(r));
      save(s);
      const r = { type: add ? 'add' : 'remove', message_id: messageId, user_id: me.id, emoji };
      emit('reaction', r);
      ping({ t: 'reaction', r });
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
