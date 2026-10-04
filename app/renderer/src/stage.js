// Palco: telas recebidas em grade, com foco, tela cheia, ponteiro e desenho.
import { icon } from './icons.js';
import { watchLevel } from './audio.js';
import { Annotator } from './annotate.js';

const GAP = 12;

export class Stage {
  // hooks: { onPointer, onStroke, onDrawRequest, onVolume, myColor }
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    this.grid = document.createElement('div');
    this.grid.className = 'grid';
    this.strip = document.createElement('div');
    this.strip.className = 'strip';
    root.append(this.grid, this.strip);
    this.tiles = new Map();
    this.focusId = null;
    new ResizeObserver(() => this.layout()).observe(root);
  }

  get size() {
    return this.tiles.size;
  }

  tile(id) {
    return this.tiles.get(id) || null;
  }

  // items: [{ id, name, stream, draw: 'none' | 'pending' | 'allowed', volume }]
  sync(items) {
    const wanted = new Set(items.map((i) => i.id));
    for (const id of [...this.tiles.keys()]) {
      if (!wanted.has(id)) this.#remove(id);
    }
    for (const item of items) {
      const tile = this.tiles.get(item.id) || this.#create(item);
      tile.setName(item.name);
      tile.setStream(item.stream);
      tile.setDraw(item.draw || 'none');
    }
    if (this.focusId && !this.tiles.has(this.focusId)) this.focusId = null;
    this.layout();
  }

  clear() {
    for (const id of [...this.tiles.keys()]) this.#remove(id);
    this.focusId = null;
    this.layout();
  }

  toggleFocus(id) {
    this.focusId = this.focusId === id || this.tiles.size < 2 ? null : id;
    this.layout();
  }

  layout() {
    const tiles = [...this.tiles.values()];
    const focused = this.focusId && tiles.length > 1 ? this.tiles.get(this.focusId) : null;
    this.root.classList.toggle('focus', !!focused);

    if (focused) {
      if (focused.el.parentElement !== this.grid) this.grid.append(focused.el);
      for (const t of tiles) {
        t.el.classList.toggle('focused', t === focused);
        if (t !== focused && t.el.parentElement !== this.strip) this.strip.append(t.el);
      }
      this.grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
      this.grid.style.gridTemplateRows = 'minmax(0, 1fr)';
      return;
    }

    for (const t of tiles) {
      t.el.classList.remove('focused');
      if (t.el.parentElement !== this.grid) this.grid.append(t.el);
    }
    const n = tiles.length;
    if (!n) return;
    const { width, height } = this.grid.getBoundingClientRect();
    let best = { cols: 1, rows: n, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = (width - GAP * (cols - 1)) / cols;
      const hgt = (height - GAP * (rows - 1)) / rows;
      const size = Math.min(w, (hgt * 16) / 9);
      if (size > best.size) best = { cols, rows, size };
    }
    const w = Math.max(0, Math.floor(best.size));
    const hgt = Math.max(0, Math.floor((best.size * 9) / 16));
    this.grid.style.gridTemplateColumns = `repeat(${best.cols}, ${w}px)`;
    this.grid.style.gridTemplateRows = `repeat(${best.rows}, ${hgt}px)`;
  }

  #remove(id) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.destroy();
    this.tiles.delete(id);
  }

  #create({ id, name, volume }) {
    const tile = new Tile(id, name, volume ?? 1, {
      onFocus: () => this.toggleFocus(id),
      ...this.hooks,
    });
    this.tiles.set(id, tile);
    this.grid.append(tile.el);
    return tile;
  }
}

class Tile {
  constructor(id, name, volume, hooks) {
    this.id = id;
    this.hooks = hooks;
    this.stream = null;
    this.volume = volume;
    this.meterTracks = 0;
    this.stopMeter = () => {};
    this.mode = null; // null | 'pointer' | 'draw'
    this.draw = 'none';
    this.stroke = null;

    const el = document.createElement('div');
    el.className = 'tile';
    el.tabIndex = 0;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;

    const canvas = document.createElement('canvas');
    canvas.className = 'ink';

    const label = document.createElement('span');
    label.className = 'tile-name';

    const tools = document.createElement('div');
    tools.className = 'tile-tools';
    const pointerBtn = this.#button('pointer', 'Ponteiro', () => this.#setMode(this.mode === 'pointer' ? null : 'pointer'));
    const penBtn = this.#button('pen', 'Desenhar', () => {
      if (this.draw === 'allowed') this.#setMode(this.mode === 'draw' ? null : 'draw');
      else if (this.draw === 'none') this.hooks.onDrawRequest?.(this.id);
    });
    tools.append(pointerBtn, penBtn);

    const controls = document.createElement('div');
    controls.className = 'tile-controls';
    const muteBtn = this.#button('volume', 'Silenciar', () => {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        if (video.volume === 0) video.volume = this.volume || 1;
        video.play().catch(() => {});
      } else {
        video.muted = true;
      }
      syncAudio();
    });
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.02';
    slider.value = String(volume);
    slider.className = 'volume';
    slider.setAttribute('aria-label', 'Volume');
    const fullBtn = this.#button('expand', 'Tela cheia', () => this.fullscreen());
    controls.append(muteBtn, slider, fullBtn);
    el.append(video, canvas, label, tools, controls);

    const syncAudio = () => {
      const audioCount = this.stream?.getAudioTracks().length || 0;
      const hasAudio = audioCount > 0;
      if (audioCount !== this.meterTracks) {
        this.meterTracks = audioCount;
        this.stopMeter();
        label.classList.remove('sound');
        this.stopMeter = watchLevel(this.stream, (level) => label.classList.toggle('sound', level > 0.03));
      }
      label.classList.toggle('has-audio', hasAudio);
      muteBtn.hidden = !hasAudio;
      slider.hidden = !hasAudio;
      const silent = video.muted || video.volume === 0;
      muteBtn.replaceChildren(icon(silent ? 'mute' : 'volume', 16));
      muteBtn.title = silent ? 'Ativar som' : 'Silenciar';
      slider.value = video.muted ? '0' : String(video.volume);
    };

    slider.addEventListener('input', (e) => {
      e.stopPropagation();
      const v = Number(slider.value);
      video.volume = v;
      video.muted = v === 0;
      if (v > 0) this.volume = v;
      this.hooks.onVolume?.(this.id, v);
      syncAudio();
    });
    for (const node of [slider, tools, controls]) {
      node.addEventListener('click', (e) => e.stopPropagation());
      node.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    el.addEventListener('click', () => { if (!this.mode) this.hooks.onFocus(); });
    el.addEventListener('dblclick', () => { if (!this.mode) this.fullscreen(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') this.fullscreen();
      if (e.key === 'Escape') this.#setMode(null);
    });

    // ponteiro e desenho
    let lastSent = 0;
    el.addEventListener('pointermove', (e) => {
      const point = this.#normalize(e);
      if (this.mode === 'pointer' && point) {
        const now = performance.now();
        if (now - lastSent > 40) {
          lastSent = now;
          this.hooks.onPointer?.(this.id, point.x, point.y);
          this.annotator.pointer('me', 'Você', this.hooks.myColor || '#9aa8ff', point.x, point.y);
        }
      } else if (this.mode === 'draw' && this.stroke && point) {
        this.stroke.pending.push([round(point.x), round(point.y)]);
        this.annotator.stroke(`me:${this.stroke.id}`, [[point.x, point.y]], this.hooks.myColor || '#9aa8ff', false);
      }
    });
    el.addEventListener('pointerleave', () => {
      if (this.mode === 'pointer') this.hooks.onPointer?.(this.id, null, null);
      this.#endStroke();
    });
    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'draw' || e.button !== 0) return;
      const point = this.#normalize(e);
      if (!point) return;
      el.setPointerCapture(e.pointerId);
      this.stroke = { id: Math.random().toString(36).slice(2, 10), pending: [[round(point.x), round(point.y)]] };
      this.annotator.stroke(`me:${this.stroke.id}`, [[point.x, point.y]], this.hooks.myColor || '#9aa8ff', false);
      this.strokeTimer = setInterval(() => this.#flushStroke(false), 50);
    });
    el.addEventListener('pointerup', () => this.#endStroke());

    this.el = el;
    this.video = video;
    this.label = label;
    this.pointerBtn = pointerBtn;
    this.penBtn = penBtn;
    this.syncAudio = syncAudio;
    this.annotator = new Annotator(canvas, () => this.contentRect());
    this.setName(name);
  }

  #button(name, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'icon-btn small';
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.append(icon(name, 16));
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  #setMode(mode) {
    if (this.mode === 'pointer' && mode !== 'pointer') this.hooks.onPointer?.(this.id, null, null);
    this.mode = mode;
    this.el.classList.toggle('mode-pointer', mode === 'pointer');
    this.el.classList.toggle('mode-draw', mode === 'draw');
    this.pointerBtn.classList.toggle('active', mode === 'pointer');
    this.penBtn.classList.toggle('active', mode === 'draw');
  }

  setDraw(state) {
    this.draw = state;
    this.penBtn.classList.toggle('pending', state === 'pending');
    this.penBtn.title = state === 'allowed' ? 'Desenhar' : state === 'pending' ? 'Aguardando permissão' : 'Pedir para desenhar';
    if (state !== 'allowed' && this.mode === 'draw') this.#setMode(null);
  }

  #flushStroke(done) {
    if (!this.stroke) return;
    const pts = this.stroke.pending.splice(0);
    if (!pts.length && !done) return;
    this.hooks.onStroke?.(this.id, { id: this.stroke.id, pts, color: this.hooks.myColor || '#9aa8ff', done });
  }

  #endStroke() {
    if (!this.stroke) return;
    clearInterval(this.strokeTimer);
    this.#flushStroke(true);
    this.annotator.stroke(`me:${this.stroke.id}`, [], this.hooks.myColor || '#9aa8ff', true);
    this.stroke = null;
  }

  // Área do vídeo dentro do quadro (object-fit: contain)
  contentRect() {
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const scale = Math.min(w / vw, hgt / vh);
    const cw = vw * scale;
    const ch = vh * scale;
    return { x: (w - cw) / 2, y: (hgt - ch) / 2, width: cw, height: ch };
  }

  #normalize(e) {
    const box = this.el.getBoundingClientRect();
    const r = this.contentRect();
    const x = (e.clientX - box.left - r.x) / r.width;
    const y = (e.clientY - box.top - r.y) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  setName(name) {
    this.label.textContent = name || 'Conectando';
    this.el.setAttribute('aria-label', `Tela de ${name || 'participante'}`);
  }

  setStream(stream) {
    if (this.stream === stream) { this.syncAudio(); return; }
    this.stream?.removeEventListener('addtrack', this.syncAudio);
    this.stream?.removeEventListener('removetrack', this.syncAudio);
    this.stream = stream;
    this.meterTracks = -1;
    this.video.srcObject = stream;
    this.video.muted = false;
    this.video.volume = this.volume;
    this.video.play().catch(() => {
      this.video.muted = true;
      this.video.play().catch(() => {});
      this.syncAudio();
    });
    stream.addEventListener('addtrack', this.syncAudio);
    stream.addEventListener('removetrack', this.syncAudio);
    this.syncAudio();
  }

  fullscreen() {
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    else this.el.requestFullscreen().catch(() => {});
  }

  destroy() {
    this.stopMeter();
    this.annotator.destroy();
    clearInterval(this.strokeTimer);
    if (document.fullscreenElement === this.el) document.exitFullscreen().catch(() => {});
    this.stream?.removeEventListener('addtrack', this.syncAudio);
    this.stream?.removeEventListener('removetrack', this.syncAudio);
    this.video.srcObject = null;
    this.el.remove();
  }
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
