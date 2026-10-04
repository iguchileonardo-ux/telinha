// Sessão de uma sala: descoberta dos amigos (Trystero) e transmissão das telas (WebRTC).
//
// Dois modos de sinalização, com a mesma API:
//   - 'auto':   relays públicos da rede Nostr, sem servidor próprio;
//   - 'server': um servidor WebSocket próprio (pasta server/ do projeto).
// O vídeo sempre vai direto entre os computadores (ou pelo TURN, se configurado).
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

const APP_ID = 'telinha-app-v1-7d3f91c2';

const QUALITY = {
  detail: { frameRate: 30, maxBitrate: 6_000_000, hint: 'detail' },
  motion: { frameRate: 60, maxBitrate: 9_000_000, hint: 'motion' },
};

export class RoomSession extends EventTarget {
  constructor({ code, settings }) {
    super();
    this.code = code;
    this.settings = settings;
    this.selfId = selfId;
    this.peers = new Map();
    this.localStream = null;
    this.quality = settings.quality in QUALITY ? settings.quality : 'detail';
    this.signalingOnline = false;
    this.closed = false;

    const config = {
      appId: APP_ID,
      // A senha deriva do código: as mensagens de conexão vão cifradas pelos relays.
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
      this.room = joinNostr({ ...config, relayConfig: { warnOnRelayFailure: false } }, code, callbacks);
      this.sockets = nostrSockets;
    }

    this.stateAction = this.room.makeAction('state');
    this.stateAction.onMessage = (data, { peerId }) => this.#onState(peerId, data);

    this.room.onPeerJoin = (peerId) => this.#onJoin(peerId);
    this.room.onPeerLeave = (peerId) => this.#onLeave(peerId);
    this.room.onPeerStream = (stream, peerId) => this.#onStream(stream, peerId);

    this.timer = setInterval(() => this.#tick(), 2000);
    this.#tick();
  }

  // ---- API usada pela interface ----

  get name() {
    return this.settings.name.trim() || 'Sem nome';
  }

  get sharing() {
    return !!this.localStream;
  }

  setName(name) {
    this.settings = { ...this.settings, name };
    this.#broadcastState();
  }

  setQuality(quality) {
    if (!(quality in QUALITY)) return;
    this.quality = quality;
    if (this.localStream) this.#applyQuality();
  }

  async startShare(stream) {
    if (this.closed) { stream.getTracks().forEach((t) => t.stop()); return; }
    if (this.localStream) this.stopShare();
    this.localStream = stream;
    const video = stream.getVideoTracks()[0];
    video?.addEventListener('ended', () => {
      if (this.localStream === stream) this.stopShare();
    });
    this.#applyQuality();
    this.room.addStream(stream, { metadata: { kind: 'screen' } });
    this.#broadcastState();
    this.#emit('share', { sharing: true });
  }

  stopShare() {
    const stream = this.localStream;
    if (!stream) return;
    this.localStream = null;
    try { this.room.removeStream(stream); } catch { /* a conexão pode já ter caído */ }
    stream.getTracks().forEach((t) => t.stop());
    this.#broadcastState();
    this.#emit('share', { sharing: false });
  }

  async leave() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.peers.clear();
    try { await this.room.leave(); } catch { /* ignorado */ }
  }

  // Retorna a transmissão visível de um amigo (ou null se ele não está compartilhando).
  streamOf(peer) {
    if (!peer.sharing || !peer.stream) return null;
    if (peer.streamId && peer.stream.id !== peer.streamId) return null;
    if (!peer.stream.getVideoTracks().length) return null;
    return peer.stream;
  }

  // ---- eventos internos ----

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #changed() {
    this.#emit('peers', { peers: [...this.peers.values()] });
  }

  #myState() {
    return {
      name: this.name.slice(0, 32),
      sharing: !!this.localStream,
      streamId: this.localStream?.id ?? null,
    };
  }

  #broadcastState() {
    if (this.closed) return;
    this.stateAction.send(this.#myState()).catch(() => {});
  }

  #peer(peerId) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { id: peerId, name: null, sharing: false, streamId: null, stream: null, joinedAt: Date.now() };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  #onJoin(peerId) {
    if (this.closed) return;
    this.#peer(peerId);
    this.stateAction.send(this.#myState(), { target: peerId }).catch(() => {});
    if (this.localStream) {
      this.room.addStream(this.localStream, { target: peerId, metadata: { kind: 'screen' } });
    }
    this.#changed();
  }

  #onLeave(peerId) {
    if (!this.peers.delete(peerId)) return;
    this.#changed();
  }

  #onState(peerId, data) {
    if (this.closed || !data || typeof data !== 'object') return;
    const peer = this.#peer(peerId);
    peer.name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 32) : 'Sem nome';
    peer.sharing = data.sharing === true;
    peer.streamId = typeof data.streamId === 'string' ? data.streamId : null;
    if (!peer.sharing) peer.stream = null;
    this.#changed();
  }

  #onStream(stream, peerId) {
    if (this.closed) return;
    const peer = this.#peer(peerId);
    peer.stream = stream;
    stream.addEventListener('addtrack', () => this.#changed());
    stream.addEventListener('removetrack', () => this.#changed());
    this.#changed();
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
    if (this.localStream) this.#applyQuality();
  }

  // Ajusta qualidade do vídeo enviado: taxa de quadros e taxa de bits por conexão.
  #applyQuality() {
    const stream = this.localStream;
    const video = stream?.getVideoTracks()[0];
    if (!video) return;
    const q = QUALITY[this.quality];
    if (video.contentHint !== q.hint) {
      video.contentHint = q.hint;
      video.applyConstraints({ frameRate: { ideal: q.frameRate, max: q.frameRate } }).catch(() => {});
    }
    let peers = {};
    try { peers = this.room.getPeers() || {}; } catch { peers = {}; }
    for (const pc of Object.values(peers)) {
      for (const sender of pc.getSenders?.() || []) {
        if (sender.track !== video) continue;
        const params = sender.getParameters();
        const encoding = params.encodings?.[0];
        if (!encoding) continue;
        if (encoding.maxBitrate === q.maxBitrate && encoding.maxFramerate === q.frameRate) continue;
        encoding.maxBitrate = q.maxBitrate;
        encoding.maxFramerate = q.frameRate;
        sender.setParameters(params).catch(() => {});
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
