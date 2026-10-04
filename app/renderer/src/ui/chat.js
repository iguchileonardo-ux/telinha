// Chat de texto da Turma.
import { $, h, avatar, clock, icon } from './dom.js';
import * as store from '../store.js';

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
const GROUP_MS = 5 * 60 * 1000;

export class ChatView {
  // app: { member(uid) -> { name, hash }, send(text), pin(msg), command(text) -> bool }
  constructor(app) {
    this.app = app;
    this.list = $('messages');
    this.input = $('composerInput');
    this.code = null;
    this.items = [];

    $('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      this.#submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.#submit();
      }
    });
    this.input.addEventListener('input', () => this.#grow());
    $('unpinBtn').addEventListener('click', () => this.app.unpin());
  }

  async load(code) {
    this.code = code;
    this.items = await store.messages(code);
    this.render();
    this.scrollToEnd();
  }

  async append(messages) {
    if (!this.code) return;
    const atBottom = this.#atBottom();
    const known = new Set(this.items.map((m) => m.id));
    this.items = [...this.items, ...messages.filter((m) => !known.has(m.id))].sort((a, b) => a.ts - b.ts).slice(-500);
    this.render();
    if (atBottom || messages.some((m) => m.uid === this.app.uid)) this.scrollToEnd();
  }

  render() {
    this.list.replaceChildren();
    if (!this.items.length) {
      this.list.append(h('div.chat-empty', {}, h('p', {}, 'Nenhuma mensagem ainda.'), h('small', {}, 'O que for escrito aqui fica salvo para a turma, inclusive para quem entrar depois.')));
      return;
    }
    let prev = null;
    for (const msg of this.items) {
      const grouped = prev && prev.uid === msg.uid && msg.ts - prev.ts < GROUP_MS;
      this.list.append(this.#row(msg, !grouped));
      prev = msg;
    }
  }

  setPinned(turma) {
    const pinned = turma?.pinned;
    const show = !!pinned && !pinned.cleared && pinned.text;
    $('pinned').hidden = !show;
    if (show) {
      $('pinnedText').replaceChildren(h('b', {}, `${pinned.name}: `), ...linkify(pinned.text));
      $('pinnedText').title = pinned.text;
    }
  }

  focus() {
    this.input.focus();
  }

  scrollToEnd() {
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  #atBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
  }

  #row(msg, header) {
    const info = this.app.member(msg.uid) || { name: msg.name };
    const name = info.name || msg.name;
    const text = h('div.msg-text', {}, ...linkify(msg.text));
    const actions = h('div.msg-actions', {},
      h('button.icon-btn.small', { type: 'button', title: 'Fixar no topo', 'aria-label': 'Fixar no topo', on: { click: () => this.app.pin(msg) } }, icon('pin', 15)));
    if (!header) {
      return h('div.msg.cont', { title: clock(msg.ts) }, h('span.msg-time', {}, new Date(msg.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })), text, actions);
    }
    return h('div.msg', {},
      avatar({ uid: msg.uid, name, hash: info.hash }, 34, 'msg-avatar'),
      h('div.msg-body', {},
        h('div.msg-head', {}, h('span.msg-name', {}, name), h('span.msg-when', {}, clock(msg.ts))),
        text),
      actions);
  }

  async #submit() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.#grow();
    if (await this.app.command(text)) return;
    this.app.send(text);
  }

  #grow() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
  }
}

export function linkify(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const url = match[0].replace(/[),.;!?]+$/, '');
    parts.push(h('a', { href: url, target: '_blank', rel: 'noreferrer noopener' }, url));
    parts.push(match[0].slice(url.length));
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.filter((p) => p !== '');
}
