import { createSupabaseBackend } from './backend-supabase.js';
import { createDemoBackend } from './backend-demo.js';
import {
  AVATAR_COLORS, FILE_TYPES, MIN_PASSWORD, QUICK_REACTIONS, fileExt, fileIcon, formatSize, passwordStrength, resizeAvatar,
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

function setMode(register) {
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
    const user = isRegister
      ? await b.register($('pseudo').value, $('password').value, $('code').value)
      : await b.login($('pseudo').value, $('password').value);
    $('password').value = '';
    $('password2').value = '';
    await enterApp(user);
  } catch (err) {
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
  $('auth').hidden = true;
  $('app').hidden = false;
  $('admin-btn').hidden = !isAdmin();
  renderMeAvatar();
  buildEmojis();
  bindEvents();
  await loadRooms();
  b.start();
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
    if (theirs && (mentioned || document.hidden || m.room_id !== current?.id)) notify(m, mentioned);
    if (m.room_id !== current?.id) {
      unread[m.room_id] = (unread[m.room_id] || 0) + 1;
      updateTitle();
      return renderRooms();
    }
    if (theirs && document.hidden) {
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
    $('online-count').textContent = `(${list.length})`;
    // quelqu'un de nouveau est en ligne : on met à jour la liste des comptes (mentions, messages privés)
    if (list.some((name) => !b.people().some((p) => p.pseudo === name))) b.refreshPeople().catch(() => {});
    const ul = $('online');
    ul.replaceChildren();
    for (const name of list) {
      const li = document.createElement('li');
      li.append(makeAvatar(name), name);
      if (name !== me.pseudo) {
        li.title = 'Écrire en privé';
        li.onclick = () => startDmWith(name);
      }
      ul.append(li);
    }
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
  const total = Object.values(unread).reduce((a, n) => a + n, 0) + hiddenUnread;
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
  btn.className = `room-btn ${r.id === current?.id ? 'active' : ''}`;
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = roomLabel(r);
  btn.append(nm);
  if (unread[r.id]) {
    const badge = document.createElement('span');
    badge.className = 'badge';
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
  updateMembersCount();
  refreshPins();
  await showHistory();
  $('text').focus();
}
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
  if (!msgs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = "Personne n'a encore écrit ici. Brise la glace ! 🧊";
    box.append(p);
  }
  for (const m of msgs) addMessage(m);
  if (!minId) box.scrollTop = box.scrollHeight;
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
    if (!mine) {
      name.style.cursor = 'pointer';
      name.title = 'Écrire en privé';
      name.onclick = () => startDmWith(m.pseudo);
    }
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
  if (m.file_path) {
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

  row.append(makeAvatar(m.pseudo, 34), bubble);
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
$('emoji-btn').onclick = () => ($('emoji-panel').hidden = !$('emoji-panel').hidden);

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
const sendPicked = (file) => {
  if (!file) return;
  if (file.type.startsWith('image/')) sendImage(file);
  else sendDocument(file);
};
$('img-btn').onclick = () => $('file').click();
$('file').onchange = (e) => { sendPicked(e.target.files[0]); e.target.value = ''; };
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
chatEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  chatEl.classList.remove('dragover');
  sendPicked(e.dataTransfer?.files?.[0]);
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
const startDmWith = guard(async (pseudo) => {
  await b.refreshPeople();
  const p = b.people().find((x) => x.pseudo === pseudo);
  if (!p || p.id === me.id) return;
  await openDmWith(p.id);
});
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
  const server = Theme.normalize((b.me() || me)?.settings);
  if (Object.keys(server).length) {
    appearance = server;
    Theme.save(appearance);
  } else {
    appearance = Theme.load();
  }
  Theme.apply(appearance);
}
let pushTimer = null;
function setAppearance(patch, { render = true, reset = false } = {}) {
  appearance = Theme.normalize(reset ? {} : { ...appearance, ...patch });
  Theme.apply(appearance);
  Theme.save(appearance);
  if (render) renderAppearance();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => b.setSettings(appearance).catch((e) => toast(e.message)), 500);
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
  const pool = current?.is_common ? b.people() : roomMembers;
  const items = pool.filter((p) => p.id !== me.id && p.pseudo.toLowerCase().startsWith(q)).slice(0, 6);
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

// ---------- Panneau admin : comptes, suppression, bannissement ----------
const dlgAdmin = $('dlg-admin');
const adminError = (text = '') => ($('admin-error').textContent = text);
async function renderAdminPanel() {
  await b.refreshPeople();
  syncMe();
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
