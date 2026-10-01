import { createSupabaseBackend } from './backend-supabase.js';
import { createDemoBackend } from './backend-demo.js';

const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG || {};
const b = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY
  ? createSupabaseBackend({ url: cfg.SUPABASE_URL, key: cfg.SUPABASE_ANON_KEY })
  : createDemoBackend();

const EMOJIS = '😀😂🤣😊😍😎🤔😅😭😡🥳🤯😴🙃😬🫠👍👎👏🙌🙏💪🤝✌️🤞❤️🔥💯✨🎉💀👀🍕🍟🍔☕🎮🎧📚✏️🧠⏰🚌🏫🐐🦆🐸🌈'.match(/\p{Extended_Pictographic}️?/gu);
const GROUP_EMOJIS = ['💬', '📚', '🎮', '🍕', '🎧', '⚽', '🔥', '🧠', '🎉', '🐸', '🌈', '🤫'];

let me = null;
let rooms = [];
let current = null;
let isRegister = false;
let wasOnline = false;
let lastMsg = null;
const unread = {};
const typingUsers = new Map();

// ---------- Utilitaires ----------
const colorFor = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 70% 55%)`;
};
function makeAvatar(name, size) {
  const el = document.createElement('span');
  el.className = 'avatar';
  el.style.background = colorFor(name);
  if (size) Object.assign(el.style, { width: `${size}px`, height: `${size}px` });
  el.textContent = [...name][0].toUpperCase();
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

// Texte -> nœuds DOM avec liens http(s) cliquables (jamais d'innerHTML).
function renderText(container, text) {
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<]+/g)) {
    container.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = m[0];
    a.textContent = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    container.append(a);
    last = m.index + m[0].length;
  }
  container.append(text.slice(last));
}

// ---------- Authentification ----------
function setMode(register) {
  isRegister = register;
  $('tab-login').classList.toggle('active', !register);
  $('tab-register').classList.toggle('active', register);
  $('code-label').hidden = !register;
  $('code').required = register;
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('auth-submit').textContent = register ? 'Créer mon compte 🎉' : 'Entrer 🚀';
  $('auth-error').textContent = '';
}
$('tab-login').onclick = () => setMode(false);
$('tab-register').onclick = () => setMode(true);

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const user = isRegister
      ? await b.register($('pseudo').value, $('password').value, $('code').value)
      : await b.login($('pseudo').value, $('password').value);
    $('password').value = '';
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

async function enterApp(user) {
  me = user;
  $('auth').hidden = true;
  $('app').hidden = false;
  $('me-name').textContent = me.pseudo;
  $('me-avatar').replaceWith(Object.assign(makeAvatar(me.pseudo), { id: 'me-avatar' }));
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
    if (m.room_id !== current?.id) {
      unread[m.room_id] = (unread[m.room_id] || 0) + 1;
      return renderRooms();
    }
    const box = $('messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140 || m.user_id === me.id;
    box.querySelector('.empty')?.remove();
    addMessage(m);
    if (stick) box.scrollTop = box.scrollHeight;
    typingUsers.delete(m.pseudo);
    renderTyping();
  });
  b.on('deleted', ({ id }) => document.querySelector(`.msg[data-id="${id}"]`)?.remove());
  b.on('rooms', guard(async () => {
    await b.refreshPeople();
    await loadRooms();
    toast('Tu as été ajouté à un groupe 🎉');
  }));
  b.on('members', guard(async ({ room_id }) => {
    if (room_id === current?.id) updateMembersCount();
  }));
  b.on('presence', (list) => {
    $('online-count').textContent = `(${list.length})`;
    const ul = $('online');
    ul.replaceChildren();
    for (const name of list) {
      const li = document.createElement('li');
      li.append(makeAvatar(name), name);
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
  nm.textContent = `${r.emoji} ${r.name}`;
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
  const priv = rooms.filter((r) => !r.is_common);
  $('common-room').replaceChildren(...common.map(roomButton));
  $('private-rooms').replaceChildren(...priv.map(roomButton));
  $('no-groups').hidden = priv.length > 0;
}
async function switchRoom(r) {
  current = r;
  unread[r.id] = 0;
  typingUsers.clear();
  renderTyping();
  $('room-title').textContent = `${r.is_common ? '' : '🔒 '}${r.emoji} ${r.name}`;
  renderRooms();
  closeSidebar();
  $('messages').replaceChildren();
  updateMembersCount();
  await showHistory();
  $('text').focus();
}
async function showHistory() {
  const room = current;
  let msgs;
  try {
    msgs = await b.history(room.id);
  } catch (e) {
    return toast(e.message);
  }
  if (room !== current) return; // l'utilisateur a changé de salon entre-temps
  const box = $('messages');
  box.replaceChildren();
  lastMsg = null;
  if (!msgs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = "Personne n'a encore écrit ici. Brise la glace ! 🧊";
    box.append(p);
  }
  for (const m of msgs) addMessage(m);
  box.scrollTop = box.scrollHeight;
}
async function updateMembersCount() {
  const room = current;
  try {
    const list = await b.members(room);
    if (room === current) $('members-count').textContent = list.length;
  } catch {}
}

const sidebar = $('sidebar');
const closeSidebar = () => { sidebar.classList.remove('open'); $('scrim').hidden = true; };
$('menu').onclick = () => { sidebar.classList.add('open'); $('scrim').hidden = false; };
$('scrim').onclick = closeSidebar;

// ---------- Messages ----------
function addMessage(m) {
  const box = $('messages');
  const mine = m.user_id === me.id;
  const t = new Date(m.created_at).getTime();
  const cont = lastMsg && lastMsg.user_id === m.user_id && t - lastMsg.t < 120_000;
  lastMsg = { user_id: m.user_id, t };

  const row = document.createElement('div');
  row.className = `msg ${mine ? 'mine' : ''} ${cont ? 'cont' : 'first'}`;
  row.dataset.id = m.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (!cont) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('b');
    name.textContent = m.pseudo;
    name.style.color = colorFor(m.pseudo);
    meta.append(name, fmtTime(m.created_at));
    bubble.append(meta);
  }
  if (m.text) {
    const body = document.createElement('div');
    body.className = 'body';
    renderText(body, m.text);
    bubble.append(body);
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
  if (mine) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = 'Supprimer';
    del.textContent = '✕';
    del.onclick = guard(async () => confirm('Supprimer ce message ?') && (await b.remove(m)));
    bubble.append(del);
  }
  row.append(makeAvatar(m.pseudo, 34), bubble);
  box.append(row);
}

$('composer').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  $('emoji-panel').hidden = true;
  try {
    await b.send(current.id, text);
  } catch (err) {
    $('text').value = text; // on ne perd pas le message
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
  await b.send(current.id, caption, path);
  $('text').value = '';
});
$('img-btn').onclick = () => $('file').click();
$('file').onchange = (e) => { sendImage(e.target.files[0]); e.target.value = ''; };
document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file && !$('app').hidden) sendImage(file);
});
function openLightbox(src) {
  $('lightbox').querySelector('img').src = src;
  $('lightbox').hidden = false;
}
$('lightbox').onclick = () => ($('lightbox').hidden = true);
document.addEventListener('keydown', (e) => e.key === 'Escape' && ($('lightbox').hidden = true));

// ---------- Groupes : création ----------
const dlgCreate = $('dlg-create');
let chosenEmoji = GROUP_EMOJIS[0];
document.querySelectorAll('[data-close]').forEach((btn) => (btn.onclick = () => btn.closest('dialog').close()));

function personRow(p, { checkbox } = {}) {
  const row = document.createElement(checkbox ? 'label' : 'div');
  row.className = 'person';
  row.append(makeAvatar(p.pseudo), p.pseudo);
  if (checkbox) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    row.append(cb);
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

// ---------- Groupes : membres ----------
const dlgMembers = $('dlg-members');
async function renderMembersDialog() {
  const room = current;
  await b.refreshPeople();
  const members = await b.members(room);
  const ids = new Set(members.map((m) => m.id));
  $('members-title').textContent = `${room.emoji} ${room.name} · ${members.length} membre${members.length > 1 ? 's' : ''}`;
  $('members-list').replaceChildren(...members.map((p) => personRow(p)));
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

boot();
