import { FILE_TYPES, IMAGE_EXT, MAX_FILE, MAX_IMAGE, MIN_PASSWORD, fileExt, mkEmitter, pseudoToEmail } from './shared.js';

const MSG_COLS = 'id, room_id, user_id, text, image_path, created_at, reply_to, edited_at, file_path, file_name, file_size';

export function createSupabaseBackend({ url, key }) {
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const { on, emit } = mkEmitter();
  let me = null;
  let profiles = new Map(); // id -> { pseudo, color, is_admin, avatar_path, settings }
  let colors = new Map(); // pseudo -> couleur d'avatar choisie
  let dbChannel = null;
  let presenceChannel = null;
  const signed = new Map(); // path -> { url, exp }
  const msgCache = new Map(); // id -> { user_id, text, image_path, file_name } (pour afficher les citations)

  const fail = (error) => {
    if (error) throw new Error(error.message || 'Erreur');
  };
  const pseudoOf = (id) => profiles.get(id)?.pseudo || '???';

  // Photos de profil : fichiers privés, affichés via des liens signés gardés en cache (~50 min).
  const avatarSigned = new Map(); // path -> { url, exp }
  let avatars = new Map(); // pseudo -> url signée
  async function signAvatars(list) {
    const now = Date.now();
    const need = [...new Set(list.map((p) => p.avatar_path).filter(Boolean))].filter((path) => !(avatarSigned.get(path)?.exp > now));
    if (need.length) {
      const { data, error } = await sb.storage.from('images').createSignedUrls(need, 3600);
      if (!error) for (const r of data) if (r.signedUrl) avatarSigned.set(r.path, { url: r.signedUrl, exp: now + 50 * 60_000 });
    }
    avatars = new Map(list.filter((p) => p.avatar_path && avatarSigned.has(p.avatar_path)).map((p) => [p.pseudo, avatarSigned.get(p.avatar_path).url]));
  }

  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('id, pseudo, color, is_admin, avatar_path, settings');
    fail(error);
    profiles = new Map(data.map((p) => [p.id, { pseudo: p.pseudo, color: p.color, is_admin: p.is_admin, avatar_path: p.avatar_path, settings: p.settings || {} }]));
    colors = new Map(data.filter((p) => p.color).map((p) => [p.pseudo, p.color]));
    await signAvatars(data);
    if (me && profiles.has(me.id)) {
      const mine = profiles.get(me.id);
      Object.assign(me, { color: mine.color, is_admin: mine.is_admin, settings: mine.settings });
    }
    return profiles;
  }

  const remember = (m) => msgCache.set(m.id, { user_id: m.user_id, text: m.text, image_path: m.image_path, file_name: m.file_name });
  function replyInfo(id) {
    if (!id) return null;
    const c = msgCache.get(id);
    if (!c) return { id, pseudo: '???', text: 'message introuvable', image: false };
    return { id, pseudo: pseudoOf(c.user_id), text: c.text, image: !!(c.image_path || c.file_name) };
  }
  async function loadReplyTargets(ids) {
    const missing = [...new Set(ids.filter((id) => id && !msgCache.has(id)))];
    if (!missing.length) return;
    const { data, error } = await sb.from('messages').select(MSG_COLS).in('id', missing);
    fail(error);
    data.forEach(remember);
  }
  const full = (m, reactions = [], poll = null) => ({ ...m, pseudo: pseudoOf(m.user_id), reactions, reply: replyInfo(m.reply_to), poll });

  // Sondages : question + choix + votes, regroupés par message
  async function loadPolls(messageIds) {
    if (!messageIds.length) return new Map();
    const { data: polls, error } = await sb
      .from('polls')
      .select('id, message_id, question, multiple, closed, created_by')
      .in('message_id', messageIds);
    fail(error);
    if (!polls.length) return new Map();
    const pids = polls.map((p) => p.id);
    const [o, v] = await Promise.all([
      sb.from('poll_options').select('id, poll_id, label, position').in('poll_id', pids),
      sb.from('poll_votes').select('option_id, poll_id, user_id').in('poll_id', pids),
    ]);
    fail(o.error);
    fail(v.error);
    return new Map(polls.map((p) => [p.message_id, {
      id: p.id,
      message_id: p.message_id,
      question: p.question,
      multiple: p.multiple,
      closed: p.closed,
      created_by: p.created_by,
      options: o.data
        .filter((x) => x.poll_id === p.id)
        .sort((a, b) => a.position - b.position)
        .map((x) => ({ id: x.id, label: x.label, votes: v.data.filter((y) => y.option_id === x.id).map((y) => y.user_id) })),
    }]));
  }

  async function loadSession() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    await loadProfiles();
    const p = profiles.get(data.session.user.id);
    if (!p) {
      await sb.auth.signOut();
      return null;
    }
    me = { id: data.session.user.id, pseudo: p.pseudo, color: p.color, is_admin: p.is_admin, settings: p.settings };
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
    async setSettings(settings) {
      fail((await sb.rpc('set_my_settings', { p_settings: settings })).error);
      if (me) me.settings = settings;
    },

    avatar: (pseudo) => avatars.get(pseudo) || '',
    async setAvatar(blob) {
      const old = profiles.get(me.id)?.avatar_path;
      const path = `${me.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('images').upload(path, blob, { contentType: 'image/jpeg' });
      fail(error);
      const { error: e2 } = await sb.rpc('set_my_avatar', { p_path: path });
      if (e2) {
        sb.storage.from('images').remove([path]);
        fail(e2);
      }
      if (old) sb.storage.from('images').remove([old]);
      await loadProfiles();
    },
    async removeAvatar() {
      const old = profiles.get(me.id)?.avatar_path;
      fail((await sb.rpc('set_my_avatar', { p_path: '' })).error);
      if (old) sb.storage.from('images').remove([old]);
      await loadProfiles();
    },

    async ban(userId, reason) {
      fail((await sb.rpc('admin_ban', { p_user: userId, p_reason: reason || '' })).error);
      await loadProfiles();
    },
    async unban(pseudoKey) {
      fail((await sb.rpc('admin_unban', { p_key: pseudoKey })).error);
    },
    async banned() {
      const { data, error } = await sb.from('banned_users').select('pseudo_key, pseudo, reason, banned_at').order('banned_at', { ascending: false });
      fail(error);
      return data;
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

    // Les 100 derniers messages du salon (ou tous ceux depuis minId, pour sauter à un vieux message)
    async history(roomId, { minId = null } = {}) {
      let q = sb.from('messages').select(MSG_COLS).eq('room_id', roomId);
      q = minId ? q.gte('id', minId).order('id', { ascending: true }).limit(300) : q.order('id', { ascending: false }).limit(100);
      const { data, error } = await q;
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      const msgs = minId ? data : data.reverse();
      msgs.forEach(remember);
      await loadReplyTargets(msgs.map((m) => m.reply_to));
      let reacts = [];
      let polls = new Map();
      if (msgs.length) {
        const ids = msgs.map((m) => m.id);
        const r = await sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids);
        fail(r.error);
        reacts = r.data;
        polls = await loadPolls(msgs.filter((m) => m.text.startsWith('📊 ')).map((m) => m.id));
      }
      return msgs.map((m) =>
        full(m, reacts.filter((r) => r.message_id === m.id).map(({ user_id, emoji }) => ({ user_id, emoji })), polls.get(m.id) || null),
      );
    },

    async send(roomId, text, { image = null, file = null, replyTo = null } = {}) {
      const { error } = await sb.from('messages').insert({
        room_id: roomId,
        user_id: me.id,
        text,
        image_path: image,
        reply_to: replyTo,
        file_path: file?.path ?? null,
        file_name: file?.name ?? null,
        file_size: file?.size ?? null,
      });
      fail(error);
    },

    async editMessage(id, text) {
      fail((await sb.rpc('edit_message', { p_id: id, p_text: text })).error);
    },

    async remove(msg) {
      const { error } = await sb.from('messages').delete().eq('id', msg.id);
      fail(error);
      if (msg.image_path) sb.storage.from('images').remove([msg.image_path]);
      if (msg.file_path) sb.storage.from('files').remove([msg.file_path]);
    },

    async react(messageId, emoji, add) {
      const q = add
        ? sb.from('message_reactions').insert({ message_id: messageId, user_id: me.id, emoji })
        : sb.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', me.id).eq('emoji', emoji);
      fail((await q).error);
    },

    // Messages épinglés
    async pins(roomId) {
      const { data, error } = await sb
        .from('pinned_messages')
        .select('message_id, pinned_at, pinned_by')
        .eq('room_id', roomId)
        .order('pinned_at', { ascending: false });
      fail(error);
      if (!data.length) return [];
      const { data: ms, error: e2 } = await sb.from('messages').select(MSG_COLS).in('id', data.map((p) => p.message_id));
      fail(e2);
      if (ms.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      ms.forEach(remember);
      return data
        .map((p) => {
          const m = ms.find((x) => x.id === p.message_id);
          return m ? { ...full(m), pinned_by: pseudoOf(p.pinned_by), pinned_at: p.pinned_at } : null;
        })
        .filter(Boolean);
    },
    async pin(messageId, on) {
      fail((await sb.rpc('pin_message', { p_id: messageId, p_pin: on })).error);
    },

    // Sondages
    async createPoll(roomId, question, options, multiple) {
      const { data, error } = await sb.rpc('create_poll', { p_room: roomId, p_question: question, p_options: options, p_multiple: !!multiple });
      fail(error);
      return data;
    },
    async votePoll(pollId, optionId, on) {
      fail((await sb.rpc('vote_poll', { p_poll: pollId, p_option: optionId, p_on: on })).error);
    },
    async closePoll(pollId) {
      fail((await sb.rpc('close_poll', { p_poll: pollId })).error);
    },
    async polls(messageIds) {
      return loadPolls(messageIds);
    },

    // Recherche dans les messages (d'un salon, ou de tous ceux auxquels on a accès)
    async search(query, roomId = null) {
      const esc = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      let q = sb
        .from('messages')
        .select('id, room_id, user_id, text, image_path, file_name, created_at')
        .ilike('text', `%${esc}%`)
        .order('id', { ascending: false })
        .limit(40);
      if (roomId) q = q.eq('room_id', roomId);
      const { data, error } = await q;
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      return data.map((m) => ({ ...m, pseudo: pseudoOf(m.user_id) }));
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

    // Documents (PDF, Word, Excel…) : bucket privé « files », 10 Mo max
    async uploadFile(file) {
      const ext = fileExt(file.name);
      if (!FILE_TYPES[ext]) throw new Error('Type de fichier non accepté (PDF, Word, Excel, PowerPoint, texte, CSV, ZIP…).');
      if (file.size > MAX_FILE) throw new Error('Fichier trop gros (10 Mo max).');
      const path = `${me.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await sb.storage.from('files').upload(path, file, { contentType: FILE_TYPES[ext] });
      fail(error);
      return { path, name: file.name.replace(/[/\\]/g, '_').slice(0, 120), size: file.size };
    },
    async fileUrl(path, name) {
      const { data, error } = await sb.storage.from('files').createSignedUrl(path, 600, { download: name });
      fail(error);
      return data.signedUrl;
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
          let poll = null;
          try {
            await loadReplyTargets([p.new.reply_to]);
            if (p.new.text.startsWith('📊 ')) poll = (await loadPolls([p.new.id])).get(p.new.id) || null;
          } catch {}
          emit('message', full(p.new, [], poll));
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => {
          remember(p.new);
          emit('edited', { id: p.new.id, text: p.new.text, edited_at: p.new.edited_at });
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
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pinned_messages' }, () => emit('pins', {}))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, (p) => emit('poll', { poll_id: p.new?.poll_id || null }))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'polls' }, (p) => emit('poll', { poll_id: p.new.id }))
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
