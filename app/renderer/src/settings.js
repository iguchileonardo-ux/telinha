// Preferências locais (ficam só neste computador).
const SETTINGS_KEY = 'telinha:settings';
const RECENT_KEY = 'telinha:recent'; // versão 1: salas recentes (migradas para Turmas)

export const defaults = {
  userId: '',
  name: '',
  avatar: '', // data URL da foto de perfil (já recortada e reduzida)
  theme: 'dark', // 'dark' | 'light' | 'system'
  fps: 30, // quadros por segundo da transmissão: 24 | 30 | 60
  res: 1080, // resolução da transmissão (altura): 480 | 720 | 1080 | 0 (original)
  shareAudio: true,
  lastSource: null, // { name, kind } da última fonte compartilhada
  volumes: {}, // volume por pessoa (userId -> 0..1)
  radioVolume: 0.6,
  micId: '', // microfone ('' = padrão do sistema)
  speakerId: '', // saída de áudio ('' = padrão do sistema)
  speakerLabel: '', // nome da saída, para o player do rádio
  lastTurma: '',
  signaling: 'auto', // 'auto' (sem servidor) | 'server' (servidor próprio)
  serverUrl: '',
  turnUrl: '',
  turnUser: '',
  turnPass: '',
  notifications: true, // avisos do Windows quando a janela está em segundo plano
  sounds: true, // sons do aplicativo (liga e desliga tudo)
  soundsPeople: true, // outras pessoas: entrar, sair e transmitir
  soundsSelf: true, // ações suas: microfone, call e transmissão
  soundsChat: true, // mensagens e reações
  soundsSystem: true, // conexão e avisos do aplicativo
  tray: true, // fechar a janela mantém a Telinha na bandeja
  autostart: false, // abrir com o Windows (escondida na bandeja)
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* armazenamento indisponível */ }
}

function randomId(bytes = 8) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function loadSettings() {
  const saved = read(SETTINGS_KEY, {});
  const settings = { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
  if (!/^[0-9a-f]{16}$/.test(settings.userId)) {
    settings.userId = randomId(8);
    write(SETTINGS_KEY, settings);
  }
  // Até a 2.3.3 a qualidade era um modo; converte uma vez para quadros por segundo e resolução.
  if (saved && saved.fps === undefined && typeof saved.quality === 'string') {
    settings.fps = { motion: 60, movie: 24 }[saved.quality] || 30;
    settings.res = 0; // os modos antigos enviavam a resolução original
  }
  delete settings.quality;
  if (![24, 30, 60].includes(settings.fps)) settings.fps = 30;
  if (![480, 720, 1080, 0].includes(settings.res)) settings.res = 1080;
  if (!settings.volumes || typeof settings.volumes !== 'object') settings.volumes = {};
  return settings;
}

export function saveSettings(settings) {
  write(SETTINGS_KEY, settings);
}

// Salas recentes da versão 1, para migrar.
export function takeLegacyRecent() {
  const list = read(RECENT_KEY, null);
  if (!Array.isArray(list)) return [];
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignorado */ }
  return list.filter((r) => r && typeof r.id === 'string');
}

export function iceServers(settings) {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const turn = settings.turnUrl.trim();
  if (turn) {
    servers.push({
      urls: turn.split(/[\s,]+/).filter(Boolean),
      username: settings.turnUser.trim(),
      credential: settings.turnPass,
    });
  }
  return servers;
}
