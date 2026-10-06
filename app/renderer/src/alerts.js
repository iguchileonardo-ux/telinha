// Sons discretos e avisos do sistema (notificações). Os sons são sintetizados,
// sem arquivos de áudio, e saem pela mesma saída escolhida nas configurações.
import { bridge } from './ui/dom.js';

const TONES = {
  join: [[660, 0], [880, 0.11]],
  leave: [[660, 0], [440, 0.11]],
  share: [[523, 0], [659, 0.1], [784, 0.2]],
  message: [[880, 0]],
};
const NOTE_LENGTH = 0.16;
const GAIN = 0.05;
const MIN_GAP_MS = 1500;

export function createAlerts(getSettings) {
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

  function sound(kind) {
    if (dnd || !getSettings().sounds || !TONES[kind]) return;
    const now = Date.now();
    if (now - (last.get(kind) || 0) < MIN_GAP_MS) return;
    last.set(kind, now);
    try {
      const audio = context();
      if (!audio) return;
      const base = audio.currentTime + 0.02;
      for (const [freq, offset] of TONES[kind]) {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, base + offset);
        gain.gain.exponentialRampToValueAtTime(GAIN, base + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, base + offset + NOTE_LENGTH);
        osc.connect(gain).connect(audio.destination);
        osc.start(base + offset);
        osc.stop(base + offset + NOTE_LENGTH + 0.05);
      }
    } catch { /* sem som */ }
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
