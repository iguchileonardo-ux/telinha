// Rádio da Turma: um player do YouTube escondido (página oficial do YouTube,
// sem baixar nada), controlado pelo processo principal.
const { BrowserWindow, app, net, session } = require('electron');

let win = null;
let currentId = null;
let volume = 0.6;
let sinkLabel = ''; // nome da saída de áudio escolhida (os ids mudam entre sessões)

function userAgent() {
  // Remove "Electron/x" e o nome do app para o YouTube tratar como Chrome comum.
  return app.userAgentFallback.replace(/\s(Electron|Telinha|telinha)\/\S+/g, '');
}

function ensure() {
  if (win && !win.isDestroyed()) return win;
  const ses = session.fromPartition('persist:radio');
  ses.setUserAgent(userAgent());
  // Só o necessário para tocar na saída de áudio escolhida.
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'speaker-selection'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'speaker-selection' || permission === 'media');
  win = new BrowserWindow({
    show: false,
    width: 960,
    height: 540,
    skipTaskbar: true,
    webPreferences: { partition: 'persist:radio', sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; currentId = null; });
  return win;
}

const STATUS_JS = `(() => {
  const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
  const p = document.getElementById('movie_player');
  if (!v) return null;
  return { t: v.currentTime || 0, d: Number.isFinite(v.duration) ? v.duration : 0, paused: v.paused, ended: v.ended, ad: !!(p && p.classList.contains('ad-showing')) };
})()`;

function run(js) {
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  return win.webContents.executeJavaScript(js, true).catch(() => null);
}

function applyVolume() {
  const v = Math.max(0, Math.min(1, volume));
  return run(`(() => {
    const p = document.getElementById('movie_player');
    if (p && p.setVolume) { p.unMute && p.unMute(); p.setVolume(${Math.round(v * 100)}); }
    const el = document.querySelector('video'); if (el) { el.muted = false; el.volume = ${v}; }
    return true;
  })()`);
}

function applySink() {
  return run(`(async () => {
    const v = document.querySelector('video');
    if (!v || !v.setSinkId) return false;
    const label = ${JSON.stringify(sinkLabel)};
    let id = '';
    if (label) {
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const match = devices.find((d) => d.kind === 'audiooutput' && d.label === label);
      if (match) id = match.deviceId;
    }
    if (v.sinkId !== id) await v.setSinkId(id).catch(() => {});
    return true;
  })()`);
}

async function load({ videoId, at = 0, playing = true }) {
  if (!/^[\w-]{11}$/.test(videoId)) return false;
  const w = ensure();
  if (currentId !== videoId) {
    currentId = videoId;
    const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(at))}s`;
    await w.loadURL(url).catch(() => {});
    // espera o vídeo aparecer
    for (let i = 0; i < 40; i++) {
      if (await run(STATUS_JS)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await applyVolume();
  await applySink();
  await command({ action: 'seek', value: at });
  await command({ action: playing ? 'play' : 'pause' });
  return true;
}

function command({ action, value }) {
  switch (action) {
    case 'play':
      return run(`(() => { const v = document.querySelector('video'); if (v) v.play().catch(() => {}); return true; })()`);
    case 'pause':
      return run(`(() => { const v = document.querySelector('video'); if (v) v.pause(); return true; })()`);
    case 'seek': {
      const t = Math.max(0, Number(value) || 0);
      return run(`(() => {
        const p = document.getElementById('movie_player');
        if (p && p.classList.contains('ad-showing')) return false;
        const v = document.querySelector('video'); if (v) v.currentTime = ${t}; return true;
      })()`);
    }
    case 'volume':
      volume = Number(value);
      return applyVolume();
    case 'sink':
      sinkLabel = String(value || '').slice(0, 200);
      return applySink();
    default:
      return Promise.resolve(false);
  }
}

function status() {
  return run(STATUS_JS);
}

function stop() {
  currentId = null;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

async function info(videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: String(data.title || '').slice(0, 120), author: String(data.author_name || '').slice(0, 60) };
  } catch {
    return null;
  }
}

module.exports = { load, command, status, stop, info };
