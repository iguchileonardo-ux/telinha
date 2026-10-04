// Reações com imagens enviadas pelos membros (galeria da Turma).
import { $, h, icon, toast, showPopover, closePopover, repositionPopover, cachedImage, preloadImages, rememberImage } from './dom.js';
import { pickFile, prepareReaction, hashData } from '../images.js';
import * as store from '../store.js';

const MAX_ON_SCREEN = 24;

export class Reactions {
  // app: { session(), uid }
  constructor(app) {
    this.app = app;
    this.pop = $('reactPop');
    this.layer = $('reactionLayer');
    this.items = [];
  }

  async refresh(code) {
    const list = (await store.gallery(code)).filter((g) => !g.deleted);
    await preloadImages(list.map((g) => g.hash));
    this.items = list.filter((g) => cachedImage(g.hash));
    if (!this.pop.hidden) this.#render();
  }

  open(anchor) {
    this.#render();
    showPopover(this.pop, anchor, { place: 'above', align: 'center' });
  }

  // Atalhos 1..9
  sendIndex(i) {
    const item = this.items[i];
    if (item) this.send(item.hash);
  }

  send(hash) {
    const session = this.app.session();
    if (!session) return;
    const now = Date.now();
    this.sent = (this.sent || []).filter((t) => now - t < 3000);
    if (this.sent.length >= 6) return;
    this.sent.push(now);
    session.sendReaction(hash);
  }

  show({ hash, name, self }) {
    const data = cachedImage(hash);
    if (!data || this.layer.childElementCount >= MAX_ON_SCREEN) return;
    const x = 8 + Math.random() * 84;
    const drift = (Math.random() - 0.5) * 80;
    const el = h('div.float-reaction', { style: { left: `${x}%` } },
      h('img', { src: data, alt: '' }),
      name ? h('span', {}, self ? 'Você' : name) : null);
    el.style.setProperty('--drift', `${drift}px`);
    el.addEventListener('animationend', () => el.remove());
    // Garante a saída mesmo sem animação (Windows com "Efeitos de animação" desligado).
    setTimeout(() => el.remove(), 3200);
    this.layer.append(el);
  }

  async #upload() {
    const session = this.app.session();
    if (!session) return;
    const file = await pickFile();
    if (!file) return;
    try {
      const data = await prepareReaction(file);
      const hash = await hashData(data);
      rememberImage(hash, data);
      await session.addReactionImage(hash, data);
      await this.refresh(session.code);
      toast('Reação adicionada à galeria da turma.');
    } catch (error) {
      toast(error.message || 'Não foi possível usar essa imagem.');
    }
  }

  #render() {
    const grid = h('div.reaction-grid');
    this.items.forEach((item, i) => {
      const btn = h('button.reaction', { type: 'button', title: `${item.byName ? `De ${item.byName}` : ''}${i < 9 ? ` · tecla ${i + 1}` : ''}`, on: { click: () => this.send(item.hash) } },
        h('img', { src: cachedImage(item.hash), alt: '' }));
      if (item.by === this.app.uid) {
        btn.append(h('span.reaction-remove', {
          role: 'button',
          title: 'Remover da galeria',
          on: {
            click: async (e) => {
              e.stopPropagation();
              await this.app.session()?.removeReactionImage(item.hash);
              await this.refresh(this.app.session().code);
            },
          },
        }, icon('close', 12)));
      }
      grid.append(btn);
    });
    grid.append(h('button.reaction.add', { type: 'button', title: 'Adicionar imagem', on: { click: () => { closePopover(); this.#upload(); } } }, icon('plus', 20)));
    const hint = this.items.length
      ? h('small.pop-hint', {}, 'Clique para reagir. Teclas 1 a 9 funcionam como atalho.')
      : h('small.pop-hint', {}, 'Adicione imagens (PNG, JPG, WebP ou GIF). Elas ficam disponíveis para toda a turma.');
    this.pop.replaceChildren(h('div.pop-title', {}, 'Reações'), grid, hint);
    repositionPopover(this.pop);
  }
}
