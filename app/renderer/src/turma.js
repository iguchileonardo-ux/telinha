// Sessão de uma Turma: presença, chat, imagens, call de voz, telas, ponteiro,
// desenho e rádio. Tudo direto entre os computadores (WebRTC via Trystero).
//
// Sinalização:
//   - 'builtin': servidor da Telinha no Cloudflare (padrão quando configurado);
//   - 'auto':    relays públicos da rede Nostr (reserva, se o servidor falhar);
//   - 'server':  servidor escolhido nas configurações.
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

const RATE_LIMITS = { chat: [8, 5000], react: [6, 3000], img: [40, 10000], gallery: [10, 10000], drawreq: [3, 10000], relay: [200, 5000], feed: [12, 10000] };

// Repasse de carga: quando quem transmite não consegue enviar a tela para todos
// (internet ou processador no limite), parte dos espectadores passa a receber por
// outro espectador conectado a eles. Só entra em ação quando a limitação é medida;
// com internet boa, tudo continua direto, sem atraso extra e sem recodificação.
// Um único nível: quem transmite, o repassador e os espectadores dele.
const TREE_KIDS = 3; // espectadores atendidos por cada repassador
const TREE_FORWARD_MAX = 4; // limite de segurança para quem repassa
const LOAD_GRACE_MS = 12000; // tempo de uma conexão enviando antes de ser avaliada
const LOAD_SAMPLES = 4; // amostras de 2 s avaliadas em conjunto
const LOAD_LIMITED = 0.5; // fração do tempo limitado que caracteriza sobrecarga
const LOAD_COOLDOWN_MS = 15000; // intervalo mínimo entre mudanças de distribuição
const TREE_CONFIRM_MS = 12000; // prazo para o espectador confirmar o recebimento pelo repassador
const BAD_RELAY_MS = 5 * 60 * 1000; // tempo sem reutilizar um repassador que falhou
const UPLINK_KEY = 'telinha:uplink';

// Indica se o envio está sobrecarregado. Cada registro traz o histórico recente do
// tempo em que o envio de vídeo ficou limitado por banda ou por processador.
// Com 'min' = 2, só considera sobrecarga quando há ao menos duas conexões medidas
// (com uma só, não há o que repassar).
export function overloaded(records, min = 2) {
  const rows = records.filter((r) => r && r.hist.length >= LOAD_SAMPLES);
  if (rows.length < min) return false;
  const mean = (r, key) => r.hist.reduce((sum, x) => sum + x[key], 0) / r.hist.length;
  if (rows.some((r) => mean(r, 'cpu') >= LOAD_LIMITED)) return true;
  return rows.filter((r) => mean(r, 'frac') >= LOAD_LIMITED).length >= Math.max(min > 1 ? 2 : 1, Math.ceil(rows.length * 0.6));
}

// Taxa de bits de cada envio de vídeo conforme o número de pessoas recebendo direto de mim:
// com mais gente, cada cópia usa menos internet em vez de todas disputarem a mesma banda.
const FANOUT_MIN_BITRATE = 1_500_000;
export function fanoutScale(count) {
  if (count <= 2) return 1;
  if (count === 3) return 0.8;
  if (count === 4) return 0.65;
  return 0.5;
}

const shortId = (id) => String(id || '').slice(0, 4);

function readUplink() {
  try { return Math.max(0, Math.min(1_000_000, Number(localStorage.getItem(UPLINK_KEY)) || 0)); } catch { return 0; }
}

// Ponte: quando duas pessoas da turma não conseguem se conectar direto (redes
// que bloqueiam a conexão), alguém conectado às duas repassa chat, presença,
// voz e telas entre elas. Só entra em ação depois deste tempo sem conexão direta.
const BRIDGE_DELAY_MS = 8000;
const ACTIONS = ['hello', 'meta', 'chat', 'sync', 'chatbulk', 'imgget', 'img', 'gallery', 'react', 'ptr', 'stroke', 'drawreq', 'drawres', 'radio', 'bye', 'feed'];
// Tentativas de reencontrar quem caiu sem avisar (queda de internet, Wi-Fi, hibernação).
const RECONNECT_DELAYS = [3000, 8000, 20000, 45000, 60000];
const RECONNECT_GIVE_UP = 10 * 60 * 1000;
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
  // builtinServer: servidor da Telinha (wss://...) ou null para usar os relays Nostr.
  // extraIce: servidores TURN fornecidos pelo servidor da Telinha.
  constructor({ code, settings, builtinServer = null, extraIce = [] }) {
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
    this.outgoing = new Map(); // `${streamId}>${destino}` -> objeto realmente enviado ao destino
    this.removedKeys = new Set(); // envios já removidos de um destino (o reenvio precisa de stream novo)
    this.lost = new Map(); // uid -> tentativas de reconexão
    this.byes = new Set(); // quem saiu de propósito
    // Repasse de carga (ver TREE_KIDS)
    this.routes = new Map(); // quem transmite: espectador -> { relay, since, confirmed }
    this.relaying = new Map(); // quem repassa: `${streamId}>${espectador}` -> repasse ativo
    this.relayCap = new Map(); // repassador -> limite de espectadores
    this.badRelays = new Map(); // repassador -> até quando evitar
    this.load = new Map(); // conexão -> medição do envio de vídeo
    this.shareSince = 0;
    this.lastShift = 0;
    this.offloadedAt = 0;
    this.uplink = readUplink(); // maior vazão de envio já medida (kbps)
    this.uplinkSaved = 0;

    const config = {
      appId: APP_ID,
      password: `telinha:${code}`,
      rtcConfig: { iceServers: [...iceServers(settings), ...extraIce] },
    };
    const callbacks = { onJoinError: (details) => this.#emit('join-error', details) };

    if (settings.signaling === 'server') {
      const url = normalizeServerUrl(settings.serverUrl);
      if (!url) throw new Error('Informe o endereço do servidor próprio nas configurações.');
      this.mode = 'server';
      this.room = joinRelay({ ...config, relayConfig: { urls: [url] } }, code, callbacks);
      this.sockets = relaySockets;
    } else if (builtinServer) {
      this.mode = 'builtin';
      this.room = joinRelay({ ...config, relayConfig: { urls: [builtinServer] } }, code, callbacks);
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

    this.onOnline = () => this.#kickSignaling(true);
    window.addEventListener('online', this.onOnline);
    this.onDeviceChange = () => this.#deviceChanged();
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);

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
    const changed = this.muted !== muted;
    this.muted = muted;
    if (!muted && !this.micStream) await this.#ensureMic();
    this.micStream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.#syncStreams();
    this.#broadcastHello();
    this.#emit('call', { inCall: this.inCall });
    if (changed) this.#emit('muted', { muted });
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
      stream.getAudioTracks().forEach((t) => {
        t.enabled = !this.muted;
        // Fone desconectado ou sem bateria: troca para o microfone padrão sozinho.
        t.addEventListener('ended', () => this.#onMicEnded(stream));
      });
    } catch (error) {
      this.muted = true;
      this.#emit('notice', { text: 'Não foi possível usar o microfone. Você entrou na call sem microfone.' });
      console.warn('Microfone indisponível:', error);
    }
  }

  // O microfone escolhido voltou (fone religado): volta a usar ele.
  async #deviceChanged() {
    if (this.closed || !this.inCall || !this.micStream || !this.micId) return;
    const current = this.micStream.getAudioTracks()[0];
    if (current?.readyState === 'live' && current.getSettings?.().deviceId === this.micId) return;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const back = devices.find((d) => d.kind === 'audioinput' && d.deviceId === this.micId);
    if (!back) return;
    await this.setMicDevice(this.micId);
    this.#emit('notice', { text: `Microfone de volta: ${back.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') || 'microfone escolhido'}.` });
  }

  async #onMicEnded(stream) {
    if (this.closed || this.micStream !== stream || !this.inCall) return;
    const chosen = this.micId;
    this.micId = '';
    this.#emit('notice', { text: 'O microfone foi desconectado. Usando o microfone padrão do sistema.' });
    await this.setMicDevice('');
    // Mantém a escolha: quando o microfone voltar, a próxima call já usa ele.
    this.micId = chosen;
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
    this.shareSince = Date.now();
    this.#resetRoutes();
    this.#log(`Transmissão iniciada: ${kind === 'audio' ? 'só som' : 'tela'}, modo ${this.quality}; na call: ${[...this.peers.values()].filter((p) => p.inCall && !p.via).length}.`);
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
    this.#log(`Transmissão encerrada após ${Math.round((Date.now() - this.shareSince) / 1000)} s; repassadores usados: ${new Set([...this.routes.values()].map((e) => e.relay)).size}.`);
    this.#resetRoutes();
    this.#retireStream(current.stream);
    current.stream.getTracks().forEach((t) => t.stop());
    this.#broadcastHello();
    this.#emit('share', { sharing: false });
  }

  // ---- streams recebidas ----

  shareOf(peer) {
    if (!peer?.sharing || !peer.inCall) return null;
    const id = peer.sharing.streamId;
    const direct = peer.streams.get(id);
    // Quando um repassador atende este espectador, a tela vem por ele depois da confirmação.
    const relayed = peer.relayed?.get(id);
    const stream = relayed && (peer.feedAck || !this.#flowing(direct, peer.sharing.kind)) ? relayed : direct;
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
    window.removeEventListener('online', this.onOnline);
    for (const entry of this.lost.values()) clearTimeout(entry.timer);
    this.lost.clear();
    // Avisa que é uma saída de propósito, para ninguém ficar tentando reconectar.
    await Promise.race([this.actions.bye.send({}).catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.#saveUplink(true);
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

  // Registro de diagnóstico (a interface grava em arquivo).
  #log(text) {
    this.dispatchEvent(new CustomEvent('log', { detail: { text } }));
  }

  #who(id) {
    const name = this.peers.get(id)?.name;
    return name ? `${name} (${shortId(id)})` : shortId(id);
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
        ? {
          streamId: this.share.stream.id,
          kind: this.share.kind,
          mode: this.share.mode,
          label: this.share.label,
          audio: !!this.share.stream.getAudioTracks().length,
          // Espectadores atendidos por um repassador: { espectador: repassador }.
          ...(this.routes.size ? { relays: Object.fromEntries([...this.routes].map(([viewer, e]) => [viewer, e.relay])) } : {}),
        }
        : null,
      tree: 1, // sabe repassar e receber telas por um repassador
      up: this.uplink || undefined,
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
      const known = this.peers.has(from);
      if (!known) this.#virtual(from, fromPeerId);
      if (!this.#allowed(from, data.name)) return;
      this.#handle(data.name, data.data, from);
      // A outra pessoa começou a falar comigo pela ponte antes de eu perceber: me apresento.
      if (!known) this.#greet(from);
      return;
    }
    // Sou a ponte: repasso para o destino, se ele estiver conectado direto comigo.
    const target = this.peers.get(data.to);
    const source = this.peers.get(fromPeerId);
    if (!target || target.via || !source || source.via) return;
    this.actions.relay.send({ to: data.to, from: fromPeerId, name: data.name, data: data.data }, { target: data.to }).catch(() => {});
  }

  // Alguém caiu sem avisar: reconecta a sinalização algumas vezes. Isso faz os dois
  // lados se anunciarem de novo e refazerem a conexão, sem derrubar os outros.
  #lostPeer(uid) {
    if (this.closed || this.lost.has(uid)) return;
    const entry = { since: Date.now(), tries: 0, timer: null };
    this.lost.set(uid, entry);
    this.#log(`Queda sem aviso de ${uid.slice(0, 4)}: tentando reconectar.`);
    const attempt = () => {
      if (this.closed || this.lost.get(uid) !== entry) return;
      if (this.peerByUid(uid) || Date.now() - entry.since > RECONNECT_GIVE_UP) { this.lost.delete(uid); return; }
      this.#kickSignaling();
      entry.tries += 1;
      entry.timer = setTimeout(attempt, RECONNECT_DELAYS[Math.min(entry.tries, RECONNECT_DELAYS.length - 1)]);
    };
    entry.timer = setTimeout(attempt, RECONNECT_DELAYS[0]);
  }

  #found(uid) {
    const entry = this.lost.get(uid);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.lost.delete(uid);
    this.#log(`Reconectado com ${uid.slice(0, 4)} após ${Math.round((Date.now() - entry.since) / 1000)} s e ${entry.tries} tentativa(s).`);
  }

  #kickSignaling(force = false) {
    const now = Date.now();
    if (!force && now - (this.lastKick || 0) < 2500) return;
    this.lastKick = now;
    try {
      for (const ws of Object.values(this.sockets() || {})) {
        if (ws?.readyState === WebSocket.OPEN) ws.close();
      }
    } catch { /* sem sockets */ }
  }

  #virtual(peerId, via) {
    const peer = this.#peer(peerId);
    peer.via = via;
    const pending = this.pendingRelayStreams.get(peerId);
    if (pending) {
      for (const item of pending) peer.streams.set(item.sid, item.stream);
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
      if (this.peers.has(f.target)) this.#removeStreamFrom(f.stream, f.target);
      this.forwards.delete(key);
    }
    for (const [key, f] of wanted) {
      if (this.forwards.has(key)) continue;
      this.#addStreamTo(f.stream, f.target, { kind: f.kind, relayFrom: f.from });
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
    this.#log(`${peer.name || shortId(peerId)} (${shortId(peerId)}) saiu da turma${this.byes.has(peerId) ? '' : ' sem avisar'}.`);
    if (peer.inCall && peer.uid) this.#emit('peer-call', { peer, inCall: false });
    if (peer.sharing) this.#emit('stopped-sharing', { peer });
    if (peer.uid) this.#emit('peer-presence', { peer, present: false });
    if (peer.uid && !this.byes.has(peerId)) this.#lostPeer(peer.uid);
    this.byes.delete(peerId);
    for (const set of this.sent.values()) set.delete(peerId);
    this.load.delete(peerId);
    for (const key of [...this.outgoing.keys()]) if (key.endsWith(`>${peerId}`)) this.outgoing.delete(key);
    for (const key of [...this.removedKeys]) if (key.endsWith(`>${peerId}`)) this.removedKeys.delete(key);
    for (const [key, f] of this.relaying) if (f.target === peerId) this.relaying.delete(key);
    const routesChanged = this.#pruneRoutes(Date.now());
    this.#broadcastHello();
    this.#refreshBridges();
    this.#syncForwards();
    if (routesChanged) this.#applyQuality();
    this.#syncRelaying();
    this.#emit('peers', {});
  }

  #onStream(stream, peerId, metadata) {
    if (this.closed || blocked(peerId)) return;
    // Id verdadeiro da stream (diferente do id do objeto quando ela foi reenviada).
    const sid = typeof metadata?.sid === 'string' ? metadata.sid.slice(0, 64) : stream.id;
    const relayFrom = metadata?.relayFrom;
    if (typeof relayFrom === 'string' && relayFrom !== peerId) {
      // Stream de outra pessoa, repassada pela ponte.
      const owner = this.peers.get(relayFrom);
      if (owner?.via) owner.streams.set(sid, stream);
      else if (!owner) {
        const list = this.pendingRelayStreams.get(relayFrom) || [];
        this.pendingRelayStreams.set(relayFrom, [...list.slice(-3), { stream, sid }]);
        return;
      } else {
        // Repasse de carga: a tela de quem transmite (conectado direto) chega por um repassador.
        if (!owner.relayed) owner.relayed = new Map();
        owner.relayed.set(sid, stream);
        owner.feedVia = peerId;
        const check = () => { this.#checkRouted(owner.id); this.#emit('peers', {}); };
        stream.getTracks().forEach((t) => t.addEventListener('unmute', check));
        stream.addEventListener('addtrack', (event) => { event.track.addEventListener('unmute', check); check(); });
        stream.addEventListener('removetrack', check);
        this.#checkRouted(owner.id);
        this.#emit('peers', {});
        return;
      }
      stream.addEventListener('addtrack', () => this.#emit('peers', {}));
      stream.addEventListener('removetrack', () => this.#emit('peers', {}));
      this.#emit('peers', {});
      return;
    }
    const peer = this.#peer(peerId);
    peer.streams.set(sid, stream);
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
      case 'bye': this.byes.add(peerId); return;
      case 'feed': return this.#onFeed(peer, data);
      default:
    }
  }

  #onHello(peer, data) {
    const before = { sharing: peer.sharing?.streamId, inCall: peer.inCall };
    const firstHello = !peer.uid;
    if (typeof data.uid === 'string') this.#found(data.uid.slice(0, 32));
    peer.links = Array.isArray(data.links) ? data.links.filter((x) => typeof x === 'string').slice(0, 32) : null;
    peer.uid = typeof data.uid === 'string' ? data.uid.slice(0, 32) : peer.uid;
    peer.name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 32) : 'Sem nome';
    peer.avatar = typeof data.avatar === 'string' ? data.avatar.slice(0, 32) : '';
    peer.inCall = data.inCall === true || (data.p === undefined && data.sharing === true);
    peer.muted = data.muted !== false;
    peer.micStreamId = typeof data.micStreamId === 'string' ? data.micStreamId : null;
    peer.drawAllow = Array.isArray(data.drawAllow) ? data.drawAllow.filter((x) => typeof x === 'string').slice(0, 32) : [];
    peer.canRelay = data.tree === 1;
    peer.up = Math.max(0, Math.min(1_000_000, Number(data.up) || 0));
    const routeBefore = peer.sharing?.relays?.[this.selfId] || null;
    const s = data.sharing;
    if (s && typeof s === 'object' && typeof s.streamId === 'string') {
      peer.sharing = {
        streamId: s.streamId,
        kind: s.kind === 'audio' ? 'audio' : 'screen',
        mode: s.mode in QUALITY ? s.mode : 'detail',
        label: typeof s.label === 'string' ? s.label.slice(0, 60) : '',
        audio: s.audio === true,
        relays: parseRelays(s.relays),
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
    // Mudou o repassador deste espectador (ou deixou de existir): recomeça a confirmação.
    const routeNow = peer.sharing?.relays?.[this.selfId] || null;
    if (routeNow !== routeBefore) {
      peer.feedAck = null;
      peer.feedBad = 0;
      if (!routeNow || (peer.feedVia && peer.feedVia !== routeNow)) { peer.relayed = null; peer.feedVia = null; }
    }
    if (peer.avatar) this.#wantImages([peer.avatar], peer.id);
    // Avisa os outros que agora tenho conexão direta com essa pessoa.
    if (firstHello && !peer.via) this.#broadcastHello();
    this.#syncStreams();
    this.#checkRouted(peer.id);
    this.#emit('member', { uid: peer.uid, name: peer.name, avatar: peer.avatar });
    if (firstHello && !peer.via && peer.uid) this.#emit('peer-presence', { peer, present: true });
    if (before.sharing !== peer.sharing?.streamId && peer.sharing && before.sharing === undefined) {
      this.#emit('started-sharing', { peer });
    }
    if (before.sharing !== undefined && !peer.sharing) this.#emit('stopped-sharing', { peer });
    if (!firstHello && before.inCall !== peer.inCall && peer.uid) {
      this.#log(`${this.#who(peer.id)} ${peer.inCall ? 'entrou na' : 'saiu da'} call.`);
      this.#emit('peer-call', { peer, inCall: peer.inCall });
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
        // A tela, depois de enviada, não é removida de quem sai da call: o envio só fica em
        // pausa (ver #applyQuality). Remover e reenviar renegocia a conexão e a estimativa de
        // banda recomeça muito baixa, deixando a imagem a poucos quadros por segundo.
        const isShare = stream === this.share?.stream;
        const should = !peer.via && (peer.inCall || (isShare && set.has(peer.id)));
        if (should && !set.has(peer.id)) {
          this.#addStreamTo(stream, peer.id, { kind });
          set.add(peer.id);
        } else if (!should && set.has(peer.id)) {
          this.#removeStreamFrom(stream, peer.id);
          set.delete(peer.id);
        }
      }
    }
    this.#syncForwards();
    this.#syncRelaying();
    if (this.share) setTimeout(() => this.#applyQuality(), 400);
  }

  #retireStream(stream) {
    const set = this.sent.get(stream.id);
    for (const id of set || []) this.#removeStreamFrom(stream, id);
    this.sent.delete(stream.id);
    for (const key of [...this.removedKeys]) if (key.startsWith(`${stream.id}>`)) this.removedKeys.delete(key);
  }

  // O Trystero reaproveita o objeto de stream antigo quando a mesma stream é removida e
  // reenviada ao mesmo destino (por exemplo, quem sai da call e volta): o destino ficaria com
  // um stream sem faixas e sem imagem. No reenvio vai um MediaStream novo, com o id verdadeiro
  // em metadata.sid. No primeiro envio vai a stream original, o que mantém as versões antigas
  // funcionando.
  #addStreamTo(stream, target, metadata) {
    const key = `${stream.id}>${target}`;
    const again = this.removedKeys.has(key);
    const out = again ? new MediaStream(stream.getTracks()) : stream;
    this.room.addStream(out, { target, metadata: again ? { ...metadata, sid: stream.id } : metadata });
    this.outgoing.set(key, out);
  }

  #removeStreamFrom(stream, target) {
    const key = `${stream.id}>${target}`;
    const out = this.outgoing.get(key) || stream;
    try { this.room.removeStream(out, { target }); } catch { /* conexão já fechada */ }
    this.outgoing.delete(key);
    this.removedKeys.add(key);
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
    this.#syncRelaying();
    if (this.share) this.#applyQuality();
    this.#tuneRelaying();
    this.#applyReceiverHints();
    for (const peer of this.peers.values()) if (peer.sharing?.relays) this.#checkRouted(peer.id, true);
    if (this.share || this.relaying.size) this.#loadTick();
    this.ticks = (this.ticks || 0) + 1;
    if (this.ticks % 2 === 0) this.#measure();
  }

  // Mede a conexão com cada pessoa: atraso (ms), perda de pacotes e o caminho
  // (direto, pelo servidor TURN ou pela ponte). Resultado em peer.net.
  async #measure() {
    const connections = this.#connections();
    let changed = false;
    for (const peer of this.peers.values()) {
      if (peer.via) continue;
      const pc = connections[peer.id];
      if (!pc?.getStats) continue;
      let stats;
      try { stats = await pc.getStats(); } catch { continue; }
      let pair = null;
      let received = 0;
      let lost = 0;
      const byId = new Map();
      stats.forEach((r) => {
        byId.set(r.id, r);
        if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) pair = pair || r;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') { received += r.packetsReceived || 0; lost += r.packetsLost || 0; }
      });
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId && byId.has(r.selectedCandidatePairId)) pair = byId.get(r.selectedCandidatePairId);
      });
      const prev = peer.netRaw || { received: 0, lost: 0 };
      const dr = Math.max(0, received - prev.received);
      const dl = Math.max(0, lost - prev.lost);
      peer.netRaw = { received, lost };
      const loss = dr + dl > 20 ? dl / (dr + dl) : (peer.net?.loss ?? 0);
      const rtt = pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : (peer.net?.rtt ?? null);
      const local = pair && byId.get(pair.localCandidateId);
      const remote = pair && byId.get(pair.remoteCandidateId);
      const path = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'direto';
      const level = rtt == null ? 'ok' : (rtt > 350 || loss > 0.08) ? 'bad' : (rtt > 180 || loss > 0.03) ? 'warn' : 'ok';
      const before = peer.net;
      peer.net = { rtt, loss, path, level };
      if (!before || before.level !== level || before.path !== path || Math.abs((before.rtt ?? 0) - (rtt ?? 0)) > 40) changed = true;
      if (!before || before.level !== level || before.path !== path) {
        this.#log(`Conexão com ${this.#who(peer.id)}: ${path}, atraso ${rtt ?? '?'} ms, perda ${Math.round(loss * 100)}%, nível ${level}.`);
      }
    }
    for (const peer of this.peers.values()) {
      if (!peer.via) continue;
      const bridge = this.peers.get(peer.via)?.net;
      const level = bridge?.level || 'ok';
      const before = peer.net;
      peer.net = { rtt: bridge?.rtt ?? null, loss: bridge?.loss ?? 0, path: 'ponte', level };
      if (!before || before.level !== level || before.path !== 'ponte') changed = true;
    }
    if (changed) this.#emit('peers', {});
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
    const sends = this.#directChildren().length;
    const scale = fanoutScale(sends);
    if (scale !== this.lastScale) {
      this.lastScale = scale;
      this.#log(`Qualidade por envio ajustada: ${sends} envio(s) direto(s), taxa máxima de vídeo ${Math.round(Math.min(q.maxBitrate, Math.max(FANOUT_MIN_BITRATE, q.maxBitrate * scale)) / 1000)} kbps.`);
    }
    for (const [peerId, pc] of Object.entries(this.#connections())) {
      // Fica com o envio em pausa quem saiu da call e quem já recebe a tela por um repassador
      // (confirmado): não gasta internet nem processador, e volta na hora quando preciso.
      const active = !!this.peers.get(peerId)?.inCall && this.routes.get(peerId)?.confirmed !== true;
      for (const sender of pc.getSenders?.() || []) {
        if (!sender.track || (sender.track !== video && sender.track !== audio)) continue;
        this.#tuneSender(sender, sender.track === video, this.quality, active, scale);
      }
    }
  }

  // Aplica taxa de bits, quadros por segundo, prioridade e pausa a um envio.
  #tuneSender(sender, isVideo, mode, active = true, scale = 1) {
    const q = QUALITY[mode] || QUALITY.detail;
    const params = sender.getParameters();
    const encoding = params.encodings?.[0];
    if (!encoding) return;
    const bitrate = isVideo ? Math.min(q.maxBitrate, Math.max(FANOUT_MIN_BITRATE, Math.round(q.maxBitrate * scale))) : q.audioBitrate;
    const fps = isVideo ? q.frameRate : undefined;
    const preference = mode === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
    if ((encoding.active !== false) === active && encoding.maxBitrate === bitrate && encoding.maxFramerate === fps && (!isVideo || params.degradationPreference === preference)) return;
    encoding.active = active;
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

  // No modo filme, quem assiste guarda um pouco mais de vídeo para evitar travadas.
  #applyReceiverHints() {
    const connections = this.#connections();
    for (const peer of this.peers.values()) {
      const stream = this.shareOf(peer);
      if (!stream) continue;
      const target = QUALITY[peer.sharing.mode]?.buffer ?? null;
      const tracks = new Set(stream.getTracks());
      // A tela chega pela conexão com quem transmite ou, no repasse de carga, pela do repassador.
      for (const pc of [connections[peer.id], peer.feedVia ? connections[peer.feedVia] : null]) {
        for (const receiver of pc?.getReceivers?.() || []) {
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

  // ================= repasse de carga =================

  #flowing(stream, kind) {
    if (!stream) return false;
    const tracks = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    return tracks.some((t) => t.readyState === 'live' && !t.muted);
  }

  #resetRoutes() {
    this.routes.clear();
    this.relayCap.clear();
    this.badRelays.clear();
    this.load.clear();
    this.lastShift = 0;
    this.offloadedAt = 0;
  }

  // ---- quem repassa ----

  // Repassa a tela de quem transmite aos espectadores que ele indicou para mim.
  #syncRelaying() {
    const wanted = new Map();
    for (const owner of this.peers.values()) {
      const relays = owner.sharing?.relays;
      if (owner.via || !owner.inCall || !relays) continue;
      const sid = owner.sharing.streamId;
      const source = owner.streams.get(sid);
      if (!source || !source.getTracks().some((t) => t.readyState === 'live')) continue;
      // Só repassa quando o vídeo e, se houver, o áudio já chegaram.
      if (owner.sharing.kind === 'screen' && !source.getVideoTracks().length) continue;
      if (owner.sharing.audio && !source.getAudioTracks().length) continue;
      for (const [viewerId, relayId] of Object.entries(relays)) {
        if (relayId !== this.selfId || wanted.size >= TREE_FORWARD_MAX) continue;
        const viewer = this.peers.get(viewerId);
        if (!viewer || viewer.via || !viewer.inCall || blocked(viewerId)) continue;
        wanted.set(`${sid}>${viewerId}`, {
          source, sid, target: viewerId, owner: owner.id, kind: owner.sharing.kind, mode: owner.sharing.mode, tracks: source.getTracks().length,
        });
      }
    }
    for (const [key, f] of [...this.relaying]) {
      const w = wanted.get(key);
      if (w && w.source === f.source && w.tracks === f.tracks) continue;
      if (this.peers.has(f.target)) {
        try { this.room.removeStream(f.stream, { target: f.target }); } catch { /* conexão já fechada */ }
      }
      this.relaying.delete(key);
      this.#log(`Repasse da tela de ${this.#who(f.owner)} para ${this.#who(f.target)} encerrado.`);
    }
    for (const [key, f] of wanted) {
      if (this.relaying.has(key)) continue;
      try {
        // Um MediaStream novo a cada repasse: o Trystero reaproveita o stream antigo quando o
        // mesmo objeto é reenviado ao mesmo destino, e isso deixaria o espectador sem imagem.
        f.stream = new MediaStream(f.source.getTracks());
        this.room.addStream(f.stream, { target: f.target, metadata: { kind: f.kind, relayFrom: f.owner, sid: f.sid } });
        this.relaying.set(key, f);
        this.#log(`Repassando a tela de ${this.#who(f.owner)} para ${this.#who(f.target)}.`);
      } catch (error) { console.warn('Repasse não iniciado:', error); }
    }
  }

  // O que repasso segue o modo de qualidade de quem transmite.
  #tuneRelaying() {
    if (!this.relaying.size) return;
    const connections = this.#connections();
    const kids = new Map();
    for (const f of this.relaying.values()) kids.set(f.owner, (kids.get(f.owner) || 0) + 1);
    for (const f of this.relaying.values()) {
      const pc = connections[f.target];
      if (!pc) continue;
      const hint = (QUALITY[f.mode] || QUALITY.detail).hint;
      const tracks = new Set(f.stream.getTracks());
      for (const track of tracks) {
        if (track.kind !== 'video' || track.contentHint === hint) continue;
        try { track.contentHint = hint; } catch { /* não suportado */ }
      }
      for (const sender of pc.getSenders?.() || []) {
        if (sender.track && tracks.has(sender.track)) this.#tuneSender(sender, sender.track.kind === 'video', f.mode, true, fanoutScale(kids.get(f.owner) || 1));
      }
    }
  }

  // Se o próprio repasse está no limite, avisa quem transmite para reduzir a minha parte.
  #watchRelaying() {
    const targets = [...new Set([...this.relaying.values()].map((f) => f.target))];
    if (!targets.length || !overloaded(targets.map((id) => this.load.get(id)), 1)) return;
    const now = Date.now();
    if (now - (this.lastRelayReport || 0) < 10000) return;
    this.lastRelayReport = now;
    const sids = new Map();
    for (const f of this.relaying.values()) sids.set(f.owner, f.sid);
    for (const [ownerId, sid] of sids) this.#send('feed', { sid, role: 'relay', ok: false, kids: targets.length }, ownerId);
    this.#log(`Meu repasse está no limite (${targets.length} destino(s)); avisando ${[...sids.keys()].map((id) => this.#who(id)).join(', ')}.`);
    for (const id of targets) this.load.delete(id);
  }

  // ---- quem recebe por um repassador ----

  // Confirma a quem transmite que a tela está chegando pelo repassador (ou que parou de chegar).
  #checkRouted(ownerId, fromTick = false) {
    const owner = this.peers.get(ownerId);
    const route = owner?.sharing?.relays?.[this.selfId];
    if (!owner || owner.via || !route || owner.feedVia !== route) return;
    const sid = owner.sharing.streamId;
    const flowing = this.#flowing(owner.relayed?.get(sid), owner.sharing.kind);
    const key = `${sid}:${route}`;
    if (flowing && owner.feedAck !== key) {
      owner.feedAck = key;
      owner.feedBad = 0;
      this.#log(`Recebendo a tela de ${this.#who(owner.id)} pelo repassador ${this.#who(route)}.`);
      this.#send('feed', { sid, role: 'leaf', ok: true }, owner.id);
      this.#emit('peers', {});
    } else if (flowing) {
      owner.feedBad = 0;
    } else if (fromTick && owner.feedAck === key) {
      owner.feedBad = (owner.feedBad || 0) + 1;
      if (owner.feedBad >= 3) {
        owner.feedAck = null;
        this.#log(`A tela de ${this.#who(owner.id)} parou de chegar pelo repassador ${this.#who(route)}.`);
        this.#send('feed', { sid, role: 'leaf', ok: false }, owner.id);
        this.#emit('peers', {});
      }
    }
  }

  // ---- quem transmite ----

  #onFeed(peer, data) {
    const share = this.share;
    if (!share || data.sid !== share.stream.id) return;
    const now = Date.now();
    if (data.role === 'leaf') {
      const route = this.routes.get(peer.id);
      if (!route) return;
      if (data.ok === true) {
        if (!route.confirmed) {
          route.confirmed = true;
          this.#log(`Repasse confirmado: ${this.#who(peer.id)} recebe por ${this.#who(route.relay)} (${Math.round((now - route.since) / 100) / 10} s).`);
          this.#applyQuality();
        }
      } else {
        this.#dropRoute(peer.id, true, 'o espectador deixou de receber');
      }
      return;
    }
    if (data.role === 'relay' && data.ok === false) {
      const kids = [...this.routes].filter(([, e]) => e.relay === peer.id).sort((a, b) => b[1].since - a[1].since);
      if (!kids.length) return;
      // O repassador não aguenta: atende menos gente. Se nem um espectador, deixa de ser usado.
      this.relayCap.set(peer.id, Math.max(0, kids.length - 1));
      if (kids.length === 1) this.badRelays.set(peer.id, now + BAD_RELAY_MS);
      this.lastShift = now;
      this.load.clear();
      this.#log(`${this.#who(peer.id)} avisou que o repasse está no limite (${kids.length} atendido(s)); novo limite ${Math.max(0, kids.length - 1)}.`);
      this.#dropRoute(kids[0][0], false, 'o repassador está no limite');
    }
  }

  #dropRoute(viewerId, markRelayBad, reason = '') {
    const route = this.routes.get(viewerId);
    if (!route) return;
    this.#log(`${this.#who(viewerId)} volta a receber direto de mim${reason ? `: ${reason}` : ''}${markRelayBad ? `; ${this.#who(route.relay)} ficará ${BAD_RELAY_MS / 60000} min sem uso` : ''}.`);
    this.routes.delete(viewerId);
    if (markRelayBad) this.badRelays.set(route.relay, Date.now() + BAD_RELAY_MS);
    this.#applyQuality(); // volta a enviar direto
    this.#broadcastHello();
  }

  // Remove atribuições inválidas. Retorna true se algo mudou (sem enviar nada).
  #pruneRoutes(now) {
    let changed = false;
    for (const [viewerId, route] of [...this.routes]) {
      const viewer = this.peers.get(viewerId);
      const relay = this.peers.get(route.relay);
      const valid = viewer && relay && !viewer.via && !relay.via && viewer.inCall && relay.inCall && relay.canRelay
        && relay.links?.includes(viewerId) && viewer.links?.includes(route.relay);
      if (!valid) {
        this.#log(`${this.#who(viewerId)} volta a receber direto: o repasse por ${this.#who(route.relay)} deixou de ser possível.`);
        this.routes.delete(viewerId);
        changed = true;
      } else if (!route.confirmed && now - route.since > TREE_CONFIRM_MS) {
        // O repassador não entregou a tempo: o espectador segue direto e o repassador é evitado.
        this.#log(`${this.#who(route.relay)} não entregou a tela a ${this.#who(viewerId)} em ${TREE_CONFIRM_MS / 1000} s; fica ${BAD_RELAY_MS / 60000} min sem uso.`);
        this.routes.delete(viewerId);
        this.badRelays.set(route.relay, now + BAD_RELAY_MS);
        changed = true;
      }
    }
    for (const id of [...this.relayCap.keys()]) if (!this.peers.has(id)) this.relayCap.delete(id);
    return changed;
  }

  // Espectadores que recebem a tela direto de mim.
  #directChildren() {
    const sent = this.share ? this.sent.get(this.share.stream.id) : null;
    if (!sent) return [];
    return [...sent].filter((id) => this.peers.get(id)?.inCall && !this.routes.get(id)?.confirmed);
  }

  #linked(a, b) {
    return !!(a.links?.includes(b.id) && b.links?.includes(a.id));
  }

  #kidsOf(relayId) {
    let n = 0;
    for (const e of this.routes.values()) if (e.relay === relayId) n += 1;
    return n;
  }

  // Mede o envio de vídeo de cada conexão: fração do tempo limitado por banda ou processador.
  async #sampleLoad(ids) {
    const now = Date.now();
    const connections = this.#connections();
    let kbps = 0;
    let limited = 0;
    for (const id of ids) {
      let rec = this.load.get(id);
      if (!rec) { rec = { since: now, prev: null, hist: [] }; this.load.set(id, rec); }
      let sample = null;
      const forced = globalThis.__telinhaLoad?.(id); // usado só nos testes automáticos
      if (forced) {
        sample = { frac: forced.frac || 0, cpu: forced.cpu || 0, kbps: forced.kbps || 0 };
      } else {
        const pc = connections[id];
        if (!pc?.getStats) continue;
        let stats;
        try { stats = await pc.getStats(); } catch { continue; }
        let out = null;
        stats.forEach((r) => {
          if (r.type === 'outbound-rtp' && r.kind === 'video' && (!out || (r.bytesSent || 0) > (out.bytesSent || 0))) out = r;
        });
        if (!out) continue;
        const d = out.qualityLimitationDurations;
        const cur = { t: now, bytes: out.bytesSent || 0, none: d?.none ?? 0, cpu: d?.cpu ?? 0, bw: d?.bandwidth ?? 0, other: d?.other ?? 0 };
        const prev = rec.prev;
        rec.prev = cur;
        if (!prev) continue;
        const seconds = (cur.t - prev.t) / 1000;
        const rate = seconds > 0 ? ((cur.bytes - prev.bytes) * 8) / seconds / 1000 : 0;
        if (d) {
          const dc = cur.cpu - prev.cpu;
          const db = cur.bw - prev.bw;
          const total = cur.none - prev.none + dc + db + (cur.other - prev.other);
          // Sem codificação no período (tela parada): não há limitação.
          sample = total < 0.5 ? { frac: 0, cpu: 0, kbps: rate } : { frac: (dc + db) / total, cpu: dc / total, kbps: rate };
        } else {
          const reason = out.qualityLimitationReason;
          sample = { frac: reason === 'cpu' || reason === 'bandwidth' ? 1 : 0, cpu: reason === 'cpu' ? 1 : 0, kbps: rate };
        }
      }
      kbps += sample.kbps;
      if (sample.frac > 0.2) limited += 1;
      // Uma conexão recém-iniciada ainda está subindo a taxa: só é avaliada depois da carência.
      if (now - rec.since >= LOAD_GRACE_MS) {
        rec.hist.push(sample);
        if (rec.hist.length > LOAD_SAMPLES) rec.hist.shift();
      }
    }
    this.lastKbps = kbps;
    // Maior vazão já enviada sem limitação: ajuda a escolher bons repassadores.
    if (kbps > this.uplink && !limited) {
      this.uplink = Math.min(1_000_000, Math.round(kbps));
      this.#saveUplink();
    }
  }

  #saveUplink(force = false) {
    const now = Date.now();
    if (!force && now - this.uplinkSaved < 30000) return;
    this.uplinkSaved = now;
    try { localStorage.setItem(UPLINK_KEY, String(this.uplink)); } catch { /* armazenamento indisponível */ }
  }

  async #loadTick() {
    if (this.loading || this.closed) return;
    this.loading = true;
    try {
      const kids = this.#directChildren();
      const targets = [...new Set([...this.relaying.values()].map((f) => f.target))];
      await this.#sampleLoad([...new Set([...kids, ...targets])]);
      for (const id of [...this.load.keys()]) if (!kids.includes(id) && !targets.includes(id)) this.load.delete(id);
      if (this.share) this.#balance(kids);
      this.#watchRelaying();
      this.summaryTicks = (this.summaryTicks || 0) + 1;
      if (this.summaryTicks % 15 === 0) {
        const attached = this.share ? (this.sent.get(this.share.stream.id)?.size || 0) : 0;
        this.#log(`Resumo: ${kids.length} envio(s) direto(s), ${Math.max(0, attached - kids.length)} em pausa, ${this.routes.size} por repasse, repassando para ${targets.length}; vazão ${Math.round(this.lastKbps || 0)} kbps; maior envio já medido ${this.uplink} kbps.`);
      }
    } catch (error) {
      console.warn('Medição do envio falhou:', error);
    } finally {
      this.loading = false;
    }
  }

  // Decide se é preciso passar espectadores para um repassador e quais.
  #balance(kids) {
    if (!this.share || this.closed) return;
    const now = Date.now();
    let announce = false;
    if (this.#pruneRoutes(now)) { this.#applyQuality(); announce = true; }
    if (this.offloadedAt && this.#placeNewcomers()) announce = true;
    if (now - this.lastShift >= LOAD_COOLDOWN_MS && overloaded(kids.map((id) => this.load.get(id)))) {
      const summary = this.#loadSummary(kids);
      this.#log(`Sobrecarga no envio (${summary}).`);
      if (this.#shift(now)) {
        this.lastShift = now;
        if (!this.offloadedAt) this.offloadedAt = now;
        this.load.clear();
        announce = true;
      } else if (now - (this.lastNoRelayLog || 0) > 60000) {
        this.lastNoRelayLog = now;
        this.#log('Nenhum espectador disponível para repassar.');
      }
    }
    if (announce) this.#broadcastHello();
  }

  #loadSummary(kids) {
    const rows = kids.map((id) => this.load.get(id)).filter(Boolean);
    const mean = (r, key) => (r.hist.length ? r.hist.reduce((sum, x) => sum + x[key], 0) / r.hist.length : 0);
    const kbps = Math.round(rows.reduce((sum, r) => sum + (r.hist.at(-1)?.kbps || 0), 0));
    return `${kids.length} envio(s) direto(s), ${rows.filter((r) => mean(r, 'frac') >= LOAD_LIMITED).length} limitado(s), processador ${rows.some((r) => mean(r, 'cpu') >= LOAD_LIMITED) ? 'no limite' : 'ok'}, vazão ${kbps} kbps`;
  }

  #relayChoices(now) {
    const viewers = [...this.peers.values()].filter((p) => !p.via && p.inCall && p.uid && p.canRelay && !this.routes.has(p.id));
    const relays = new Set([...this.routes.values()].map((e) => e.relay));
    return { viewers, relays, ok: (p) => !(this.badRelays.get(p.id) > now) };
  }

  // Passa espectadores para um repassador. Retorna true se alguma atribuição foi feita.
  #shift(now) {
    const { viewers, relays, ok } = this.#relayChoices(now);
    const levelRank = (p) => (p.net?.level === 'bad' ? 2 : p.net?.level === 'warn' ? 1 : 0);
    const kidsFor = (relay) => viewers
      .filter((v) => v.id !== relay.id && !relays.has(v.id) && this.#linked(relay, v))
      .sort((a, b) => levelRank(b) - levelRank(a) || (a.uid < b.uid ? -1 : 1));
    const assign = (relay, list) => {
      for (const v of list) this.routes.set(v.id, { relay: relay.id, since: now, confirmed: false });
      if (list.length) this.#log(`Repasse: ${list.map((v) => this.#who(v.id)).join(', ')} ${list.length > 1 ? 'passam' : 'passa'} a receber por ${this.#who(relay.id)}${relay.up ? ` (envio já medido ${relay.up} kbps)` : ''}.`);
      return list.length > 0;
    };

    // 1) Repassadores já em uso com vaga.
    for (const relay of viewers.filter((p) => relays.has(p.id) && ok(p))) {
      const spare = (this.relayCap.get(relay.id) ?? TREE_KIDS) - this.#kidsOf(relay.id);
      if (spare > 0 && assign(relay, kidsFor(relay).slice(0, spare))) return true;
    }
    // 2) Um repassador novo, o de melhor envio medido e melhor conexão com quem transmite.
    const fresh = viewers
      .filter((p) => !relays.has(p.id) && ok(p) && p.net?.level !== 'bad' && p.sharing?.kind !== 'screen' && kidsFor(p).length)
      .sort((a, b) => b.up - a.up || levelRank(a) - levelRank(b) || (a.net?.rtt ?? 9999) - (b.net?.rtt ?? 9999) || (a.uid < b.uid ? -1 : 1));
    if (fresh.length) return assign(fresh[0], kidsFor(fresh[0]).slice(0, TREE_KIDS));
    // 3) Sem alternativa: um repassador saudável passa a atender mais uma pessoa.
    for (const relay of viewers.filter((p) => relays.has(p.id) && ok(p))) {
      const cap = this.relayCap.get(relay.id) ?? TREE_KIDS;
      if (cap >= TREE_FORWARD_MAX) continue;
      const kid = kidsFor(relay)[0];
      if (kid) { this.relayCap.set(relay.id, cap + 1); return assign(relay, [kid]); }
    }
    return false;
  }

  // Depois que a carga foi repartida, quem chega vai direto para um repassador com vaga.
  #placeNewcomers() {
    const now = Date.now();
    const { viewers, relays, ok } = this.#relayChoices(now);
    let placed = false;
    for (const v of viewers) {
      if (relays.has(v.id) || v.joinedAt <= this.offloadedAt) continue;
      const relay = viewers.find((r) => relays.has(r.id) && ok(r) && this.#linked(r, v)
        && (this.relayCap.get(r.id) ?? TREE_KIDS) - this.#kidsOf(r.id) > 0);
      if (!relay) continue;
      this.routes.set(v.id, { relay: relay.id, since: now, confirmed: false });
      this.#log(`Quem chegou depois, ${this.#who(v.id)}, vai receber por ${this.#who(relay.id)}.`);
      placed = true;
    }
    return placed;
  }
}

function parseRelays(value) {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).slice(0, 32)
    .filter(([key, relay]) => typeof relay === 'string' && key.length <= 64 && relay.length <= 64)
    .map(([key, relay]) => [key, relay]);
  return entries.length ? Object.fromEntries(entries) : undefined;
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
