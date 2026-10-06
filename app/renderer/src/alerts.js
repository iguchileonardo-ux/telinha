// Sons discretos e avisos do sistema (notificações). Os sons são sintetizados,
// sem arquivos de áudio, e saem pela mesma saída escolhida nas configurações.
import { bridge } from './ui/dom.js';

// Cada som pertence a um grupo, que pode ser desligado nas configurações.
//   people: outras pessoas (entrar, sair, transmitir)
//   self:   ações suas (microfone, call, transmissão)
//   chat:   mensagens e reações
//   system: conexão e avisos do aplicativo
// notes: [frequência em Hz, início em segundos]; len: duração de cada nota.
export const SOUND_GROUPS = {
  people: 'soundsPeople',
  self: 'soundsSelf',
  chat: 'soundsChat',
  system: 'soundsSystem',
};

export const SOUNDS = {
  peerJoin: { group: 'people', notes: [[587, 0], [784, 0.1]] },
  peerLeave: { group: 'people', notes: [[784, 0], [587, 0.1]] },
  callJoin: { group: 'people', notes: [[660, 0], [880, 0.11]] },
  callLeave: { group: 'people', notes: [[660, 0], [440, 0.11]] },
  shareStart: { group: 'people', notes: [[523, 0], [659, 0.1], [784, 0.2]] },
  shareStop: { group: 'people', notes: [[784, 0], [659, 0.1], [523, 0.2]] },

  muteOn: { group: 'self', notes: [[700, 0], [480, 0.07]], len: 0.11, gain: 0.9, bypassDnd: true },
  muteOff: { group: 'self', notes: [[480, 0], [700, 0.07]], len: 0.11, gain: 0.9, bypassDnd: true },
  selfCallJoin: { group: 'self', notes: [[440, 0], [660, 0.09], [880, 0.18]] },
  selfCallLeave: { group: 'self', notes: [[880, 0], [660, 0.09], [440, 0.18]] },
  selfShareStart: { group: 'self', notes: [[523, 0], [784, 0.1]] },
  selfShareStop: { group: 'self', notes: [[784, 0], [523, 0.1]] },

  message: { group: 'chat', notes: [[880, 0], [1175, 0.09]] },
  sent: { group: 'chat', notes: [[1047, 0]], len: 0.09, gain: 0.55, gap: 400 },
  reaction: { group: 'chat', notes: [[1319, 0]], len: 0.08, gain: 0.5, gap: 2500 },

  connLost: { group: 'system', notes: [[392, 0], [294, 0.14]], len: 0.2 },
  connBack: { group: 'system', notes: [[392, 0], [523, 0.12]] },
  notice: { group: 'system', notes: [[660, 0], [660, 0.14]], len: 0.1 },
  update: { group: 'system', notes: [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]] },
};

const NOTE_LENGTH = 0.16;
const GAIN = 0.3;
const MIN_GAP_MS = 1500;

// Agenda as notas de um som em qualquer contexto de áudio (também serve para
// renderizar fora da tela nos testes).
export function scheduleSound(audio, kind, when = audio.currentTime + 0.02) {
  const sound = SOUNDS[kind];
  if (!sound) return 0;
  const len = sound.len || NOTE_LENGTH;
  const peak = GAIN * (sound.gain || 1);
  let end = 0;
  for (const [freq, offset] of sound.notes) {
    const start = when + offset;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
    gain.connect(audio.destination);
    // Fundamental mais um harmônico leve, para se ouvir também em alto-falantes pequenos.
    for (const [mult, level] of [[1, 1], [2, 0.22]]) {
      const osc = audio.createOscillator();
      const part = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      part.gain.value = level;
      osc.connect(part).connect(gain);
      osc.start(start);
      osc.stop(start + len + 0.05);
    }
    end = Math.max(end, offset + len);
  }
  return end;
}

export function createAlerts(getSettings, log = () => {}) {
  let ctx = null;
  let sink = null;
  let dnd = false;
  const last = new Map();

  function context() {
    if (!ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return null;
      ctx = new Context();
    }
    const speakerId = getSettings().speakerId || '';
    if (speakerId !== sink && typeof ctx.setSinkId === 'function') {
      sink = speakerId;
      ctx.setSinkId(speakerId || '').catch(() => {});
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function allowed(sound) {
    const settings = getSettings();
    if (settings.sounds === false || settings[SOUND_GROUPS[sound.group]] === false) return false;
    return !dnd || !!sound.bypassDnd;
  }

  // force: toca mesmo desligado, para a amostra ao ligar uma opção.
  function sound(kind, { force = false } = {}) {
    const def = SOUNDS[kind];
    if (!def || (!force && !allowed(def))) return;
    const now = Date.now();
    if (!force && now - (last.get(kind) || 0) < (def.gap || MIN_GAP_MS)) return;
    last.set(kind, now);
    try {
      const audio = context();
      if (!audio) { log(`Som ${kind}: AudioContext indisponível.`); return; }
      scheduleSound(audio, kind);
      log(`Som ${kind}: contexto ${audio.state}, saída ${sink || 'padrão'}.`);
    } catch (error) {
      log(`Som ${kind}: falhou (${error?.message || error}).`);
    }
  }

  // O processo principal decide se mostra: só com a janela em segundo plano.
  function notify(data) {
    if (!bridge?.notify || dnd || !getSettings().notifications) return;
    bridge.notify(data).catch(() => {});
  }

  return {
    sound,
    notify,
    setDnd(value) { dnd = !!value; },
    get dnd() { return dnd; },
  };
}
