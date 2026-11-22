import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import { NCEngine, DirectChannel, GroupChannel, SendTextMessageParams, MessageHandler } from '@nexconn/chat';
import * as NC from '@nexconn/chat';

const env = import.meta.env;
const auth = getAuth(initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
}));

const FREE = 1;
const GROUP_TYPE = 3;
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

// ---------- user profile cache ----------
const profileCache = {};
async function fetchProfiles(userIds) {
  const missing = userIds.filter((id) => id && !profileCache[id]);
  if (!missing.length) return;
  try {
    const r = await NCEngine.userModule.getUserProfiles(missing);
    if (r.isOk && r.data) {
      r.data.forEach((p) => {
        profileCache[p.userId] = { name: p.name || p.userId?.slice(0, 8), avatarUrl: p.avatarUrl || '' };
      });
    }
  } catch (e) { console.warn('profile fetch failed', e); }
  // fill anything still missing with defaults
  missing.forEach((id) => {
    if (!profileCache[id]) profileCache[id] = { name: id.slice(0, 8), avatarUrl: '' };
  });
}
function getProfile(userId) {
  return profileCache[userId] || { name: userId?.slice(0, 8) || '???', avatarUrl: '' };
}
function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

// ---------- shared chat state ----------
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
      profileCache[S.myId] = { name: S.name, avatarUrl: S.photo.startsWith('emoji:') ? '' : S.photo };
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
onAuthStateChanged(auth, (u) => { if (u && S.phase === 'out') connectWith(u); });

function onMessageReceived({ messages }) {
  const newUserIds = [];
  messages.forEach((m) => {
    const text = m.content?.text, ci = m.channelIdentifier;
    if (!text || !ci?.channelId || m.senderUserId === S.myId) return;
    const type = ci.channelType === GROUP_TYPE ? 'g' : 'd';
    const comm = COMMUNITIES.find((c) => c.id === ci.channelId);
    const k = addConvo(type, ci.channelId, comm ? comm.name : ci.channelId, comm?.emoji);
    // extract sender info from message content
    const ui = m.content?.senderUserInfo;
    const senderName = ui?.name || m.senderUserId.slice(0, 8);
    const senderAvatar = ui?.avatarUrl || '';
    if (ui && !profileCache[m.senderUserId]) {
      profileCache[m.senderUserId] = { name: senderName, avatarUrl: senderAvatar };
    }
    if (!profileCache[m.senderUserId]) newUserIds.push(m.senderUserId);
    (S.msgs[k] = S.msgs[k] || []).push({ mine: false, from: m.senderUserId, name: senderName, avatar: senderAvatar, text, time: m.sentTime || Date.now() });
    if (k !== S.active) S.unread[k] = (S.unread[k] || 0) + 1;
  });
  if (newUserIds.length) fetchProfiles(newUserIds).then(notify);
  notify();
}

async function loadHistory(k) {
  if (S.loaded[k]) return; S.loaded[k] = true;
  const c = S.convos[k];
  try {
    const ident = c.type === 'g' ? new NC.GroupChannelIdentifier(c.id) : new NC.DirectChannelIdentifier(c.id);
    const r = await GroupChannel.createMessagesQuery({ channelIdentifier: ident, pageSize: 30 }).loadNextPage();
    if (!r.isOk) throw new Error('code ' + r.code);
    const userIds = new Set();
    S.msgs[k] = r.data.data.filter((m) => m.content?.text).sort((a, b) => a.sentTime - b.sentTime)
      .map((m) => {
        const ui = m.content?.senderUserInfo;
        const senderName = ui?.name || m.senderUserId?.slice(0, 8) || '???';
        const senderAvatar = ui?.avatarUrl || '';
        if (ui && !profileCache[m.senderUserId]) {
          profileCache[m.senderUserId] = { name: senderName, avatarUrl: senderAvatar };
        }
        if (!profileCache[m.senderUserId]) userIds.add(m.senderUserId);
        return { mine: m.senderUserId === S.myId, from: m.senderUserId, name: senderName, avatar: senderAvatar, text: m.content.text, time: m.sentTime || 0 };
      });
    if (userIds.size) await fetchProfiles([...userIds]);
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
    const cr = await GroupChannel.createGroup({ groupId: c.id, groupName: c.name, joinPermission: FREE });
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
    (S.msgs[S.active] = S.msgs[S.active] || []).push({ mine: true, from: S.myId, name: S.name, avatar: S.photo, text, time: Date.now() });
    notify(); return true;
  } catch (e) { say('Message not sent: ' + e.message, true); console.error(e); return false; }
}

// ---------- format time ----------
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const hh = d.getHours(), mm = d.getMinutes();
  const timeStr = `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
  if (d.toDateString() === now.toDateString()) return timeStr;
  const diff = (now - d) / 86400000;
  if (diff < 1) return 'Yesterday ' + timeStr;
  if (diff < 7) return d.toLocaleDateString('en', { weekday: 'short' }) + ' ' + timeStr;
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' ' + timeStr;
}

// ---------- styles ----------
const css = `
/* ===== NexChat Redesigned UI ===== */
.nx { --bg: #0c0f1a; --panel: #141829; --panel2: #1a1f38; --soft: #1e2545; --line: #262d50; --text: #e8ecf5; --muted: #7b84a3; --acc: #6c5ce7; --acc2: #a855f7; --acc-ink: #fff; --green: #10b981; --red: #ef4444; --orange: #f59e0b; font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif; color: var(--text); }
html:not(.dark) .nx { --bg: #f0f2f7; --panel: #ffffff; --panel2: #f7f8fc; --soft: #eef0f6; --line: #dfe3ed; --text: #1a1d2e; --muted: #6b7394; --acc: #6c5ce7; --acc2: #a855f7; --acc-ink: #fff; }
.nx * { box-sizing: border-box; margin: 0; padding: 0; }
.nx [hidden] { display: none !important; }

/* cards */
.nx .nx-card { background: var(--panel); border: 1px solid var(--line); border-radius: 1.25rem; overflow: hidden; }

/* gate */
.nx .nx-gate { max-width: 26rem; margin: 3rem auto; text-align: center; padding: 3rem 2rem; }
.nx .nx-gate-icon { font-size: 3.5rem; margin-bottom: 1rem; display: block; }
.nx .nx-gate h2 { font-size: 1.75rem; font-weight: 800; margin-bottom: .5rem; background: linear-gradient(135deg, var(--acc), var(--acc2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.nx .nx-gate p { color: var(--muted); font-size: .95rem; line-height: 1.5; margin-bottom: 1.5rem; }
.nx .nx-gate .nx-btn { width: 100%; padding: .85rem; font-size: 1rem; }

/* buttons */
.nx .nx-btn { background: linear-gradient(135deg, var(--acc), var(--acc2)); color: var(--acc-ink); border: 0; border-radius: .85rem; padding: .6rem 1.2rem; font-weight: 700; font-size: .875rem; cursor: pointer; min-height: 42px; transition: all .2s; letter-spacing: .01em; }
.nx .nx-btn:hover { opacity: .9; transform: translateY(-1px); box-shadow: 0 4px 15px rgba(108, 92, 231, .3); }
.nx .nx-btn.ghost { background: var(--soft); color: var(--text); border: 1px solid var(--line); box-shadow: none; }
.nx .nx-btn.ghost:hover { background: var(--line); transform: translateY(-1px); }
.nx .nx-btn.sm { padding: .4rem .8rem; font-size: .8rem; min-height: 34px; border-radius: .6rem; }
.nx .nx-btn.danger { background: var(--red); }
.nx .nx-btn:disabled { opacity: .4; cursor: not-allowed; transform: none; }
.nx button:focus-visible, .nx input:focus-visible, .nx summary:focus-visible { outline: 2px solid var(--acc); outline-offset: 2px; }

/* inputs */
.nx .nx-input { width: 100%; background: var(--soft); color: var(--text); border: 1px solid var(--line); border-radius: .85rem; padding: .65rem .9rem; font-size: .95rem; font-family: inherit; transition: border-color .2s; }
.nx .nx-input:focus { border-color: var(--acc); background: var(--panel); }
.nx .nx-input::placeholder { color: var(--muted); }
.nx .nx-row { display: flex; gap: .5rem; align-items: center; }

/* status */
.nx .nx-status { color: var(--muted); font-size: .82rem; min-height: 1.2em; margin-top: .5rem; }
.nx .nx-status.err { color: var(--red); }

/* app layout */
.nx .nx-app { display: grid; grid-template-columns: 320px 1fr; height: 680px; border-radius: 1.25rem; overflow: hidden; border: 1px solid var(--line); background: var(--panel); }
@media (max-width: 760px) { .nx .nx-app { grid-template-columns: 1fr; height: calc(100dvh - 120px); min-height: 500px; } }

/* sidebar */
.nx .nx-side { display: flex; flex-direction: column; border-right: 1px solid var(--line); background: var(--panel); overflow: hidden; }
.nx .nx-side-header { padding: 1.25rem 1rem 1rem; border-bottom: 1px solid var(--line); }
.nx .nx-me { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.nx .nx-profile { display: flex; align-items: center; gap: .75rem; }
.nx .nx-profile strong { font-size: .95rem; }
.nx .nx-avatar { width: 2.6rem; height: 2.6rem; border-radius: 50%; background: linear-gradient(135deg, var(--acc), var(--acc2)); display: grid; place-items: center; font-size: 1.1rem; color: #fff; font-weight: 700; flex-shrink: 0; object-fit: cover; }
.nx .nx-avatar.img { background: none; }

/* avatar choices */
.nx .nx-avatars { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .5rem; }
.nx .nx-avatar-choice { border: 2px solid var(--line); background: var(--soft); border-radius: 50%; width: 2.4rem; height: 2.4rem; cursor: pointer; font-size: 1.2rem; display: grid; place-items: center; transition: all .2s; }
.nx .nx-avatar-choice:hover { border-color: var(--acc); }
.nx .nx-avatar-choice.on { border-color: var(--acc); box-shadow: 0 0 0 2px rgba(108, 92, 231, .3); }

/* sidebar list */
.nx .nx-list-wrap { flex: 1; overflow-y: auto; padding: .75rem .5rem; }
.nx .nx-sub { font-size: .65rem; font-weight: 800; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); padding: .6rem .75rem .3rem; }
.nx .nx-chat { display: flex; align-items: center; gap: .65rem; width: 100%; text-align: left; background: transparent; color: var(--text); border: none; border-radius: .85rem; padding: .6rem .75rem; font-weight: 600; font-size: .9rem; cursor: pointer; transition: all .15s; }
.nx .nx-chat:hover { background: var(--soft); }
.nx .nx-chat.on { background: rgba(108, 92, 231, .12); }
.nx .nx-chat-icon { width: 2.2rem; height: 2.2rem; border-radius: 50%; background: var(--soft); display: grid; place-items: center; font-size: 1rem; flex-shrink: 0; }
.nx .nx-chat.on .nx-chat-icon { background: linear-gradient(135deg, var(--acc), var(--acc2)); color: #fff; }
.nx .nx-chat-info { flex: 1; min-width: 0; }
.nx .nx-chat-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nx .nx-badge { background: linear-gradient(135deg, var(--acc), var(--acc2)); color: #fff; border-radius: 99px; padding: .1rem .5rem; font-size: .7rem; font-weight: 800; flex-shrink: 0; min-width: 1.3rem; text-align: center; }

/* expand sections */
.nx .nx-more { border-top: 1px solid var(--line); padding: .75rem 1rem; }
.nx .nx-more summary { cursor: pointer; font-weight: 700; font-size: .85rem; color: var(--muted); list-style: none; display: flex; align-items: center; gap: .5rem; }
.nx .nx-more summary::before { content: '›'; font-size: 1.1rem; transition: transform .2s; }
.nx .nx-more[open] summary::before { transform: rotate(90deg); }
.nx .nx-more label { display: block; font-size: .78rem; color: var(--muted); margin: .6rem 0 .25rem; font-weight: 600; }

/* main chat area */
.nx .nx-main { display: flex; flex-direction: column; overflow: hidden; }
.nx .nx-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--panel); min-height: 64px; }
.nx .nx-head-title { display: flex; align-items: center; gap: .65rem; }
.nx .nx-head-title strong { font-size: 1.05rem; }
.nx .nx-head-emoji { font-size: 1.4rem; }

/* message log */
.nx .nx-log { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: .15rem; padding: 1rem 1.25rem; scroll-behavior: smooth; background: var(--panel2); }
.nx .nx-log::-webkit-scrollbar { width: 5px; } .nx .nx-log::-webkit-scrollbar-thumb { background: var(--line); border-radius: 9px; }

/* message bubbles */
.nx .nx-msg-wrap { display: flex; gap: .5rem; align-items: flex-start; max-width: 82%; margin-bottom: .3rem; }
.nx .nx-msg-wrap.mine { align-self: flex-end; flex-direction: row-reverse; }
.nx .nx-msg-wrap.mine + .nx-msg-wrap:not(.mine),
.nx .nx-msg-wrap:not(.mine) + .nx-msg-wrap.mine { margin-top: .6rem; }

.nx .nx-msg-avatar { width: 2rem; height: 2rem; border-radius: 50%; background: var(--soft); display: grid; place-items: center; font-size: .7rem; font-weight: 700; color: var(--muted); flex-shrink: 0; cursor: pointer; margin-top: .15rem; overflow: hidden; transition: transform .15s; }
.nx .nx-msg-avatar:hover { transform: scale(1.1); }
.nx .nx-msg-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.nx .nx-msg-wrap.mine .nx-msg-avatar { display: none; }
.nx .nx-msg-body { min-width: 0; }
.nx .nx-msg-sender { display: flex; align-items: baseline; gap: .4rem; margin-bottom: .15rem; }
.nx .nx-msg-sender-name { font-size: .75rem; font-weight: 700; color: var(--acc); }
.nx .nx-msg-time { font-size: .65rem; color: var(--muted); }
.nx .nx-msg-wrap.mine .nx-msg-sender { display: none; }
.nx .nx-msg { padding: .55rem .9rem; border-radius: 1.1rem 1.1rem 1.1rem .3rem; background: var(--soft); line-height: 1.45; word-break: break-word; font-size: .92rem; }
.nx .nx-msg-wrap.mine .nx-msg { background: linear-gradient(135deg, var(--acc), var(--acc2)); color: #fff; border-radius: 1.1rem 1.1rem .3rem 1.1rem; }
.nx .nx-msg-wrap.mine .nx-msg-time-below { text-align: right; }
.nx .nx-msg-time-below { font-size: .6rem; color: var(--muted); margin-top: .15rem; padding: 0 .2rem; }

.nx .nx-empty { margin: auto; color: var(--muted); text-align: center; padding: 2rem; }
.nx .nx-empty-icon { font-size: 3rem; margin-bottom: .75rem; display: block; opacity: .5; }

/* compose bar */
.nx .nx-compose { display: flex; gap: .5rem; padding: .85rem 1.25rem; border-top: 1px solid var(--line); background: var(--panel); align-items: center; }
.nx .nx-compose .nx-input { border-radius: 1.5rem; padding: .7rem 1rem; }
.nx .nx-send-btn { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, var(--acc), var(--acc2)); color: #fff; border: 0; cursor: pointer; display: grid; place-items: center; flex-shrink: 0; transition: all .2s; }
.nx .nx-send-btn:hover { transform: scale(1.05); box-shadow: 0 4px 15px rgba(108, 92, 231, .4); }
.nx .nx-send-btn:disabled { opacity: .3; cursor: not-allowed; transform: none; }
.nx .nx-send-btn svg { width: 18px; height: 18px; }

/* profile popup */
.nx .nx-popup-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0, 0, 0, .5); backdrop-filter: blur(4px); display: grid; place-items: center; animation: nxFadeIn .2s; }
.nx .nx-popup { background: var(--panel); border: 1px solid var(--line); border-radius: 1.25rem; padding: 2rem 1.75rem; min-width: 280px; max-width: 340px; text-align: center; animation: nxSlideUp .25s ease-out; position: relative; box-shadow: 0 20px 60px rgba(0, 0, 0, .3); }
.nx .nx-popup-close { position: absolute; top: .75rem; right: .75rem; background: var(--soft); border: none; color: var(--muted); border-radius: 50%; width: 2rem; height: 2rem; cursor: pointer; display: grid; place-items: center; font-size: 1.1rem; }
.nx .nx-popup-close:hover { background: var(--line); color: var(--text); }
.nx .nx-popup-avatar { width: 5rem; height: 5rem; border-radius: 50%; background: linear-gradient(135deg, var(--acc), var(--acc2)); display: grid; place-items: center; font-size: 1.8rem; font-weight: 800; color: #fff; margin: 0 auto 1rem; overflow: hidden; }
.nx .nx-popup-avatar img { width: 100%; height: 100%; object-fit: cover; }
.nx .nx-popup h3 { font-size: 1.15rem; font-weight: 800; margin-bottom: .25rem; }
.nx .nx-popup .nx-popup-id { font-size: .78rem; color: var(--muted); word-break: break-all; margin-bottom: 1rem; }
.nx .nx-popup-actions { display: flex; gap: .5rem; justify-content: center; }

@keyframes nxFadeIn { from { opacity: 0; } }
@keyframes nxSlideUp { from { transform: translateY(16px); opacity: 0; } }

/* communities */
.nx .nx-commhead { display: flex; justify-content: space-between; align-items: flex-end; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.nx .nx-commhead h2 { font-size: 1.5rem; font-weight: 800; background: linear-gradient(135deg, var(--acc), var(--acc2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.nx .nx-commhead p { color: var(--muted); font-size: .92rem; }
.nx .nx-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
.nx .nx-comm { display: flex; flex-direction: column; gap: .65rem; padding: 1.25rem; transition: transform .15s, box-shadow .15s; }
.nx .nx-comm:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(0, 0, 0, .12); }
.nx .nx-comm .em { font-size: 2rem; }
.nx .nx-comm h3 { font-size: 1.1rem; font-weight: 800; }
.nx .nx-comm p { color: var(--muted); font-size: .88rem; line-height: 1.4; }
.nx .nx-comm .nx-btn { margin-top: auto; align-self: flex-start; }
.nx-host { margin-bottom: 2rem; }
`;
const styleEl = document.createElement('style'); styleEl.id = 'nx-style'; styleEl.textContent = css; document.head.appendChild(styleEl);

// ---------- helpers ----------
const el$ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const statusClass = () => 'nx-status' + (S.err ? ' err' : '');
const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

function unmount(host) { if (host && host.__nx) { subs.delete(host.__nx); host.__nx = null; host.innerHTML = ''; } }

// ---------- profile popup ----------
function showProfilePopup(userId) {
  const p = getProfile(userId);
  const overlay = el$('div', 'nx-popup-overlay');
  const popup = el$('div', 'nx-popup');
  const closeBtn = el$('button', 'nx-popup-close', '✕');
  closeBtn.onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const avatarEl = el$('div', 'nx-popup-avatar');
  if (p.avatarUrl && !p.avatarUrl.startsWith('emoji:')) {
    const img = document.createElement('img'); img.src = p.avatarUrl; img.alt = p.name;
    avatarEl.appendChild(img);
  } else if (p.avatarUrl?.startsWith('emoji:')) {
    avatarEl.textContent = p.avatarUrl.slice(6);
  } else {
    avatarEl.textContent = initialsFor(p.name);
  }

  const nameEl = el$('h3', '', p.name);
  const idEl = el$('div', 'nx-popup-id', userId);
  const actions = el$('div', 'nx-popup-actions');
  const dmBtn = el$('button', 'nx-btn sm', '💬 Message');
  dmBtn.onclick = () => { overlay.remove(); openDirect(userId); };
  const copyBtn = el$('button', 'nx-btn sm ghost', '📋 Copy ID');
  copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(userId); copyBtn.textContent = '✓ Copied'; } catch {} };
  if (userId !== S.myId) actions.append(dmBtn, copyBtn);
  else actions.append(copyBtn);

  popup.append(closeBtn, avatarEl, nameEl, idEl, actions);
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
}

// ---------- build avatar element ----------
function makeAvatarEl(photo, name, cls) {
  if (photo && !photo.startsWith('emoji:')) {
    const img = document.createElement('img');
    img.src = photo; img.alt = name || ''; img.className = (cls || 'nx-avatar') + ' img';
    return img;
  }
  const span = el$('span', cls || 'nx-avatar');
  if (photo?.startsWith('emoji:')) { span.textContent = photo.slice(6); }
  else { span.textContent = initialsFor(name); }
  return span;
}

// ---------- CHATS HTML ----------
const CHATS_HTML = `<div class="nx">
<div class="nx-card nx-gate" data-r="gate">
  <span class="nx-gate-icon">💬</span>
  <h2>Khel Chat</h2>
  <p>Sign in with Google to message players, join sports communities and create squad groups.</p>
  <button class="nx-btn" data-r="login">
    <svg style="width:18px;height:18px;vertical-align:middle;margin-right:6px" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
    Continue with Google
  </button>
  <p class="nx-status" data-r="gstatus" role="status"></p>
</div>
<div class="nx-app" data-r="app">
  <aside class="nx-side">
    <div class="nx-side-header">
      <div class="nx-me">
        <div class="nx-profile"><span class="nx-avatar" data-r="avatar"></span><strong data-r="name"></strong></div>
        <button class="nx-btn sm ghost" data-r="copy" title="Copy your user ID">📋 ID</button>
      </div>
    </div>
    <div class="nx-list-wrap" data-r="list"></div>
    <details class="nx-more">
      <summary>✏️ Edit profile</summary>
      <label>Your name</label>
      <div class="nx-row"><input class="nx-input" data-r="pname" maxlength="40" autocomplete="name"><button class="nx-btn sm" data-r="saveprofile">Save</button></div>
      <label>Choose a photo</label>
      <label class="nx-btn sm ghost" style="display:inline-block;cursor:pointer">📷 Upload<input data-r="upload" type="file" accept="image/*" hidden></label>
      <div class="nx-avatars" data-r="avatars"></div>
    </details>
    <details class="nx-more">
      <summary>➕ Start something</summary>
      <label>Direct message (user id)</label>
      <div class="nx-row"><input class="nx-input" data-r="peer" placeholder="Paste user id" autocomplete="off"><button class="nx-btn sm" data-r="open">Open</button></div>
      <label>New group</label>
      <div class="nx-row"><input class="nx-input" data-r="gname" placeholder="Group name" autocomplete="off"><button class="nx-btn sm" data-r="create">Create</button></div>
      <label>Join a group (id)</label>
      <div class="nx-row"><input class="nx-input" data-r="gid" placeholder="Paste group id" autocomplete="off"><button class="nx-btn sm" data-r="join">Join</button></div>
    </details>
    <p class="nx-status" data-r="status" role="status" style="padding:.5rem 1rem"></p>
  </aside>
  <section class="nx-main" aria-label="Conversation">
    <div class="nx-head">
      <div class="nx-head-title"><span class="nx-head-emoji" data-r="headEmoji"></span><strong data-r="title">Pick a chat</strong></div>
      <div class="nx-row" data-r="actions"><button class="nx-btn sm ghost" data-r="copygid">📋 Group ID</button><button class="nx-btn sm danger" data-r="leave">Leave</button></div>
    </div>
    <div class="nx-log" data-r="log" aria-live="polite"></div>
    <div class="nx-compose">
      <input class="nx-input" data-r="text" placeholder="Type a message…" autocomplete="off">
      <button class="nx-send-btn" data-r="send">${SEND_SVG}</button>
    </div>
  </section>
</div>
</div>`;

// ---------- render sidebar list ----------
function renderList(box) {
  box.innerHTML = '';
  const keys = Object.keys(S.convos);
  const sections = [
    ['Communities', (k) => isCommunity(S.convos[k])],
    ['Squad Groups', (k) => S.convos[k].type === 'g' && !isCommunity(S.convos[k])],
    ['Direct Messages', (k) => S.convos[k].type === 'd'],
  ];
  let any = false;
  sections.forEach(([label, f]) => {
    const ks = keys.filter(f); if (!ks.length) return; any = true;
    box.appendChild(el$('h3', 'nx-sub', label));
    ks.forEach((k) => {
      const c = S.convos[k];
      const btn = el$('button', 'nx-chat' + (k === S.active ? ' on' : ''));
      const icon = el$('span', 'nx-chat-icon', c.emoji || (c.type === 'g' ? '#' : '@'));
      const info = el$('span', 'nx-chat-info');
      const nameSpan = el$('span', 'nx-chat-name', c.name);
      info.appendChild(nameSpan);
      btn.append(icon, info);
      if (S.unread[k]) btn.appendChild(el$('span', 'nx-badge', String(S.unread[k])));
      btn.onclick = () => openConv(k);
      box.appendChild(btn);
    });
  });
  if (!any) {
    const empty = el$('div', '', '');
    empty.style.cssText = 'text-align:center;padding:2rem 1rem;color:var(--muted)';
    empty.innerHTML = '<div style="font-size:2.5rem;margin-bottom:.75rem;opacity:.5">💬</div><div style="font-size:.88rem;line-height:1.5">No chats yet.<br>Join a community, create a group, or start a DM below.</div>';
    box.appendChild(empty);
  }
}

// ---------- render message log ----------
function renderLog(log, c, list) {
  log.innerHTML = '';
  if (!c) {
    const empty = el$('div', 'nx-empty');
    empty.innerHTML = '<span class="nx-empty-icon">👋</span><div style="font-size:1rem;font-weight:600;margin-bottom:.35rem">Welcome to Khel Chat</div><div style="font-size:.88rem">Pick a conversation or start a new one.</div>';
    log.appendChild(empty);
    return;
  }
  if (!list.length) {
    const empty = el$('div', 'nx-empty');
    empty.innerHTML = '<span class="nx-empty-icon">✨</span><div style="font-size:1rem;font-weight:600;margin-bottom:.35rem">No messages yet</div><div style="font-size:.88rem">Be the first to say something!</div>';
    log.appendChild(empty);
    return;
  }
  let lastSender = null;
  list.forEach((m) => {
    const wrap = el$('div', 'nx-msg-wrap' + (m.mine ? ' mine' : ''));
    const prof = m.from ? getProfile(m.from) : { name: m.name || '?', avatarUrl: m.avatar || '' };
    const displayName = prof.name || m.name || m.from?.slice(0, 8) || '?';
    const displayAvatar = prof.avatarUrl || m.avatar || '';
    const sameSender = m.from === lastSender;
    lastSender = m.from;

    // avatar
    if (!m.mine) {
      const avEl = el$('div', 'nx-msg-avatar');
      if (sameSender) { avEl.style.visibility = 'hidden'; }
      if (displayAvatar && !displayAvatar.startsWith('emoji:')) {
        const img = document.createElement('img'); img.src = displayAvatar; img.alt = displayName;
        avEl.appendChild(img);
      } else if (displayAvatar?.startsWith('emoji:')) {
        avEl.textContent = displayAvatar.slice(6);
      } else {
        avEl.textContent = initialsFor(displayName);
      }
      avEl.title = displayName;
      avEl.onclick = () => showProfilePopup(m.from);
      wrap.appendChild(avEl);
    }

    // body
    const body = el$('div', 'nx-msg-body');
    if (!m.mine && c.type === 'g' && !sameSender) {
      const sender = el$('div', 'nx-msg-sender');
      sender.appendChild(el$('span', 'nx-msg-sender-name', displayName));
      if (m.time) sender.appendChild(el$('span', 'nx-msg-time', fmtTime(m.time)));
      body.appendChild(sender);
    }
    const bubble = el$('div', 'nx-msg');
    bubble.textContent = m.text;
    body.appendChild(bubble);
    if (m.time && (m.mine || c.type === 'd' || sameSender)) {
      body.appendChild(el$('div', 'nx-msg-time-below', fmtTime(m.time)));
    }
    wrap.appendChild(body);
    log.appendChild(wrap);
  });
}

// ---------- mount chats ----------
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
    profileCache[S.myId] = { ...profileCache[S.myId], name: value };
    say('Profile updated ✓');
  };
  ui.upload.onchange = () => {
    const file = ui.upload.files?.[0];
    if (!file) return;
    if (file.size > 2000000) return say('Choose an image under 2 MB.', true);
    const reader = new FileReader();
    reader.onload = () => {
      S.photo = String(reader.result);
      localStorage.setItem('khel_profile_photo_' + S.myId, S.photo);
      profileCache[S.myId] = { ...profileCache[S.myId], avatarUrl: S.photo };
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
      profileCache[S.myId] = { ...profileCache[S.myId], avatarUrl: S.photo };
      update();
    };
    ui.avatars.appendChild(button);
  });
  ui.copy.onclick = async () => { try { await navigator.clipboard.writeText(S.myId); say('Your ID copied ✓'); } catch { say('Your id: ' + S.myId); } };
  ui.open.onclick = () => { const v = ui.peer.value.trim(); if (v) { openDirect(v); ui.peer.value = ''; } };
  ui.peer.onkeydown = (e) => { if (e.key === 'Enter') ui.open.click(); };
  ui.create.onclick = async () => { const v = ui.gname.value.trim(); if (v && await createGroup(v)) ui.gname.value = ''; };
  ui.join.onclick = async () => { const v = ui.gid.value.trim(); if (v && await joinGroup(v)) ui.gid.value = ''; };
  ui.leave.onclick = () => leaveActive();
  ui.copygid.onclick = async () => { const c = S.convos[S.active]; if (!c) return; try { await navigator.clipboard.writeText(c.id); say('Group ID copied ✓'); } catch { say('Group id: ' + c.id); } };
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

    // update avatar in sidebar
    const newAv = makeAvatarEl(S.photo, S.name, 'nx-avatar');
    newAv.dataset.r = 'avatar';
    ui.avatar.replaceWith(newAv); ui.avatar = newAv;

    renderList(ui.list);
    const c = S.convos[S.active], list = S.msgs[S.active] || [];
    if (c) {
      ui.headEmoji.textContent = c.emoji || (c.type === 'g' ? '#' : '');
      ui.title.textContent = c.type === 'd' ? 'Chat with ' + (getProfile(c.id)?.name || c.name) : c.name;
    } else {
      ui.headEmoji.textContent = '';
      ui.title.textContent = 'Pick a chat';
    }
    ui.actions.hidden = !(c && c.type === 'g');
    ui.copygid.hidden = isCommunity(c);
    ui.leave.textContent = isCommunity(c) ? '🚪 Leave' : '🚪 Leave';
    ui.text.disabled = ui.send.disabled = !c;
    renderLog(ui.log, c, list);
    if (S.active !== lastKey || list.length !== lastCount) ui.log.scrollTop = ui.log.scrollHeight;
    lastKey = S.active; lastCount = list.length;
  };
  subs.add(update); host.__nx = update; update();
}

// ---------- mount communities ----------
function mountCommunities(host, openChats) {
  unmount(host);
  host.innerHTML = `<div class="nx"><div class="nx-commhead"><div><h2>Communities</h2>
<p>Real rooms where players talk right now. Pick a sport and jump in.</p></div><p data-r="s" role="status"></p></div><div class="nx-grid" data-r="grid"></div></div>`;
  const st = host.querySelector('[data-r="s"]'), grid = host.querySelector('[data-r="grid"]');
  const update = () => {
    st.textContent = S.phase === 'in' ? '' : S.note; st.className = statusClass();
    grid.innerHTML = '';
    COMMUNITIES.forEach((c) => {
      const joined = !!S.convos[keyOf('g', c.id)];
      const card = el$('article', 'nx-card nx-comm');
      card.append(el$('span', 'em', c.emoji), el$('h3', '', c.name), el$('p', '', c.blurb));
      const b = el$('button', 'nx-btn', joined ? '💬 Open chat' : S.phase === 'in' ? '🤝 Join chat' : '🔑 Sign in & join');
      b.disabled = S.phase === 'connecting';
      b.onclick = async () => { if (await joinCommunity(c) && openChats) openChats(); };
      card.appendChild(b); grid.appendChild(card);
    });
  };
  subs.add(update); host.__nx = update; update();
}

window.NexChat = { mountChats, mountCommunities, unmount };
window.dispatchEvent(new Event('nexchat-ready'));
