// Processo principal do Electron: janela, captura, links telinha://, camada de
// ponteiro/desenho, rádio e atualização automática.
const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  session,
  shell,
} = require('electron');
const path = require('node:path');
const audio = require('./audio');
const native = require('./native');
const overlay = require('./overlay');
const radio = require('./radio');
const pkg = require('../package.json');

const PROTOCOL = 'telinha';
const THEMES = {
  dark: { background: '#0c0d0f', symbol: '#8d9097' },
  light: { background: '#f6f6f4', symbol: '#5d6067' },
};

let win = null;
let pendingLink = null;
let pendingSource = null;
let updateReady = null;

// Permite tocar o áudio dos amigos e o rádio sem precisar clicar antes.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'win32') app.setAppUserModelId('dev.telinha.app');

function findLink(argv) {
  return argv.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(`${PROTOCOL}://`)) || null;
}

function registerProtocol() {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function deliverLink(link) {
  if (!link) return;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('open-link', link);
  } else {
    pendingLink = link;
  }
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Telinha',
    backgroundColor: THEMES.dark.background,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: THEMES.dark.background, symbolColor: THEMES.dark.symbol, height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  const cleanup = () => { audio.stop(); overlay.stop(); radio.stop(); };
  win.webContents.on('render-process-gone', cleanup);
  win.webContents.on('did-start-loading', cleanup);
  win.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = event?.level ?? legacyLevel;
    const message = event?.message ?? legacyMessage;
    if (level === 'warning' || level === 'error' || level >= 2) console.log(`[interface] ${message}`);
  });
  win.on('closed', () => { cleanup(); win = null; });
}

function setupMedia() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'fullscreen', 'notifications', 'speaker-selection'].includes(permission));
  });

  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const choice = pendingSource;
    pendingSource = null;
    if (!choice) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === choice.id);
      if (!source) { callback({}); return; }
      const withAudio = choice.audio && process.platform === 'win32';
      callback(withAudio ? { video: source, audio: 'loopback' } : { video: source });
    } catch (error) {
      console.error('Falha ao preparar a captura:', error);
      callback({});
    }
  });
}

function setupIpc() {
  ipcMain.handle('sources:list', async () => {
    const ownId = win && !win.isDestroyed() ? win.getMediaSourceId() : null;
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 225 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.id !== ownId && s.name !== 'Telinha')
      .filter((s) => s.id.startsWith('screen:') || !s.thumbnail.isEmpty())
      .map((s) => {
        const kind = s.id.startsWith('screen:') ? 'screen' : 'window';
        let game = false;
        if (kind === 'window') {
          try { game = native.isGamePath(native.processPath(native.pidFromSourceId(s.id))); } catch { game = false; }
        }
        return {
          id: s.id,
          name: s.name,
          kind,
          game,
          thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
          icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        };
      });
  });

  ipcMain.handle('sources:select', (_event, choice) => {
    if (!choice || typeof choice.id !== 'string') return false;
    pendingSource = { id: choice.id, audio: !!choice.audio };
    return true;
  });

  // Áudio sem eco
  ipcMain.handle('audio:support', () => audio.support());
  ipcMain.handle('audio:start', (event, sourceId) => {
    if (typeof sourceId !== 'string') return { ok: false, error: 'Fonte inválida.' };
    const sender = event.sender;
    return audio.start(sourceId, (chunk) => {
      if (!sender.isDestroyed()) sender.send('audio:pcm', chunk);
    });
  });
  ipcMain.handle('audio:stop', () => { audio.stop(); return true; });

  // Camada de ponteiro/desenho sobre a tela compartilhada
  ipcMain.handle('overlay:start', (_event, sourceId) => {
    if (typeof sourceId === 'string' && /^(screen|window):/.test(sourceId)) overlay.start(sourceId);
    return true;
  });
  ipcMain.on('overlay:event', (_event, data) => overlay.event(data));
  ipcMain.handle('overlay:stop', () => { overlay.stop(); return true; });

  // Rádio
  ipcMain.handle('radio:load', (_event, args) => radio.load(args || {}));
  ipcMain.handle('radio:command', (_event, args) => radio.command(args || {}));
  ipcMain.handle('radio:status', () => radio.status());
  ipcMain.handle('radio:stop', () => { radio.stop(); return true; });
  ipcMain.handle('radio:info', (_event, videoId) => radio.info(String(videoId || '')));

  // Aparência
  ipcMain.handle('app:theme', (_event, theme) => {
    const t = THEMES[theme] || THEMES.dark;
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(t.background);
      try { win.setTitleBarOverlay({ color: t.background, symbolColor: t.symbol, height: 44 }); } catch { /* fora do Windows */ }
    }
    return true;
  });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    updates: !!updateRepo(),
    updateReady,
    packaged: app.isPackaged,
  }));
  ipcMain.handle('app:focus', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    return true;
  });

  // Área de transferência (assíncrona no Electron 44)
  ipcMain.handle('clipboard:read', async () => {
    try {
      return String((await clipboard.readText()) ?? '').slice(0, 500);
    } catch (error) {
      console.error('Falha ao ler a área de transferência:', error);
      return '';
    }
  });
  ipcMain.handle('clipboard:write', async (_event, text) => {
    await clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('link:pending', () => {
    const link = pendingLink;
    pendingLink = null;
    return link;
  });

  ipcMain.handle('update:install', () => {
    if (!updateReady) return false;
    const { autoUpdater } = require('electron-updater');
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });
}

// ---- atualização automática (GitHub Releases) ----

function updateRepo() {
  const repo = String(pkg.telinha?.updateRepo || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

function setupUpdater() {
  const repo = updateRepo();
  if (!app.isPackaged || !repo) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    console.error('electron-updater indisponível:', error.message);
    return;
  }
  const [owner, name] = repo.split('/');
  autoUpdater.setFeedURL({ provider: 'github', owner, repo: name });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = info?.version || 'nova';
    send('update:ready', updateReady);
  });
  autoUpdater.on('error', (error) => console.log('Atualização:', error?.message || error));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

// "--perfil=2" abre uma segunda instância independente (útil para testar sozinho).
const profileArg = process.argv.find((arg) => arg.startsWith('--perfil='));
const profile = profileArg ? profileArg.slice('--perfil='.length).replace(/[^\w-]/g, '') : '';
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `Telinha-${profile}`));

if (!profile && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingLink = findLink(process.argv);

  app.on('second-instance', (_event, argv) => {
    const link = findLink(argv);
    if (link) deliverLink(link);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverLink(url);
  });

  app.whenReady().then(() => {
    if (!profile) registerProtocol();
    setupMedia();
    setupIpc();
    createWindow();
    setupUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { audio.stop(); overlay.stop(); radio.stop(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
