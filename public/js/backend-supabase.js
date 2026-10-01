import { IMAGE_EXT, MAX_IMAGE, MIN_PASSWORD, mkEmitter, pseudoToEmail } from './shared.js';

export function createSupabaseBackend({ url, key }) {
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const { on, emit } = mkEmitter();
  let me = null;
  let profiles = new Map(); // id -> { pseudo, color, is_admin }
  let colors = new Map(); // pseudo -> couleur d'avatar choisie
  let dbChannel = null;
  let presenceChannel = null;
  const signed = new Map(); // path -> { url, exp }
  const msgCache = new Map(); // id -> { user_id, text, image_path } (pour afficher les citations)

  const fail = (error) => {
    if (error) throw new Error(error.message || 'Erreur');
  };
  const pseudoOf = (id) => profiles.get(id)?.pseudo || '???';

  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('id, pseudo, color, is_admin');
    fail(error);
    profiles = new Map(data.map((p) => [p.id, { pseudo: p.pseudo, color: p.color, is_admin: p.is_admin }]));
    colors = new Map(data.filter((p) => p.color).map((p) => [p.pseudo, p.color]));
    if (me && profiles.has(me.id)) Object.assign(me, { color: profiles.get(me.id).color, is_admin: profiles.get(me.id).is_admin });
    return profiles;
  }

  const remember = (m) => msgCache.set(m.id, { user_id: m.user_id, text: m.text, image_path: m.image_path });
  function replyInfo(id) {
    if (!id) return null;
    const c = msgCache.get(id);
    if (!c) return { id, pseudo: '???', text: 'message introuvable', image: false };
    return { id, pseudo: pseudoOf(c.user_id), text: c.text, image: !!c.image_path };
  }
  async function loadReplyTargets(ids) {
    const missing = [...new Set(ids.filter((id) => id && !msgCache.has(id)))];
    if (!missing.length) return;
    const { data, error } = await sb.from('messages').select('id, user_id, text, image_path').in('id', missing);
    fail(error);
    data.forEach(remember);
  }
  const full = (m, reactions = []) => ({ ...m, pseudo: pseudoOf(m.user_id), reactions, reply: replyInfo(m.reply_to) });

  async function loadSession() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    await loadProfiles();
    const p = profiles.get(data.session.user.id);
    if (!p) {
      await sb.auth.signOut();
      return null;
    }
    me = { id: data.session.user.id, pseudo: p.pseudo, color: p.color, is_admin: p.is_admin };
    return me;
  }

  return {
    mode: 'supabase',
    on,
    me: () => me,

    getSession: loadSession,

    async register(pseudo, password, code) {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pseudo, password, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Inscription impossible.');
      return this.login(pseudo, password);
    },

    async login(pseudo, password) {
      const { error } = await sb.auth.signInWithPassword({ email: await pseudoToEmail(pseudo), password });
      if (error) throw new Error('Pseudo ou mot de passe incorrect.');
      return loadSession();
    },

    async logout() {
      this.stop();
      await sb.auth.signOut();
    },

    async changePassword(oldPassword, newPassword) {
      if (newPassword.length < MIN_PASSWORD) throw new Error(`Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
      const { error: e1 } = await sb.auth.signInWithPassword({ email: await pseudoToEmail(me.pseudo), password: oldPassword });
      if (e1) throw new Error('Mot de passe actuel incorrect.');
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message || 'Impossible de changer le mot de passe.');
    },

    async setColor(color) {
      fail((await sb.rpc('set_my_color', { p_color: color })).error);
      await loadProfiles();
    },

    people: () =>
      [...profiles]
        .map(([id, p]) => ({ id, pseudo: p.pseudo, color: p.color, is_admin: p.is_admin }))
        .sort((a, b) => a.pseudo.localeCompare(b.pseudo)),
    color: (pseudo) => colors.get(pseudo) || '',
    refreshPeople: loadProfiles,

    async rooms() {
      const { data, error } = await sb
        .from('rooms')
        .select('id, name, emoji, is_common, is_dm')
        .order('is_common', { ascending: false })
        .order('created_at');
      fail(error);
      const dms = data.filter((r) => r.is_dm);
      if (dms.length) {
        const { data: mem, error: e2 } = await sb.from('room_members').select('room_id, user_id').in('room_id', dms.map((r) => r.id));
        fail(e2);
        if (mem.some((m) => !profiles.has(m.user_id))) await loadProfiles();
        for (const r of dms) {
          const other = mem.find((m) => m.room_id === r.id && m.user_id !== me.id);
          r.peer = other ? { id: other.user_id, pseudo: pseudoOf(other.user_id) } : null;
        }
      }
      return data;
    },

    async members(room) {
      if (room.is_common) return this.people();
      const { data, error } = await sb.from('room_members').select('user_id').eq('room_id', room.id);
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      return data.map((m) => ({ id: m.user_id, pseudo: pseudoOf(m.user_id), is_admin: !!profiles.get(m.user_id)?.is_admin }));
    },

    async createRoom(name, emoji, memberIds) {
      const { data, error } = await sb.rpc('create_room', { p_name: name, p_emoji: emoji, p_members: memberIds });
      fail(error);
      return data;
    },
    async createDm(userId) {
      const { data, error } = await sb.rpc('create_dm', { p_user: userId });
      fail(error);
      return data;
    },
    async addMember(roomId, userId) {
      fail((await sb.rpc('add_room_member', { p_room: roomId, p_user: userId })).error);
    },
    async leaveRoom(roomId) {
      fail((await sb.rpc('leave_room', { p_room: roomId })).error);
    },
    async kick(userId) {
      fail((await sb.rpc('admin_kick', { p_user: userId })).error);
      await loadProfiles();
    },

    async history(roomId) {
      const { data, error } = await sb
        .from('messages')
        .select('id, room_id, user_id, text, image_path, created_at, reply_to')
        .eq('room_id', roomId)
        .order('id', { ascending: false })
        .limit(100);
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      const msgs = data.reverse();
      msgs.forEach(remember);
      await loadReplyTargets(msgs.map((m) => m.reply_to));
      let reacts = [];
      if (msgs.length) {
        const r = await sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', msgs.map((m) => m.id));
        fail(r.error);
        reacts = r.data;
      }
      return msgs.map((m) =>
        full(m, reacts.filter((r) => r.message_id === m.id).map(({ user_id, emoji }) => ({ user_id, emoji }))),
      );
    },

    async send(roomId, text, imagePath = null, replyTo = null) {
      const { error } = await sb
        .from('messages')
        .insert({ room_id: roomId, user_id: me.id, text, image_path: imagePath, reply_to: replyTo });
      fail(error);
    },

    async remove(msg) {
      const { error } = await sb.from('messages').delete().eq('id', msg.id);
      fail(error);
      if (msg.image_path) sb.storage.from('images').remove([msg.image_path]);
    },

    async react(messageId, emoji, add) {
      const q = add
        ? sb.from('message_reactions').insert({ message_id: messageId, user_id: me.id, emoji })
        : sb.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', me.id).eq('emoji', emoji);
      fail((await q).error);
    },

    async upload(file) {
      const ext = IMAGE_EXT[file.type];
      if (!ext) throw new Error('Format non supporté (png, jpg, gif, webp).');
      if (file.size > MAX_IMAGE) throw new Error('Image trop grosse (5 Mo max).');
      const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from('images').upload(path, file, { contentType: file.type });
      fail(error);
      return path;
    },

    async imageUrl(path) {
      const hit = signed.get(path);
      if (hit && hit.exp > Date.now()) return hit.url;
      const { data, error } = await sb.storage.from('images').createSignedUrl(path, 3600);
      fail(error);
      signed.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60_000 });
      return data.signedUrl;
    },

    start() {
      this.stop();
      dbChannel = sb
        .channel('db-changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (p) => {
          if (!profiles.has(p.new.user_id)) await loadProfiles();
          remember(p.new);
          try {
            await loadReplyTargets([p.new.reply_to]);
          } catch {}
          emit('message', full(p.new));
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) =>
          emit('deleted', { id: p.old.id }),
        )
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reactions' }, (p) =>
          emit('reaction', { type: 'add', message_id: p.new.message_id, user_id: p.new.user_id, emoji: p.new.emoji }),
        )
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'message_reactions' }, (p) =>
          emit('reaction', { type: 'remove', message_id: p.old.message_id, user_id: p.old.user_id, emoji: p.old.emoji }),
        )
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members' }, async (p) => {
          if (!profiles.has(p.new.user_id)) await loadProfiles();
          emit(p.new.user_id === me.id ? 'rooms' : 'members', { room_id: p.new.room_id });
        })
        .subscribe((status) => emit('status', status === 'SUBSCRIBED'));

      presenceChannel = sb
        .channel('presence', { config: { presence: { key: me.id } } })
        .on('presence', { event: 'sync' }, () => {
          const state = presenceChannel.presenceState();
          emit('presence', Object.values(state).map((a) => a[0].pseudo).sort((a, b) => a.localeCompare(b)));
        })
        .on('broadcast', { event: 'typing' }, ({ payload }) => emit('typing', payload))
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') await presenceChannel.track({ pseudo: me.pseudo });
        });
    },

    stop() {
      if (dbChannel) sb.removeChannel(dbChannel);
      if (presenceChannel) sb.removeChannel(presenceChannel);
      dbChannel = presenceChannel = null;
    },

    typing(roomId) {
      presenceChannel?.send({ type: 'broadcast', event: 'typing', payload: { room_id: roomId, pseudo: me.pseudo } });
    },
  };
}
