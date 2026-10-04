// Membros da Turma: quem está online, na call ou transmitindo, e volume por pessoa.
import { $, h, avatar, timeAgo, showPopover } from './dom.js';

export class Members {
  // app: { session(), turma(), settings(), saveVolume(uid, v), speakingSet() }
  constructor(app) {
    this.app = app;
    this.pop = $('membersPop');
    this.button = $('membersBtn');
    this.button.addEventListener('click', () => {
      this.render();
      showPopover(this.pop, this.button, { place: 'below', align: 'end' });
    });
  }

  // Lista combinada: quem está conectado agora + quem já entrou alguma vez.
  list() {
    const session = this.app.session();
    const turma = this.app.turma();
    const settings = this.app.settings();
    const online = new Map();
    if (session) {
      online.set(settings.userId, { uid: settings.userId, name: settings.name || 'Você', hash: session.avatarHash, me: true, inCall: session.inCall, sharing: session.sharing, muted: session.muted });
      for (const p of session.peers.values()) {
        if (!p.uid) continue;
        online.set(p.uid, { uid: p.uid, name: p.name, hash: p.avatar, inCall: p.inCall, sharing: !!p.sharing, muted: p.muted, peerId: p.id });
      }
    }
    const offline = Object.entries(turma?.members || {})
      .filter(([uid]) => !online.has(uid))
      .map(([uid, m]) => ({ uid, name: m.name, hash: m.avatar, lastSeen: m.lastSeen }))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return { online: [...online.values()], offline };
  }

  renderButton() {
    const { online } = this.list();
    const speaking = this.app.speakingSet();
    this.button.replaceChildren();
    for (const m of online.slice(0, 4)) {
      this.button.append(avatar(m, 26, [m.sharing ? 'live' : '', speaking.has(m.uid) ? 'speaking' : ''].filter(Boolean).join('.')));
    }
    if (online.length > 4) this.button.append(h('span.avatar.more', {}, `+${online.length - 4}`));
    this.button.title = `${online.length} ${online.length === 1 ? 'pessoa online' : 'pessoas online'}`;
    if (!this.pop.hidden) this.render();
  }

  render() {
    const { online, offline } = this.list();
    const settings = this.app.settings();
    const speaking = this.app.speakingSet();
    const row = (m, isOnline) => {
      let status = isOnline ? 'Online' : `Visto ${m.lastSeen ? timeAgo(m.lastSeen) : 'antes'}`;
      if (m.sharing) status = 'Transmitindo';
      else if (m.inCall) status = m.muted ? 'Na call, sem microfone' : 'Na call';
      const children = [
        avatar(m, 32, speaking.has(m.uid) ? 'speaking' : ''),
        h('div.member-info', {}, h('span.member-name', {}, m.name + (m.me ? ' (você)' : '')), h('span.member-status', {}, status)),
      ];
      if (isOnline && !m.me && m.inCall) {
        const volume = h('input.volume', { type: 'range', min: '0', max: '1', step: '0.05', value: String(settings.volumes?.[m.uid] ?? 1), 'aria-label': `Volume de ${m.name}`, title: 'Volume da voz' });
        volume.addEventListener('input', () => this.app.saveVolume(m.uid, Number(volume.value)));
        children.push(volume);
      }
      return h(`div.member${isOnline ? '' : '.offline'}`, {}, ...children);
    };
    const parts = [h('div.pop-title', {}, 'Membros')];
    parts.push(h('div.pop-sub', {}, `Online (${online.length})`), ...online.map((m) => row(m, true)));
    if (offline.length) parts.push(h('div.pop-sub', {}, `Offline (${offline.length})`), ...offline.slice(0, 30).map((m) => row(m, false)));
    this.pop.replaceChildren(...parts);
  }
}
