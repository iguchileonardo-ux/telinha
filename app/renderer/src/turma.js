// Sessão de uma Turma: presença, chat, imagens, call de voz, telas, ponteiro,
// desenho e rádio. Tudo direto entre os computadores (WebRTC via Trystero).
//
// Sinalização:
//   - 'auto':   relays públicos da rede Nostr, sem servidor próprio;
//   - 'server': servidor WebSocket próprio (pasta server/ do projeto).
import {
  joinRoom as joinNostr,
  getRelaySockets as nostrSockets,
  selfId,
} from '@trystero-p2p/nostr';
import {
  joinRoom as joinRelay,
  getRelaySockets as relaySockets,
} from '@trystero-p2p/ws-relay';
import { iceServers } from './settings.js';
import { micConstraints } from './devices.js';
import { validImage, hashData } from './images.js';
import * as store from './store.js';

const APP_ID = 'telinha-app-v1-7d3f91c2';
const PROTOCOL = 2;

export const QUALITY = {
  detail: { frameRate: 30, maxBitrate: 6_000_000, hint: 'detail', audioBitrate: 128_000, buffer: null },
  motion: { frameRate: 60, maxBitrate: 9_000_000, hint: 'motion', audioBitrate: 128_000, buffer: null },
  movie: { frameRate: 24, maxBitrate: 4_500_000, hint: 'motion', audioBitrate: 192_000, buffer: 0.8 },
};

// ---- áudio estéreo e de alta qualidade (Opus) em todas as conexões ----
// Ajusta o SDP recebido para indicar que este lado aceita estéreo; o outro lado
// então codifica em estéreo. Vale para música, filmes e jogos.
(function patchOpusStereo() {
  if (typeof RTCPeerConnection === 'undefined' || RTCPeerConnection.prototype.__telinhaStereo) return;
  const munge = (sdp) => sdp.replace(/a=fmtp:(\d+) (.*minptime=\d+.*)/g, (line, pt, params) => {
    if (/stereo=1/.test(params)) return line;
    return `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=192000`;
  });
  const original = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (description, ...rest) {
    if (description?.sdp && description.type !== 'rollback') {
      description = { type: description.type, sdp: munge(description.sdp) };
    }
    return original.call(this, description, ...rest);
  };
  RTCPeerConnection.prototype.__telinhaStereo = true;
})();

const RATE_LIMITS = { chat: [8, 5000], react: [6, 3000], img: [40, 10000], gallery: [10, 10000], drawreq: [3, 10000], relay: [200, 5000] };

// Ponte: quando duas pessoas da turma não conseguem se conectar direto (redes
// que bloqueiam a conexão), alguém conectado às duas repassa chat, presença,
// voz e telas entre elas. Só entra em ação depois deste tempo sem conexão direta.
const BRIDGE_DELAY_MS = 8000;
const ACTIONS = ['hello', 'meta', 'chat', 'sync', 'chatbulk', 'imgget', 'img', 'gallery', 'react', 'ptr', 'stroke', 'drawreq', 'drawres', 'radio'];
const RELAYABLE = new Set(ACTIONS);
// Usado só nos testes automáticos, para simular duas pessoas sem conexão direta.
const blocked = (peerId) => !!globalThis.__telinhaBlocked?.has?.(peerId);

// Relays Nostr usados para os PCs se encontrarem. Lista fixa, testada:
// os dois primeiros eram usados pela versão 2.1.0 e continuam aqui para que
// versões antigas e novas se achem. Todos precisam aceitar eventos efêmeros.
const NOSTR_RELAYS = [
  'wss://relay-can.zombi.cloudrodion.com',
  'wss://staging.yabu.me',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.oxtr.dev',
  'wss://nostr.mom',
];

export class TurmaSession extends EventTarget {
  constructor({ code, settings }) {
    super();
    this.code = code;
    this.settings = settings;
    this.selfId = selfId;
    this.uid = settings.userId;
    this.peers = new Map();
    this.inCall = false;
    this.muted = false;
    this.micStream = null;
    this.micId = settings.micId || '';
    this.share = null; // { stream, kind: 'screen' | 'audio', mode, label, audio }
    this.drawAllow = new Set();
    this.quality = settings.quality in QUALITY ? settings.quality : 'detail';
    this.avatarHash = '';
    this.signalingOnline = false;
    this.closed = false;
    this.sent = new Map(); // streamId -> Set(peerId) para quem a stream já foi enviada
    this.rate = new Map();
    this.radio = { v: 0, by: '', queue: [], current: null };
    this.forwards = new Map(); // streams repassadas pela ponte
    this.pairSince = new Map();
    this.indirectSince = new Map();
    this.pendingRelayStreams = new Map();

    const config = {
      appId: APP_ID,
      password: `telinha:${code}`,
      rtcConfig: { iceServers: iceServers(settings) },
    };
    const callbacks = { onJoinError: (details) => this.#emit('join-error', details) };

    if (settings.signaling === 'server') {
      const url = normalizeServerUrl(settings.serverUrl);
      if (!url) throw new Error('Informe o endereço do servidor próprio nas configurações.');
      this.mode = 'server';
      this.room = joinRelay({ ...config, relayConfig: { urls: [url] } }, code, callbacks);
      this.sockets = relaySockets;
    } else {
      this.mode = 'auto';
      this.room = joinNostr({ ...config, relayConfig: { urls: NOSTR_RELAYS, warnOnRelayFailure: false } }, code, callbacks);
      this.sockets = nostrSockets;
    }

    this.actions = {};
    for (const name of [...ACTIONS, 'relay']) {
      const action = this.room.makeAction(name);
      action.onMessage = (data, ctx) => {
        if (this.closed || blocked(ctx.peerId)) return;
        if (!this.#allowed(ctx.peerId, name)) return;
        try {
          if (name === 'relay') this.#onRelay(data, ctx.peerId);
          else this.#handle(name, data, ctx.peerId);
        } catch (error) { console.warn(`Mensagem inválida (${name}):`, error); }
      };
      this.actions[name] = action;
    }

    this.room.onPeerJoin = (peerId) => this.#onJoin(peerId);
    this.room.onPeerLeave = (peerId) => this.#onLeave(peerId);
    this.room.onPeerStream = (stream, peerId, metadata) => this.#onStream(stream, peerId, metadata);

    this.timer = setInterval(() => this.#tick(), 2000);
    this.#tick();
  }

  // ================= API pública =================

  get name() {
    return this.settings.name.trim() || 'Sem nome';
  }

  get sharing() {
    return !!this.share;
  }

  get localStream() {
    return this.share?.stream || null;
  }

  peerByUid(uid) {
    for (const p of this.peers.values()) if (p.uid === uid) return p;
    return null;
  }

  updateProfile({ name, avatarHash }) {
    if (name !== undefined) this.settings = { ...this.settings, name };
    if (avatarHash !== undefined) this.avatarHash = avatarHash;
    this.#broadcastHello();
  }

  setQuality(quality) {
    if (!(quality in QUALITY)) return;
    this.quality = quality;
    if (this.share) {
      this.share.mode = quality;
      this.#applyQuality();
      this.#broadcastHello();
    }
  }

  // ---- call ----

  async joinCall({ withMic = true } = {}) {
    if (this.closed) return;
    this.inCall = true;
    this.muted = !withMic;
    if (withMic) await this.#ensureMic();
    this.#syncStreams();
    this.#broadcastHello();
    this.#emit('call', { inCall: true });
  }

  leaveCall() {
    if (!this.inCall) return;
    this.stopShare();
    this.inCall = false;
    if (this.micStream) {
      this.#retireStream(this.micStream);
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.#broadcastHello();
    this.#emit('call', { inCall: false });
  }

  async setMuted(muted) {
    this.muted = muted;
    if (!muted && !this.micStream) await this.#ensureMic();
    this.micStream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.#syncStreams();
    this.#broadcastHello();
    this.#emit('call', { inCall: this.inCall });
  }

  async #ensureMic() {
    if (this.micStream) return;
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(this.micId), video: false });
      } catch (error) {
        if (!this.micId) throw error;
        // Microfone escolhido desconectado: usa o padrão do sistema.
        stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(''), video: false });
        this.#emit('notice', { text: 'O microfone escolhido não foi encontrado. Usando o padrão do sistema.' });
      }
      if (this.closed || !this.inCall) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.micStream = stream;
      stream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    } catch (error) {
      this.muted = true;
      this.#emit('notice', { text: 'Não foi possível usar o microfone. Você entrou na call sem microfone.' });
      console.warn('Microfone indisponível:', error);
    }
  }

  // Troca o microfone sem sair da call.
  async setMicDevice(micId) {
    this.micId = micId || '';
    const old = this.micStream;
    if (!old) return;
    const wasMuted = this.muted;
    this.micStream = null;
    await this.#ensureMic();
    if (!this.micStream) {
      this.micStream = old;
      this.muted = wasMuted;
      return;
    }
    this.#retireStream(old);
    old.getTracks().forEach((t) => t.stop());
    this.#syncStreams();
    this.#broadcastHello();
    this.#emit('call', { inCall: this.inCall });
  }

  // ---- compartilhamento ----

  async startShare(stream, { kind = 'screen', label = '', audio = null } = {}) {
    if (this.closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    if (!this.inCall) await this.joinCall({ withMic: false });
    if (this.share) this.stopShare();
    this.share = { stream, kind, mode: this.quality, label: String(label).slice(0, 60), audio };
    const ending = stream.getVideoTracks()[0] || stream.getAudioTracks()[0];
    ending?.addEventListener('ended', () => {
      if (this.share?.stream === stream) this.stopShare();
    });
    this.#applyQuality();
    this.#syncStreams();
    this.#broadcastHello();
    this.#emit('share', { sharing: true });
  }

  stopShare() {
    const current = this.share;
    if (!current) return;
    this.share = null;
    this.drawAllow.clear();
    this.#retireStream(current.stream);
    current.stream.getTracks().forEach((t) => t.stop());
    this.#broadcastHello();
    this.#emit('share', { sharing: false });
  }

  // ---- streams recebidas ----

  shareOf(peer) {
    if (!peer?.sharing || !peer.inCall) return null;
    const stream = peer.streams.get(peer.sharing.streamId);
    if (!stream) return null;
    if (peer.sharing.kind === 'screen' && !stream.getVideoTracks().length) return null;
    return stream;
  }

  micOf(peer) {
    if (!peer?.inCall || !peer.micStreamId) return null;
    return peer.streams.get(peer.micStreamId) || null;
  }

  // ---- chat ----

  async sendMessage(text) {
    const clean = String(text).trim().slice(0, 2000);
    if (!clean) return null;
    const msg = { id: `${this.uid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, uid: this.uid, name: this.name, text: clean, ts: Date.now() };
    await store.addMessages(this.code, [msg]);
    this.#emit('messages', { messages: [msg] });
    this.#send('chat', msg);
    return msg;
  }

  async setMeta(meta) {
    // meta: { name?, pinned? } — vence a alteração mais recente
    const turma = await store.updateTurma(this.code, (t) => {
      const change = {};
      if (meta.name !== undefined) { change.name = meta.name; change.nameTs = Date.now(); }
      if (meta.pinned !== undefined) { change.pinned = meta.pinned ? { ...meta.pinned, ts: Date.now() } : { cleared: true, ts: Date.now() }; }
      return change;
    });
    if (!turma) return;
    this.#emit('meta', { turma });
    this.#sendMeta(turma);
  }

  // ---- imagens ----

  async addReactionImage(hash, data) {
    await store.putImage(hash, data);
    const item = { hash, by: this.uid, byName: this.name, ts: Date.now() };
    await store.addToGallery(this.code, [item]);
    this.#emit('gallery', {});
    this.#send('img', { hash, data });
    this.#send('gallery', { items: [item] });
  }

  async removeReactionImage(hash) {
    const item = { hash, deleted: true, ts: Date.now() };
    await store.addToGallery(this.code, [item]);
    this.#emit('gallery', {});
    this.#send('gallery', { items: [item] });
  }

  sendReaction(hash) {
    this.#send('react', { hash });
    this.#emit('reaction', { uid: this.uid, name: this.name, hash, self: true });
  }

  // ---- ponteiro e desenho ----

  sendPointer(targetPeerId, x, y) {
    this.#send('ptr', { to: targetPeerId, x, y }, this.#callPeerIds());
  }

  sendStroke(targetPeerId, stroke) {
    this.#send('stroke', { to: targetPeerId, ...stroke }, this.#callPeerIds());
  }

  requestDraw(targetPeerId) {
    this.#send('drawreq', {}, targetPeerId);
  }

  answerDraw(peerId, allow) {
    const peer = this.peers.get(peerId);
    if (!peer?.uid) return;
    if (allow) this.drawAllow.add(peer.uid);
    else this.drawAllow.delete(peer.uid);
    this.#send('drawres', { allow }, peerId);
    this.#broadcastHello();
    this.#emit('peers', {});
  }

  revokeDraw(uid) {
    this.drawAllow.delete(uid);
    this.#broadcastHello();
    this.#emit('peers', {});
  }

  canDrawOn(peer) {
    return !!peer?.drawAllow?.includes(this.uid);
  }

  // ---- rádio ----

  setRadio(state) {
    this.radio = { ...state, v: this.radio.v + 1, by: this.uid };
    this.#emit('radio', { radio: this.radio, local: true });
    this.#sendRadio();
  }

  sendRadioTick(position) {
    this.#sendRadio(position);
  }

  async leave() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const stream of [this.share?.stream, this.micStream]) stream?.getTracks().forEach((t) => t.stop());
    this.share = null;
    this.micStream = null;
    this.peers.clear();
    try { await this.room.leave(); } catch { /* ignorado */ }
  }

  // ================= internos =================

  #emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #allowed(peerId, name) {
    const limit = RATE_LIMITS[name];
    if (!limit) return true;
    const key = `${peerId}:${name}`;
    const now = Date.now();
    const list = (this.rate.get(key) || []).filter((t) => now - t < limit[1]);
    if (list.length >= limit[0]) return false;
    list.push(now);
    this.rate.set(key, list);
    return true;
  }

  #callPeerIds() {
    return [...this.peers.values()].filter((p) => p.inCall).map((p) => p.id);
  }

  #hello() {
    return {
      p: PROTOCOL,
      uid: this.uid,
      name: this.name.slice(0, 32),
      avatar: this.avatarHash || '',
      inCall: this.inCall,
      muted: this.muted || !this.micStream,
      micStreamId: this.micStream?.id ?? null,
      sharing: this.share
        ? { streamId: this.share.stream.id, kind: this.share.kind, mode: this.share.mode, label: this.share.label, audio: !!this.share.stream.getAudioTracks().length }
        : null,
      drawAllow: [...this.drawAllow],
      // Quem está conectado direto comigo (para a ponte).
      links: [...this.peers.values()].filter((p) => !p.via && p.uid).map((p) => p.id).slice(0, 32),
    };
  }

  // Envia uma mensagem. target: id, lista de ids ou nada (todos).
  // Quem não está conectado direto recebe pela ponte.
  #send(name, data, target) {
    const action = this.actions[name];
    const ids = target === undefined || target === null ? null : [].concat(target);
    const direct = [];
    const bridged = [];
    if (ids) {
      for (const id of ids) {
        const peer = this.peers.get(id);
        if (peer?.via) bridged.push(peer);
        else direct.push(id);
      }
      if (direct.length) action.send(data, { target: direct }).catch(() => {});
    } else {
      action.send(data).catch(() => {});
      for (const peer of this.peers.values()) if (peer.via) bridged.push(peer);
    }
    for (const peer of bridged) {
      this.actions.relay.send({ to: peer.id, name, data }, { target: peer.via }).catch(() => {});
    }
  }

  #onRelay(data, fromPeerId) {
    if (!data || typeof data.to !== 'string' || !RELAYABLE.has(data.name)) return;
    if (data.to === this.selfId) {
      const from = typeof data.from === 'string' ? data.from : '';
      const bridge = this.peers.get(fromPeerId);
      if (!from || from === this.selfId || !bridge || bridge.via) return;
      if (!this.peers.has(from)) this.#virtual(from, fromPeerId);
      if (!this.#allowed(from, data.name)) return;
      this.#handle(data.name, data.data, from);
      return;
    }
    // Sou a ponte: repasso para o destino, se ele estiver conectado direto comigo.
    const target = this.peers.get(data.to);
    const source = this.peers.get(fromPeerId);
    if (!target || target.via || !source || source.via) return;
    this.actions.relay.send({ to: data.to, from: fromPeerId, name: data.name, data: data.data }, { target: data.to }).catch(() => {});
  }

  #virtual(peerId, via) {
    const peer = this.#peer(peerId);
    peer.via = via;
    const pending = this.pendingRelayStreams.get(peerId);
    if (pending) {
      for (const stream of pending) peer.streams.set(stream.id, stream);
      this.pendingRelayStreams.delete(peerId);
    }
    return peer;
  }

  // Descobre quem só é alcançável pela ponte e cria/remove essas conexões indiretas.
  #refreshBridges() {
    const now = Date.now();
    const directs = [...this.peers.values()].filter((p) => !p.via);
    const directIds = new Set(directs.map((p) => p.id));
    const candidates = new Map();
    for (const p of directs) {
      if (!p.uid || !p.links) continue;
      for (const sid of p.links) {
        if (sid === this.selfId || directIds.has(sid)) continue;
        if (!candidates.has(sid)) candidates.set(sid, []);
        candidates.get(sid).push(p);
      }
    }
    for (const sid of [...this.indirectSince.keys()]) if (!candidates.has(sid)) this.indirectSince.delete(sid);
    let changed = false;
    for (const [sid, bridges] of candidates) {
      if (!this.indirectSince.has(sid)) this.indirectSince.set(sid, now);
      if (now - this.indirectSince.get(sid) < BRIDGE_DELAY_MS) continue;
      const via = bridges.sort((a, b) => (a.uid < b.uid ? -1 : 1))[0].id;
      const existing = this.peers.get(sid);
      if (existing) {
        if (existing.via !== via) { existing.via = via; changed = true; }
      } else {
        this.#virtual(sid, via);
        this.#greet(sid);
        changed = true;
      }
    }
    for (const p of [...this.peers.values()]) {
      if (!p.via) continue;
      if (candidates.has(p.id) && this.peers.has(p.via)) continue;
      if (!candidates.has(p.id) && this.peers.has(p.via) && now - p.joinedAt < 10000) continue;
      this.peers.delete(p.id);
      changed = true;
    }
    if (changed) {
      this.#syncStreams();
      this.#emit('peers', {});
    }
  }

  // Como ponte, repasso voz e tela entre pessoas que não se conectam direto.
  // Se houver mais de uma ponte possível, quem tem o menor id faz o repasse.
  #syncForwards() {
    const now = Date.now();
    const wanted = new Map();
    const pairs = new Set();
    const directs = [...this.peers.values()].filter((p) => !p.via && p.uid && p.links);
    for (const a of directs) {
      for (const b of directs) {
        if (a === b || a.links.includes(b.id) || b.links.includes(a.id)) continue;
        const key = `${a.id}|${b.id}`;
        pairs.add(key);
        if (!this.pairSince.has(key)) this.pairSince.set(key, now);
        if (now - this.pairSince.get(key) < BRIDGE_DELAY_MS || !a.inCall || !b.inCall) continue;
        const common = directs.filter((q) => q !== a && q !== b && q.links.includes(a.id) && q.links.includes(b.id));
        if (common.some((q) => q.uid < this.uid)) continue;
        for (const [stream, kind] of [[this.micOf(a), 'mic'], [this.shareOf(a), a.sharing?.kind]]) {
          if (stream) wanted.set(`${stream.id}>${b.id}`, { stream, target: b.id, kind, from: a.id });
        }
      }
    }
    for (const key of [...this.pairSince.keys()]) if (!pairs.has(key)) this.pairSince.delete(key);
    for (const [key, f] of this.forwards) {
      if (wanted.get(key)?.stream === f.stream) continue;
      if (this.peers.has(f.target)) {
        try { this.room.removeStream(f.stream, { target: f.target }); } catch { /* conexão já fechada */ }
      }
      this.forwards.delete(key);
    }
    for (const [key, f] of wanted) {
      if (this.forwards.has(key)) continue;
      this.room.addStream(f.stream, { target: f.target, metadata: { kind: f.kind, relayFrom: f.from } });
      this.forwards.set(key, f);
    }
  }

  #broadcastHello() {
    if (this.closed) return;
    this.#send('hello', this.#hello());
  }

  #peer(peerId) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = {
        id: peerId, uid: null, name: null, avatar: '', inCall: false, muted: true,
        micStreamId: null, sharing: null, drawAllow: [], streams: new Map(), joinedAt: Date.now(),
      };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  async #onJoin(peerId) {
    if (this.closed || blocked(peerId)) return;
    const peer = this.#peer(peerId);
    // Quem estava pela ponte agora conectou direto.
    const wasBridged = !!peer.via;
    if (wasBridged) peer.via = null;
    await this.#greet(peerId);
    if (wasBridged) this.#broadcastHello();
  }

  async #greet(peerId) {
    this.#send('hello', this.#hello(), peerId);
    const turma = (await store.listTurmas()).find((t) => t.code === this.code);
    if (turma) this.#sendMeta(turma, peerId);
    const msgs = await store.messages(this.code);
    const gallery = await store.gallery(this.code);
    this.#send('sync', {
      have: msgs.slice(-300).map((m) => m.id),
      gallery: gallery.map(({ hash, by, byName, ts, deleted }) => ({ hash, by, byName, ts, deleted: !!deleted })),
    }, peerId);
    if (this.radio.v) this.#sendRadio(undefined, peerId);
    this.#emit('peers', {});
  }

  #onLeave(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.via) return;
    this.peers.delete(peerId);
    for (const set of this.sent.values()) set.delete(peerId);
    this.#broadcastHello();
    this.#refreshBridges();
    this.#syncForwards();
    this.#emit('peers', {});
  }

  #onStream(stream, peerId, metadata) {
    if (this.closed || blocked(peerId)) return;
    const relayFrom = metadata?.relayFrom;
    if (typeof relayFrom === 'string' && relayFrom !== peerId) {
      // Stream de outra pessoa, repassada pela ponte.
      const owner = this.peers.get(relayFrom);
      if (owner?.via) owner.streams.set(stream.id, stream);
      else if (!owner) {
        const list = this.pendingRelayStreams.get(relayFrom) || [];
        this.pendingRelayStreams.set(relayFrom, [...list.slice(-3), stream]);
        return;
      } else return;
      stream.addEventListener('addtrack', () => this.#emit('peers', {}));
      stream.addEventListener('removetrack', () => this.#emit('peers', {}));
      this.#emit('peers', {});
      return;
    }
    const peer = this.#peer(peerId);
    peer.streams.set(stream.id, stream);
    stream.addEventListener('addtrack', () => this.#emit('peers', {}));
    stream.addEventListener('removetrack', () => this.#emit('peers', {}));
    this.#emit('peers', {});
  }

  #handle(name, data, peerId) {
    if (!data || typeof data !== 'object') return;
    const peer = this.#peer(peerId);
    switch (name) {
      case 'hello': return this.#onHello(peer, data);
      case 'meta': return this.#onMeta(data);
      case 'chat': return this.#onChat(peer, [data]);
      case 'chatbulk': return Array.isArray(data.messages) && this.#onChat(peer, data.messages.slice(0, 300));
      case 'sync': return this.#onSync(peerId, data);
      case 'imgget': return this.#onImgGet(peerId, data);
      case 'img': return this.#onImg(data);
      case 'gallery': return this.#onGallery(peerId, data);
      case 'react':
        if (typeof data.hash === 'string' && peer.uid) {
          this.#emit('reaction', { uid: peer.uid, name: peer.name, hash: data.hash, peerId });
        }
        return;
      case 'ptr': return this.#onPointer(peer, data);
      case 'stroke': return this.#onStroke(peer, data);
      case 'drawreq':
        if (this.share && peer.uid) this.#emit('draw-request', { peerId, uid: peer.uid, name: peer.name });
        return;
      case 'drawres':
        this.#emit('draw-response', { peerId, allow: data.allow === true, name: peer.name });
        return;
      case 'radio': return this.#onRadio(data);
      default:
    }
  }

  #onHello(peer, data) {
    const before = { sharing: peer.sharing?.streamId, inCall: peer.inCall };
    const firstHello = !peer.uid;
    peer.links = Array.isArray(data.links) ? data.links.filter((x) => typeof x === 'string').slice(0, 32) : null;
    peer.uid = typeof data.uid === 'string' ? data.uid.slice(0, 32) : peer.uid;
    peer.name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 32) : 'Sem nome';
    peer.avatar = typeof data.avatar === 'string' ? data.avatar.slice(0, 32) : '';
    peer.inCall = data.inCall === true || (data.p === undefined && data.sharing === true);
    peer.muted = data.muted !== false;
    peer.micStreamId = typeof data.micStreamId === 'string' ? data.micStreamId : null;
    peer.drawAllow = Array.isArray(data.drawAllow) ? data.drawAllow.filter((x) => typeof x === 'string').slice(0, 32) : [];
    const s = data.sharing;
    if (s && typeof s === 'object' && typeof s.streamId === 'string') {
      peer.sharing = {
        streamId: s.streamId,
        kind: s.kind === 'audio' ? 'audio' : 'screen',
        mode: s.mode in QUALITY ? s.mode : 'detail',
        label: typeof s.label === 'string' ? s.label.slice(0, 60) : '',
        audio: s.audio === true,
      };
    } else if (data.p === undefined && data.sharing === true && typeof data.streamId === 'string') {
      // Compatibilidade com a versão 1
      peer.sharing = { streamId: data.streamId, kind: 'screen', mode: 'detail', label: '', audio: true };
      peer.inCall = true;
    } else {
      peer.sharing = null;
    }
    // Remove streams antigas que não estão mais em uso
    for (const id of [...peer.streams.keys()]) {
      if (id !== peer.sharing?.streamId && id !== peer.micStreamId && peer.streams.get(id).getTracks().every((t) => t.readyState === 'ended')) {
        peer.streams.delete(id);
      }
    }
    if (peer.avatar) this.#wantImages([peer.avatar], peer.id);
    // Avisa os outros que agora tenho conexão direta com essa pessoa.
    if (firstHello && !peer.via) this.#broadcastHello();
    this.#syncStreams();
    this.#emit('member', { uid: peer.uid, name: peer.name, avatar: peer.avatar });
    if (before.sharing !== peer.sharing?.streamId && peer.sharing && before.sharing === undefined) {
      this.#emit('started-sharing', { peer });
    }
    this.#emit('peers', {});
  }

  async #wantImages(hashes, peerId) {
    const have = new Set(await store.imageHashes());
    const missing = hashes.filter((h) => typeof h === 'string' && h && !have.has(h)).slice(0, 60);
    if (missing.length) this.#send('imgget', { hashes: missing }, peerId);
  }

  async #onImgGet(peerId, data) {
    if (!Array.isArray(data.hashes)) return;
    for (const hash of data.hashes.slice(0, 60)) {
      if (typeof hash !== 'string') continue;
      const img = hash === this.avatarHash && this.settings.avatar ? this.settings.avatar : await store.image(hash);
      if (img) this.#send('img', { hash, data: img }, peerId);
    }
  }

  async #onImg(data) {
    if (typeof data.hash !== 'string' || !validImage(data.data)) return;
    if ((await hashData(data.data)) !== data.hash) return;
    if (await store.putImage(data.hash, data.data)) this.#emit('image', { hash: data.hash });
  }

  async #onGallery(peerId, data) {
    if (!Array.isArray(data.items)) return;
    const items = data.items.slice(0, 60).filter((g) => g && typeof g.hash === 'string').map((g) => ({
      hash: g.hash.slice(0, 32),
      by: typeof g.by === 'string' ? g.by.slice(0, 32) : '',
      byName: typeof g.byName === 'string' ? g.byName.slice(0, 32) : '',
      ts: Number(g.ts) || Date.now(),
      ...(g.deleted ? { deleted: true } : {}),
    }));
    const changed = await store.addToGallery(this.code, items);
    if (changed.length) this.#emit('gallery', {});
    this.#wantImages(items.filter((g) => !g.deleted).map((g) => g.hash), peerId);
  }

  async #onSync(peerId, data) {
    if (Array.isArray(data.have)) {
      const have = new Set(data.have);
      const mine = await store.messages(this.code);
      const missing = mine.slice(-300).filter((m) => !have.has(m.id));
      if (missing.length) this.#send('chatbulk', { messages: missing }, peerId);
    }
    if (Array.isArray(data.gallery)) await this.#onGallery(peerId, { items: data.gallery });
  }

  async #onChat(peer, list) {
    const valid = list.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && typeof m.uid === 'string')
      .map((m) => ({
        id: m.id.slice(0, 64),
        uid: m.uid.slice(0, 32),
        name: typeof m.name === 'string' ? m.name.slice(0, 32) : 'Sem nome',
        text: m.text.slice(0, 2000),
        ts: Number(m.ts) || Date.now(),
      }));
    if (!valid.length) return;
    const fresh = await store.addMessages(this.code, valid);
    if (fresh.length) this.#emit('messages', { messages: fresh });
  }

  #sendMeta(turma, target) {
    const meta = { name: turma.name, nameTs: turma.nameTs || 0, pinned: turma.pinned || null };
    this.#send('meta', meta, target);
  }

  async #onMeta(data) {
    const turma = await store.updateTurma(this.code, (t) => {
      const change = {};
      if (typeof data.name === 'string' && Number(data.nameTs) > (t.nameTs || 0)) {
        change.name = data.name.slice(0, 40);
        change.nameTs = Number(data.nameTs);
      }
      const p = data.pinned;
      if (p && typeof p === 'object' && Number(p.ts) > (t.pinned?.ts || 0)) {
        change.pinned = p.cleared
          ? { cleared: true, ts: Number(p.ts) }
          : { text: String(p.text || '').slice(0, 500), name: String(p.name || '').slice(0, 32), id: String(p.id || ''), ts: Number(p.ts) };
      }
      return change;
    });
    if (turma) this.#emit('meta', { turma });
  }

  #onPointer(peer, data) {
    if (!peer.inCall || typeof data.to !== 'string') return;
    const x = Number(data.x);
    const y = Number(data.y);
    const hide = data.x === null;
    if (!hide && (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1))) return;
    this.#emit('pointer', { from: peer, to: data.to, x, y, hide });
  }

  #onStroke(peer, data) {
    if (!peer.inCall || typeof data.to !== 'string' || !peer.uid) return;
    // Só aceita desenho de quem tem permissão de quem está transmitindo.
    const sharerAllows = data.to === this.selfId
      ? this.drawAllow.has(peer.uid)
      : this.peers.get(data.to)?.drawAllow?.includes(peer.uid);
    if (!sharerAllows) return;
    const pts = Array.isArray(data.pts) ? data.pts.slice(0, 200).filter((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) : [];
    this.#emit('stroke', {
      from: peer,
      to: data.to,
      id: String(data.id || '').slice(0, 40),
      pts,
      color: /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : '#ff5f5f',
      done: data.done === true,
    });
  }

  #sendRadio(position, target) {
    const state = { ...this.radio };
    if (state.current) state.current = { ...state.current, pos: position ?? this.radioPosition?.() ?? state.current.pos ?? 0 };
    this.#send('radio', state, target);
  }

  #onRadio(data) {
    if (!Array.isArray(data.queue) || typeof data.v !== 'number') return;
    const newer = data.v > this.radio.v || (data.v === this.radio.v && String(data.by) > this.radio.by);
    const sameVersion = data.v === this.radio.v && data.by === this.radio.by;
    if (!newer && !sameVersion) return;
    const item = (x) => x && typeof x.videoId === 'string' && /^[\w-]{11}$/.test(x.videoId)
      ? { id: String(x.id || x.videoId).slice(0, 40), videoId: x.videoId, title: String(x.title || '').slice(0, 120), by: String(x.by || '').slice(0, 32) }
      : null;
    const current = data.current && item(data.current)
      ? { ...item(data.current), playing: data.current.playing !== false, pos: Math.max(0, Number(data.current.pos) || 0) }
      : null;
    this.radio = { v: data.v, by: String(data.by || ''), queue: data.queue.map(item).filter(Boolean).slice(0, 50), current };
    this.#emit('radio', { radio: this.radio, local: false, tick: sameVersion });
  }

  // Envia/remove streams de acordo com quem está na call.
  #syncStreams() {
    if (this.closed) return;
    const locals = [];
    if (this.inCall && this.micStream) locals.push([this.micStream, 'mic']);
    if (this.inCall && this.share) locals.push([this.share.stream, this.share.kind]);
    const activeIds = new Set(locals.map(([s]) => s.id));
    for (const [streamId, set] of this.sent) {
      if (!activeIds.has(streamId)) { set.clear(); this.sent.delete(streamId); }
    }
    for (const [stream, kind] of locals) {
      let set = this.sent.get(stream.id);
      if (!set) { set = new Set(); this.sent.set(stream.id, set); }
      for (const peer of this.peers.values()) {
        const should = peer.inCall && !peer.via;
        if (should && !set.has(peer.id)) {
          this.room.addStream(stream, { target: peer.id, metadata: { kind } });
          set.add(peer.id);
        } else if (!should && set.has(peer.id)) {
          try { this.room.removeStream(stream, { target: peer.id }); } catch { /* conexão já fechada */ }
          set.delete(peer.id);
        }
      }
    }
    this.#syncForwards();
    if (this.share) setTimeout(() => this.#applyQuality(), 400);
  }

  #retireStream(stream) {
    const set = this.sent.get(stream.id);
    if (set?.size) {
      try { this.room.removeStream(stream, { target: [...set] }); } catch { /* ignorado */ }
    }
    this.sent.delete(stream.id);
  }

  #tick() {
    if (this.closed) return;
    let online = false;
    try {
      online = Object.values(this.sockets() || {}).some((s) => s && s.readyState === WebSocket.OPEN);
    } catch { online = false; }
    if (online !== this.signalingOnline) {
      this.signalingOnline = online;
      this.#emit('signaling', { online });
    }
    this.#refreshBridges();
    this.#syncForwards();
    if (this.share) this.#applyQuality();
    this.#applyReceiverHints();
  }

  #connections() {
    try { return this.room.getPeers() || {}; } catch { return {}; }
  }

  // Ajusta a qualidade do que é enviado: quadros por segundo, taxa de bits e prioridade.
  #applyQuality() {
    const share = this.share;
    if (!share) return;
    const q = QUALITY[this.quality];
    const video = share.stream.getVideoTracks()[0];
    const audio = share.stream.getAudioTracks()[0];
    if (video && video.contentHint !== q.hint) {
      video.contentHint = q.hint;
      video.applyConstraints({ frameRate: { ideal: q.frameRate, max: q.frameRate } }).catch(() => {});
    }
    if (audio && audio.contentHint !== 'music') audio.contentHint = 'music';
    for (const pc of Object.values(this.#connections())) {
      for (const sender of pc.getSenders?.() || []) {
        if (!sender.track || (sender.track !== video && sender.track !== audio)) continue;
        const params = sender.getParameters();
        const encoding = params.encodings?.[0];
        if (!encoding) continue;
        const isVideo = sender.track === video;
        const bitrate = isVideo ? q.maxBitrate : q.audioBitrate;
        const fps = isVideo ? q.frameRate : undefined;
        const preference = this.quality === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
        if (encoding.maxBitrate === bitrate && encoding.maxFramerate === fps && (!isVideo || params.degradationPreference === preference)) continue;
        encoding.maxBitrate = bitrate;
        if (isVideo) {
          encoding.maxFramerate = fps;
          params.degradationPreference = preference;
        }
        sender.setParameters(params).catch(() => {
          delete params.degradationPreference;
          sender.setParameters(params).catch(() => {});
        });
      }
    }
  }

  // No modo filme, quem assiste guarda um pouco mais de vídeo para evitar travadas.
  #applyReceiverHints() {
    const connections = this.#connections();
    for (const peer of this.peers.values()) {
      const stream = this.shareOf(peer);
      const pc = connections[peer.id];
      if (!stream || !pc) continue;
      const target = QUALITY[peer.sharing.mode]?.buffer ?? null;
      const tracks = new Set(stream.getTracks());
      for (const receiver of pc.getReceivers?.() || []) {
        if (!tracks.has(receiver.track)) continue;
        try {
          if ('jitterBufferTarget' in receiver) {
            const ms = target === null ? null : target * 1000;
            if (receiver.jitterBufferTarget !== ms) receiver.jitterBufferTarget = ms;
          } else if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = target;
          }
        } catch { /* não suportado */ }
      }
    }
  }
}

export function normalizeServerUrl(value) {
  let url = String(value || '').trim();
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = `wss://${url}`;
  url = url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  try {
    const parsed = new URL(url);
    if (!['ws:', 'wss:'].includes(parsed.protocol)) return null;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
