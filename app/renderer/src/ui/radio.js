// Rádio da Turma: fila de músicas do YouTube tocando sincronizada para quem está na call.
// Cada computador toca a música sozinho (player oficial do YouTube); a Telinha só
// mantém todos no mesmo ponto.
import { $, h, icon, toast, bridge, showPopover, repositionPopover } from './dom.js';

const DRIFT_LIMIT = 1.6; // segundos
const TICK_MS = 5000;

export function youtubeId(text) {
  const s = String(text || '').trim();
  const patterns = [
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)([\w-]{11})/,
    /music\.youtube\.com\/watch\?(?:.*&)?v=([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return /^[\w-]{11}$/.test(s) ? s : null;
}

// Player do app (YouTube escondido no processo principal)
class BridgePlayer {
  load(videoId, at, playing) { return bridge.radioLoad({ videoId, at, playing }); }
  play() { return bridge.radioCommand('play'); }
  pause() { return bridge.radioCommand('pause'); }
  seek(t) { return bridge.radioCommand('seek', t); }
  volume(v) { return bridge.radioCommand('volume', v); }
  status() { return bridge.radioStatus(); }
  stop() { return bridge.radioStop(); }
}

// Player simulado (testes no navegador, sem YouTube)
class FakePlayer {
  constructor() { this.t = 0; this.d = 200; this.paused = true; this.at = 0; this.videoId = null; }
  #now() { return this.paused ? this.t : this.t + (performance.now() - this.at) / 1000; }
  async load(videoId, at, playing) { this.videoId = videoId; this.t = at; this.at = performance.now(); this.paused = !playing; window.__radioLoads = (window.__radioLoads || 0) + 1; }
  async play() { this.t = this.#now(); this.at = performance.now(); this.paused = false; }
  async pause() { this.t = this.#now(); this.paused = true; }
  async seek(t) { this.t = t; this.at = performance.now(); }
  async volume() {}
  async status() { if (!this.videoId) return null; const t = Math.min(this.#now(), this.d); return { t, d: this.d, paused: this.paused, ended: t >= this.d, ad: false }; }
  async stop() { this.videoId = null; }
}

export class Radio {
  // app: { session(), uid, name(), settings(), saveSettings(patch), speaking() }
  constructor(app) {
    this.app = app;
    this.pop = $('radioPop');
    this.player = bridge ? new BridgePlayer() : new FakePlayer();
    this.loadedId = null;
    this.playing = false;
    this.anchor = null;
    this.last = null;
    this.lastTick = 0;
    this.ducked = false;
    this.busy = false;
    this.timer = setInterval(() => this.#poll(), 1000);
  }

  attach(session) {
    this.session = session;
    session.radioPosition = () => this.position();
    session.addEventListener('radio', (e) => this.#onState(e.detail));
    session.addEventListener('call', () => this.apply());
  }

  detach() {
    this.session = null;
    this.#stopPlayer();
  }

  get state() {
    return this.session?.radio || { queue: [], current: null };
  }

  position() {
    const cur = this.state.current;
    if (!cur) return 0;
    if (this.loadedId === cur.id && this.last) return this.last.t;
    return this.#target() ?? cur.pos ?? 0;
  }

  #target() {
    const cur = this.state.current;
    if (!cur || !this.anchor || this.anchor.id !== cur.id) return null;
    return this.anchor.pos + (cur.playing ? (performance.now() - this.anchor.at) / 1000 : 0);
  }

  #onState({ radio, local, tick }) {
    const cur = radio.current;
    if (cur && !(tick && this.anchor?.id === cur.id && local)) {
      // latência estimada da mensagem
      this.anchor = { id: cur.id, pos: cur.pos + (local ? 0 : 0.15), at: performance.now() };
    }
    if (!cur) this.anchor = null;
    this.apply(tick);
    this.render();
    this.app.onRadioChange?.();
  }

  async apply(tick = false) {
    if (this.busy) { this.pending = true; return; }
    const session = this.session;
    const cur = this.state.current;
    if (!session || !session.inCall || !cur) { await this.#stopPlayer(); return; }
    this.busy = true;
    try {
      const target = this.#target() ?? cur.pos ?? 0;
      if (this.loadedId !== cur.id) {
        this.loadedId = cur.id;
        this.last = null;
        await this.player.load(cur.videoId, target, cur.playing);
        await this.#applyVolume(true);
        this.playing = cur.playing;
      } else {
        if (cur.playing !== this.playing) {
          this.playing = cur.playing;
          if (cur.playing) { await this.player.seek(target); await this.player.play(); } else await this.player.pause();
        } else if (tick || cur.playing) {
          const status = await this.player.status();
          if (status && !status.ad && Math.abs(status.t - target) > DRIFT_LIMIT) await this.player.seek(target);
        }
      }
    } finally {
      this.busy = false;
      if (this.pending) { this.pending = false; this.apply(); }
    }
  }

  async #stopPlayer() {
    if (!this.loadedId) return;
    this.loadedId = null;
    this.playing = false;
    this.last = null;
    await this.player.stop();
  }

  #leader() {
    const session = this.session;
    if (!session?.inCall) return false;
    const uids = [session.uid, ...[...session.peers.values()].filter((p) => p.inCall && p.uid).map((p) => p.uid)];
    return uids.sort()[0] === session.uid;
  }

  async #poll() {
    const cur = this.state.current;
    if (!this.session || !cur || this.loadedId !== cur.id) return;
    const status = await this.player.status();
    if (!status) return;
    this.last = status;
    // Reaplica o volume (o rádio abaixa quando alguém fala)
    const duck = !!this.app.speaking?.();
    if (duck !== this.ducked) { this.ducked = duck; this.#applyVolume(); }
    if (!this.#leader()) return;
    const ended = status.ended || (status.d > 0 && status.t >= status.d - 0.4 && !status.ad);
    if (ended && cur.playing) { this.next(); return; }
    if (cur.playing && !status.ad && performance.now() - this.lastTick > TICK_MS) {
      this.lastTick = performance.now();
      this.anchor = { id: cur.id, pos: status.t, at: performance.now() };
      this.session.sendRadioTick(status.t);
    }
    if (!this.pop.hidden) this.#renderProgress();
  }

  async #applyVolume(force) {
    const base = this.app.settings().radioVolume ?? 0.6;
    const v = this.ducked ? base * 0.35 : base;
    if (force || this.loadedId) await this.player.volume(v);
  }

  // ---- ações ----

  async add(text) {
    const session = this.session;
    if (!session) return false;
    const videoId = youtubeId(text);
    if (!videoId) { toast('Cole um link do YouTube.'); return false; }
    const info = bridge ? await bridge.radioInfo(videoId).catch(() => null) : null;
    const item = { id: Math.random().toString(36).slice(2, 10), videoId, title: info?.title || 'Vídeo do YouTube', by: this.app.name() };
    const { queue, current } = this.state;
    if (!current) {
      this.anchor = { id: item.id, pos: 0, at: performance.now() };
      session.setRadio({ queue: [...queue], current: { ...item, pos: 0, playing: true } });
    } else {
      session.setRadio({ queue: [...queue, item].slice(0, 50), current: { ...current, pos: this.position() } });
    }
    if (!session.inCall) toast('Adicionada ao rádio. Entre na call para ouvir.');
    else toast(current ? 'Adicionada à fila.' : 'Tocando no rádio da turma.');
    return true;
  }

  toggle() {
    const cur = this.state.current;
    if (!cur || !this.session) return;
    const pos = this.position();
    this.anchor = { id: cur.id, pos, at: performance.now() };
    this.session.setRadio({ queue: [...this.state.queue], current: { ...cur, pos, playing: !cur.playing } });
  }

  next() {
    if (!this.session) return;
    const [nextItem, ...rest] = this.state.queue;
    if (nextItem) this.anchor = { id: nextItem.id, pos: 0, at: performance.now() };
    this.session.setRadio({ queue: rest, current: nextItem ? { ...nextItem, pos: 0, playing: true } : null });
  }

  remove(id) {
    if (!this.session) return;
    const cur = this.state.current;
    this.session.setRadio({ queue: this.state.queue.filter((q) => q.id !== id), current: cur ? { ...cur, pos: this.position() } : null });
  }

  setVolume(v) {
    this.app.saveSettings({ radioVolume: v });
    this.#applyVolume();
  }

  // ---- interface ----

  open(anchor) {
    this.render(true);
    showPopover(this.pop, anchor, { place: 'above', align: 'center' });
  }

  get active() {
    return !!this.state.current;
  }

  render(force = false) {
    if (this.pop.hidden && !force) return;
    const { queue, current } = this.state;
    const inCall = !!this.session?.inCall;
    const form = h('form.join.compact', {
      autocomplete: 'off',
      on: {
        submit: async (e) => {
          e.preventDefault();
          const input = e.target.querySelector('input');
          if (await this.add(input.value)) input.value = '';
        },
      },
    }, h('input', { placeholder: 'Cole um link do YouTube', spellcheck: 'false', 'aria-label': 'Link do YouTube' }), h('button.btn.small', { type: 'submit' }, 'Adicionar'));

    const parts = [h('div.pop-title', {}, 'Rádio da turma'), form];
    if (current) {
      parts.push(h('div.now-playing', {},
        h('img.thumb', { src: `https://i.ytimg.com/vi/${current.videoId}/mqdefault.jpg`, alt: '' }),
        h('div.np-info', {},
          h('div.np-title', { title: current.title }, current.title),
          h('div.np-by', {}, `pedida por ${current.by || 'alguém'}`),
          h('div.np-progress', {}, h('span', { id: 'npBar' }))),
        h('div.np-controls', {},
          h('button.icon-btn', { type: 'button', title: current.playing ? 'Pausar' : 'Tocar', on: { click: () => this.toggle() } }, icon(current.playing ? 'pause' : 'play', 17)),
          h('button.icon-btn', { type: 'button', title: 'Pular', on: { click: () => this.next() } }, icon('skip', 17)))));
    } else {
      parts.push(h('p.pop-empty', {}, 'Nada tocando. Cole um link para começar.'));
    }
    if (queue.length) {
      parts.push(h('div.pop-sub', {}, `A seguir (${queue.length})`));
      parts.push(h('ul.queue', {}, queue.map((q) => h('li', {},
        h('span.q-title', { title: q.title }, q.title),
        h('span.q-by', {}, q.by),
        h('button.icon-btn.small', { type: 'button', title: 'Remover', on: { click: () => this.remove(q.id) } }, icon('close', 13))))));
    }
    const volume = h('input.volume.wide', { type: 'range', min: '0', max: '1', step: '0.02', value: String(this.app.settings().radioVolume ?? 0.6), 'aria-label': 'Volume do rádio' });
    volume.addEventListener('input', () => this.setVolume(Number(volume.value)));
    parts.push(h('div.radio-volume', {}, icon('volume', 16), volume));
    if (!inCall) parts.push(h('small.pop-hint', {}, 'O rádio toca para quem está na call.'));
    else parts.push(h('small.pop-hint', {}, 'O volume abaixa sozinho quando alguém fala.'));
    this.pop.replaceChildren(...parts);
    repositionPopover(this.pop);
    this.#renderProgress();
  }

  #renderProgress() {
    const bar = document.getElementById('npBar');
    if (!bar || !this.last?.d) return;
    bar.style.width = `${Math.min(100, (this.last.t / this.last.d) * 100)}%`;
  }
}
