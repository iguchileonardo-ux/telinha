// Telinha: Turmas, chat, call, telas, reações, rádio e configurações.
import { TurmaSession, normalizeServerUrl } from './turma.js';
import { loadSettings, saveSettings, takeLegacyRecent } from './settings.js';
import { newRoomCode, inviteLink, parseRoomCode } from './codes.js';
import { captureScreen, stopCapture } from './capture.js';
import { renderIcons } from './icons.js';
import { prepareAvatar, pickFile, hashData } from './images.js';
import * as store from './store.js';
import {
  $, h, icon, bridge, toast, copyText, readClipboard, hue, initials, avatar,
  preloadImages, rememberImage, showPopover, closePopover, typing,
} from './ui/dom.js';
import { ChatView } from './ui/chat.js';
import { CallView } from './ui/call.js';
import { Reactions } from './ui/reactions.js';
import { Radio, youtubeId } from './ui/radio.js';
import { Members } from './ui/members.js';
import { listDevices, setSpeaker, micConstraints } from './devices.js';
import { watchLevel } from './audio.js';
import { createAlerts } from './alerts.js';

let settings = loadSettings();
const alerts = createAlerts(() => settings);
let appVersion = '';
let turmas = [];
let current = null; // Turma aberta
let session = null;
let tab = 'chat';
let unread = false;
let dismissedInvite = null;
let pendingCode = null;
let starting = false;
let updateReady = null;
let pendingAvatar; // undefined = sem mudança, '' = remover, string = nova foto
const reportedErrors = new Set();

// ---------- registro de diagnóstico ----------
// Texto simples gravado no PC (diagnostico.txt). Abre clicando na versão, no
// rodapé das configurações. Não guarda mensagens nem o código das turmas.

const diagBuffer = [];
function diag(text) {
  if (!bridge?.writeLog) return;
  diagBuffer.push(`[${new Date().toLocaleString('sv-SE')}] ${text}`);
  if (diagBuffer.length > 400) diagBuffer.splice(0, diagBuffer.length - 400);
  if (diagBuffer.length >= 50) flushDiag();
}
function flushDiag() {
  if (!bridge?.writeLog || !diagBuffer.length) return;
  bridge.writeLog(diagBuffer.splice(0, 200)).catch(() => {});
}

function pushPrefs() {
  if (!bridge?.setPrefs) return;
  bridge.setPrefs({ notifications: settings.notifications, tray: settings.tray, autostart: settings.autostart })
    .then((state) => alerts.setDnd(state?.dnd))
    .catch(() => {});
}

// ---------- serviços compartilhados ----------

const app = {
  uid: settings.userId,
  session: () => session,
  turma: () => current,
  settings: () => settings,
  name: () => settings.name || 'Sem nome',
  saveSettings: (patch) => { settings = { ...settings, ...patch }; saveSettings(settings); },
  saveVolume: (key, v) => {
    settings = { ...settings, volumes: { ...settings.volumes, [key]: v } };
    saveSettings(settings);
    scheduleRender();
  },
  member: (uid) => {
    if (uid === settings.userId) return { name: settings.name || 'Você', hash: session?.avatarHash || '' };
    const peer = session?.peerByUid(uid);
    if (peer) return { name: peer.name, hash: peer.avatar };
    const m = current?.members?.[uid];
    return m ? { name: m.name, hash: m.avatar } : null;
  },
  speakingSet: () => call.speaking,
  speaking: () => call.speaking.size > 0,
  onSpeakingChange: () => scheduleRender(),
  toggleShare: () => toggleShare(),
  send: (text) => session?.sendMessage(text),
  pin: (msg) => session?.setMeta({ pinned: { id: msg.id, text: msg.text, name: msg.name } }),
  unpin: () => session?.setMeta({ pinned: null }),
  command: async (text) => {
    const m = text.match(/^\/(tocar|play|radio)\s+(.+)/i);
    if (!m) {
      // Um link do YouTube sozinho, com /tocar implícito? Não: só com o comando.
      return false;
    }
    await radio.add(m[2]);
    return true;
  },
  onRadioChange: () => scheduleRender(),
};

const chat = new ChatView(app);
const call = new CallView(app);
const reactions = new Reactions(app);
const radio = new Radio(app);
const members = new Members(app);

// ---------- aparência ----------

function resolvedTheme() {
  if (settings.theme === 'system') return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return settings.theme === 'light' ? 'light' : 'dark';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  bridge?.setTheme(theme).catch(() => {});
}
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (settings.theme === 'system') applyTheme(); });

// ---------- renderização ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  renderRail();
  const hasTurma = !!current;
  $('welcome').hidden = hasTurma;
  $('turmaTitle').hidden = !hasTurma;
  $('tabs').hidden = !hasTurma;
  $('membersBtn').hidden = !hasTurma;
  $('inviteBtn').hidden = !hasTurma;
  $('chatView').hidden = !hasTurma || tab !== 'chat';
  $('callView').hidden = !hasTurma || tab !== 'call';
  document.body.dataset.screen = hasTurma ? tab : 'welcome';
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  if (!hasTurma) return;

  $('turmaName').textContent = turmaName(current);
  $('signalDot').classList.toggle('online', !!session?.signalingOnline);
  $('turmaTitle').title = session?.signalingOnline ? 'Conectado' : 'Conectando à rede';
  $('chatDot').hidden = !unread || tab === 'chat';
  const peers = session ? [...session.peers.values()] : [];
  const someoneSharing = peers.some((p) => p.inCall && p.sharing);
  const someoneInCall = peers.some((p) => p.inCall) || session?.inCall;
  $('callDot').hidden = !someoneInCall || tab === 'call';
  $('callDot').classList.toggle('live', someoneSharing);
  $('radioBtn').classList.toggle('active', radio.active);
  $('radioBtn').title = radio.state.current ? `Rádio: ${radio.state.current.title}` : 'Rádio';
  members.renderButton();
  call.render();
}

function turmaName(t) {
  return t?.name || 'Nova turma';
}

function renderRail() {
  const list = $('railList');
  list.replaceChildren(...turmas.map((t) => {
    const btn = h(`button.rail-item${current?.code === t.code ? '.active' : ''}`, {
      type: 'button',
      title: turmaName(t),
      'aria-label': turmaName(t),
      on: {
        click: () => openTurma(t.code),
        contextmenu: (e) => { e.preventDefault(); openTurmaMenu(t, btn); },
      },
    }, initials(turmaName(t)));
    btn.style.setProperty('--h', hue(t.code));
    return btn;
  }));
}

// ---------- Turmas ----------

function ensureName() {
  if (settings.name.trim()) return true;
  current = null;
  render();
  const input = $('nameInput');
  input.focus();
  input.classList.add('attention');
  setTimeout(() => input.classList.remove('attention'), 1200);
  toast('Escolha um nome antes de entrar.');
  return false;
}

async function refreshTurmas() {
  turmas = (await store.listTurmas()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

async function createTurma() {
  if (!ensureName()) return;
  const code = newRoomCode();
  const turma = { ...store.newTurma(code, `Turma de ${settings.name}`), nameTs: Date.now() };
  await store.saveTurma(turma);
  await refreshTurmas();
  await openTurma(code);
  const ok = await copyText(inviteLink(code));
  dismissedInvite = code;
  toast(ok ? 'Turma criada. O convite já foi copiado.' : 'Turma criada.');
}

async function joinByCode(code) {
  if (!ensureName()) { pendingCode = code; return; }
  $('suggest').hidden = true;
  const isNew = !turmas.some((t) => t.code === code);
  if (isNew) {
    await store.saveTurma(store.newTurma(code, ''));
    await refreshTurmas();
  }
  await openTurma(code);
  if (isNew) {
    // Ao entrar por convite, avisa se ninguém da turma estiver online.
    setTimeout(() => {
      if (session?.code === code && session.peers.size === 0) {
        toast('Ninguém da turma está online agora. Vocês se conectam assim que outra pessoa abrir a Telinha.', 6000);
      }
    }, 20000);
  }
}

// ---------- conexão ----------

let openToken = 0;
let serverInfo = null;
const nostrFallback = new Set(); // turmas que, nesta execução, usam os relays públicos

// Decide como a turma se conecta: servidor da Telinha (com TURN) ou relays públicos.
async function networkConfig(code) {
  if (settings.signaling === 'server') return { builtinServer: null, extraIce: await turnServers() };
  serverInfo ??= bridge ? await bridge.appInfo().catch(() => null) : (window.__telinhaServer || null);
  const server = serverInfo?.server || '';
  return {
    builtinServer: server && !nostrFallback.has(code) ? server : null,
    extraIce: await turnServers(),
  };
}

async function turnServers() {
  try {
    if (bridge?.turnServers) return (await bridge.turnServers()) || [];
    return window.__telinhaServer?.iceServers || [];
  } catch {
    return [];
  }
}

// Se o servidor da Telinha não responder, usa os relays públicos nesta turma.
function watchBuiltin(s) {
  if (s.mode !== 'builtin') return;
  setTimeout(() => {
    if (session !== s || s.signalingOnline || s.peers.size) return;
    nostrFallback.add(s.code);
    const code = s.code;
    closeSession().then(() => openTurma(code));
  }, 12000);
}

async function openTurma(code) {
  if (!ensureName()) { pendingCode = code; return; }
  pendingCode = null;
  closePopover();
  if (session?.code === code) { render(); return; }
  await closeSession();

  const turma = turmas.find((t) => t.code === code);
  if (!turma) return;
  const token = ++openToken;
  const network = await networkConfig(code);
  // Outra turma foi aberta enquanto as credenciais chegavam.
  if (token !== openToken || session) return;
  let next;
  try {
    next = new TurmaSession({ code, settings, ...network });
  } catch (error) {
    toast(error.message);
    openSettings();
    return;
  }
  session = next;
  current = turma;
  tab = 'chat';
  unread = false;
  reportedErrors.clear();
  app.saveSettings({ lastTurma: code });
  if (settings.avatar) session.avatarHash = await hashData(settings.avatar);
  await store.updateTurma(code, (t) => ({
    lastOpened: Date.now(),
    members: { ...t.members, [settings.userId]: { name: settings.name, avatar: session.avatarHash, lastSeen: Date.now() } },
  }));

  wireSession(session);
  diag(`Sessão iniciada na turma "${turma.name || 'sem nome'}", versão ${appVersion || 'desconhecida'}, modo ${session.mode || 'desconhecido'}.`);
  watchBuiltin(session);
  call.attach(session);
  radio.attach(session);
  await preloadImages(Object.values(turma.members || {}).map((m) => m.avatar));
  await chat.load(code);
  chat.setPinned(turma);
  await reactions.refresh(code);
  render();
}

async function closeSession() {
  const old = session;
  if (!old) return;
  session = null;
  diag('Sessão encerrada.');
  flushDiag();
  endShareExtras();
  call.detach();
  radio.detach();
  await old.leave();
}

function wireSession(s) {
  const mine = (fn) => (e) => { if (session === s) fn(e.detail); };
  s.addEventListener('peers', mine(() => scheduleRender()));
  s.addEventListener('call', mine(() => scheduleRender()));
  s.addEventListener('signaling', mine(() => scheduleRender()));
  s.addEventListener('notice', mine((d) => toast(d.text, 5000)));
  s.addEventListener('share', mine((d) => {
    if (!d.sharing) endShareExtras();
    scheduleRender();
  }));
  s.addEventListener('messages', mine((d) => {
    chat.append(d.messages);
    if (tab !== 'chat' && d.messages.some((m) => m.uid !== settings.userId)) unread = true;
    // Histórico recebido ao entrar não avisa: só mensagens de agora.
    const incoming = d.messages.filter((m) => m.uid !== settings.userId && Date.now() - (m.ts || 0) < 20000);
    if (incoming.length) {
      if (tab !== 'chat' || !document.hasFocus()) alerts.sound('message');
      const last = incoming[incoming.length - 1];
      alerts.notify({ title: last.name || 'Telinha', body: last.text, tab: 'chat', flash: true });
    }
    scheduleRender();
  }));
  s.addEventListener('log', mine((d) => diag(d.text)));
  s.addEventListener('peer-call', mine((d) => {
    if (session?.inCall) alerts.sound(d.inCall ? 'join' : 'leave');
    if (d.inCall) alerts.notify({ title: current?.name || 'Telinha', body: `${d.peer.name || 'Alguém'} entrou na call`, tab: 'call' });
  }));
  s.addEventListener('started-sharing', mine((d) => {
    alerts.sound('share');
    alerts.notify({ title: current?.name || 'Telinha', body: `${d.peer.name || 'Alguém'} começou a transmitir`, tab: 'call' });
  }));
  s.addEventListener('meta', mine((d) => {
    current = d.turma;
    turmas = turmas.map((t) => (t.code === d.turma.code ? d.turma : t));
    chat.setPinned(current);
    scheduleRender();
  }));
  s.addEventListener('gallery', mine(() => reactions.refresh(s.code)));
  s.addEventListener('image', mine(async (d) => {
    await preloadImages([d.hash]);
    await reactions.refresh(s.code);
    chat.render();
    scheduleRender();
  }));
  s.addEventListener('reaction', mine((d) => reactions.show(d)));
  s.addEventListener('member', mine(async (d) => {
    if (!d.uid) return;
    const prev = current?.members?.[d.uid];
    if (prev && prev.name === d.name && prev.avatar === d.avatar && Date.now() - (prev.lastSeen || 0) < 60000) return;
    const turma = await store.updateTurma(s.code, (t) => ({ members: { ...t.members, [d.uid]: { name: d.name, avatar: d.avatar, lastSeen: Date.now() } } }));
    if (turma && session === s) {
      current = turma;
      turmas = turmas.map((t) => (t.code === turma.code ? turma : t));
      if (prev?.name !== d.name || prev?.avatar !== d.avatar) chat.render();
    }
  }));
  s.addEventListener('join-error', mine((d) => {
    const id = d?.peerId || 'geral';
    if (reportedErrors.has(id)) return;
    reportedErrors.add(id);
    const name = s.peers.get(id)?.name;
    toast(`Não foi possível conectar${name ? ` com ${name}` : ''}. Se continuar, configure um servidor TURN.`, 6000);
  }));
}

function setTab(next) {
  tab = next;
  if (tab === 'chat') { unread = false; chat.scrollToEnd(); }
  render();
}

// ---------- menu da Turma ----------

function openTurmaMenu(turma, anchor) {
  const menu = $('turmaMenu');
  const renameForm = h('form.join.compact', {
    hidden: true,
    autocomplete: 'off',
    on: {
      submit: async (e) => {
        e.preventDefault();
        const name = e.target.querySelector('input').value.trim().slice(0, 40);
        if (!name) return;
        closePopover();
        if (session?.code === turma.code) await session.setMeta({ name });
        else await store.updateTurma(turma.code, () => ({ name, nameTs: Date.now() }));
        await refreshTurmas();
        current = turmas.find((t) => t.code === current?.code) || current;
        render();
      },
    },
  }, h('input', { value: turma.name || '', maxlength: '40', 'aria-label': 'Nome da turma' }), h('button.btn.small', { type: 'submit' }, 'Salvar'));
  menu.replaceChildren(
    h('div.pop-title', {}, turmaName(turma)),
    h('button.menu-item', { type: 'button', on: { click: () => { renameForm.hidden = false; renameForm.querySelector('input').select(); } } }, icon('edit', 16), 'Renomear'),
    renameForm,
    h('button.menu-item', { type: 'button', on: { click: async () => { closePopover(); const ok = await copyText(inviteLink(turma.code)); toast(ok ? 'Convite copiado.' : inviteLink(turma.code)); } } }, icon('link', 16), 'Copiar convite'),
    h('button.menu-item.danger', { type: 'button', on: { click: () => leaveTurma(turma) } }, icon('leave', 16), 'Sair da turma'),
  );
  showPopover(menu, anchor, { place: anchor.closest('.rail') ? 'right' : 'below', align: 'start' });
}

async function leaveTurma(turma) {
  closePopover();
  if (!window.confirm(`Sair da turma "${turmaName(turma)}"? O histórico salvo neste computador será apagado. Você pode voltar com o convite.`)) return;
  if (session?.code === turma.code) { await closeSession(); current = null; }
  await store.removeTurma(turma.code);
  await refreshTurmas();
  if (turmas[0]) await openTurma(turmas[0].code);
  else render();
}

// ---------- compartilhar ----------

const AUDIO_LABEL = {
  window: 'áudio da janela',
  system: 'áudio do PC',
  'system-echo': 'áudio do PC',
  browser: 'com áudio',
};

function endShareExtras() {
  stopCapture();
  bridge?.overlayStop().catch(() => {});
  call.clearShareInfo();
}

async function toggleShare() {
  if (!session || starting) return;
  if (session.sharing) { session.stopShare(); return; }
  starting = true;
  const s = session;
  try {
    const result = await captureScreen({ quality: settings.quality, audio: settings.shareAudio, lastSource: settings.lastSource });
    if (!result) return;
    if (s !== session) { result.stream.getTracks().forEach((t) => t.stop()); stopCapture(); return; }
    await s.startShare(result.stream, { kind: result.kind, label: result.label });
    app.saveSettings({ lastSource: result.source ? { name: result.source.name, kind: result.kind === 'audio' ? 'audio' : result.source.kind } : null });
    if (result.sourceId) bridge?.overlayStart(result.sourceId).catch(() => {});
    const what = result.kind === 'audio' ? 'Tocando só o som' : `Ao vivo · ${AUDIO_LABEL[result.audio] || 'sem áudio'}`;
    call.setShareInfo(what, result.stream);
    if (result.warning) toast(result.warning, 5000);
    else if (result.audio === 'system-echo') toast('Áudio do PC inteiro: se você estiver ouvindo alguém, pode dar eco.', 5000);
    if (tab !== 'call') setTab('call');
  } catch (error) {
    stopCapture();
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
      toast(error?.message && !/getDisplayMedia/.test(error.message) ? error.message : 'Não foi possível capturar a tela.');
      console.error(error);
    }
  } finally {
    starting = false;
    scheduleRender();
  }
}

// ---------- configurações ----------

const QUALITY_HINT = {
  detail: 'Ideal para texto, código e navegação. Até 30 quadros por segundo.',
  motion: 'Ideal para jogos. Até 60 quadros por segundo, usa mais internet.',
  movie: 'Ideal para filmes: 24 quadros por segundo, som estéreo e um pouco mais de buffer para não travar.',
};
const SIGNALING_HINT = {
  auto: 'Usa o servidor da Telinha para encontrar seus amigos e, se ele estiver fora do ar, relays públicos. Não precisa configurar nada.',
  server: 'Usa o seu servidor de sinalização. Todos na turma precisam usar o mesmo.',
};

function segmented(root, value) {
  for (const b of root.querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === value);
}
function segmentedValue(root) {
  return root.querySelector('button.active')?.dataset.value;
}

function syncSettingsHints() {
  $('qualityHint').textContent = QUALITY_HINT[segmentedValue($('setQuality'))] || '';
  const signaling = segmentedValue($('setSignaling'));
  $('signalingHint').textContent = SIGNALING_HINT[signaling] || '';
  $('setServer').hidden = signaling !== 'server';
}

function renderAvatarPick(el, data, name) {
  el.replaceChildren();
  el.style.setProperty('--h', hue(settings.userId));
  if (data) el.append(h('img', { src: data, alt: '' }));
  else el.append(h('span', {}, name ? initials(name) : ''), h('span.avatar-pick-plus', {}, icon('camera', 14)));
}

async function renderAbout() {
  const about = $('about');
  const info = bridge ? await bridge.appInfo().catch(() => null) : null;
  const parts = [h('span.about-version', {
    title: bridge ? 'Abrir o registro de diagnóstico' : '',
    on: { click: () => bridge?.openLog?.() },
  }, `Telinha ${info?.version || ''}`.trim())];
  if (updateReady || info?.updateReady) {
    parts.push(h('button.btn.primary.small', { type: 'button', on: { click: () => bridge?.installUpdate() } }, 'Reiniciar e atualizar'));
  } else if (info?.packaged) {
    parts.push(h('small', {}, info.updates ? 'Atualizações automáticas ativadas.' : 'Atualizações automáticas não configuradas.'));
  }
  about.replaceChildren(...parts);
}

function fillSelect(select, list, value) {
  const options = [h('option', { value: '' }, 'Padrão do sistema'), ...list.map((d) => h('option', { value: d.id, title: d.name, dataset: { label: d.label } }, d.name))];
  if (value && !list.some((d) => d.id === value)) options.push(h('option', { value }, 'Dispositivo desconectado'));
  select.replaceChildren(...options);
  select.value = value || '';
}

async function fillDevices(keepSelection = false) {
  const { inputs, outputs } = await listDevices();
  fillSelect($('setMic'), inputs, keepSelection ? $('setMic').value : settings.micId);
  fillSelect($('setSpeaker'), outputs, keepSelection ? $('setSpeaker').value : settings.speakerId);
}

// Barrinha de nível do microfone nas configurações.
let micTest = null;
async function startMicTest() {
  stopMicTest();
  const id = $('setMic').value;
  const token = {};
  micTest = token;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(id), video: false });
  } catch {
    return;
  }
  if (micTest !== token || !$('settings').open) { stream.getTracks().forEach((t) => t.stop()); return; }
  const bar = $('micMeter').firstElementChild;
  const stop = watchLevel(stream, (level) => { bar.style.transform = `scaleX(${level.toFixed(3)})`; });
  token.stop = () => { stop(); stream.getTracks().forEach((t) => t.stop()); bar.style.transform = 'scaleX(0)'; };
}
function stopMicTest() {
  micTest?.stop?.();
  micTest = null;
}

function openSettings() {
  pendingAvatar = undefined;
  $('setName').value = settings.name;
  renderAvatarPick($('setAvatar'), settings.avatar, settings.name);
  $('removeAvatar').hidden = !settings.avatar;
  segmented($('setTheme'), settings.theme);
  segmented($('setQuality'), settings.quality);
  segmented($('setSignaling'), settings.signaling);
  $('setServer').value = settings.serverUrl;
  $('setTurnUrl').value = settings.turnUrl;
  $('setTurnUser').value = settings.turnUser;
  $('setTurnPass').value = settings.turnPass;
  $('connDetails').open = settings.signaling !== 'auto' || !!settings.turnUrl;
  $('appField').hidden = !bridge;
  $('setNotify').checked = settings.notifications;
  $('setSounds').checked = settings.sounds;
  $('setTray').checked = settings.tray;
  $('setAutostart').checked = settings.autostart;
  syncSettingsHints();
  renderAbout();
  fillDevices().then(startMicTest);
  $('settings').showModal();
}

async function chooseAvatar(target) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return null;
  try {
    const data = await prepareAvatar(file);
    renderAvatarPick(target, data, settings.name);
    return data;
  } catch {
    toast('Não foi possível usar essa imagem.');
    return null;
  }
}

async function applyAvatar(data) {
  settings = { ...settings, avatar: data || '' };
  saveSettings(settings);
  let hash = '';
  if (data) {
    hash = await hashData(data);
    rememberImage(hash, data);
    await store.putImage(hash, data);
  }
  if (session) {
    session.updateProfile({ avatarHash: hash });
    await store.updateTurma(session.code, (t) => ({ members: { ...t.members, [settings.userId]: { name: settings.name, avatar: hash, lastSeen: Date.now() } } }));
  }
  renderAvatarPick($('welcomeAvatar'), settings.avatar, settings.name);
  chat.render();
  scheduleRender();
}

async function saveSettingsFromDialog() {
  const next = {
    ...settings,
    name: $('setName').value.trim().slice(0, 32),
    theme: segmentedValue($('setTheme')) || 'dark',
    quality: segmentedValue($('setQuality')) || 'detail',
    signaling: segmentedValue($('setSignaling')) || 'auto',
    serverUrl: $('setServer').value.trim(),
    turnUrl: $('setTurnUrl').value.trim(),
    turnUser: $('setTurnUser').value.trim(),
    turnPass: $('setTurnPass').value,
    micId: $('setMic').value,
    speakerId: $('setSpeaker').value,
    speakerLabel: $('setSpeaker').value ? $('setSpeaker').selectedOptions[0]?.dataset.label || '' : '',
    ...(bridge ? {
      notifications: $('setNotify').checked,
      sounds: $('setSounds').checked,
      tray: $('setTray').checked,
      autostart: $('setAutostart').checked,
    } : {}),
  };
  if (!next.name) { toast('O nome não pode ficar vazio.'); $('setName').focus(); return; }
  if (next.signaling === 'server' && !normalizeServerUrl(next.serverUrl)) {
    toast('Informe um endereço válido para o servidor, por exemplo wss://meu-servidor.onrender.com');
    $('setServer').focus();
    return;
  }
  if (next.turnUrl && !/^turns?:/i.test(next.turnUrl)) {
    toast('O endereço TURN deve começar com turn: ou turns:');
    $('setTurnUrl').focus();
    return;
  }
  const connectionChanged = ['signaling', 'serverUrl', 'turnUrl', 'turnUser', 'turnPass'].some((k) => next[k] !== settings[k]);
  const nameChanged = next.name !== settings.name;
  const micChanged = next.micId !== settings.micId;
  const speakerChanged = next.speakerId !== settings.speakerId;
  settings = next;
  saveSettings(settings);
  pushPrefs();
  applyTheme();
  $('nameInput').value = settings.name;
  $('settings').close();
  if (pendingAvatar !== undefined) await applyAvatar(pendingAvatar);
  if (session) {
    if (nameChanged) session.updateProfile({ name: settings.name });
    session.setQuality(settings.quality);
    if (micChanged) session.setMicDevice(settings.micId);
  }
  if (speakerChanged) setSpeaker(settings.speakerId, settings.speakerLabel);
  toast(connectionChanged && session ? 'As mudanças de conexão valem a partir da próxima vez que você abrir a turma.' : 'Configurações salvas.', connectionChanged ? 4500 : 2500);
  scheduleRender();
}

// ---------- área de transferência ----------

async function checkClipboard() {
  const code = parseRoomCode(await readClipboard(), { strict: true });
  const show = !!code && code !== dismissedInvite && !turmas.some((t) => t.code === code);
  $('suggest').hidden = !show;
  if (show) $('suggestCode').textContent = code;
}

// ---------- inicialização ----------

function bind() {
  const nameInput = $('nameInput');
  nameInput.value = settings.name;
  nameInput.addEventListener('input', () => {
    settings = { ...settings, name: nameInput.value.trim().slice(0, 32) };
    saveSettings(settings);
    renderAvatarPick($('welcomeAvatar'), settings.avatar, settings.name);
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && pendingCode && settings.name) joinByCode(pendingCode);
  });
  $('welcomeAvatar').addEventListener('click', async () => {
    const data = await chooseAvatar($('welcomeAvatar'));
    if (data) applyAvatar(data);
  });
  $('createBtn').addEventListener('click', createTurma);
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = parseRoomCode($('joinInput').value);
    if (!code) { toast('Convite inválido. Ele se parece com telinha://sala/abcd-efgh-jkmn'); return; }
    $('joinInput').value = '';
    joinByCode(code);
  });

  // barra de turmas
  $('railAdd').addEventListener('click', () => {
    if (!current && !turmas.length) { $('createBtn').focus(); return; }
    showPopover($('addPop'), $('railAdd'), { place: 'right', align: 'start' });
    $('addJoinInput').focus();
  });
  $('addCreate').addEventListener('click', () => { closePopover(); createTurma(); });
  $('addJoinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = parseRoomCode($('addJoinInput').value);
    if (!code) { toast('Convite inválido.'); return; }
    $('addJoinInput').value = '';
    closePopover();
    joinByCode(code);
  });
  $('turmaTitle').addEventListener('click', () => current && openTurmaMenu(current, $('turmaTitle')));

  $('suggestJoin').addEventListener('click', () => {
    const code = $('suggestCode').textContent;
    if (code) joinByCode(code);
  });
  $('suggestDismiss').addEventListener('click', () => {
    dismissedInvite = $('suggestCode').textContent;
    $('suggest').hidden = true;
  });

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) setTab(btn.dataset.tab);
  });
  $('inviteBtn').addEventListener('click', async () => {
    if (!current) return;
    const ok = await copyText(inviteLink(current.code));
    dismissedInvite = current.code;
    toast(ok ? 'Convite copiado. Mande para seus amigos.' : inviteLink(current.code));
  });
  $('reactBtn').addEventListener('click', () => reactions.open($('reactBtn')));
  $('radioBtn').addEventListener('click', () => radio.open($('radioBtn')));

  // configurações
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => $('settings').close());
  $('settings').addEventListener('close', stopMicTest);
  $('setMic').addEventListener('change', startMicTest);
  $('settingsCancel').addEventListener('click', () => $('settings').close());
  $('settingsSave').addEventListener('click', saveSettingsFromDialog);
  $('setAvatar').addEventListener('click', async () => {
    const data = await chooseAvatar($('setAvatar'));
    if (data) { pendingAvatar = data; $('removeAvatar').hidden = false; }
  });
  $('removeAvatar').addEventListener('click', () => {
    pendingAvatar = '';
    renderAvatarPick($('setAvatar'), '', $('setName').value);
    $('removeAvatar').hidden = true;
  });
  for (const id of ['setTheme', 'setQuality', 'setSignaling']) {
    $(id).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      segmented($(id), btn.dataset.value);
      syncSettingsHints();
    });
  }
  $('audioToggle').addEventListener('change', (e) => {
    if (!e.target.disabled) app.saveSettings({ shareAudio: e.target.checked });
  });

  // atalhos
  document.addEventListener('keydown', (e) => {
    if (typing() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!session?.inCall) return;
    if (e.key === 'm' || e.key === 'M') { call.toggleMute(); e.preventDefault(); }
    if (tab === 'call' && /^[1-9]$/.test(e.key)) reactions.sendIndex(Number(e.key) - 1);
  });

  window.addEventListener('focus', checkClipboard);
  window.addEventListener('beforeunload', () => { session?.leave(); });
  setInterval(() => scheduleRender(), 15000);

  bridge?.onLink((link) => {
    const code = parseRoomCode(link);
    if (code) joinByCode(code);
  });
  bridge?.onDnd?.((value) => alerts.setDnd(value));
  bridge?.onNotifyClick?.((d) => { if (session) setTab(d?.tab === 'call' ? 'call' : 'chat'); });
  setInterval(flushDiag, 5000);
  window.addEventListener('beforeunload', flushDiag);
  bridge?.onUpdateReady((version) => {
    updateReady = version;
    $('updateDot').hidden = false;
    toast(`Atualização ${version} pronta. Ela será aplicada quando a Telinha reiniciar.`, 6000);
  });
}

async function migrate() {
  const legacy = takeLegacyRecent();
  if (!legacy.length) return;
  const existing = new Set((await store.listTurmas()).map((t) => t.code));
  for (const room of legacy) {
    if (existing.has(room.id)) continue;
    const name = room.people?.length ? `Turma com ${room.people.slice(0, 2).join(' e ')}` : '';
    await store.saveTurma({ ...store.newTurma(room.id, name), createdAt: room.at || Date.now() });
  }
}

async function start() {
  renderIcons();
  applyTheme();
  bind();
  if (settings.speakerId) setSpeaker(settings.speakerId, settings.speakerLabel);
  navigator.mediaDevices?.addEventListener('devicechange', () => { if ($('settings').open) fillDevices(true); });
  await migrate();
  await refreshTurmas();
  if (settings.avatar) {
    const hash = await hashData(settings.avatar);
    rememberImage(hash, settings.avatar);
    await store.putImage(hash, settings.avatar);
  }
  renderAvatarPick($('welcomeAvatar'), settings.avatar, settings.name);
  pushPrefs();
  if (bridge) bridge.appInfo().then((info) => { appVersion = info?.version || ''; if (info?.updateReady) { updateReady = info.updateReady; $('updateDot').hidden = false; } }).catch(() => {});

  const link = bridge ? await bridge.pendingLink() : new URLSearchParams(location.search).get('sala');
  const code = link ? parseRoomCode(link) : null;
  if (code) await joinByCode(code);
  else if (settings.name && turmas.length) await openTurma(turmas.find((t) => t.code === settings.lastTurma)?.code || turmas[0].code);
  else render();
  checkClipboard();
}

// Atalho para testes automatizados no navegador.
window.__telinha = { app, get session() { return session; }, radio, youtubeId };

start();
