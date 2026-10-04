// Utilidades de interface compartilhadas.
import { icon } from '../icons.js';
import * as store from '../store.js';

export const $ = (id) => document.getElementById(id);
export const bridge = window.telinha ?? null;

// h('div.classe', { props }, ...filhos)
export function h(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function iconBtn(name, title, onClick, extra = '') {
  return h(`button.icon-btn${extra ? `.${extra}` : ''}`, { type: 'button', title, 'aria-label': title, on: { click: onClick } }, icon(name));
}

let toastTimer;
export function toast(message, ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export async function copyText(text) {
  try {
    if (bridge) await bridge.writeClipboard(text);
    else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readClipboard() {
  try {
    return bridge ? await bridge.readClipboard() : '';
  } catch {
    return '';
  }
}

export function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

export function clock(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `ontem ${time}`;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

export function hue(text) {
  let n = 0;
  for (const ch of String(text || '?')) n = (n * 31 + ch.codePointAt(0)) % 360;
  return n;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

export function listNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`;
}

// ---- avatares (foto ou iniciais) ----

const imageCache = new Map();

export async function preloadImages(hashes) {
  await Promise.all([...new Set(hashes)].filter((x) => x && !imageCache.has(x)).map(async (hash) => {
    const data = await store.image(hash);
    if (data) imageCache.set(hash, data);
  }));
}

export function cachedImage(hash) {
  return hash ? imageCache.get(hash) || null : null;
}

export function rememberImage(hash, data) {
  if (hash && data) imageCache.set(hash, data);
}

export function avatar({ uid, name, hash }, size = 28, extra = '') {
  const el = h(`span.avatar${extra ? `.${extra}` : ''}`, { title: name || '' });
  el.style.setProperty('--h', hue(uid || name));
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.38)}px`;
  const data = cachedImage(hash);
  if (data) el.append(h('img', { src: data, alt: '' }));
  else el.textContent = name ? initials(name) : '·';
  return el;
}

// ---- popovers ----

let openPopover = null;

export function closePopover() {
  if (!openPopover) return;
  const { el, onClose } = openPopover;
  openPopover = null;
  el.hidden = true;
  onClose?.();
}

function position(el, anchor, place, align) {
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const margin = 8;
  let left = align === 'start' ? a.left : align === 'center' ? a.left + a.width / 2 - r.width / 2 : a.right - r.width;
  left = Math.max(margin, Math.min(window.innerWidth - r.width - margin, left));
  let top = place === 'above' ? a.top - r.height - margin : a.bottom + margin;
  if (place === 'right') { left = a.right + margin; top = a.top; }
  top = Math.max(margin, Math.min(window.innerHeight - r.height - margin, top));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// Abre um popover ancorado em um elemento. place: 'below' | 'above' | 'right'
export function showPopover(el, anchor, { place = 'below', align = 'end', onClose } = {}) {
  if (openPopover?.el === el) { closePopover(); return false; }
  closePopover();
  el.hidden = false;
  position(el, anchor, place, align);
  openPopover = { el, onClose, anchor, place, align };
  return true;
}

// Recalcula a posição depois que o conteúdo mudou.
export function repositionPopover(el) {
  if (openPopover?.el !== el) return;
  position(el, openPopover.anchor, openPopover.place, openPopover.align);
}

document.addEventListener('pointerdown', (e) => {
  if (!openPopover) return;
  if (openPopover.el.contains(e.target) || openPopover.anchor.contains(e.target)) return;
  closePopover();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

export function typing() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export { icon };
