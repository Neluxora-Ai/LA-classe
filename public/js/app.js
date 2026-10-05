import { createSupabaseBackend } from './backend-supabase.js';
import { createDemoBackend } from './backend-demo.js';
import {
  AVATAR_COLORS, BIG_EMOJIS, FILE_TYPES, MIN_PASSWORD, MONTHS, QUICK_REACTIONS, birthdayLabel, daysUntilBirthday, fileExt, fileIcon,
  VOICE_MAX_SECS, dropEntries, formatSize, isAudioName, isBigEmoji, passwordStrength, readDropped, relTime, resizeAvatar, resizeSticker, zipFolder,
} from './shared.js';

const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const b = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
  ? createSupabaseBackend({ url: cfg.SUPABASE_URL, key: cfg.SUPABASE_ANON_KEY })
  : createDemoBackend();

const BASE_TITLE = document.title;
const EMOJIS = '😀😂🤣😊😍😎🤔😅😭😡🥳🤯😴🙃😬🫠👍👎👏🙌🙏💪🤝✌️🤞❤️🔥💯✨🎉💀👀🍕🍟🍔☕🎮🎧📚✏️🧠⏰🚌🏫🐐🦆🐸🌈'.match(/\p{Extended_Pictographic}️?/gu);
const GROUP_EMOJIS = ['💬', '📚', '🎮', '🍕', '🎧', '⚽', '🔥', '🧠', '🎉', '🐸', '🌈', '🤫'];

let me = null;
let rooms = [];
let current = null;
let isRegister = false;
let wasOnline = false;
let lastMsg = null;
let replyTo = null; // { id, pseudo, text }
let hiddenUnread = 0; // messages reçus dans le salon ouvert pendant que l'onglet est caché
const unread = {};
const typingUsers = new Map();
const reactionsById = new Map(); // id du message -> [{ user_id, emoji }]
const msgById = new Map(); // id du message -> message affiché (texte à jour, pour modifier / citer)
const pollsByMsg = new Map(); // id du message -> sondage affiché
let roomMembers = []; // membres du salon ouvert (pour l'auto-complétion des @mentions)
let pins = []; // messages épinglés du salon ouvert

const Theme = window.ClasseTheme;
let appearance = Theme.load(); // { theme, accent, accent2, bg, font } : réglages d'apparence
let privacy = { receipts: 'on', lastseen: 'on' }; // « vu » et dernière connexion (synchronisés sur le compte)
let mutedRooms = new Set(); // salons dont les notifications sont coupées
let onlineNames = new Set(); // pseudos actuellement en ligne
const reads = new Map(); // salon ouvert : id de la personne -> dernier message lu
const lastMarked = {}; // salon -> dernier message que j'ai marqué comme lu
let limits = { keep_messages: 50, max_accounts: 20 }; // limites de l'application (lues sur le serveur)
let stickers = []; // stickers de la classe
let stickerTab = 'emoji';

const receiptsOn = () => privacy.receipts !== 'off';

const isAdmin = () => !!(b.me() || me)?.is_admin;
const syncMe = () => {
  me = b.me() || me;
};

// ---------- Réglages (notifications), gardés dans ce navigateur ----------
const PREFS_KEY = 'classe-prefs';
const prefs = (() => {
  const base = { sound: true, desktop: false };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
  } catch {
    return base;
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
};

// ---------- Utilitaires ----------
const colorFor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 70% 55%)`;
};
const colorOf = (name) => b.color(name) || colorFor(name);
function makeAvatar(name, size) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = colorOf(name);
  if (size) Object.assign(el.style, { width: `${size}px`, height: `${size}px` });
  const initial = [...name][0].toUpperCase();
  const photo = b.avatar(name);
  if (photo) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = photo;
    img.onerror = () => { // lien expiré : on retombe sur l'initiale
      img.remove();
      el.textContent = initial;
    };
    el.append(img);
  } else {
    el.textContent = initial;
  }
  return el;
}
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const guard = (fn) => async (...a) => {
  try {
    return await fn(...a);
  } catch (e) {
    toast(e.message);
  }
};
const snippet = (text, image) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return image ? '📷 image' : '';
  return t.length > 70 ? `${t.slice(0, 70)}…` : t;
};
const roomLabel = (r) => (r.is_dm ? `💬 ${r.peer?.pseudo ?? 'conversation terminée'}` : `${r.emoji} ${r.name}`);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_END = '(?![\\p{L}\\p{N}_-])'; // un pseudo ne continue pas par une lettre, un chiffre, _ ou -
// Vrai si le texte mentionne @monpseudo
const mentionsMe = (text) => !!me && new RegExp(`@${escapeRe(me.pseudo)}${NAME_END}`, 'iu').test(text || '');

// Texte -> nœuds DOM : liens http(s) cliquables et @mentions de pseudos connus (jamais d'innerHTML).
function renderText(container, text) {
  const names = b.people().map((p) => p.pseudo).sort((x, y) => y.length - x.length).map(escapeRe);
  const re = new RegExp(`(https?:\\/\\/[^\\s<]+)${names.length ? `|@(${names.join('|')})${NAME_END}` : ''}`, 'giu');
  let last = 0;
  for (const m of text.matchAll(re)) {
    container.append(text.slice(last, m.index));
    if (m[1]) {
      const a = document.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.append(a);
    } else {
      const span = document.createElement('span');
      span.className = `mention${me && m[2].toLowerCase() === me.pseudo.toLowerCase() ? ' me' : ''}`;
      span.textContent = m[0];
      container.append(span);
    }
    last = m.index + m[0].length;
  }
  container.append(text.slice(last));
}

// Bouton « œil » : afficher / masquer un mot de passe
document.addEventListener('click', (e) => {
  const eye = e.target.closest?.('.eye[data-eye]');
  if (!eye) return;
  const input = $(eye.dataset.eye);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  eye.classList.toggle('on', show);
  eye.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
});

// ---------- Authentification ----------
function updateStrength() {
  const pw = $('password').value;
  const { score, label } = passwordStrength(pw);
  const fill = $('strength-fill');
  fill.style.width = pw ? `${score * 25}%` : '0';
  fill.style.background = ['#ff7b7b', '#ff7b7b', '#f5c542', '#8ddc3d', '#3ddc84'][score];
  $('strength-text').textContent = label;
}
function updateMatch() {
  const a = $('password').value;
  const c = $('password2').value;
  const el = $('match-text');
  el.className = 'hint';
  if (!c) return (el.textContent = '');
  const ok = a === c;
  el.textContent = ok ? '✓ Les mots de passe sont identiques' : '✗ Les mots de passe ne sont pas identiques';
  el.classList.add(ok ? 'ok' : 'bad');
}
$('password').addEventListener('input', () => {
  if (isRegister) {
    updateStrength();
    updateMatch();
  }
});
$('password2').addEventListener('input', updateMatch);

let mfaPending = false; // connexion en cours : le mot de passe est bon, on attend le code de la double authentification
function setMfaPending(on) {
  mfaPending = on;
  $('mfa-row').hidden = !on;
  $('mfa-login-code').required = on;
  $('auth-submit').textContent = on ? 'Valider le code 🔐' : isRegister ? 'Créer mon compte 🎉' : 'Entrer 🚀';
  if (on) $('mfa-login-code').focus();
}
function setMode(register) {
  if (mfaPending) {
    b.cancelMfa?.();
    $('mfa-login-code').value = '';
    setMfaPending(false);
  }
  isRegister = register;
  $('tab-login').classList.toggle('active', !register);
  $('tab-register').classList.toggle('active', register);
  $('code-label').hidden = !register;
  $('code').required = register;
  $('password2-label').hidden = !register;
  $('password2').required = register;
  $('strength').hidden = !register;
  if (register) $('password').minLength = MIN_PASSWORD;
  else $('password').removeAttribute('minlength');
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-submit').textContent = register ? 'Créer mon compte 🎉' : 'Entrer 🚀';
  $('auth-error').textContent = '';
  if (register) {
    updateStrength();
    updateMatch();
  }
}
$('tab-login').onclick = () => setMode(false);
$('tab-register').onclick = () => setMode(true);

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  if (isRegister) {
    if ($('password').value.length < MIN_PASSWORD) return ($('auth-error').textContent = `Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
    if ($('password').value !== $('password2').value) return ($('auth-error').textContent = 'Les deux mots de passe ne sont pas identiques.');
  }
  $('auth-submit').disabled = true;
  try {
    const user = mfaPending
      ? await b.loginMfa($('mfa-login-code').value) // 2e étape : code de la double authentification
      : isRegister
        ? await b.register($('pseudo').value, $('password').value, $('code').value)
        : await b.login($('pseudo').value, $('password').value);
    $('password').value = '';
    $('password2').value = '';
    $('mfa-login-code').value = '';
    setMfaPending(false);
    await enterApp(user);
  } catch (err) {
    if (err.mfa) setMfaPending(true); // mot de passe bon, il reste le code à 6 chiffres
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('logout').onclick = async () => {
  await b.logout();
  location.reload();
};

// ---------- Démarrage ----------
async function boot() {
  if (b.mode === 'demo') $('demo-banner').hidden = false;
  let user = null;
  try {
    user = await b.getSession();
  } catch (e) {
    console.error(e);
  }
  if (user) await enterApp(user);
  else $('auth').hidden = false;
}

function renderMeAvatar() {
  $('me-name').textContent = me.pseudo;
  $('me-avatar').replaceWith(Object.assign(makeAvatar(me.pseudo), { id: 'me-avatar' }));
}

async function enterApp(user) {
  me = user;
  syncMe();
  loadAppearance();
  limits = { ...limits, ...(await b.limits().catch(() => ({}))) };
  $('auth').hidden = true;
  $('app').hidden = false;
  $('admin-btn').hidden = !isAdmin();
  renderMeAvatar();
  buildEmojis();
  bindEvents();
  await loadRooms();
  mutedRooms = await b.mutes().catch(() => new Set());
  b.start();
  startPresenceLoop();
  await switchRoom(rooms[0]);
}

let bound = false;
function bindEvents() {
  if (bound) return;
  bound = true;
  b.on('status', async (ok) => {
    $('conn').classList.toggle('off', !ok);
    if (ok && wasOnline && current) await showHistory(); // rattrape les messages ratés pendant une coupure
    if (ok) wasOnline = true;
  });
  b.on('message', async (m) => {
    if (!rooms.some((r) => r.id === m.room_id)) await loadRooms();
    const theirs = m.user_id !== me.id;
    const mentioned = theirs && mentionsMe(m.text);
    const silent = mutedRooms.has(m.room_id) && !mentioned; // salon en sourdine : seules les @mentions préviennent
    if (theirs && !silent && (mentioned || document.hidden || m.room_id !== current?.id)) notify(m, mentioned);
    if (m.room_id !== current?.id) {
      unread[m.room_id] = (unread[m.room_id] || 0) + 1;
      updateTitle();
      return renderRooms();
    }
    if (theirs && document.hidden && !silent) {
      hiddenUnread++;
      updateTitle();
    }
    const box = $('messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || m.user_id === me.id;
    box.querySelector('.empty')?.remove();
    addMessage(m);
    if (stick) box.scrollTop = box.scrollHeight;
    typingUsers.delete(m.pseudo);
    renderTyping();
    renderSeen();
    markRead();
  });
  b.on('reads', ({ room_id, user_id, last_read_id }) => {
    if (!room_id || room_id !== current?.id || user_id === me.id) return;
    reads.set(user_id, Math.max(reads.get(user_id) || 0, last_read_id));
    renderSeen();
  });
  b.on('deleted', ({ id }) => {
    document.querySelector(`.msg[data-id="${id}"]`)?.remove();
    reactionsById.delete(id);
    msgById.delete(id);
    pollsByMsg.delete(id);
    if (pins.some((p) => p.id === id)) refreshPins();
  });
  b.on('edited', applyEdit);
  b.on('pins', guard(refreshPins));
  b.on('poll', guard(({ poll_id }) => refreshPolls(poll_id)));
  b.on('reaction', (ev) => {
    applyReaction(ev);
    renderReactions(ev.message_id);
  });
  b.on('rooms', guard(async () => {
    await b.refreshPeople();
    await loadRooms();
    toast('Nouvelle conversation 🎉');
  }));
  b.on('members', guard(async ({ room_id }) => {
    if (room_id === current?.id) updateMembersCount();
  }));
  b.on('presence', (list) => {
    onlineNames = new Set(list);
    // quelqu'un de nouveau est en ligne : on met à jour la liste des comptes (mentions, messages privés)
    if (list.some((name) => !b.people().some((p) => p.pseudo === name))) b.refreshPeople().then(renderPresence).catch(() => {});
    renderPresence();
  });
  b.on('typing', ({ room_id, pseudo }) => {
    if (room_id !== current?.id || pseudo === me.pseudo) return;
    clearTimeout(typingUsers.get(pseudo));
    typingUsers.set(pseudo, setTimeout(() => { typingUsers.delete(pseudo); renderTyping(); }, 2500));
    renderTyping();
  });
}

// ---------- Notifications (son, navigateur, titre de l'onglet) ----------
let audio = null;
const ensureAudio = () => {
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {}
};
document.addEventListener('pointerdown', ensureAudio, { once: true });
document.addEventListener('keydown', ensureAudio, { once: true });
function beep() {
  if (!audio) return;
  try {
    const t = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.2);
    });
  } catch {}
}
function notify(m, mentioned = false) {
  if (prefs.sound) beep();
  if (prefs.desktop && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const room = rooms.find((r) => r.id === m.room_id);
    const where = !room || room.is_dm ? '' : ` · ${room.emoji} ${room.name}`;
    try {
      const n = new Notification(`${m.pseudo}${mentioned ? ' t\'a mentionné' : ''}${where}`, {
        body: snippet(m.text, m.image_path || m.file_name),
        tag: m.room_id,
      });
      n.onclick = () => {
        window.focus();
        if (room) switchRoom(room);
        n.close();
      };
    } catch {}
  }
}
function updateTitle() {
  const total = Object.entries(unread).reduce((a, [id, n]) => a + (mutedRooms.has(id) ? 0 : n), 0) + hiddenUnread;
  document.title = total ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    hiddenUnread = 0;
    updateTitle();
  }
});

// ---------- Salons ----------
async function loadRooms() {
  rooms = await b.rooms();
  if (current && !rooms.some((r) => r.id === current.id)) await switchRoom(rooms[0]);
  renderRooms();
}
function roomButton(r) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `room-btn ${r.id === current?.id ? 'active' : ''} ${mutedRooms.has(r.id) ? 'muted' : ''}`;
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = roomLabel(r);
  btn.append(nm);
  if (unread[r.id]) {
    const badge = document.createElement('span');
    badge.className = `badge${mutedRooms.has(r.id) ? ' muted' : ''}`;
    badge.textContent = unread[r.id];
    btn.append(badge);
  }
  btn.onclick = () => switchRoom(r);
  return btn;
}
function renderRooms() {
  const common = rooms.filter((r) => r.is_common);
  const groups = rooms.filter((r) => !r.is_common && !r.is_dm);
  const dms = rooms.filter((r) => r.is_dm);
  $('common-room').replaceChildren(...common.map(roomButton));
  $('private-rooms').replaceChildren(...groups.map(roomButton));
  $('dm-rooms').replaceChildren(...dms.map(roomButton));
  $('no-groups').hidden = groups.length > 0;
  $('no-dms').hidden = dms.length > 0;
}
async function switchRoom(r) {
  current = r;
  unread[r.id] = 0;
  hiddenUnread = 0;
  updateTitle();
  clearReply();
  typingUsers.clear();
  renderTyping();
  $('room-title').textContent = `${!r.is_common && !r.is_dm ? '🔒 ' : ''}${roomLabel(r)}`;
  $('members-btn').hidden = !!r.is_dm;
  renderRooms();
  closeSidebar();
  $('messages').replaceChildren();
  pins = [];
  renderPinsBar();
  hideMentions();
  hidePanels();
  cancelRecording(); // un message vocal en cours ne doit pas partir dans un autre salon
  reads.clear();
  renderMuteButton();
  renderRoomSub();
  updateMembersCount();
  refreshPins();
  loadReads(r);
  await showHistory();
  $('text').focus();
}
// Où en sont les autres dans ce salon (pour « vu »)
async function loadReads(room) {
  if (!receiptsOn()) return;
  try {
    const list = await b.reads(room.id);
    if (room !== current) return;
    reads.clear();
    for (const r of list) if (r.user_id !== me.id) reads.set(r.user_id, r.last_read_id);
    renderSeen();
  } catch {}
}
// Je viens de lire jusqu'au dernier message du salon ouvert
let markTimer = null;
function markRead() {
  if (!receiptsOn() || document.hidden || !current) return;
  clearTimeout(markTimer);
  const room = current;
  markTimer = setTimeout(() => {
    const rows = document.querySelectorAll('#messages .msg');
    const last = Number(rows[rows.length - 1]?.dataset.id || 0);
    if (!last || room !== current || last <= (lastMarked[room.id] || 0)) return;
    lastMarked[room.id] = last;
    b.markRead(room.id, last).catch(() => {});
  }, 400);
}
// « Vu par … » sous mon dernier message
function renderSeen() {
  document.querySelectorAll('#messages .seen').forEach((el) => el.remove());
  if (!receiptsOn() || !current) return;
  const mine = [...document.querySelectorAll('#messages .msg.mine')];
  const row = mine[mine.length - 1];
  if (!row) return;
  const id = Number(row.dataset.id);
  const names = new Map(b.people().map((p) => [p.id, p.pseudo]));
  const readers = [...reads].filter(([, last]) => last >= id).map(([uid]) => names.get(uid)).filter(Boolean);
  if (!readers.length) return;
  const el = document.createElement('div');
  el.className = `seen${current.is_dm ? ' in-dm' : ''}`;
  el.textContent = current.is_dm ? '✓✓ Vu' : `👁 Vu par ${readers.slice(0, 3).join(', ')}${readers.length > 3 ? ` et ${readers.length - 3} autre${readers.length > 4 ? 's' : ''}` : ''}`;
  row.after(el);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) markRead();
});

// ---------- Sourdine d'un salon ----------
function renderMuteButton() {
  const muted = !!current && mutedRooms.has(current.id);
  const btn = $('mute-btn');
  btn.textContent = muted ? '🔕' : '🔔';
  btn.classList.toggle('off', muted);
  btn.title = muted ? 'Notifications coupées (seules les @mentions préviennent) : cliquer pour les réactiver' : 'Couper les notifications de ce salon';
}
$('mute-btn').onclick = guard(async () => {
  const id = current.id;
  const muted = !mutedRooms.has(id);
  await b.setMuted(id, muted);
  if (muted) mutedRooms.add(id);
  else mutedRooms.delete(id);
  renderMuteButton();
  renderRooms();
  updateTitle();
  toast(muted ? '🔕 Notifications coupées pour ce salon (les @mentions te préviennent encore).' : '🔔 Notifications réactivées.');
});
// minId : charge tous les messages depuis celui-là (pour atteindre un vieux message trouvé par la recherche / un épinglé)
async function showHistory({ minId = null } = {}) {
  const room = current;
  let msgs;
  try {
    msgs = await b.history(room.id, { minId });
  } catch (e) {
    return toast(e.message);
  }
  if (room !== current) return; // l'utilisateur a changé de salon entre-temps
  const box = $('messages');
  box.replaceChildren();
  reactionsById.clear();
  msgById.clear();
  pollsByMsg.clear();
  lastMsg = null;
  const note = document.createElement('div');
  note.className = 'retention-note';
  note.textContent = `ℹ️ Seuls les ${limits.keep_messages} derniers messages de cette conversation sont gardés : les plus anciens disparaissent.`;
  box.append(note);
  if (!msgs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = "Personne n'a encore écrit ici. Brise la glace ! 🧊";
    box.append(p);
  }
  for (const m of msgs) addMessage(m);
  if (!minId) box.scrollTop = box.scrollHeight;
  renderSeen();
  markRead();
}
async function updateMembersCount() {
  const room = current;
  try {
    const list = await b.members(room);
    if (room !== current) return;
    roomMembers = list;
    if (!room.is_dm) $('members-count').textContent = list.length;
  } catch {}
}

const sidebar = $('sidebar');
const closeSidebar = () => { sidebar.classList.remove('open'); $('scrim').hidden = true; };
$('menu').onclick = () => { sidebar.classList.add('open'); $('scrim').hidden = false; };
$('scrim').onclick = closeSidebar;

// ---------- Réactions ----------
function applyReaction({ type, message_id, user_id, emoji }) {
  const list = reactionsById.get(message_id) || [];
  const idx = list.findIndex((r) => r.user_id === user_id && r.emoji === emoji);
  if (type === 'add' && idx < 0) list.push({ user_id, emoji });
  if (type === 'remove' && idx >= 0) list.splice(idx, 1);
  reactionsById.set(message_id, list);
}
function renderReactions(id) {
  const box = document.querySelector(`.msg[data-id="${id}"] .reactions`);
  if (!box) return;
  const byEmoji = new Map();
  for (const r of reactionsById.get(id) || []) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  const names = new Map(b.people().map((p) => [p.id, p.pseudo]));
  box.replaceChildren(...[...byEmoji].map(([emoji, users]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    const mine = users.includes(me.id);
    chip.className = `chip ${mine ? 'mine' : ''}`;
    chip.textContent = `${emoji} ${users.length}`;
    chip.title = users.map((u) => names.get(u) || '???').join(', ');
    chip.onclick = () => toggleReaction(id, emoji);
    return chip;
  }));
}
const toggleReaction = guard(async (id, emoji) => {
  const has = (reactionsById.get(id) || []).some((r) => r.user_id === me.id && r.emoji === emoji);
  const ev = { message_id: id, user_id: me.id, emoji };
  applyReaction({ ...ev, type: has ? 'remove' : 'add' }); // affichage immédiat
  renderReactions(id);
  try {
    await b.react(id, emoji, !has);
  } catch (err) {
    applyReaction({ ...ev, type: has ? 'add' : 'remove' }); // on annule si le serveur refuse
    renderReactions(id);
    throw err;
  }
});

// ---------- Réponses ----------
function setReply(m) {
  replyTo = { id: m.id, pseudo: m.pseudo, text: snippet(m.text, m.image_path || m.file_name) };
  $('reply-name').textContent = `↩ ${m.pseudo} :`;
  $('reply-name').style.fontWeight = '700';
  $('reply-snippet').textContent = replyTo.text;
  $('reply-bar').hidden = false;
  $('text').focus();
}
function clearReply() {
  replyTo = null;
  $('reply-bar').hidden = true;
}
$('reply-cancel').onclick = clearReply;
// Va jusqu'à un message (changeant de salon si besoin, et chargeant l'historique ancien si nécessaire)
const goToMessage = guard(async (roomId, id) => {
  if (current?.id !== roomId) {
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return toast("Tu n'as plus accès à ce salon.");
    await switchRoom(room);
  }
  let row = document.querySelector(`.msg[data-id="${id}"]`);
  if (!row) {
    await showHistory({ minId: id });
    row = document.querySelector(`.msg[data-id="${id}"]`);
  }
  if (!row) return toast('Ce message a été supprimé.');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1300);
});
const jumpTo = (id) => goToMessage(current.id, id);

// ---------- Messages ----------
function actionButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.onclick = onClick;
  return btn;
}
// (Re)dessine le texte d'un message : liens, @mentions et mention « modifié »
function renderBody(row, m) {
  const body = row.querySelector('.body');
  if (!body) return;
  body.replaceChildren();
  if (m.poll || !m.text) {
    body.hidden = true;
    return;
  }
  body.hidden = false;
  const big = isBigEmoji(m.text) && !m.sticker && !m.image_path && !m.file_path && !m.reply;
  body.classList.toggle('big', big);
  row.classList.toggle('big-emoji', big);
  renderText(body, m.text);
  if (m.edited_at) {
    const tag = document.createElement('span');
    tag.className = 'edited';
    tag.textContent = '(modifié)';
    tag.title = `Modifié à ${fmtTime(m.edited_at)}`;
    body.append(' ', tag);
  }
}
function applyEdit({ id, text, edited_at }) {
  const m = msgById.get(id);
  if (!m) return;
  m.text = text;
  m.edited_at = edited_at;
  const row = document.querySelector(`.msg[data-id="${id}"]`);
  if (row) {
    renderBody(row, m);
    row.classList.toggle('mentioned', m.user_id !== me.id && mentionsMe(text));
  }
  const pin = pins.find((p) => p.id === id);
  if (pin) {
    pin.text = text;
    renderPinsBar();
  }
}
function startEdit(row, m) {
  const body = row.querySelector('.body');
  if (!body || row.querySelector('.edit-box')) return;
  const box = document.createElement('div');
  box.className = 'edit-box';
  const input = document.createElement('input');
  input.maxLength = 1000;
  input.value = m.text || '';
  const save = actionButton('Enregistrer', 'Enregistrer la modification', null);
  const cancel = actionButton('Annuler', 'Annuler', null);
  const close = () => {
    box.remove();
    renderBody(row, m);
  };
  save.onclick = guard(async () => {
    const text = input.value.trim();
    if (text === (m.text || '')) return close();
    await b.editMessage(m.id, text);
    applyEdit({ id: m.id, text, edited_at: new Date().toISOString() });
    box.remove();
  });
  cancel.onclick = close;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save.click();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  box.append(input, save, cancel);
  body.hidden = true;
  body.after(box);
  input.focus();
}

// ---------- Sondages ----------
function renderPoll(row, poll) {
  const box = row.querySelector('.poll');
  if (!box) return;
  pollsByMsg.set(poll.message_id, poll);
  const voters = new Set(poll.options.flatMap((o) => o.votes));
  const total = voters.size;
  const names = new Map(b.people().map((p) => [p.id, p.pseudo]));
  const q = document.createElement('div');
  q.className = 'poll-q';
  q.textContent = `📊 ${poll.question}`;
  const opts = poll.options.map((o) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `poll-opt${o.votes.includes(me.id) ? ' mine' : ''}`;
    btn.disabled = poll.closed;
    const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.width = `${pct}%`;
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = o.label;
    const num = document.createElement('span');
    num.className = 'pct';
    num.textContent = `${o.votes.length} · ${pct}%`;
    btn.title = o.votes.length ? o.votes.map((u) => names.get(u) || '???').join(', ') : 'Aucun vote';
    btn.append(bar, num, lbl);
    btn.onclick = () => votePollUi(poll, o);
    return btn;
  });
  const meta = document.createElement('div');
  meta.className = 'poll-meta';
  const info = document.createElement('span');
  info.textContent = `${total} votant${total > 1 ? 's' : ''} · ${poll.multiple ? 'plusieurs choix' : 'un seul choix'}${poll.closed ? ' · terminé 🔒' : ''}`;
  meta.append(info);
  if (!poll.closed && (poll.created_by === me.id || isAdmin())) {
    const end = document.createElement('button');
    end.type = 'button';
    end.textContent = 'Terminer';
    end.onclick = guard(async () => {
      if (!confirm('Terminer ce sondage ? Plus personne ne pourra voter.')) return;
      await b.closePoll(poll.id);
      poll.closed = true;
      renderPoll(row, poll);
    });
    meta.append(end);
  }
  box.replaceChildren(q, ...opts, meta);
}
const votePollUi = guard(async (poll, opt) => {
  const has = opt.votes.includes(me.id);
  if (!has && !poll.multiple) poll.options.forEach((o) => (o.votes = o.votes.filter((u) => u !== me.id)));
  opt.votes = has ? opt.votes.filter((u) => u !== me.id) : [...opt.votes, me.id];
  renderPoll(document.querySelector(`.msg[data-id="${poll.message_id}"]`), poll); // affichage immédiat
  try {
    await b.votePoll(poll.id, opt.id, !has);
  } catch (err) {
    await refreshPolls();
    throw err;
  }
});
// Recharge les sondages affichés (votes des autres, sondage terminé…)
async function refreshPolls() {
  const ids = [...pollsByMsg.keys()];
  if (!ids.length) return;
  const fresh = await b.polls(ids);
  for (const [mid, poll] of fresh) renderPoll(document.querySelector(`.msg[data-id="${mid}"]`), poll);
}

// ---------- Messages épinglés ----------
const canPin = (room) => !!room && (!room.is_common || isAdmin());
async function refreshPins() {
  const room = current;
  if (!room) return;
  const list = await b.pins(room.id);
  if (room !== current) return;
  pins = list;
  renderPinsBar();
}
function renderPinsBar() {
  const bar = $('pins-bar');
  bar.hidden = !pins.length;
  if (!pins.length) return;
  const p = pins[0];
  const who = document.createElement('b');
  who.textContent = p.pseudo;
  $('pin-text').replaceChildren(who, ` ${snippet(p.text, p.image_path || p.file_name) || '(sondage)'}`);
  $('pin-count').textContent = pins.length > 1 ? `+${pins.length - 1}` : '';
}
const togglePin = guard(async (m) => {
  await b.pin(m.id, !pins.some((p) => p.id === m.id));
  await refreshPins();
});
$('pins-bar').onclick = () => {
  $('pins-error').textContent = '';
  renderPinsList();
  $('dlg-pins').showModal();
};
function renderPinsList() {
  $('pins-list').replaceChildren(...pins.map((p) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'result';
    const head = document.createElement('div');
    head.className = 'r-head';
    const who = document.createElement('b');
    who.textContent = p.pseudo;
    head.append(who, new Date(p.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }), `épinglé par ${p.pinned_by}`);
    const text = document.createElement('div');
    text.className = 'r-text';
    text.textContent = snippet(p.text, p.image_path || p.file_name) || '(sondage)';
    go.append(head, text);
    go.onclick = () => {
      $('dlg-pins').close();
      goToMessage(current.id, p.id);
    };
    row.append(go);
    if (canPin(current)) {
      const un = document.createElement('button');
      un.type = 'button';
      un.className = 'add';
      un.textContent = 'Désépingler';
      un.onclick = async () => {
        try {
          await b.pin(p.id, false);
          await refreshPins();
          renderPinsList();
        } catch (err) {
          $('pins-error').textContent = err.message;
        }
      };
      row.append(un);
    }
    return row;
  }));
}

function addMessage(m) {
  const box = $('messages');
  const mine = m.user_id === me.id;
  const t = new Date(m.created_at).getTime();
  const cont = lastMsg && lastMsg.user_id === m.user_id && t - lastMsg.t < 120_000 && !m.reply && !m.poll;
  lastMsg = { user_id: m.user_id, t };
  msgById.set(m.id, m);

  const row = document.createElement('div');
  row.className = `msg ${mine ? 'mine' : ''} ${cont ? 'cont' : 'first'}`;
  if (!mine && !m.poll && mentionsMe(m.text)) row.classList.add('mentioned');
  row.dataset.id = m.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (!cont) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = m.pseudo;
    name.style.color = colorOf(m.pseudo);
    name.style.cursor = 'pointer';
    name.title = 'Voir le profil';
    name.onclick = () => openCard(m.user_id);
    meta.append(name, fmtTime(m.created_at));
    bubble.append(meta);
  }
  if (m.reply) {
    const q = document.createElement('div');
    q.className = 'quote';
    const qn = document.createElement('b');
    qn.textContent = m.reply.pseudo;
    q.append('↩ ', qn, ` ${snippet(m.reply.text, m.reply.image)}`);
    q.onclick = () => jumpTo(m.reply.id);
    bubble.append(q);
  }
  const body = document.createElement('div');
  body.className = 'body';
  bubble.append(body);
  if (m.poll) {
    const poll = document.createElement('div');
    poll.className = 'poll';
    bubble.append(poll);
  }
  if (m.file_path && isAudioName(m.file_name)) {
    // audio / message vocal : on l'écoute directement dans le chat
    const card = document.createElement('div');
    card.className = 'audio-card';
    const head = document.createElement('div');
    head.className = 'audio-head';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = /^Message vocal/.test(m.file_name) ? '🎤' : '🎧';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = m.file_name.replace(/\.[^.]+$/, '');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'play-btn';
    play.textContent = '▶ Écouter';
    head.append(ico, nm, play);
    const foot = document.createElement('span');
    foot.className = 'sz';
    foot.textContent = formatSize(m.file_size || 0);
    card.append(head, foot);
    play.onclick = guard(async () => {
      const url = await b.fileUrl(m.file_path, m.file_name, { inline: true });
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.autoplay = true;
      audio.src = url;
      play.remove();
      card.insertBefore(audio, foot); // le lecteur prend toute la largeur sous le titre
      const dl = document.createElement('a');
      dl.className = 'dl';
      dl.textContent = 'Télécharger';
      dl.href = '#';
      dl.onclick = guard(async (e) => {
        e.preventDefault();
        const a = document.createElement('a');
        a.href = await b.fileUrl(m.file_path, m.file_name);
        a.download = m.file_name;
        a.rel = 'noopener';
        document.body.append(a);
        a.click();
        a.remove();
      });
      foot.append(' · ', dl);
    });
    bubble.append(card);
  } else if (m.file_path) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'file-card';
    card.title = 'Télécharger';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = fileIcon(m.file_name);
    const info = document.createElement('span');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = m.file_name;
    const sz = document.createElement('div');
    sz.className = 'sz';
    sz.textContent = `${fileExt(m.file_name).toUpperCase()} · ${formatSize(m.file_size || 0)} · Télécharger`;
    info.append(nm, sz);
    card.append(ico, info);
    card.onclick = guard(async () => {
      const url = await b.fileUrl(m.file_path, m.file_name);
      const a = document.createElement('a');
      a.href = url;
      a.download = m.file_name;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    });
    bubble.append(card);
  }
  if (m.image_path) {
    const img = document.createElement('img');
    img.alt = 'image envoyée';
    b.imageUrl(m.image_path).then((url) => {
      img.src = url;
      img.onclick = () => openLightbox(url);
    }).catch(() => (img.alt = 'image indisponible'));
    img.onload = () => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
    };
    bubble.append(img);
  }

  const chips = document.createElement('div');
  chips.className = 'reactions';
  bubble.append(chips);

  // Barre d'actions : réagir, répondre, supprimer
  const actions = document.createElement('div');
  actions.className = 'actions';
  const quick = document.createElement('div');
  quick.className = 'quick';
  for (const em of QUICK_REACTIONS) {
    quick.append(actionButton(em, `Réagir ${em}`, () => {
      quick.classList.remove('open');
      row.classList.remove('show-actions');
      toggleReaction(m.id, em);
    }));
  }
  actions.append(
    quick,
    actionButton('😊', 'Réagir', () => quick.classList.toggle('open')),
    actionButton('↩', 'Répondre', () => {
      row.classList.remove('show-actions');
      setReply(m);
    }),
  );
  if (mine && !m.poll) {
    actions.append(actionButton('✏', 'Modifier', () => {
      row.classList.remove('show-actions');
      startEdit(row, m);
    }));
  }
  if (canPin(current)) {
    actions.append(actionButton('📌', 'Épingler / désépingler', () => {
      row.classList.remove('show-actions');
      togglePin(m);
    }));
  }
  if (mine || isAdmin()) {
    actions.append(actionButton('🗑', mine ? 'Supprimer' : 'Supprimer (admin)', guard(async () => {
      const ok = confirm(mine ? 'Supprimer ce message ?' : `Supprimer ce message de ${m.pseudo} ?`);
      if (ok) await b.remove(m);
    })));
  }
  bubble.append(actions);

  // Sur téléphone (pas de survol) : un appui sur la bulle ouvre la barre d'actions
  bubble.addEventListener('click', (e) => {
    if (!matchMedia('(hover: none)').matches || e.target.closest('a, button, img')) return;
    document.querySelectorAll('.msg.show-actions').forEach((r) => r !== row && r.classList.remove('show-actions'));
    row.classList.toggle('show-actions');
  });

  if (m.sticker) {
    const img = document.createElement('img');
    img.className = 'sticker-img';
    img.alt = m.sticker.name;
    img.title = m.sticker.name;
    b.imageUrl(m.sticker.path).then((url) => {
      img.src = url;
    }).catch(() => (img.alt = 'sticker indisponible'));
    img.onload = () => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 300) box.scrollTop = box.scrollHeight;
    };
    bubble.prepend(img);
    row.classList.add('has-sticker');
  }
  const avatar = makeAvatar(m.pseudo, 34);
  avatar.title = 'Voir le profil';
  avatar.onclick = () => openCard(m.user_id);
  row.append(avatar, bubble);
  box.append(row);
  renderBody(row, m);
  if (m.poll) renderPoll(row, m.poll);
  reactionsById.set(m.id, [...(m.reactions || [])]);
  renderReactions(m.id);
}

$('composer').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  const reply = replyTo;
  $('text').value = '';
  $('emoji-panel').hidden = true;
  clearReply();
  try {
    await b.send(current.id, text, { replyTo: reply?.id ?? null });
  } catch (err) {
    $('text').value = text; // on ne perd pas le message
    if (reply) setReply({ id: reply.id, pseudo: reply.pseudo, text: reply.text });
    throw err;
  }
}));

let lastTyping = 0;
$('text').addEventListener('input', () => {
  if (Date.now() - lastTyping > 1500) {
    lastTyping = Date.now();
    b.typing(current.id);
  }
});
function renderTyping() {
  const names = [...typingUsers.keys()];
  $('typing').textContent = !names.length ? '' : names.length === 1 ? `${names[0]} écrit…` : `${names.slice(0, 3).join(', ')} écrivent…`;
}

// ---------- Emojis & images ----------
function buildEmojis() {
  const panel = $('emoji-panel');
  if (panel.childElementCount) return;
  for (const e of EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = e;
    btn.onclick = () => { $('text').value += e; $('text').focus(); };
    panel.append(btn);
  }
}
// Un seul panneau ouvert à la fois (emojis / stickers)
function hidePanels() {
  $('emoji-panel').hidden = true;
  $('sticker-panel').hidden = true;
}
$('emoji-btn').onclick = () => {
  const open = $('emoji-panel').hidden;
  hidePanels();
  $('emoji-panel').hidden = !open;
};

const sendImage = guard(async (file) => {
  if (!file || !file.type.startsWith('image/')) return;
  const path = await b.upload(file);
  const caption = $('text').value.trim();
  const reply = replyTo;
  await b.send(current.id, caption, { image: path, replyTo: reply?.id ?? null });
  $('text').value = '';
  clearReply();
});
// Documents (PDF, Word, Excel…) : 10 Mo max
const sendDocument = guard(async (file) => {
  if (!FILE_TYPES[fileExt(file.name)]) throw new Error('Type de fichier non accepté (PDF, Word, Excel, PowerPoint, texte, CSV, ZIP…).');
  toast('Envoi du fichier…');
  const info = await b.uploadFile(file);
  const caption = $('text').value.trim();
  const reply = replyTo;
  await b.send(current.id, caption, { file: info, replyTo: reply?.id ?? null });
  $('text').value = '';
  clearReply();
  $('toast').hidden = true;
});
// Image ou document : on choisit selon le type du fichier
const sendPicked = async (file) => {
  if (!file) return;
  if (file.type.startsWith('image/')) await sendImage(file);
  else await sendDocument(file);
};
// Plusieurs fichiers d'un coup : un message par fichier (10 maximum)
const MAX_PICK = 10;
const sendMany = async (files) => {
  if (files.length > MAX_PICK) toast(`${files.length} fichiers choisis : je n'envoie que les ${MAX_PICK} premiers.`);
  for (const file of files.slice(0, MAX_PICK)) await sendPicked(file);
};
// Un dossier : fabriqué en .zip dans le navigateur puis envoyé comme un fichier
const sendFolder = guard(async (name, files) => {
  toast(`Préparation du dossier « ${name} »…`);
  await sendDocument(await zipFolder(name, files));
});
$('img-btn').onclick = () => $('file').click();
$('file').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  sendMany(files);
};
$('folder-btn').onclick = () => $('folder').click();
$('folder').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const root = (files[0].webkitRelativePath || '').split('/')[0] || 'dossier';
  sendFolder(root, files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
};
document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file && !$('app').hidden) sendImage(file);
});
// Glisser-déposer un fichier dans le chat
const chatEl = document.querySelector('.chat');
let dragDepth = 0;
chatEl.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  chatEl.classList.add('dragover');
});
chatEl.addEventListener('dragover', (e) => {
  if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
});
chatEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) chatEl.classList.remove('dragover');
});
const handleDropped = guard(async (entries) => {
  const { files, folders } = await readDropped(entries);
  if (!files.length && !folders.length) return;
  for (const f of folders) await sendFolder(f.name, f.files);
  await sendMany(files);
});
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  chatEl.classList.remove('dragover');
  handleDropped(dropEntries(e.dataTransfer)); // à lire tout de suite : le navigateur vide la liste après le « drop »
});
function openLightbox(src) {
  $('lightbox').querySelector('img').src = src;
  $('lightbox').hidden = false;
}
$('lightbox').onclick = () => ($('lightbox').hidden = true);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('lightbox').hidden = true;
  if (document.activeElement === $('text')) clearReply();
});

// ---------- Groupes : création ----------
const dlgCreate = $('dlg-create');
let chosenEmoji = GROUP_EMOJIS[0];
document.querySelectorAll('[data-close]').forEach((btn) => (btn.onclick = () => btn.closest('dialog').close()));

function personRow(p, { checkbox, kick } = {}) {
  const row = document.createElement(checkbox ? 'label' : 'div');
  row.className = 'person';
  row.append(makeAvatar(p.pseudo), p.pseudo);
  if (p.nickname) {
    const nick = document.createElement('span');
    nick.className = 'nick';
    nick.textContent = `« ${p.nickname} »`;
    row.append(nick);
  }
  if (p.is_admin) {
    const crown = document.createElement('span');
    crown.className = 'crown';
    crown.title = 'Admin';
    crown.textContent = '👑';
    row.append(crown);
  }
  if (checkbox) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    row.append(cb);
  }
  if (kick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'kick';
    btn.textContent = 'Supprimer le compte';
    btn.title = 'Admin : supprime ce compte et tous ses messages';
    btn.onclick = kick;
    row.append(btn);
  }
  return row;
}

$('new-room').onclick = guard(async () => {
  await b.refreshPeople();
  $('room-name').value = '';
  $('create-error').textContent = '';
  chosenEmoji = GROUP_EMOJIS[0];
  const choice = $('emoji-choice');
  choice.replaceChildren(...GROUP_EMOJIS.map((em) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = em;
    btn.className = em === chosenEmoji ? 'sel' : '';
    btn.onclick = () => {
      chosenEmoji = em;
      choice.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === btn));
    };
    return btn;
  }));
  $('create-people').replaceChildren(...b.people().filter((p) => p.id !== me.id).map((p) => personRow(p, { checkbox: true })));
  dlgCreate.showModal();
  $('room-name').focus();
});

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ids = [...$('create-people').querySelectorAll('input:checked')].map((i) => i.value);
  try {
    const id = await b.createRoom($('room-name').value, chosenEmoji, ids);
    dlgCreate.close();
    await loadRooms();
    await switchRoom(rooms.find((r) => r.id === id) || rooms[0]);
  } catch (err) {
    $('create-error').textContent = err.message;
  }
});

// ---------- Groupes : membres (et exclusion pour l'admin) ----------
const dlgMembers = $('dlg-members');
async function renderMembersDialog() {
  const room = current;
  await b.refreshPeople();
  syncMe();
  const members = await b.members(room);
  const ids = new Set(members.map((m) => m.id));
  $('members-title').textContent = `${room.emoji} ${room.name} · ${members.length} membre${members.length > 1 ? 's' : ''}`;
  $('members-list').replaceChildren(...members.map((p) => personRow(p, {
    kick: isAdmin() && p.id !== me.id && !p.is_admin
      ? guard(async () => {
        if (!confirm(`Supprimer le compte de « ${p.pseudo} » ? Son compte, ses messages et ses réactions seront effacés définitivement.`)) return;
        await b.kick(p.id);
        await renderMembersDialog();
        updateMembersCount();
        showHistory();
      })
      : null,
  })));
  $('add-section').hidden = room.is_common;
  $('leave-btn').hidden = room.is_common;
  const addable = b.people().filter((p) => !ids.has(p.id));
  $('add-people').replaceChildren(...addable.map((p) => {
    const row = personRow(p);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add';
    add.textContent = 'Ajouter';
    add.onclick = async () => {
      add.disabled = true;
      try {
        await b.addMember(room.id, p.id);
        await renderMembersDialog();
        updateMembersCount();
      } catch (err) {
        $('members-error').textContent = err.message;
        add.disabled = false;
      }
    };
    row.append(add);
    return row;
  }));
  if (room.is_common) $('add-people').replaceChildren();
}
$('members-btn').onclick = guard(async () => {
  $('members-error').textContent = '';
  await renderMembersDialog();
  dlgMembers.showModal();
});
$('leave-btn').onclick = guard(async () => {
  if (!confirm(`Quitter « ${current.name} » ? Tu ne verras plus ses messages.`)) return;
  await b.leaveRoom(current.id);
  dlgMembers.close();
  await loadRooms();
  await switchRoom(rooms[0]);
});

// ---------- Messages privés ----------
const dlgDm = $('dlg-dm');
async function openDmWith(userId) {
  const id = await b.createDm(userId);
  await loadRooms();
  dlgDm.close();
  await switchRoom(rooms.find((r) => r.id === id) || rooms[0]);
}
$('new-dm').onclick = guard(async () => {
  await b.refreshPeople();
  $('dm-error').textContent = '';
  $('dm-people').replaceChildren(...b.people().filter((p) => p.id !== me.id).map((p) => {
    const row = personRow(p);
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'add';
    go.textContent = 'Écrire';
    go.onclick = async () => {
      try {
        await openDmWith(p.id);
      } catch (err) {
        $('dm-error').textContent = err.message;
      }
    };
    row.append(go);
    return row;
  }));
  dlgDm.showModal();
});

// ---------- Profil ----------
const dlgProfile = $('dlg-profile');
function renderColorChoice() {
  const cur = (b.me() || me).color || '';
  const wrap = $('color-choice');
  const make = (color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = cur === color ? 'sel' : '';
    if (color) {
      btn.style.background = color;
      btn.title = color;
    } else {
      btn.classList.add('auto');
      btn.textContent = 'Auto';
      btn.title = 'Couleur automatique';
    }
    btn.onclick = guard(async () => {
      await b.setColor(color);
      syncMe();
      renderMeAvatar();
      renderColorChoice();
      renderProfileAvatar();
      showHistory();
    });
    return btn;
  };
  wrap.replaceChildren(make(''), ...AVATAR_COLORS.map(make));
}
function renderProfileAvatar() {
  $('profile-avatar').replaceWith(Object.assign(makeAvatar(me.pseudo), { id: 'profile-avatar' }));
  $('avatar-remove').hidden = !b.avatar(me.pseudo);
}
function avatarMsg(text, ok = false) {
  const el = $('avatar-msg');
  el.className = ok ? 'ok' : 'error';
  el.textContent = text;
}
$('avatar-btn').onclick = () => $('avatar-file').click();
$('avatar-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  avatarMsg('Envoi de la photo…', true);
  try {
    await b.setAvatar(await resizeAvatar(file));
    syncMe();
    renderMeAvatar();
    renderProfileAvatar();
    showHistory();
    avatarMsg('Photo mise à jour ✅', true);
  } catch (err) {
    avatarMsg(err.message);
  }
};
$('avatar-remove').onclick = async () => {
  try {
    await b.removeAvatar();
    syncMe();
    renderMeAvatar();
    renderProfileAvatar();
    showHistory();
    avatarMsg('Photo retirée.', true);
  } catch (err) {
    avatarMsg(err.message);
  }
};
function renderDesktopHint() {
  const hint = $('pref-desktop-hint');
  if (!('Notification' in window)) hint.textContent = '(non supporté par ce navigateur)';
  else if (Notification.permission === 'denied') hint.textContent = '(bloquées dans les réglages du navigateur)';
  else hint.textContent = '';
}
$('profile-btn').onclick = guard(async () => {
  await b.refreshPeople();
  syncMe();
  renderProfileAvatar();
  avatarMsg('');
  $('profile-name').textContent = me.pseudo;
  $('profile-admin').hidden = !isAdmin();
  renderColorChoice();
  renderAppearance();
  renderProfileInfo();
  renderInstall();
  renderSecurity();
  $('pref-sound').checked = prefs.sound;
  $('pref-desktop').checked = prefs.desktop && 'Notification' in window && Notification.permission === 'granted';
  renderDesktopHint();
  for (const id of ['pw-old', 'pw-new', 'pw-new2']) {
    $(id).value = '';
    $(id).type = 'password';
  }
  $('pw-msg').textContent = '';
  $('pw-msg').className = 'error';
  dlgProfile.showModal();
});
$('pref-sound').onchange = (e) => {
  prefs.sound = e.target.checked;
  savePrefs();
  if (prefs.sound) {
    ensureAudio();
    beep();
  }
};
$('pref-desktop').onchange = async (e) => {
  if (!e.target.checked) {
    prefs.desktop = false;
    return savePrefs();
  }
  if (!('Notification' in window)) {
    e.target.checked = false;
    return renderDesktopHint();
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  prefs.desktop = perm === 'granted';
  e.target.checked = prefs.desktop;
  savePrefs();
  renderDesktopHint();
};
$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('pw-msg');
  const fail = (text) => {
    msg.className = 'error';
    msg.textContent = text;
  };
  const oldPw = $('pw-old').value;
  const newPw = $('pw-new').value;
  if (!oldPw) return fail('Entre ton mot de passe actuel.');
  if (newPw.length < MIN_PASSWORD) return fail(`Nouveau mot de passe : ${MIN_PASSWORD} caractères minimum.`);
  if (newPw !== $('pw-new2').value) return fail('Les deux nouveaux mots de passe ne sont pas identiques.');
  if (newPw === oldPw) return fail("Le nouveau mot de passe doit être différent de l'ancien.");
  try {
    await b.changePassword(oldPw, newPw);
    for (const id of ['pw-old', 'pw-new', 'pw-new2']) $(id).value = '';
    msg.className = 'ok';
    msg.textContent = 'Mot de passe changé ✅';
  } catch (err) {
    fail(err.message);
  }
});

// ---------- Apparence : thème, couleur du site, fond, taille du texte ----------
function loadAppearance() {
  // Les réglages du compte (synchronisés) priment ; sinon ceux déjà choisis dans ce navigateur
  const all = (b.me() || me)?.settings || {};
  const server = Theme.normalize(all);
  if (Object.keys(server).length) {
    appearance = server;
    Theme.save(appearance);
  } else {
    appearance = Theme.load();
  }
  privacy = { receipts: all.receipts === 'off' ? 'off' : 'on', lastseen: all.lastseen === 'off' ? 'off' : 'on' };
  Theme.apply(appearance);
}
let pushTimer = null;
// Un seul envoi pour tous les réglages du compte (apparence + confidentialité)
function pushSettings() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => b.setSettings({ ...appearance, ...privacy }).catch((e) => toast(e.message)), 500);
}
function setAppearance(patch, { render = true, reset = false } = {}) {
  appearance = Theme.normalize(reset ? {} : { ...appearance, ...patch });
  Theme.apply(appearance);
  Theme.save(appearance);
  if (render) renderAppearance();
  pushSettings();
}
function setPrivacy(patch) {
  privacy = { ...privacy, ...patch };
  pushSettings();
  renderSeen();
  if (patch.lastseen === 'on') b.touchLastSeen().catch(() => {});
}
function segButton(label, selected, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  if (selected) btn.classList.add('sel');
  btn.onclick = onClick;
  return btn;
}
function renderAppearance() {
  const a = appearance;
  $('theme-mode').replaceChildren(...[['dark', '🌙 Sombre'], ['light', '☀️ Clair'], ['auto', '🖥 Auto']]
    .map(([id, label]) => segButton(label, (a.theme || 'dark') === id, () => setAppearance({ theme: id }))));

  const colors = Theme.THEMES.map((t) => {
    const isDefault = t.id === 'violet' && !a.accent;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = t.name;
    btn.style.background = `linear-gradient(135deg, ${t.a}, ${t.b})`;
    if (isDefault || (a.accent === t.a && a.accent2 === t.b)) btn.classList.add('sel');
    btn.onclick = () => setAppearance({ accent: t.a, accent2: t.b });
    return btn;
  });
  const custom = document.createElement('label');
  custom.title = 'N\'importe quelle couleur';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = a.accent || '#7c5cff';
  picker.addEventListener('input', () => setAppearance({ accent: picker.value, accent2: Theme.shift(picker.value, 40) }, { render: false }));
  picker.addEventListener('change', () => renderAppearance());
  custom.append(picker, 'Couleur perso');
  $('theme-colors').replaceChildren(...colors, custom);

  $('bg-choice').replaceChildren(...Theme.BGS.map((o) => segButton(o.name, (a.bg || 'none') === o.id, () => setAppearance({ bg: o.id }))));
  $('font-choice').replaceChildren(...[['s', 'Petit'], ['m', 'Normal'], ['l', 'Grand']]
    .map(([id, label]) => segButton(label, (a.font || 'm') === id, () => setAppearance({ font: id }))));
}
$('appearance-reset').onclick = () => setAppearance({}, { reset: true });

// ---------- @mentions : auto-complétion dans la zone de saisie ----------
const mentionList = $('mention-list');
let mention = { items: [], sel: 0, start: 0 };
function hideMentions() {
  mentionList.hidden = true;
  mention.items = [];
}
function renderMentionList() {
  mentionList.replaceChildren(...mention.items.map((p, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mention-item${i === mention.sel ? ' sel' : ''}`;
    btn.append(makeAvatar(p.pseudo, 22), p.pseudo);
    if (p.nickname) {
      const nick = document.createElement('span');
      nick.className = 'nick';
      nick.textContent = `« ${p.nickname} »`;
      btn.append(nick);
    }
    btn.onmousedown = (e) => {
      e.preventDefault(); // garde le focus dans la zone de saisie
      pickMention(p);
    };
    return btn;
  }));
  mentionList.hidden = false;
}
let peopleCheckedAt = 0;
function updateMentions() {
  const input = $('text');
  const caret = input.selectionStart ?? input.value.length;
  const found = /(^|\s)@([^\s@]{0,20})$/.exec(input.value.slice(0, caret));
  if (!found) return hideMentions();
  // des comptes ont pu être créés depuis l'ouverture : on rafraîchit la liste (au plus toutes les 20 s)
  if (Date.now() - peopleCheckedAt > 20_000) {
    peopleCheckedAt = Date.now();
    b.refreshPeople().then(updateMentions).catch(() => {});
  }
  const q = found[2].toLowerCase();
  const byId = new Map(b.people().map((p) => [p.id, p]));
  const pool = (current?.is_common ? b.people() : roomMembers).map((p) => ({ ...p, nickname: byId.get(p.id)?.nickname }));
  // on retrouve quelqu'un par son pseudo ou par son surnom
  const items = pool
    .filter((p) => p.id !== me.id && (p.pseudo.toLowerCase().startsWith(q) || (p.nickname || '').toLowerCase().startsWith(q)))
    .slice(0, 6);
  if (!items.length) return hideMentions();
  mention = { items, sel: 0, start: caret - found[2].length - 1 };
  renderMentionList();
}
function pickMention(p) {
  const input = $('text');
  const caret = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, mention.start)}@${p.pseudo} ${input.value.slice(caret)}`;
  const pos = mention.start + p.pseudo.length + 2;
  input.setSelectionRange(pos, pos);
  hideMentions();
  input.focus();
}
$('text').addEventListener('input', updateMentions);
$('text').addEventListener('keydown', (e) => {
  if (mentionList.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = mention.items.length;
    mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    renderMentionList();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickMention(mention.items[mention.sel]);
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    hideMentions();
  }
});
$('text').addEventListener('blur', () => setTimeout(hideMentions, 150));

// ---------- Recherche ----------
const dlgSearch = $('dlg-search');
$('search-btn').onclick = () => {
  $('search-error').textContent = '';
  $('search-results').replaceChildren();
  dlgSearch.showModal();
  $('search-q').focus();
};
function highlightInto(el, text, query) {
  const low = text.toLowerCase();
  const q = query.toLowerCase();
  let from = 0;
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, from)) {
    el.append(text.slice(from, i));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(i, i + q.length);
    el.append(mark);
    from = i + q.length;
  }
  el.append(text.slice(from));
}
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (q.length < 2) return ($('search-error').textContent = 'Tape au moins 2 caractères.');
  $('search-error').textContent = '';
  const all = $('search-all').checked;
  try {
    const found = await b.search(q, all ? null : current.id);
    $('search-results').replaceChildren(...found.map((m) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result';
      const head = document.createElement('div');
      head.className = 'r-head';
      const who = document.createElement('b');
      who.textContent = m.pseudo;
      head.append(who, new Date(m.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }));
      const room = rooms.find((r) => r.id === m.room_id);
      if (all && room) head.append(roomLabel(room));
      const text = document.createElement('div');
      text.className = 'r-text';
      highlightInto(text, snippet(m.text, m.image_path || m.file_name) || '', q);
      btn.append(head, text);
      btn.onclick = () => {
        dlgSearch.close();
        goToMessage(m.room_id, m.id);
      };
      return btn;
    }));
    if (!found.length) $('search-error').textContent = 'Aucun message trouvé.';
  } catch (err) {
    $('search-error').textContent = err.message;
  }
});

// ---------- Sondages : création ----------
const dlgPoll = $('dlg-poll');
function pollInput() {
  const input = document.createElement('input');
  input.maxLength = 80;
  input.placeholder = `Choix ${$('poll-options').children.length + 1}`;
  return input;
}
$('poll-btn').onclick = () => {
  $('poll-question').value = '';
  $('poll-multiple').checked = false;
  $('poll-error').textContent = '';
  $('poll-options').replaceChildren();
  $('poll-options').append(pollInput());
  $('poll-options').append(pollInput());
  dlgPoll.showModal();
  $('poll-question').focus();
};
$('poll-add').onclick = () => {
  const box = $('poll-options');
  if (box.children.length >= 6) return ($('poll-error').textContent = '6 choix maximum.');
  const input = pollInput();
  box.append(input);
  input.focus();
};
$('poll-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await b.createPoll(current.id, $('poll-question').value, [...$('poll-options').children].map((i) => i.value), $('poll-multiple').checked);
    dlgPoll.close();
  } catch (err) {
    $('poll-error').textContent = err.message;
  }
});

// ---------- En ligne / hors ligne, dernière connexion ----------
function personLine(p, sub) {
  const li = document.createElement('li');
  li.append(makeAvatar(p.pseudo));
  const txt = document.createElement('span');
  txt.className = 'li-txt';
  const name = document.createElement('span');
  name.textContent = p.pseudo;
  txt.append(name);
  if (sub) {
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = sub;
    txt.append(st);
  }
  li.append(txt);
  li.title = 'Voir le profil';
  li.onclick = () => openCard(p.id);
  return li;
}
function renderPresence() {
  const people = b.people();
  const byName = new Map(people.map((p) => [p.pseudo, p]));
  const online = [...onlineNames].sort((x, y) => x.localeCompare(y));
  $('online-count').textContent = `(${online.length})`;
  $('online').replaceChildren(...online.map((name) => {
    const p = byName.get(name) || { id: null, pseudo: name };
    return personLine(p, p.status || (p.nickname ? `« ${p.nickname} »` : ''));
  }));
  // hors ligne : les plus récemment vus d'abord (ceux qui masquent leur dernière connexion à la fin)
  const away = people
    .filter((p) => p.pseudo !== me.pseudo && !onlineNames.has(p.pseudo))
    .sort((x, y) => (y.last_seen || '').localeCompare(x.last_seen || '') || x.pseudo.localeCompare(y.pseudo))
    .slice(0, 12);
  $('offline-title').hidden = !away.length;
  $('offline').replaceChildren(...away.map((p) => {
    const li = personLine(p, p.status || '');
    if (p.last_seen && !p.lastSeenHidden) {
      const ago = document.createElement('span');
      ago.className = 'ago';
      ago.textContent = relTime(p.last_seen);
      li.append(ago);
    }
    return li;
  }));
  renderRoomSub();
}
// Sous le titre d'un message privé : « en ligne » ou « vu il y a 5 min »
function renderRoomSub() {
  const el = $('room-sub');
  el.textContent = '';
  if (!current?.is_dm || !current.peer) return;
  const p = b.people().find((x) => x.id === current.peer.id);
  if (!p) return;
  if (onlineNames.has(p.pseudo)) el.textContent = '🟢 en ligne';
  else if (p.last_seen && !p.lastSeenHidden) el.textContent = `vu ${relTime(p.last_seen)}`;
}
let presenceTimer = null;
function startPresenceLoop() {
  clearInterval(presenceTimer);
  const tick = async () => {
    if (document.hidden) return;
    try {
      await b.touchLastSeen();
      await b.refreshPeople();
      renderPresence();
    } catch {}
  };
  tick();
  presenceTimer = setInterval(tick, 120_000);
  document.addEventListener('visibilitychange', () => !document.hidden && tick());
}

// ---------- Fiche d'une personne ----------
const dlgCard = $('dlg-card');
const openCard = guard(async (userId) => {
  if (!userId) return;
  await b.refreshPeople();
  syncMe();
  const p = b.profile(userId);
  if (!p) return toast('Profil introuvable.');
  $('card-avatar').replaceWith(Object.assign(makeAvatar(p.pseudo), { id: 'card-avatar' }));
  $('card-name').textContent = p.pseudo;
  $('card-admin').hidden = !p.is_admin;
  $('card-nick').textContent = p.nickname ? `Surnom : « ${p.nickname} »` : '';
  $('card-status').textContent = p.status || '';
  $('card-bio').textContent = p.bio || '';
  const rows = [];
  if (p.interests) rows.push(['Centres d\'intérêt', p.interests]);
  if (p.birthday) rows.push(['Anniversaire', `🎂 ${birthdayLabel(p.birthday)}`]);
  const online = onlineNames.has(p.pseudo);
  rows.push(['Connexion', online ? '🟢 en ligne' : p.lastSeenHidden ? 'masquée' : p.last_seen ? `vu ${relTime(p.last_seen)}` : '—']);
  $('card-fields').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
  const self = userId === me.id;
  $('card-dm').hidden = self;
  $('card-dm').onclick = guard(async () => {
    dlgCard.close();
    await openDmWith(userId);
  });
  dlgCard.showModal();
});

// ---------- Mes infos : pseudo, surnom, statut, bio, anniversaire ----------
function fillBirthdaySelects() {
  const day = $('pf-day');
  const month = $('pf-month');
  if (day.children.length) return;
  day.append(new Option('Jour', ''));
  for (let d = 1; d <= 31; d++) day.append(new Option(String(d), String(d).padStart(2, '0')));
  month.append(new Option('Mois', ''));
  MONTHS.forEach((m, i) => month.append(new Option(m, String(i + 1).padStart(2, '0'))));
}
function renderProfileInfo() {
  fillBirthdaySelects();
  const p = b.profile(me.id) || {};
  $('rename-input').value = me.pseudo;
  $('rename-msg').textContent = '';
  $('info-msg').textContent = '';
  $('pf-nickname').value = p.nickname || '';
  $('pf-status').value = p.status || '';
  $('pf-bio').value = p.bio || '';
  $('pf-interests').value = p.interests || '';
  $('pf-month').value = p.birthday ? p.birthday.slice(0, 2) : '';
  $('pf-day').value = p.birthday ? p.birthday.slice(3) : '';
  $('pref-receipts').checked = receiptsOn();
  $('pref-lastseen').checked = privacy.lastseen !== 'off';
}
$('rename-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('rename-msg');
  try {
    const name = await b.renamePseudo($('rename-input').value);
    syncMe();
    renderMeAvatar();
    $('profile-name').textContent = me.pseudo;
    renderProfileInfo();
    msg.className = 'ok';
    msg.textContent = `Pseudo changé : tu t'appelles maintenant ${name} ✅ (utilise-le pour te connecter)`;
    showHistory();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
});
$('info-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('info-msg');
  const month = $('pf-month').value;
  const day = $('pf-day').value;
  if (!!month !== !!day) {
    msg.className = 'error';
    return (msg.textContent = 'Anniversaire : choisis le jour ET le mois (ou laisse les deux vides).');
  }
  try {
    await b.setProfile({
      nickname: $('pf-nickname').value,
      status: $('pf-status').value,
      bio: $('pf-bio').value,
      interests: $('pf-interests').value,
      birthday: month && day ? `${month}-${day}` : '',
    });
    syncMe();
    renderPresence();
    msg.className = 'ok';
    msg.textContent = 'Infos enregistrées ✅';
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
});
$('pref-receipts').onchange = (e) => setPrivacy({ receipts: e.target.checked ? 'on' : 'off' });
$('pref-lastseen').onchange = (e) => {
  setPrivacy({ lastseen: e.target.checked ? 'on' : 'off' });
  if (!e.target.checked) toast('Ta dernière connexion est maintenant masquée.');
};

// ---------- Infos de la classe ----------
const dlgInfo = $('dlg-info');
let infoData = {};
function infoSection(title, node) {
  const sec = document.createElement('div');
  sec.className = 'info-sec';
  const h = document.createElement('h4');
  h.textContent = title;
  sec.append(h, node);
  return sec;
}
function textNode(text) {
  const d = document.createElement('div');
  if (text && text.trim()) {
    d.className = 'txt';
    d.textContent = text;
  } else {
    d.className = 'empty-txt';
    d.textContent = 'Rien pour le moment.';
  }
  return d;
}
function renderInfoView() {
  const links = document.createElement('div');
  links.className = 'info-links';
  const list = (infoData.links || []).filter((l) => /^https:\/\//.test(l.url));
  if (list.length) {
    for (const l of list) {
      const a = document.createElement('a');
      a.href = l.url;
      a.textContent = `🔗 ${l.title}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      links.append(a);
    }
  } else links.append(textNode(''));

  const upcoming = b.people()
    .map((p) => ({ p, days: daysUntilBirthday(p.birthday) }))
    .filter((x) => x.days !== null && x.days <= 30)
    .sort((x, y) => x.days - y.days);
  const bd = document.createElement('ul');
  bd.className = 'info-bdays';
  for (const { p, days } of upcoming) {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.textContent = `🎂 ${p.pseudo}${p.nickname ? ` « ${p.nickname} »` : ''}`;
    const when = document.createElement('span');
    when.textContent = days === 0 ? "aujourd'hui !" : days === 1 ? 'demain' : `${birthdayLabel(p.birthday)} (dans ${days} j)`;
    li.append(who, when);
    bd.append(li);
  }
  const bdBox = upcoming.length ? bd : textNode('');
  const updated = document.createElement('div');
  updated.className = 'updated-at';
  updated.textContent = infoData.updated_at && Object.keys(infoData).length > 1 ? `Mis à jour ${relTime(infoData.updated_at)}` : '';
  $('info-view').replaceChildren(
    infoSection('Emploi du temps', textNode(infoData.schedule)),
    infoSection('Règles de la classe', textNode(infoData.rules)),
    infoSection('Contacts', textNode(infoData.contacts)),
    infoSection('Liens utiles', links),
    infoSection('Anniversaires à venir (30 jours)', bdBox),
    updated,
  );
}
function linkRow(title = '', url = '') {
  const row = document.createElement('div');
  row.className = 'link-row';
  const t = document.createElement('input');
  t.maxLength = 60;
  t.placeholder = 'Titre';
  t.value = title;
  const u = document.createElement('input');
  u.maxLength = 300;
  u.placeholder = 'https://…';
  u.value = url;
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.textContent = '✕';
  rm.title = 'Retirer ce lien';
  rm.onclick = () => row.remove();
  row.append(t, u, rm);
  return row;
}
function showInfoMode(edit) {
  $('info-view').hidden = edit;
  $('info-edit-form').hidden = !edit;
  $('info-actions').hidden = edit;
  $('info-edit').hidden = edit || !isAdmin();
}
$('info-btn').onclick = guard(async () => {
  await b.refreshPeople();
  syncMe();
  infoData = await b.classInfo();
  renderInfoView();
  showInfoMode(false);
  dlgInfo.showModal();
});
$('info-edit').onclick = () => {
  $('ie-schedule').value = infoData.schedule || '';
  $('ie-rules').value = infoData.rules || '';
  $('ie-contacts').value = infoData.contacts || '';
  $('ie-links').replaceChildren(...(infoData.links || []).map((l) => linkRow(l.title, l.url)));
  $('ie-error').textContent = '';
  showInfoMode(true);
};
$('ie-add-link').onclick = () => {
  if ($('ie-links').children.length >= 20) return ($('ie-error').textContent = '20 liens maximum.');
  const row = linkRow();
  $('ie-links').append(row);
  row.querySelector('input').focus();
};
$('ie-cancel').onclick = () => showInfoMode(false);
$('info-edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const links = [...$('ie-links').children]
    .map((row) => ({ title: row.children[0].value.trim(), url: row.children[1].value.trim() }))
    .filter((l) => l.title || l.url);
  try {
    await b.setClassInfo({ schedule: $('ie-schedule').value, rules: $('ie-rules').value, contacts: $('ie-contacts').value, links });
    infoData = await b.classInfo();
    renderInfoView();
    showInfoMode(false);
  } catch (err) {
    $('ie-error').textContent = err.message;
  }
});

// ---------- Stickers ----------
function sendSticker(options, text = '') {
  hidePanels();
  return b.send(current.id, text, { ...options, replyTo: replyTo?.id ?? null }).then(clearReply);
}
function renderStickerPanel() {
  const tabs = [['emoji', '😀 Emojis géants'], ['class', '🎟 Stickers de la classe']];
  $('sticker-tabs').replaceChildren(...tabs.map(([id, label]) => segButton(label, stickerTab === id, () => {
    stickerTab = id;
    renderStickerPanel();
  })));
  const grid = $('sticker-grid');
  $('sticker-error').textContent = '';
  if (stickerTab === 'emoji') {
    grid.replaceChildren(...BIG_EMOJIS.map((em) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick big';
      btn.textContent = em;
      btn.onclick = guard(() => sendSticker({}, em));
      tile.append(btn);
      return tile;
    }));
    return;
  }
  const tiles = stickers.map((s) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.title = s.name;
    const img = document.createElement('img');
    img.alt = s.name;
    b.imageUrl(s.path).then((u) => (img.src = u)).catch(() => {});
    btn.append(img);
    btn.onclick = guard(() => sendSticker({ sticker: s.id }));
    tile.append(btn);
    if (isAdmin()) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '✕';
      rm.title = 'Retirer ce sticker (admin)';
      rm.onclick = async () => {
        if (!confirm(`Retirer le sticker « ${s.name} » ? Les anciens messages qui l'utilisent restent affichés.`)) return;
        try {
          await b.removeSticker(s.id);
          stickers = await b.stickers();
          renderStickerPanel();
        } catch (err) {
          $('sticker-error').textContent = err.message;
        }
      };
      tile.append(rm);
    }
    return tile;
  });
  if (isAdmin()) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'add-tile';
    add.textContent = '＋';
    add.title = 'Ajouter un sticker (admin)';
    add.onclick = () => $('sticker-file').click();
    tiles.push(add);
  }
  grid.replaceChildren(...tiles);
  if (!stickers.length) $('sticker-error').textContent = isAdmin() ? 'Aucun sticker pour le moment : ajoute le premier avec ＋.' : "Aucun sticker de la classe pour le moment (c'est un admin qui les ajoute).";
}
$('sticker-btn').onclick = guard(async () => {
  const open = $('sticker-panel').hidden;
  hidePanels();
  if (!open) return;
  $('sticker-panel').hidden = false;
  renderStickerPanel();
  stickers = await b.stickers();
  renderStickerPanel();
});
$('sticker-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const name = prompt('Nom du sticker (30 caractères max) :', file.name.replace(/\.[^.]+$/, '').slice(0, 30));
  if (!name) return;
  try {
    $('sticker-error').textContent = 'Ajout du sticker…';
    await b.addSticker(await resizeSticker(file), name);
    stickers = await b.stickers();
    renderStickerPanel();
  } catch (err) {
    $('sticker-error').textContent = err.message;
  }
};

// ---------- Messages vocaux ----------
let rec = null; // enregistrement en cours : { stream, mr, chunks, started, type, timer, blob, url, secs, cancelled }
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function recError(text = '') {
  $('rec-error').textContent = text;
  $('rec-error').hidden = !text;
}
function recUi(state) { // 'off' | 'recording' | 'review'
  $('recorder').hidden = state === 'off';
  $('rec-dot').classList.toggle('done', state === 'review');
  $('rec-label').textContent = state === 'review' ? 'Écoute avant d\'envoyer' : 'Enregistrement…';
  $('rec-stop').hidden = state !== 'recording';
  $('rec-send').hidden = state !== 'review';
  $('rec-preview').hidden = state !== 'review';
}
function resetRecorder() {
  if (rec) {
    clearInterval(rec.timer);
    rec.stream?.getTracks().forEach((t) => t.stop());
    if (rec.url) URL.revokeObjectURL(rec.url);
  }
  rec = null;
  $('rec-preview').removeAttribute('src');
  $('rec-time').textContent = '0:00';
  recUi('off');
}
function cancelRecording() {
  if (!rec) return;
  rec.cancelled = true;
  try {
    if (rec.mr.state !== 'inactive') rec.mr.stop();
  } catch {}
  resetRecorder();
}
$('mic-btn').onclick = async () => {
  if (rec) return;
  recError('');
  hidePanels();
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Ton navigateur ne permet pas d'enregistrer un message vocal.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const r = { stream, mr, chunks: [], started: Date.now(), type: mr.mimeType || mime || 'audio/webm', timer: null, blob: null, url: null, secs: 0, cancelled: false };
    rec = r;
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.onstop = () => {
      clearInterval(r.timer);
      if (r.cancelled || rec !== r) return;
      r.secs = Math.max(1, Math.round((Date.now() - r.started) / 1000));
      r.blob = new Blob(r.chunks, { type: r.type });
      r.stream.getTracks().forEach((t) => t.stop());
      if (r.blob.size < 800) {
        resetRecorder();
        return recError('Message vocal trop court : maintiens plus longtemps.');
      }
      r.url = URL.createObjectURL(r.blob);
      $('rec-preview').src = r.url;
      $('rec-time').textContent = fmtDur(r.secs);
      recUi('review');
    };
    mr.start();
    recUi('recording');
    r.timer = setInterval(() => {
      const s = (Date.now() - r.started) / 1000;
      $('rec-time').textContent = `${fmtDur(s)} / ${fmtDur(VOICE_MAX_SECS)}`;
      if (s >= VOICE_MAX_SECS && mr.state === 'recording') mr.stop(); // durée maximale atteinte
    }, 250);
  } catch (err) {
    resetRecorder();
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      recError("Le micro est bloqué : autorise-le dans les réglages du navigateur (icône 🔒 à gauche de l'adresse), puis réessaie.");
    } else if (err?.name === 'NotFoundError') recError('Aucun micro détecté sur cet appareil.');
    else recError(err.message || "Impossible d'enregistrer.");
  }
};
$('rec-stop').onclick = () => {
  if (rec?.mr.state === 'recording') rec.mr.stop();
};
$('rec-cancel').onclick = cancelRecording;
$('rec-send').onclick = guard(async () => {
  const r = rec;
  if (!r?.blob) return;
  const ext = r.type.includes('mp4') ? 'm4a' : r.type.includes('ogg') ? 'ogg' : 'weba';
  const now = new Date();
  const name = `Message vocal ${String(now.getHours()).padStart(2, '0')}h${String(now.getMinutes()).padStart(2, '0')}.${ext}`;
  const file = new File([r.blob], name, { type: r.type.split(';')[0] });
  resetRecorder();
  await sendDocument(file);
});

// ---------- Sécurité du compte : déconnexion partout, double authentification ----------
let mfaFactor = null; // facteur en cours d'activation : { id, qr, secret }
function mfaMsg(text, ok = false) {
  $('mfa-msg').className = ok ? 'ok' : 'error';
  $('mfa-msg').textContent = text;
}
async function renderSecurity() {
  $('mfa-box').hidden = !b.mfaSupported;
  $('mfa-enroll').hidden = true;
  mfaMsg('');
  mfaFactor = null;
  if (!b.mfaSupported) return;
  try {
    const st = await b.mfaStatus();
    $('mfa-status').textContent = st.enabled
      ? '✅ Double authentification activée : un code de ton application est demandé à chaque connexion.'
      : 'Désactivée. Conseillée surtout aux admins : une fois activée, leurs pouvoirs ne marchent plus sans le code, même si quelqu\'un connaît leur mot de passe.';
    $('mfa-start').hidden = st.enabled;
    $('mfa-disable').hidden = !st.enabled;
    $('mfa-disable').dataset.id = st.id || '';
  } catch (err) {
    mfaMsg(err.message);
  }
}
$('logout-all').onclick = guard(async () => {
  if (!confirm('Déconnecter tous tes appareils, y compris celui-ci ? Tu devras te reconnecter partout avec ton mot de passe.')) return;
  await b.logoutEverywhere();
  location.reload();
});
$('mfa-start').onclick = guard(async () => {
  mfaMsg('');
  mfaFactor = await b.mfaEnroll();
  $('mfa-qr').src = mfaFactor.qr;
  $('mfa-secret').textContent = mfaFactor.secret;
  $('mfa-code').value = '';
  $('mfa-enroll').hidden = false;
  $('mfa-start').hidden = true;
  $('mfa-code').focus();
});
$('mfa-verify').onclick = async () => {
  if (!mfaFactor) return;
  try {
    await b.mfaVerify(mfaFactor.id, $('mfa-code').value);
    mfaFactor = null;
    await renderSecurity();
    mfaMsg('Double authentification activée ✅ Garde bien ton application : elle sera demandée à chaque connexion.', true);
  } catch (err) {
    mfaMsg(err.message);
  }
};
$('mfa-cancel').onclick = async () => {
  const f = mfaFactor;
  mfaFactor = null;
  try {
    if (f) await b.mfaDisable(f.id);
  } catch {}
  await renderSecurity();
};
$('mfa-disable').onclick = async () => {
  if (!confirm('Désactiver la double authentification ? Ton compte sera moins protégé.')) return;
  try {
    await b.mfaDisable($('mfa-disable').dataset.id);
    await renderSecurity();
    mfaMsg('Double authentification désactivée.', true);
  } catch (err) {
    mfaMsg(err.message);
  }
};

// ---------- Application installable (PWA) ----------
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // on propose notre propre bouton dans ⚙
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstall();
  toast('Application installée 🎉');
});
function renderInstall() {
  const btn = $('install-btn');
  const txt = $('install-text');
  btn.hidden = true;
  if (isStandalone()) txt.textContent = "✅ Tu utilises déjà l'application installée.";
  else if (installPrompt) {
    btn.hidden = false;
    txt.textContent = "Ajoute le site à ton écran d'accueil : icône, plein écran, comme une vraie appli.";
  } else if (isIos()) txt.textContent = "Sur iPhone / iPad : dans Safari, touche le bouton Partager (le carré avec une flèche), puis « Sur l'écran d'accueil ».";
  else txt.textContent = "Sur ordinateur (Chrome, Edge) : icône d'installation à droite de la barre d'adresse, ou menu ⋮ puis « Installer ». Sur Android : menu ⋮ puis « Ajouter à l'écran d'accueil ».";
}
$('install-btn').onclick = guard(async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  renderInstall();
});

// ---------- Panneau admin : comptes, suppression, bannissement ----------
const dlgAdmin = $('dlg-admin');
const adminError = (text = '') => ($('admin-error').textContent = text);
async function renderAdminLog() {
  let rows = [];
  try {
    rows = await b.adminLog();
  } catch (err) {
    adminError(err.message);
  }
  $('admin-log').replaceChildren(...rows.map((r) => {
    const row = document.createElement('div');
    row.className = 'log-row';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = r.admin_pseudo;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `${new Date(r.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}`;
    row.append(who, ` · ${r.action}${r.target ? ` « ${r.target} »` : ''}${r.detail ? ` (${r.detail})` : ''}`, when);
    return row;
  }));
}
async function renderAdminPanel() {
  await b.refreshPeople();
  syncMe();
  try {
    limits = { ...limits, ...(await b.limits()) };
  } catch {}
  const n = b.people().length;
  const lim = $('admin-limits');
  lim.className = n > limits.max_accounts ? 'hint limit-warn' : 'hint';
  lim.textContent = `Comptes : ${n} / ${limits.max_accounts}`
    + (n >= limits.max_accounts ? " — la classe est complète : plus personne ne peut s'inscrire" : '')
    + (n > limits.max_accounts ? ` (${n - limits.max_accounts} de trop : supprime des comptes pour redescendre sous la limite)` : '')
    + ` · ${limits.keep_messages} messages gardés par conversation.`;
  renderAdminLog();
  const refreshAll = async () => {
    await renderAdminPanel();
    updateMembersCount();
    showHistory();
  };

  $('admin-users').replaceChildren(...b.people().map((p) => {
    const row = personRow(p);
    if (p.id === me.id || p.is_admin) return row;
    const actions = document.createElement('span');
    actions.className = 'row-actions';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'kick';
    del.textContent = 'Supprimer';
    del.title = 'Supprime le compte et ses messages (la personne peut se réinscrire)';
    del.onclick = async () => {
      if (!confirm(`Supprimer le compte de « ${p.pseudo} » ? Son compte, ses messages et ses réactions seront effacés définitivement.\n(La personne pourra se réinscrire avec le code de classe. Pour l'en empêcher, utilise « Bannir ».)`)) return;
      try {
        adminError();
        await b.kick(p.id);
        await refreshAll();
      } catch (err) {
        adminError(err.message);
      }
    };

    const ban = document.createElement('button');
    ban.type = 'button';
    ban.className = 'ban';
    ban.textContent = 'Bannir';
    ban.title = 'Supprime le compte ET interdit ce pseudo de se réinscrire';
    ban.onclick = async () => {
      const reason = prompt(`Bannir « ${p.pseudo} » ?\nSon compte et ses messages seront supprimés, et ce pseudo ne pourra plus créer de compte.\n\nRaison (facultatif, visible seulement par les admins) :`, '');
      if (reason === null) return;
      try {
        adminError();
        await b.ban(p.id, reason.trim());
        await refreshAll();
      } catch (err) {
        adminError(err.message);
      }
    };

    actions.append(del, ban);
    row.append(actions);
    return row;
  }));

  let bans = [];
  try {
    bans = await b.banned();
  } catch (err) {
    adminError(err.message);
  }
  if (!bans.length) {
    const none = document.createElement('div');
    none.className = 'person';
    none.textContent = "Personne n'est banni.";
    none.style.color = 'var(--muted)';
    $('admin-banned').replaceChildren(none);
    return;
  }
  $('admin-banned').replaceChildren(...bans.map((x) => {
    const row = document.createElement('div');
    row.className = 'person';
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('span');
    name.textContent = x.pseudo;
    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = `${new Date(x.banned_at).toLocaleDateString('fr-FR')}${x.reason ? ` · ${x.reason}` : ''}`;
    who.append(name, why);
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'add';
    undo.textContent = 'Débannir';
    undo.onclick = async () => {
      if (!confirm(`Débannir « ${x.pseudo} » ? Ce pseudo pourra de nouveau créer un compte.`)) return;
      try {
        adminError();
        await b.unban(x.pseudo_key);
        await renderAdminPanel();
      } catch (err) {
        adminError(err.message);
      }
    };
    row.append(who, undo);
    return row;
  }));
}
$('admin-btn').onclick = guard(async () => {
  adminError();
  await renderAdminPanel();
  dlgAdmin.showModal();
});

boot();
