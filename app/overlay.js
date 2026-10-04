// Camada transparente sobre a tela/janela compartilhada, onde aparecem o ponteiro
// e os desenhos dos amigos. Ela não recebe cliques e fica fora da captura
// (setContentProtection), então não aparece duplicada para quem assiste.
const { BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('node:path');
const native = require('./native');

let overlay = null;
let timer = null;
let target = null; // { sourceId, displayId }
let lastActivity = 0;
const IDLE_HIDE_MS = 6000;

function create() {
  overlay = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setContentProtection(true);
  overlay.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlay.on('closed', () => { overlay = null; });
}

function bounds() {
  if (!target) return null;
  if (target.sourceId.startsWith('screen:')) {
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(target.displayId)) || screen.getPrimaryDisplay();
    return display.bounds;
  }
  if (!native.isForeground(target.sourceId)) return null;
  const rect = native.windowRect(target.sourceId);
  if (!rect || rect.width < 50 || rect.height < 50) return null;
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

function update() {
  if (!overlay || overlay.isDestroyed()) return;
  const idle = Date.now() - lastActivity > IDLE_HIDE_MS;
  const rect = idle ? null : bounds();
  if (!rect) {
    if (overlay.isVisible()) overlay.hide();
    return;
  }
  const current = overlay.getBounds();
  if (current.x !== rect.x || current.y !== rect.y || current.width !== rect.width || current.height !== rect.height) {
    overlay.setBounds(rect);
  }
  if (!overlay.isVisible()) overlay.showInactive();
}

async function start(sourceId) {
  stop();
  let displayId = null;
  if (sourceId.startsWith('screen:')) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      displayId = sources.find((s) => s.id === sourceId)?.display_id || null;
    } catch { /* usa a tela principal */ }
  }
  target = { sourceId, displayId };
  create();
  timer = setInterval(update, 120);
}

function event(data) {
  if (!target || !overlay || overlay.isDestroyed()) return;
  lastActivity = Date.now();
  update();
  overlay.webContents.send('overlay:event', data);
}

function stop() {
  clearInterval(timer);
  timer = null;
  target = null;
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}

module.exports = { start, event, stop };
