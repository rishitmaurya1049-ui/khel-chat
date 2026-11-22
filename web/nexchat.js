import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import { NCEngine, DirectChannel, GroupChannel, SendTextMessageParams, MessageHandler } from '@nexconn/chat';
import * as NC from '@nexconn/chat'; // used for history only

const env = import.meta.env;
const auth = getAuth(initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
}));

const FREE = 1;       // GroupJoinPermission.FREE
const GROUP_TYPE = 3; // ChannelType.GROUP
const COMMUNITIES = [
  { name: 'Football', emoji: '⚽', blurb: 'Pickup games, turf bookings and match-day plans.' },
  { name: 'Cricket', emoji: '🏏', blurb: 'Box cricket squads, nets and weekend matches.' },
  { name: 'Badminton', emoji: '🏸', blurb: 'Court partners, doubles and club nights.' },
  { name: 'Basketball', emoji: '🏀', blurb: 'Street and indoor runs, three-on-three crews.' },
  { name: 'Running', emoji: '🏃', blurb: 'Morning runs, pace groups and race prep.' },
  { name: 'Weekend Hangouts', emoji: '☕', blurb: 'Cafes, treks and easy weekend plans.' },
].map((c) => ({ ...c, id: 'community-' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') }));
const isCommunity = (c) => !!c && c.type === 'g' && c.id.startsWith('community-');
const AVATARS = ['🏏', '⚽', '🏀', '🏸', '🏃', '🎾', '🚴', '🏆'];

// ---------- shared chat state (one login and one connection for every screen) ----------
const S = { phase: 'out', note: '', err: false, myId: null, name: '', photo: '', convos: {}, msgs: {}, unread: {}, loaded: {}, active: null };
const subs = new Set();
const notify = () => subs.forEach((f) => f());
const say = (t, err = false) => { S.note = t; S.err = err; notify(); };
const fail = (what, r) => { say(`${what} (code ${r?.code ?? 'unknown'})`, true); console.error(what, r); return false; };
const keyOf = (t, id) => `${t}:${id}`;
const store = () => `khel_chats_${S.myId}`;
const save = () => { try { localStorage.setItem(store(), JSON.stringify(S.convos)); } catch {} };
const restore = () => { try { S.convos = JSON.parse(localStorage.getItem(store())) || {}; } catch { S.convos = {}; } };

function addConvo(type, id, name, emoji) {
  const k = keyOf(type, id);
  if (!S.convos[k]) { S.convos[k] = { type, id, name, emoji }; save(); }
  return k;
}

let engineReady = false, connecting = null;
function connectWith(user) {
  if (S.phase === 'in') return Promise.resolve();
  if (connecting) return connecting;
  connecting = (async () => {
    S.phase = 'connecting'; say('Connecting to chat...');
    try {
      const r = await fetch(`${env.VITE_API_URL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: await user.getIdToken() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || data.error || 'login failed');
      S.myId = data.userId;
      S.name = localStorage.getItem('khel_profile_name_' + S.myId) || data.name || user.displayName || 'Player';
      S.photo = localStorage.getItem('khel_profile_photo_' + S.myId) || user.photoURL || '';
      restore();
      if (!engineReady) {
        NCEngine.initialize({ appKey: env.VITE_NEXCONN_APP_KEY });
        NCEngine.addMessageHandler('main', new MessageHandler({ onMessageReceived }));
        engineReady = true;
      }
      const res = await NCEngine.connect({ token: data.chatToken });
      console.log('connect result', res);
      if (!res.isOk) throw new Error('chat connection failed, code ' + res.code);
      S.phase = 'in'; say('Connected.');
    } catch (e) { S.phase = 'out'; say('Sign-in failed: ' + e.message, true); console.error(e); }
  })().finally(() => { connecting = null; });
  return connecting;
}

async function signIn() {
  try {
    say('Opening Google sign-in...');
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await connectWith(cred.user);
  } catch (e) { S.phase = 'out'; say('Sign-in failed: ' + e.message, true); }
}
onAuthStateChanged(auth, (u) => { if (u && S.phase === 'out') connectWith(u); }); // stay signed in after a refresh

function onMessageReceived({ messages }) {
  messages.forEach((m) => {
    const text = m.content?.text, ci = m.channelIdentifier;
    if (!text || !ci?.channelId || m.senderUserId === S.myId) return;
    const type = ci.channelType === GROUP_TYPE ? 'g' : 'd';
    const comm = COMMUNITIES.find((c) => c.id === ci.channelId);
    const k = addConvo(type, ci.channelId, comm ? comm.name : ci.channelId, comm?.emoji);
    (S.msgs[k] = S.msgs[k] || []).push({ mine: false, from: m.senderUserId, text });
    if (k !== S.active) S.unread[k] = (S.unread[k] || 0) + 1;
  });
  notify();
}

async function loadHistory(k) {
  if (S.loaded[k]) return; S.loaded[k] = true;
  const c = S.convos[k];
  try {
    const ident = c.type === 'g' ? new NC.GroupChannelIdentifier(c.id) : new NC.DirectChannelIdentifier(c.id);
    const r = await GroupChannel.createMessagesQuery({ channelIdentifier: ident, pageSize: 30 }).loadNextPage();
    if (!r.isOk) throw new Error('code ' + r.code);
    S.msgs[k] = r.data.data.filter((m) => m.content?.text).sort((a, b) => a.sentTime - b.sentTime)
      .map((m) => ({ mine: m.senderUserId === S.myId, from: m.senderUserId, text: m.content.text }));
    notify();
  } catch (e) { console.error('history failed', e); say('Could not load earlier messages.', true); }
}

function openConv(k) { if (!S.convos[k]) return; S.active = k; S.unread[k] = 0; notify(); loadHistory(k); }
function openDirect(id) { if (id && id !== S.myId) openConv(addConvo('d', id, id)); }

async function joinCommunity(c) {
  if (S.phase !== 'in') { await signIn(); if (S.phase !== 'in') return false; }
  const k = keyOf('g', c.id);
  if (!S.convos[k]) {
    say(`Joining ${c.name}...`);
    const cr = await GroupChannel.createGroup({ groupId: c.id, groupName: c.name, joinPermission: FREE }); // harmless if it already exists
    const jr = await new GroupChannel(c.id).join();
    console.log('community create', cr, 'join', jr);
    if (!cr.isOk && !jr.isOk) return fail(`Could not join ${c.name}`, jr);
    addConvo('g', c.id, c.name, c.emoji); say(`Joined ${c.name}.`);
  }
  openConv(k); return true;
}

async function createGroup(name) {
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const r = await GroupChannel.createGroup({ groupId: id, groupName: name, joinPermission: FREE });
  if (!r.isOk) return fail('Could not create group', r);
  openConv(addConvo('g', id, name)); say('Squad group created. Share its group id with your squad.'); return true;
}

async function joinGroup(id) {
  const r = await new GroupChannel(id).join();
  console.log('join', r);
  if (!r.isOk) return fail('Could not join group', r);
  openConv(addConvo('g', id, id)); say('Joined the group.'); return true;
}

async function leaveActive() {
  const c = S.convos[S.active]; if (!c) return;
  const r = await new GroupChannel(c.id).leave();
  if (!r.isOk) return fail('Could not leave group', r);
  delete S.convos[S.active]; delete S.msgs[S.active]; delete S.loaded[S.active]; save(); S.active = null;
  say(isCommunity(c) ? `You left ${c.name}.` : 'You left the group.');
}

async function send(text) {
  const c = S.convos[S.active]; if (!c) return false;
  try {
    const ch = c.type === 'g' ? new GroupChannel(c.id) : new DirectChannel(c.id);
    const r = await ch.sendMessage(new SendTextMessageParams({ text }));
    console.log('send', r);
    if (!r.isOk) throw new Error('code ' + r.code);
    (S.msgs[S.active] = S.msgs[S.active] || []).push({ mine: true, from: S.myId, text });
    notify(); return true;
  } catch (e) { say('Message not sent: ' + e.message, true); console.error(e); return false; }
}

// ---------- styles (follow the site's light and dark mode: html.dark) ----------
const css = `
.nx{--panel:#fff;--soft:#f1f5f9;--line:#e2e8f0;--text:#0f172a;--muted:#64748b;--acc:#10b981;--acc-ink:#022c22;color:var(--text)}
html.dark .nx{--panel:#0f172a;--soft:#1e293b;--line:#1e293b;--text:#f1f5f9;--muted:#94a3b8}
.nx *{box-sizing:border-box}.nx [hidden]{display:none!important}
.nx .nx-card{background:var(--panel);border:1px solid var(--line);border-radius:1rem;padding:1rem}
.nx .nx-h{font-size:1.25rem;font-weight:900;margin:0 0 .25rem}
.nx .nx-muted{color:var(--muted);font-size:.875rem;margin:.25rem 0}
.nx .nx-btn{background:var(--acc);color:var(--acc-ink);border:0;border-radius:.75rem;padding:.55rem 1rem;font-weight:700;font-size:.875rem;cursor:pointer;min-height:40px}
.nx .nx-btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.nx .nx-btn:disabled{opacity:.5;cursor:not-allowed}
.nx button:focus-visible,.nx input:focus-visible,.nx summary:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.nx .nx-input{width:100%;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:.75rem;padding:.55rem .75rem;font-size:.95rem}
.nx .nx-row{display:flex;gap:.5rem;align-items:center}
.nx .nx-status{color:var(--muted);font-size:.85rem;margin:.5rem 0 0;min-height:1.2em}.nx .nx-status.err{color:#dc2626}
.nx .nx-gate{max-width:34rem;margin:2rem auto;text-align:center}
.nx .nx-app{display:grid;grid-template-columns:280px 1fr;gap:1rem}
@media(max-width:760px){.nx .nx-app{grid-template-columns:1fr}}
.nx .nx-side,.nx .nx-main{display:flex;flex-direction:column;gap:.6rem}
.nx .nx-me{display:flex;justify-content:space-between;align-items:center;gap:.5rem}.nx .nx-profile{display:flex;align-items:center;gap:.65rem}.nx .nx-avatar{width:2.5rem;height:2.5rem;object-fit:cover;border-radius:50%;background:var(--soft);display:grid;place-items:center;font-size:1.4rem}.nx .nx-avatars{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem}.nx .nx-avatar-choice{border:1px solid var(--line);background:var(--soft);border-radius:50%;width:2.2rem;height:2.2rem;cursor:pointer;font-size:1.2rem}.nx .nx-avatar-choice.on{outline:2px solid var(--acc)}
.nx .nx-sub{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:.6rem 0 .2rem}
.nx .nx-chat{display:block;width:100%;text-align:left;background:transparent;color:var(--text);border:1px solid transparent;border-radius:.6rem;padding:.4rem .5rem;font-weight:600;cursor:pointer;overflow-wrap:anywhere}
.nx .nx-chat.on{border-color:var(--acc);background:var(--soft)}
.nx .nx-badge{float:right;background:var(--acc);color:var(--acc-ink);border-radius:99px;padding:0 .5rem;font-size:.75rem}
.nx .nx-more{border-top:1px solid var(--line);padding-top:.5rem}.nx .nx-more summary{cursor:pointer;font-weight:700}
.nx .nx-more label{display:block;font-size:.8rem;color:var(--muted);margin:.5rem 0 .2rem}
.nx .nx-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap}
.nx .nx-log{flex:1;min-height:300px;max-height:55vh;overflow:auto;display:flex;flex-direction:column;gap:.4rem;padding:.25rem}
.nx .nx-msg{max-width:78%;padding:.45rem .75rem;border-radius:1rem;background:var(--soft);align-self:flex-start;overflow-wrap:anywhere}
.nx .nx-msg.mine{background:var(--acc);color:var(--acc-ink);align-self:flex-end}
.nx .nx-from{display:block;font-size:.7rem;opacity:.7}
.nx .nx-empty{margin:auto;color:var(--muted);text-align:center}
.nx .nx-commhead{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
.nx .nx-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr))}
.nx .nx-comm{display:flex;flex-direction:column;gap:.5rem}.nx .nx-comm h3{margin:0;font-size:1.1rem;font-weight:800}
.nx .nx-comm .em{font-size:1.75rem}.nx .nx-comm .nx-btn{margin-top:auto;align-self:flex-start}
.nx-host{margin-bottom:2rem}`;
const styleEl = document.createElement('style'); styleEl.id = 'nx-style'; styleEl.textContent = css; document.head.appendChild(styleEl);

// ---------- views ----------
const el$ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const statusClass = () => 'nx-status' + (S.err ? ' err' : '');

function unmount(host) { if (host && host.__nx) { subs.delete(host.__nx); host.__nx = null; host.innerHTML = ''; } }

const CHATS_HTML = `<div class="nx">
<div class="nx-card nx-gate" data-r="gate"><h2 class="nx-h">Chats</h2>
<p class="nx-muted">Sign in with Google to message players and create squad groups.</p>
<button class="nx-btn" data-r="login">Continue with Google</button><p class="nx-status" data-r="gstatus" role="status"></p></div>
<div class="nx-app" data-r="app">
<aside class="nx-card nx-side"><div class="nx-me"><div class="nx-profile"><span class="nx-avatar" data-r="avatar">🙂</span><strong data-r="name"></strong></div><button class="nx-btn ghost" data-r="copy">Copy my id</button></div>
<details class="nx-more"><summary>Edit profile</summary><label>Your name</label><div class="nx-row"><input class="nx-input" data-r="pname" maxlength="40" autocomplete="name"><button class="nx-btn" data-r="saveprofile">Save</button></div><label>Choose a photo</label><label class="nx-btn ghost" style="display:inline-block;cursor:pointer">Upload photo<input data-r="upload" type="file" accept="image/*" hidden></label><div class="nx-avatars" data-r="avatars"></div></details>
<div data-r="list"></div>
<details class="nx-more"><summary>Start something</summary>
<label>Direct message (their user id)</label><div class="nx-row"><input class="nx-input" data-r="peer" autocomplete="off"><button class="nx-btn" data-r="open">Open</button></div>
<label>New group</label><div class="nx-row"><input class="nx-input" data-r="gname" placeholder="Group name" autocomplete="off"><button class="nx-btn" data-r="create">Create</button></div>
<label>Join a group (its id)</label><div class="nx-row"><input class="nx-input" data-r="gid" autocomplete="off"><button class="nx-btn" data-r="join">Join</button></div></details>
<p class="nx-status" data-r="status" role="status"></p></aside>
<section class="nx-card nx-main" aria-label="Conversation"><div class="nx-head"><strong data-r="title">Pick a chat</strong>
<div class="nx-row" data-r="actions"><button class="nx-btn ghost" data-r="copygid">Copy group id</button><button class="nx-btn ghost" data-r="leave">Leave</button></div></div>
<div class="nx-log" data-r="log" aria-live="polite"></div>
<div class="nx-row"><input class="nx-input" data-r="text" placeholder="Type a message" autocomplete="off"><button class="nx-btn" data-r="send">Send</button></div></section>
</div></div>`;

function renderList(box) {
  box.innerHTML = '';
  const keys = Object.keys(S.convos);
  const sections = [
    ['Communities', (k) => isCommunity(S.convos[k])],
    ['Squad groups', (k) => S.convos[k].type === 'g' && !isCommunity(S.convos[k])],
    ['Direct messages', (k) => S.convos[k].type === 'd'],
  ];
  let any = false;
  sections.forEach(([label, f]) => {
    const ks = keys.filter(f); if (!ks.length) return; any = true;
    box.appendChild(el$('h3', 'nx-sub', label));
    ks.forEach((k) => {
      const c = S.convos[k], b = el$('button', 'nx-chat' + (k === S.active ? ' on' : ''), (c.emoji ? c.emoji + ' ' : c.type === 'g' ? '# ' : '@ ') + c.name);
      if (S.unread[k]) b.appendChild(el$('span', 'nx-badge', String(S.unread[k])));
      b.onclick = () => openConv(k); box.appendChild(b);
    });
  });
  if (!any) box.appendChild(el$('p', 'nx-muted', 'No chats yet. Join a community from the Communities tab, create a squad group, or start a direct message below.'));
}

function renderLog(log, c, list) {
  log.innerHTML = '';
  if (!c) { log.appendChild(el$('p', 'nx-empty', 'Pick a chat on the left, or create a squad group.')); return; }
  if (!list.length) { log.appendChild(el$('p', 'nx-empty', 'No messages yet. Say hi.')); return; }
  list.forEach((m) => {
    const d = el$('div', 'nx-msg' + (m.mine ? ' mine' : ''));
    if (c.type === 'g' && !m.mine) d.appendChild(el$('span', 'nx-from', (m.from || '').slice(0, 8)));
    d.appendChild(document.createTextNode(m.text)); log.appendChild(d);
  });
}

function mountChats(host) {
  unmount(host); host.innerHTML = CHATS_HTML;
  const ui = {};
  host.querySelectorAll('[data-r]').forEach((n) => { ui[n.dataset.r] = n; });
  ui.login.onclick = () => signIn();
  ui.saveprofile.onclick = () => {
    const value = ui.pname.value.trim();
    if (!value) return say('Enter your name first.', true);
    S.name = value;
    localStorage.setItem('khel_profile_name_' + S.myId, value);
    say('Profile updated.');
  };
  ui.upload.onchange = () => {
    const file = ui.upload.files?.[0];
    if (!file) return;
    if (file.size > 2000000) return say('Choose an image under 2 MB.', true);
    const reader = new FileReader();
    reader.onload = () => {
      S.photo = String(reader.result);
      localStorage.setItem('khel_profile_photo_' + S.myId, S.photo);
      update();
    };
    reader.readAsDataURL(file);
  };
  AVATARS.forEach((avatar) => {
    const button = el$('button', 'nx-avatar-choice', avatar);
    button.type = 'button'; button.title = `Use ${avatar}`;
    button.onclick = () => {
      S.photo = `emoji:${avatar}`;
      localStorage.setItem('khel_profile_photo_' + S.myId, S.photo);
      update();
    };
    ui.avatars.appendChild(button);
  });
  ui.copy.onclick = async () => { try { await navigator.clipboard.writeText(S.myId); say('Your id is copied.'); } catch { say('Your id: ' + S.myId); } };
  ui.open.onclick = () => { const v = ui.peer.value.trim(); if (v) { openDirect(v); ui.peer.value = ''; } };
  ui.peer.onkeydown = (e) => { if (e.key === 'Enter') ui.open.click(); };
  ui.create.onclick = async () => { const v = ui.gname.value.trim(); if (v && await createGroup(v)) ui.gname.value = ''; };
  ui.join.onclick = async () => { const v = ui.gid.value.trim(); if (v && await joinGroup(v)) ui.gid.value = ''; };
  ui.leave.onclick = () => leaveActive();
  ui.copygid.onclick = async () => { const c = S.convos[S.active]; if (!c) return; try { await navigator.clipboard.writeText(c.id); say('Group id copied.'); } catch { say('Group id: ' + c.id); } };
  const go = async () => { const v = ui.text.value.trim(); if (v && await send(v)) ui.text.value = ''; };
  ui.send.onclick = go; ui.text.onkeydown = (e) => { if (e.key === 'Enter') go(); };

  let lastKey = null, lastCount = -1;
  const update = () => {
    const inn = S.phase === 'in';
    ui.gate.hidden = inn; ui.app.hidden = !inn;
    ui.login.disabled = S.phase === 'connecting';
    ui.gstatus.textContent = S.note; ui.gstatus.className = statusClass();
    if (!inn) return;
    ui.status.textContent = S.note; ui.status.className = statusClass();
    ui.name.textContent = S.name;
    ui.pname.value = S.name;
    if (S.photo.startsWith('emoji:')) {
      if (ui.avatar.tagName === 'IMG') {
        const avatar = el$('span', 'nx-avatar', S.photo.slice(6)); avatar.dataset.r = 'avatar';
        ui.avatar.replaceWith(avatar); ui.avatar = avatar;
      } else ui.avatar.replaceChildren(document.createTextNode(S.photo.slice(6)));
    } else if (S.photo) {
      const image = document.createElement('img'); image.src = S.photo; image.alt = 'Profile photo'; image.className = 'nx-avatar';
      if (ui.avatar.tagName !== 'IMG') { ui.avatar.replaceWith(image); image.dataset.r = 'avatar'; ui.avatar = image; }
      else ui.avatar.src = S.photo;
    } else if (ui.avatar.tagName === 'IMG') {
      const avatar = el$('span', 'nx-avatar', '🙂'); avatar.dataset.r = 'avatar';
      ui.avatar.replaceWith(avatar); ui.avatar = avatar;
    } else {
      ui.avatar.replaceChildren(document.createTextNode('🙂'));
    }
    renderList(ui.list);
    const c = S.convos[S.active], list = S.msgs[S.active] || [];
    ui.title.textContent = c ? (c.type === 'd' ? 'Chat with ' : c.emoji ? c.emoji + ' ' : '# ') + c.name : 'Pick a chat';
    ui.actions.hidden = !(c && c.type === 'g');
    ui.copygid.hidden = isCommunity(c);
    ui.leave.textContent = isCommunity(c) ? 'Leave community' : 'Leave';
    ui.text.disabled = ui.send.disabled = !c;
    renderLog(ui.log, c, list);
    if (S.active !== lastKey || list.length !== lastCount) ui.log.scrollTop = ui.log.scrollHeight;
    lastKey = S.active; lastCount = list.length;
  };
  subs.add(update); host.__nx = update; update();
}

function mountCommunities(host, openChats) {
  unmount(host);
  host.innerHTML = `<div class="nx"><div class="nx-commhead"><div><h2 class="nx-h">Communities</h2>
<p class="nx-muted">Real rooms where players talk right now. Pick a sport and join.</p></div><p data-r="s" role="status"></p></div><div class="nx-grid" data-r="grid"></div></div>`;
  const st = host.querySelector('[data-r="s"]'), grid = host.querySelector('[data-r="grid"]');
  const update = () => {
    st.textContent = S.phase === 'in' ? '' : S.note; st.className = statusClass();
    grid.innerHTML = '';
    COMMUNITIES.forEach((c) => {
      const joined = !!S.convos[keyOf('g', c.id)];
      const card = el$('article', 'nx-card nx-comm');
      card.append(el$('span', 'em', c.emoji), el$('h3', '', c.name), el$('p', 'nx-muted', c.blurb));
      const b = el$('button', 'nx-btn', joined ? 'Open chat' : S.phase === 'in' ? 'Join chat' : 'Sign in and join');
      b.disabled = S.phase === 'connecting';
      b.onclick = async () => { if (await joinCommunity(c) && openChats) openChats(); };
      card.appendChild(b); grid.appendChild(card);
    });
  };
  subs.add(update); host.__nx = update; update();
}

window.NexChat = { mountChats, mountCommunities, unmount };
window.dispatchEvent(new Event('nexchat-ready'));
