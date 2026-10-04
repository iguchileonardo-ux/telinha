// Desenha ponteiros e traços sobre uma tela compartilhada.
// Coordenadas sempre normalizadas (0..1) em relação ao conteúdo do vídeo.

const POINTER_IDLE_MS = 3000;
const STROKE_HOLD_MS = 3500;
const STROKE_FADE_MS = 900;

export function colorFor(text) {
  let h = 0;
  for (const ch of String(text || '?')) h = (h * 31 + ch.codePointAt(0)) % 360;
  // cores vivas e legíveis em qualquer fundo
  return `hsl(${h} 85% 60%)`;
}

export function hexColorFor(text) {
  const palette = ['#ff5f5f', '#ffb347', '#ffe066', '#5ee08f', '#4dd4ff', '#9aa8ff', '#e37bff', '#ff7eb6'];
  let h = 0;
  for (const ch of String(text || '?')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return palette[h % palette.length];
}

export class Annotator {
  // getRect(): { x, y, width, height } da área do vídeo dentro do canvas (em px CSS)
  constructor(canvas, getRect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getRect = getRect;
    this.pointers = new Map();
    this.strokes = new Map();
    this.frame = null;
  }

  pointer(id, name, color, x, y, hide = false) {
    if (hide) this.pointers.delete(id);
    else this.pointers.set(id, { name, color, x, y, at: performance.now() });
    this.#kick();
  }

  stroke(key, pts, color, done) {
    let s = this.strokes.get(key);
    if (!s) {
      s = { pts: [], color, done: false, doneAt: 0 };
      this.strokes.set(key, s);
    }
    s.pts.push(...pts);
    if (s.pts.length > 4000) s.pts.splice(0, s.pts.length - 4000);
    if (done && !s.done) { s.done = true; s.doneAt = performance.now(); }
    this.#kick();
  }

  clear() {
    this.pointers.clear();
    this.strokes.clear();
    this.#kick();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  #kick() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.#draw());
  }

  #draw() {
    this.frame = null;
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const r = this.getRect();
    const now = performance.now();
    let active = false;

    for (const [key, s] of this.strokes) {
      let alpha = 1;
      if (s.done) {
        const age = now - s.doneAt;
        if (age > STROKE_HOLD_MS + STROKE_FADE_MS) { this.strokes.delete(key); continue; }
        if (age > STROKE_HOLD_MS) alpha = 1 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS;
      }
      active = true;
      if (s.pts.length < 1) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(3, Math.min(r.width, r.height) * 0.006);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => {
        const px = r.x + x * r.width;
        const py = r.y + y * r.height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      if (s.pts.length === 1) ctx.lineTo(r.x + s.pts[0][0] * r.width + 0.1, r.y + s.pts[0][1] * r.height);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
    for (const [id, p] of this.pointers) {
      const age = now - p.at;
      if (age > POINTER_IDLE_MS) { this.pointers.delete(id); continue; }
      active = true;
      const px = r.x + p.x * r.width;
      const py = r.y + p.y * r.height;
      ctx.globalAlpha = age > POINTER_IDLE_MS - 500 ? (POINTER_IDLE_MS - age) / 500 : 1;
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke();
      const label = p.name || '';
      if (label) {
        const tw = ctx.measureText(label).width;
        const bx = px + 11;
        const by = py + 8;
        ctx.fillStyle = 'rgba(12,13,15,.78)';
        roundRect(ctx, bx, by, tw + 14, 20, 10);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(label, bx + 7, by + 14);
      }
    }
    ctx.globalAlpha = 1;
    if (active) this.#kick();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
