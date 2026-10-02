// Mode démo : tout est stocké dans le navigateur (localStorage), synchronisé entre onglets.
// Sert à tester l'interface sans Supabase. Pas sécurisé, ne pas utiliser en vrai.
// Dans la démo, le PREMIER compte créé est admin.
import { FILE_TYPES, IMAGE_EXT, MAX_FILE, MAX_IMAGE, MIN_PASSWORD, PSEUDO_RE, fileExt, mkEmitter } from './shared.js';

const KEY = 'classe-demo-v1';
const SESSION = 'classe-demo-session'; // sessionStorage : un onglet = un utilisateur
const COMMON = 'common';
const DEMO_FILE_MAX = 1024 * 1024; // 1 Mo en démo (localStorage)

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
    s.bans ||= [];
    s.pins ||= [];
    s.polls ||= [];
    s.votes ||= [];
    return s;
  };
  const save = (s) => localStorage.setItem(KEY, JSON.stringify(s));
  const userOf = (s, id) => s.users.find((u) => u.id === id);
  const pseudoOf = (s, id) => userOf(s, id)?.pseudo || '???';
  const roomOf = (s, id) => s.rooms.find((r) => r.id === id);
  const isMember = (s, roomId, uid) =>
    roomOf(s, roomId)?.is_common || s.members.some((m) => m.room_id === roomId && m.user_id === uid);
  const ping = (msg) => bc.postMessage({ from: clientId, ...msg });
  const both = (event, data, t = event) => {
    emit(event, data);
    ping({ t, data });
  };
  const pub = (u) => ({ id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin });
  const replyInfo = (s, id) => {
    if (!id) return null;
    const m = s.messages.find((x) => x.id === id);
    return m ? { id, pseudo: pseudoOf(s, m.user_id), text: m.text, image: !!(m.image_path || m.file_name) } : null;
  };
  const pollOf = (s, messageId) => {
    const p = s.polls.find((x) => x.message_id === messageId);
    if (!p) return null;
    return {
      id: p.id,
      message_id: p.message_id,
      question: p.question,
      multiple: p.multiple,
      closed: p.closed,
      created_by: p.created_by,
      options: p.options.map((o) => ({ id: o.id, label: o.label, votes: s.votes.filter((v) => v.option_id === o.id).map((v) => v.user_id) })),
    };
  };
  const view = (s, m) => ({
    ...m,
    pseudo: pseudoOf(s, m.user_id),
    reactions: s.reactions.filter((r) => r.message_id === m.id).map(({ user_id, emoji }) => ({ user_id, emoji })),
    reply: replyInfo(s, m.reply_to),
    poll: pollOf(s, m.id),
  });
  const refreshMe = (s) => {
    const u = userOf(s, me.id);
    if (u) me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin, settings: u.settings || {} };
  };
  // supprime un message et tout ce qui en dépend
  const dropMessages = (s, pred) => {
    const gone = new Set(s.messages.filter(pred).map((m) => m.id));
    s.messages = s.messages.filter((m) => !gone.has(m.id));
    s.reactions = s.reactions.filter((r) => !gone.has(r.message_id));
    s.pins = s.pins.filter((p) => !gone.has(p.message_id));
    const dead = new Set(s.polls.filter((p) => gone.has(p.message_id)).map((p) => p.id));
    s.polls = s.polls.filter((p) => !dead.has(p.id));
    s.votes = s.votes.filter((v) => !dead.has(v.poll_id));
    s.messages.forEach((m) => {
      if (gone.has(m.reply_to)) m.reply_to = null;
    });
  };

  bc.onmessage = ({ data }) => {
    if (!me || data.from === clientId) return;
    const s = load();
    if (data.t === 'message' && isMember(s, data.msg.room_id, me.id)) emit('message', view(s, data.msg));
    else if (data.t === 'deleted') emit('deleted', { id: data.id });
    else if (data.t === 'reaction') emit('reaction', data.r);
    else if (data.t === 'edited') emit('edited', data.data);
    else if (data.t === 'pins') emit('pins', {});
    else if (data.t === 'poll') emit('poll', data.data);
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
      me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin, settings: u.settings || {} };
      return me;
    },
    async register(pseudo, password, code) {
      if (code.trim() !== 'demo') throw new Error('En mode démo, le code de classe est : demo');
      pseudo = pseudo.trim();
      if (!PSEUDO_RE.test(pseudo)) throw new Error('Pseudo : 2 à 20 lettres, chiffres, espaces, - ou _.');
      if (password.length < MIN_PASSWORD) throw new Error(`Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
      const s = load();
      if (s.bans.some((x) => x.pseudo_key === pseudo.toLowerCase())) throw new Error('Ce pseudo a été banni de la classe.');
      if (s.users.some((u) => u.pseudo.toLowerCase() === pseudo.toLowerCase())) throw new Error('Ce pseudo est déjà pris.');
      s.users.push({ id: crypto.randomUUID(), pseudo, password, color: '', is_admin: s.users.length === 0, settings: {} });
      save(s);
      return this.login(pseudo, password);
    },
    async login(pseudo, password) {
      const s = load();
      const u = s.users.find((x) => x.pseudo.toLowerCase() === pseudo.trim().toLowerCase() && x.password === password);
      if (!u) throw new Error('Pseudo ou mot de passe incorrect.');
      sessionStorage.setItem(SESSION, u.id);
      return (me = { id: u.id, pseudo: u.pseudo, color: u.color || '', is_admin: !!u.is_admin, settings: u.settings || {} });
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
    async setSettings(settings) {
      const s = load();
      userOf(s, me.id).settings = settings;
      save(s);
      refreshMe(s);
    },

    avatar: (pseudo) => load().users.find((u) => u.pseudo === pseudo)?.avatar || '',
    async setAvatar(blob) {
      const url = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Lecture impossible.'));
        r.readAsDataURL(blob);
      });
      const s = load();
      userOf(s, me.id).avatar = url;
      save(s);
    },
    async removeAvatar() {
      const s = load();
      delete userOf(s, me.id).avatar;
      save(s);
    },

    async ban(userId, reason) {
      const s = load();
      const target = userOf(s, userId);
      if (!userOf(s, me.id)?.is_admin) throw new Error('Interdit.');
      if (userId === me.id) throw new Error('Tu ne peux pas te bannir toi-même.');
      if (!target) throw new Error('Utilisateur inconnu.');
      if (target.is_admin) throw new Error('Impossible de bannir un admin.');
      s.bans = s.bans.filter((x) => x.pseudo_key !== target.pseudo.toLowerCase());
      s.bans.unshift({ pseudo_key: target.pseudo.toLowerCase(), pseudo: target.pseudo, reason: (reason || '').slice(0, 200), banned_at: new Date().toISOString() });
      save(s);
      await this.kick(userId);
    },
    async unban(pseudoKey) {
      const s = load();
      if (!userOf(s, me.id)?.is_admin) throw new Error('Interdit.');
      s.bans = s.bans.filter((x) => x.pseudo_key !== pseudoKey.toLowerCase());
      save(s);
    },
    async banned() {
      return load().bans;
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
      if (roomOf(s, roomId)?.is_dm) throw new Error("On ne peut pas ajouter quelqu'un à un message privé.");
      if (!s.members.some((m) => m.room_id === roomId && m.user_id === userId)) s.members.push({ room_id: roomId, user_id: userId });
      save(s);
      ping({ t: 'rooms', room_id: roomId, user_id: userId });
    },
    async leaveRoom(roomId) {
      const s = load();
      s.members = s.members.filter((m) => !(m.room_id === roomId && m.user_id === me.id));
      if (!s.members.some((m) => m.room_id === roomId)) {
        s.rooms = s.rooms.filter((r) => r.id !== roomId);
        dropMessages(s, (m) => m.room_id === roomId);
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
      dropMessages(s, (m) => m.user_id === userId);
      s.reactions = s.reactions.filter((r) => r.user_id !== userId);
      s.votes = s.votes.filter((v) => v.user_id !== userId);
      save(s);
    },

    async history(roomId, { minId = null } = {}) {
      const s = load();
      let list = s.messages.filter((m) => m.room_id === roomId);
      list = minId ? list.filter((m) => m.id >= minId).slice(0, 300) : list.slice(-100);
      return list.map((m) => view(s, m));
    },
    async send(roomId, text, { image = null, file = null, replyTo = null } = {}) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      if (replyTo && s.messages.find((m) => m.id === replyTo)?.room_id !== roomId) replyTo = null;
      const msg = {
        id: s.nextId++, room_id: roomId, user_id: me.id, text, image_path: image, reply_to: replyTo, created_at: new Date().toISOString(),
        edited_at: null, file_path: file?.path ?? null, file_name: file?.name ?? null, file_size: file?.size ?? null,
      };
      s.messages.push(msg);
      save(s);
      emit('message', view(s, msg));
      ping({ t: 'message', msg });
    },
    async editMessage(id, text) {
      const s = load();
      const m = s.messages.find((x) => x.id === id && x.user_id === me.id);
      if (!m) throw new Error('Interdit.');
      text = text.trim();
      if (text.length > 1000) throw new Error('Message trop long.');
      if (!text && !m.image_path && !m.file_path) throw new Error('Le message ne peut pas être vide.');
      if (s.polls.some((p) => p.message_id === id)) throw new Error('On ne modifie pas un sondage.');
      m.text = text;
      m.edited_at = new Date().toISOString();
      save(s);
      both('edited', { id, text, edited_at: m.edited_at });
    },
    async remove(msg) {
      const s = load();
      const admin = userOf(s, me.id)?.is_admin;
      dropMessages(s, (m) => m.id === msg.id && (m.user_id === me.id || admin));
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

    async pins(roomId) {
      const s = load();
      return s.pins
        .filter((p) => p.room_id === roomId)
        .sort((a, b) => b.pinned_at.localeCompare(a.pinned_at))
        .map((p) => {
          const m = s.messages.find((x) => x.id === p.message_id);
          return m ? { ...view(s, m), pinned_by: pseudoOf(s, p.pinned_by), pinned_at: p.pinned_at } : null;
        })
        .filter(Boolean);
    },
    async pin(messageId, on) {
      const s = load();
      const m = s.messages.find((x) => x.id === messageId);
      if (!m || !isMember(s, m.room_id, me.id)) throw new Error('Interdit.');
      if (roomOf(s, m.room_id)?.is_common && !userOf(s, me.id)?.is_admin) throw new Error('Seul un admin peut épingler dans le salon commun.');
      if (on) {
        if (!s.pins.some((p) => p.message_id === messageId)) {
          if (s.pins.filter((p) => p.room_id === m.room_id).length >= 5) throw new Error('5 messages épinglés maximum par salon.');
          s.pins.push({ message_id: messageId, room_id: m.room_id, pinned_by: me.id, pinned_at: new Date().toISOString() });
        }
      } else s.pins = s.pins.filter((p) => p.message_id !== messageId);
      save(s);
      both('pins', {}, 'pins');
    },

    async createPoll(roomId, question, options, multiple) {
      const s = load();
      if (!isMember(s, roomId, me.id)) throw new Error('Interdit.');
      question = question.trim();
      if (!question || question.length > 200) throw new Error('Question invalide (1 à 200 caractères).');
      const opts = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
      if (opts.length < 2 || opts.length > 6) throw new Error('Un sondage a entre 2 et 6 choix différents.');
      if (opts.some((o) => o.length > 80)) throw new Error('Choix trop long (80 caractères max).');
      const msg = {
        id: s.nextId++, room_id: roomId, user_id: me.id, text: `📊 ${question}`.slice(0, 1000), image_path: null, reply_to: null,
        created_at: new Date().toISOString(), edited_at: null, file_path: null, file_name: null, file_size: null,
      };
      s.messages.push(msg);
      s.polls.push({
        id: crypto.randomUUID(), message_id: msg.id, room_id: roomId, created_by: me.id, question, multiple: !!multiple, closed: false,
        options: opts.map((label) => ({ id: crypto.randomUUID(), label })),
      });
      save(s);
      emit('message', view(s, msg));
      ping({ t: 'message', msg });
      return msg.id;
    },
    async votePoll(pollId, optionId, on) {
      const s = load();
      const p = s.polls.find((x) => x.id === pollId);
      if (!p) throw new Error('Sondage introuvable.');
      if (!isMember(s, p.room_id, me.id)) throw new Error('Interdit.');
      if (p.closed) throw new Error('Ce sondage est terminé.');
      if (!p.options.some((o) => o.id === optionId)) throw new Error('Choix invalide.');
      if (on) {
        if (!p.multiple) s.votes = s.votes.filter((v) => !(v.poll_id === pollId && v.user_id === me.id && v.option_id !== optionId));
        if (!s.votes.some((v) => v.option_id === optionId && v.user_id === me.id)) s.votes.push({ poll_id: pollId, option_id: optionId, user_id: me.id });
      } else s.votes = s.votes.filter((v) => !(v.option_id === optionId && v.user_id === me.id));
      save(s);
      both('poll', { poll_id: pollId });
    },
    async closePoll(pollId) {
      const s = load();
      const p = s.polls.find((x) => x.id === pollId);
      if (!p || (p.created_by !== me.id && !userOf(s, me.id)?.is_admin)) throw new Error('Interdit.');
      p.closed = true;
      save(s);
      both('poll', { poll_id: pollId });
    },
    async polls(messageIds) {
      const s = load();
      return new Map(messageIds.map((id) => [id, pollOf(s, id)]).filter(([, p]) => p));
    },

    async search(query, roomId = null) {
      const s = load();
      const q = query.toLowerCase();
      return s.messages
        .filter((m) => isMember(s, m.room_id, me.id) && (!roomId || m.room_id === roomId) && (m.text || '').toLowerCase().includes(q))
        .slice(-40)
        .reverse()
        .map((m) => ({ id: m.id, room_id: m.room_id, user_id: m.user_id, text: m.text, image_path: m.image_path, file_name: m.file_name, created_at: m.created_at, pseudo: pseudoOf(s, m.user_id) }));
    },

    async upload(file) {
      if (!IMAGE_EXT[file.type]) throw new Error('Format non supporté (png, jpg, gif, webp).');
      if (file.size > Math.min(MAX_IMAGE, DEMO_FILE_MAX)) throw new Error('Mode démo : image de 1 Mo maximum.');
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Lecture impossible.'));
        r.readAsDataURL(file);
      });
    },
    async uploadFile(file) {
      if (!FILE_TYPES[fileExt(file.name)]) throw new Error('Type de fichier non accepté (PDF, Word, Excel, PowerPoint, texte, CSV, ZIP…).');
      if (file.size > Math.min(MAX_FILE, DEMO_FILE_MAX)) throw new Error('Mode démo : fichier de 1 Mo maximum.');
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('Lecture impossible.'));
        r.readAsDataURL(file);
      });
      return { path: data, name: file.name.replace(/[/\\]/g, '_').slice(0, 120), size: file.size };
    },
    async fileUrl(path) {
      return path; // en démo, le chemin est déjà une data: URL
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
