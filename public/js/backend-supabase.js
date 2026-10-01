import { IMAGE_EXT, MAX_IMAGE, mkEmitter, pseudoToEmail } from './shared.js';

export function createSupabaseBackend({ url, key }) {
  const sb = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const { on, emit } = mkEmitter();
  let me = null;
  let profiles = new Map(); // id -> pseudo
  let dbChannel = null;
  let presenceChannel = null;
  const signed = new Map(); // path -> { url, exp }

  const fail = (error) => {
    if (error) throw new Error(error.message || 'Erreur');
  };

  async function loadProfiles() {
    const { data, error } = await sb.from('profiles').select('id, pseudo');
    fail(error);
    profiles = new Map(data.map((p) => [p.id, p.pseudo]));
    return profiles;
  }
  const withPseudo = (m) => ({ ...m, pseudo: profiles.get(m.user_id) || '???' });

  async function loadSession() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return null;
    await loadProfiles();
    const pseudo = profiles.get(data.session.user.id);
    if (!pseudo) {
      await sb.auth.signOut();
      return null;
    }
    me = { id: data.session.user.id, pseudo };
    return me;
  }

  return {
    mode: 'supabase',
    on,

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

    people: () => [...profiles].map(([id, pseudo]) => ({ id, pseudo })).sort((a, b) => a.pseudo.localeCompare(b.pseudo)),
    refreshPeople: loadProfiles,

    async rooms() {
      const { data, error } = await sb
        .from('rooms')
        .select('id, name, emoji, is_common')
        .order('is_common', { ascending: false })
        .order('created_at');
      fail(error);
      return data;
    },

    async members(room) {
      if (room.is_common) return this.people();
      const { data, error } = await sb.from('room_members').select('user_id').eq('room_id', room.id);
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      return data.map((m) => ({ id: m.user_id, pseudo: profiles.get(m.user_id) || '???' }));
    },

    async createRoom(name, emoji, memberIds) {
      const { data, error } = await sb.rpc('create_room', { p_name: name, p_emoji: emoji, p_members: memberIds });
      fail(error);
      return data;
    },
    async addMember(roomId, userId) {
      fail((await sb.rpc('add_room_member', { p_room: roomId, p_user: userId })).error);
    },
    async leaveRoom(roomId) {
      fail((await sb.rpc('leave_room', { p_room: roomId })).error);
    },

    async history(roomId) {
      const { data, error } = await sb
        .from('messages')
        .select('id, room_id, user_id, text, image_path, created_at')
        .eq('room_id', roomId)
        .order('id', { ascending: false })
        .limit(100);
      fail(error);
      if (data.some((m) => !profiles.has(m.user_id))) await loadProfiles();
      return data.reverse().map(withPseudo);
    },

    async send(roomId, text, imagePath = null) {
      const { error } = await sb
        .from('messages')
        .insert({ room_id: roomId, user_id: me.id, text, image_path: imagePath });
      fail(error);
    },

    async remove(msg) {
      const { error } = await sb.from('messages').delete().eq('id', msg.id);
      fail(error);
      if (msg.image_path) sb.storage.from('images').remove([msg.image_path]);
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
          emit('message', withPseudo(p.new));
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) =>
          emit('deleted', { id: p.old.id }),
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
