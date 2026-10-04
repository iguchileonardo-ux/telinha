// Call: entrada/saída, microfone, quem está falando, telas, só-som, desenho com permissão.
import { $, h, icon, avatar, toast, listNames, bridge } from './dom.js';
import { Stage } from '../stage.js';
import { watchLevel } from '../audio.js';
import { hexColorFor } from '../annotate.js';

export class CallView {
  // app: { session(), settings(), saveVolume, toggleShare(), onSpeakingChange() }
  constructor(app) {
    this.app = app;
    this.sinks = new Map(); // streamId -> { audio, stop, uid }
    this.speaking = new Set();
    this.drawPending = new Set(); // peerIds a quem pedi para desenhar
    this.requests = new Map(); // peerId -> { name }
    this.myColor = hexColorFor(app.settings().userId);

    this.stage = new Stage($('stage'), {
      myColor: this.myColor,
      onPointer: (peerId, x, y) => this.app.session()?.sendPointer(peerId, x, y),
      onStroke: (peerId, stroke) => this.app.session()?.sendStroke(peerId, stroke),
      onDrawRequest: (peerId) => {
        this.app.session()?.requestDraw(peerId);
        this.drawPending.add(peerId);
        toast('Pedido enviado. Aguardando quem está transmitindo.');
        this.render();
      },
      onVolume: (peerId, v) => {
        const peer = this.app.session()?.peers.get(peerId);
        if (peer?.uid) this.app.saveVolume(`${peer.uid}:tela`, v);
      },
    });

    $('joinCallBtn').addEventListener('click', () => this.app.session()?.joinCall({ withMic: true }));
    $('joinMutedBtn').addEventListener('click', () => this.app.session()?.joinCall({ withMic: false }));
    $('leaveCallBtn').addEventListener('click', () => this.app.session()?.leaveCall());
    $('micBtn').addEventListener('click', () => this.toggleMute());
    $('shareBtn').addEventListener('click', () => this.app.toggleShare());
  }

  toggleMute() {
    const session = this.app.session();
    if (!session?.inCall) return;
    session.setMuted(!session.muted);
  }

  attach(session) {
    session.addEventListener('pointer', (e) => this.#onPointer(e.detail));
    session.addEventListener('stroke', (e) => this.#onStroke(e.detail));
    session.addEventListener('draw-request', (e) => this.#onDrawRequest(e.detail));
    session.addEventListener('draw-response', (e) => {
      const { peerId, allow, name } = e.detail;
      this.drawPending.delete(peerId);
      toast(allow ? `${name} permitiu que você desenhe na tela dele.` : `${name} não permitiu desenhar agora.`);
      this.render();
    });
  }

  detach() {
    this.#stopMuteWatch();
    this.stage.clear();
    for (const sink of this.sinks.values()) this.#dropSink(sink);
    this.sinks.clear();
    this.stopSelfMeter?.();
    this.speaking.clear();
    this.drawPending.clear();
    this.requests.clear();
    $('drawRequests').replaceChildren();
  }

  // ---------- renderização ----------

  render() {
    const session = this.app.session();
    if (!session) return;
    const peers = [...session.peers.values()];
    const inCall = peers.filter((p) => p.inCall && p.uid);
    const settings = this.app.settings();

    // Telas recebidas (só para quem está na call)
    const screens = session.inCall
      ? inCall.filter((p) => p.sharing?.kind === 'screen' && session.shareOf(p))
      : [];
    for (const id of [...this.drawPending]) {
      const peer = session.peers.get(id);
      if (!peer?.sharing || session.canDrawOn(peer)) this.drawPending.delete(id);
    }
    this.stage.sync(screens.map((p) => ({
      id: p.id,
      name: p.name,
      stream: session.shareOf(p),
      volume: settings.volumes?.[`${p.uid}:tela`] ?? 1,
      draw: session.canDrawOn(p) ? 'allowed' : this.drawPending.has(p.id) ? 'pending' : 'none',
    })));

    this.#syncAudio(session, inCall, settings);

    // Lobby (fora da call)
    $('lobby').hidden = session.inCall;
    $('dock').hidden = !session.inCall;
    if (!session.inCall) {
      const lobbyPeople = $('lobbyPeople');
      lobbyPeople.replaceChildren(...inCall.slice(0, 6).map((p) => avatar({ uid: p.uid, name: p.name, hash: p.avatar }, 44, this.speaking.has(p.uid) ? 'speaking' : '')));
      $('lobbyTitle').textContent = inCall.length ? `${listNames(inCall.map((p) => p.name))} ${inCall.length === 1 ? 'está' : 'estão'} na call` : 'Ninguém na call';
      const sharing = inCall.filter((p) => p.sharing);
      $('lobbyText').textContent = sharing.length
        ? `${listNames(sharing.map((p) => p.name))} ${sharing.length === 1 ? 'está transmitindo' : 'estão transmitindo'}. Entre para assistir.`
        : 'Entre para conversar por voz, compartilhar a tela ou ouvir o rádio.';
    }

    // Pessoas na call
    const people = $('people');
    people.hidden = !session.inCall;
    people.classList.toggle('compact', screens.length > 0);
    if (session.inCall) {
      const me = { uid: settings.userId, name: settings.name || 'Você', hash: session.avatarHash, muted: session.muted, sharing: session.sharing, me: true };
      const everyone = [me, ...inCall.map((p) => ({ uid: p.uid, name: p.name, hash: p.avatar, muted: p.muted, sharing: !!p.sharing, net: p.net }))];
      const size = people.classList.contains('compact') ? 30 : 76;
      people.replaceChildren(...everyone.map((m) => h(`div.person${this.speaking.has(m.uid) ? '.speaking' : ''}`, { title: personTitle(m) },
        avatar(m, size),
        h('span.person-name', {}, m.me ? 'Você' : m.name),
        netBadge(m.net),
        m.muted ? h('span.person-muted', { title: 'Sem microfone' }, icon('micOff', 13)) : null)));
    }

    // Só-som (música de alguém)
    const audioShares = inCall.filter((p) => p.sharing?.kind === 'audio');
    $('audioShares').replaceChildren(...(session.inCall ? audioShares : []).map((p) => {
      const volume = h('input.volume', { type: 'range', min: '0', max: '1', step: '0.02', value: String(settings.volumes?.[`${p.uid}:tela`] ?? 1), 'aria-label': `Volume do som de ${p.name}` });
      volume.addEventListener('input', () => {
        this.app.saveVolume(`${p.uid}:tela`, Number(volume.value));
        this.#syncAudio(session, inCall, this.app.settings());
      });
      return h('div.audio-share', {}, icon('music', 15), h('span', {}, `${p.name}: ${p.sharing.label || 'som do computador'}`), volume);
    }));

    // Dock
    const mic = $('micBtn');
    mic.replaceChildren(icon(session.muted ? 'micOff' : 'mic'));
    mic.classList.toggle('off', session.muted);
    mic.title = session.muted ? 'Ligar microfone (M)' : 'Desligar microfone (M)';
    const share = $('shareBtn');
    share.replaceChildren(icon(session.sharing ? 'stop' : 'monitor', 17), session.sharing ? 'Parar' : 'Compartilhar');
    share.classList.toggle('stop', session.sharing);

    // Prévia da própria transmissão
    $('selfPreview').hidden = !session.sharing;
    const selfVideo = $('selfVideo');
    const local = session.share?.kind === 'screen' ? session.localStream : null;
    selfVideo.hidden = !local;
    if (selfVideo.srcObject !== local) selfVideo.srcObject = local;
    const allowed = [...session.drawAllow];
    $('drawAllowed').replaceChildren(...allowed.map((uid) => {
      const p = session.peerByUid(uid);
      return h('button.chip', { type: 'button', title: 'Tirar permissão de desenhar', on: { click: () => session.revokeDraw(uid) } }, icon('pen', 12), p?.name || 'alguém', icon('close', 12));
    }));

    this.#renderRequests();
    this.#muteWatch(session);
  }

  // Avisa quando a pessoa fala com o microfone desligado.
  #muteWatch(session) {
    const track = session.micStream?.getAudioTracks()[0];
    const want = session.inCall && session.muted && track?.readyState === 'live';
    if (!want) { this.#stopMuteWatch(); return; }
    if (this.muteSource === track) return;
    this.#stopMuteWatch();
    const clone = track.clone();
    clone.enabled = true;
    this.muteSource = track;
    this.muteTrack = clone;
    let since = 0;
    this.muteStop = watchLevel(new MediaStream([clone]), (level) => {
      if (level < 0.08) { since = 0; return; }
      since ||= performance.now();
      if (performance.now() - since > 800 && Date.now() - (this.muteWarned || 0) > 30000) {
        this.muteWarned = Date.now();
        toast('Seu microfone está desligado. Aperte M para falar.', 3500);
      }
    });
  }

  #stopMuteWatch() {
    this.muteStop?.();
    this.muteTrack?.stop();
    this.muteStop = null;
    this.muteTrack = null;
    this.muteSource = null;
  }

  setShareInfo(label, stream) {
    $('selfLabel').textContent = label;
    this.stopSelfMeter?.();
    this.stopSelfMeter = null;
    const bar = $('selfLevel');
    bar.hidden = !stream?.getAudioTracks().length;
    if (!bar.hidden) {
      this.stopSelfMeter = watchLevel(stream, (level) => {
        bar.firstElementChild.style.transform = `scaleX(${level.toFixed(3)})`;
      });
    }
  }

  clearShareInfo() {
    this.stopSelfMeter?.();
    this.stopSelfMeter = null;
    $('selfLevel').hidden = true;
  }

  // ---------- áudio (vozes e só-som) ----------

  #syncAudio(session, inCall, settings) {
    const wanted = new Map();
    if (session.inCall) {
      for (const p of inCall) {
        const mic = session.micOf(p);
        if (mic?.getAudioTracks().length) wanted.set(mic.id, { stream: mic, uid: p.uid, volume: settings.volumes?.[p.uid] ?? 1, voice: true });
        if (p.sharing?.kind === 'audio') {
          const s = session.shareOf(p);
          if (s?.getAudioTracks().length) wanted.set(s.id, { stream: s, uid: p.uid, volume: settings.volumes?.[`${p.uid}:tela`] ?? 1, voice: false });
        }
      }
      if (session.micStream && !session.muted) wanted.set(`self:${session.micStream.id}`, { stream: session.micStream, uid: settings.userId, self: true, voice: true });
    }
    for (const [id, sink] of this.sinks) {
      if (!wanted.has(id) || wanted.get(id).stream !== sink.stream) { this.#dropSink(sink); this.sinks.delete(id); }
    }
    for (const [id, want] of wanted) {
      let sink = this.sinks.get(id);
      if (!sink) {
        sink = { stream: want.stream, uid: want.uid, stop: () => {}, audio: null };
        if (!want.self) {
          sink.audio = h('audio', { autoplay: true });
          sink.audio.srcObject = want.stream;
          $('audioSink').append(sink.audio);
          sink.audio.play().catch(() => {});
        }
        if (want.voice) {
          sink.stop = watchLevel(want.stream, (level) => this.#speaking(want.uid, level > 0.045));
        }
        this.sinks.set(id, sink);
      }
      if (sink.audio) sink.audio.volume = Math.max(0, Math.min(1, want.volume ?? 1));
    }
  }

  #dropSink(sink) {
    sink.stop?.();
    if (sink.audio) { sink.audio.srcObject = null; sink.audio.remove(); }
    this.#speaking(sink.uid, false);
  }

  #speaking(uid, on) {
    if (!uid) return;
    const had = this.speaking.has(uid);
    if (on === had) return;
    if (on) this.speaking.add(uid);
    else {
      // segura um pouco para não piscar
      clearTimeout(this.speakTimers?.[uid]);
      this.speakTimers ??= {};
      this.speakTimers[uid] = setTimeout(() => {
        this.speaking.delete(uid);
        this.app.onSpeakingChange();
      }, 350);
      return;
    }
    clearTimeout(this.speakTimers?.[uid]);
    this.app.onSpeakingChange();
  }

  // ---------- ponteiro e desenho ----------

  #onPointer({ from, to, x, y, hide }) {
    const session = this.app.session();
    if (!session) return;
    const color = hexColorFor(from.uid);
    if (to === session.selfId) {
      bridge?.overlayEvent({ type: 'pointer', id: from.id, name: from.name, color, x, y, hide });
      return;
    }
    this.stage.tile(to)?.annotator.pointer(from.id, from.name, color, x, y, hide);
  }

  #onStroke({ from, to, id, pts, done }) {
    const session = this.app.session();
    if (!session) return;
    const color = hexColorFor(from.uid);
    const key = `${from.id}:${id}`;
    if (to === session.selfId) {
      bridge?.overlayEvent({ type: 'stroke', key, pts, color, done });
      return;
    }
    this.stage.tile(to)?.annotator.stroke(key, pts, color, done);
  }

  #onDrawRequest({ peerId, name }) {
    this.requests.set(peerId, { name });
    this.#renderRequests();
    if (!document.hasFocus() && 'Notification' in window) {
      try {
        const n = new Notification('Telinha', { body: `${name} quer desenhar na sua tela.`, silent: true });
        n.onclick = () => bridge?.focus();
      } catch { /* notificações indisponíveis */ }
    }
  }

  #renderRequests() {
    const session = this.app.session();
    const box = $('drawRequests');
    box.replaceChildren(...[...this.requests].map(([peerId, { name }]) => h('div.request', {},
      icon('pen', 15),
      h('span', {}, `${name} quer desenhar na sua tela`),
      h('button.btn.ghost.small', { type: 'button', on: { click: () => { session?.answerDraw(peerId, false); this.requests.delete(peerId); this.#renderRequests(); } } }, 'Recusar'),
      h('button.btn.primary.small', { type: 'button', on: { click: () => { session?.answerDraw(peerId, true); this.requests.delete(peerId); this.#renderRequests(); } } }, 'Permitir'))));
  }
}

// ---------- qualidade da conexão ----------

const PATH_TEXT = { direto: 'conexão direta', turn: 'pelo servidor TURN', ponte: 'pela ponte' };
const LEVEL_TEXT = { ok: 'Conexão boa', warn: 'Conexão instável', bad: 'Conexão ruim' };

function personTitle(m) {
  if (m.me || !m.net) return m.name;
  const parts = [LEVEL_TEXT[m.net.level], PATH_TEXT[m.net.path]];
  if (m.net.rtt != null) parts.push(`${m.net.rtt} ms`);
  if (m.net.loss >= 0.01) parts.push(`${Math.round(m.net.loss * 100)}% de perda`);
  return `${m.name}\n${parts.join(' · ')}`;
}

// Só aparece quando há algo a notar: conexão instável/ruim ou pela ponte.
function netBadge(net) {
  if (!net || (net.level === 'ok' && net.path !== 'ponte')) return null;
  return h(`span.person-net.${net.level}`, {}, net.path === 'ponte' ? icon('link', 10) : null);
}
