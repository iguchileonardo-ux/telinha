// Processo principal do Electron: janela, bandeja, notificações, captura, links
// telinha://, camada de ponteiro/desenho, rádio e atualização automática.
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  net,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
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
let tray = null;
let quitting = false;
let dnd = false; // não incomodar: vale só até fechar o app
let lastNote = { key: '', at: 0 };
let currentNote = null;

// Preferências que o processo principal precisa conhecer antes da interface
// carregar (bandeja e início com o Windows). A interface envia as mudanças.
const DEFAULT_PREFS = { notifications: true, tray: true, autostart: false, trayNoticeShown: false };
let prefs = { ...DEFAULT_PREFS };
const prefsFile = () => path.join(app.getPath('userData'), 'preferencias.json');
const logFile = () => path.join(app.getPath('userData'), 'diagnostico.txt');
const LOG_LIMIT = 1024 * 1024;

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

function readPrefs() {
  try {
    const data = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    for (const key of Object.keys(DEFAULT_PREFS)) if (typeof data[key] === 'boolean') prefs[key] = data[key];
  } catch { /* primeira execução */ }
}

function savePrefs() {
  try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch (error) { console.log('Preferências:', error.message); }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function windowInBackground() {
  return !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused();
}

// ---- bandeja ----

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Abrir a Telinha', click: showWindow },
    { label: 'Não incomodar', type: 'checkbox', checked: dnd, click: (item) => setDnd(item.checked) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function setDnd(value) {
  dnd = !!value;
  if (tray) tray.setContextMenu(trayMenu());
  send('app:dnd', dnd);
}

function syncTray() {
  if (prefs.tray && !tray) {
    try {
      const file = path.join(__dirname, 'icon.png');
      const image = fs.existsSync(file) ? nativeImage.createFromPath(file).resize({ width: 32, height: 32 }) : nativeImage.createEmpty();
      tray = new Tray(image);
      tray.setToolTip('Telinha');
      tray.setContextMenu(trayMenu());
      tray.on('click', showWindow);
    } catch (error) {
      console.log('Bandeja indisponível:', error.message);
      tray = null;
    }
  } else if (!prefs.tray && tray) {
    tray.destroy();
    tray = null;
    if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
  }
}

// Só vale para a versão instalada: em desenvolvimento não mexe no registro do Windows.
function syncAutostart() {
  if (!app.isPackaged || process.platform !== 'win32' || profile) return;
  try { app.setLoginItemSettings({ openAtLogin: !!prefs.autostart, args: ['--oculto'] }); } catch (error) { console.log('Início com o Windows:', error.message); }
}

function applyPrefs(patch) {
  if (patch && typeof patch === 'object') {
    for (const key of ['notifications', 'tray', 'autostart']) if (typeof patch[key] === 'boolean') prefs[key] = patch[key];
  }
  savePrefs();
  syncTray();
  syncAutostart();
}

// ---- avisos do sistema ----

function notify({ title, body, tab, flash } = {}) {
  if (!prefs.notifications || dnd || !windowInBackground()) return false;
  const text = String(body || '').slice(0, 200);
  const head = String(title || 'Telinha').slice(0, 80);
  const key = `${head}|${text}`;
  const now = Date.now();
  if (key === lastNote.key && now - lastNote.at < 3000) return false;
  lastNote = { key, at: now };
  if (flash && win && !win.isDestroyed() && win.isVisible()) win.flashFrame(true);
  if (!Notification.isSupported()) return false;
  try {
    if (currentNote) currentNote.close();
    const note = new Notification({ title: head, body: text, silent: true, icon: path.join(__dirname, 'icon.png') });
    note.on('click', () => { showWindow(); send('notify:click', { tab: tab === 'call' ? 'call' : 'chat' }); });
    note.on('close', () => { if (currentNote === note) currentNote = null; });
    currentNote = note;
    note.show();
    return true;
  } catch (error) {
    console.log('Notificação:', error.message);
    return false;
  }
}

// Aviso único de que fechar a janela não encerra o app.
function trayNotice() {
  if (prefs.trayNoticeShown || !Notification.isSupported()) return;
  prefs.trayNoticeShown = true;
  savePrefs();
  try {
    new Notification({
      title: 'A Telinha continua aberta',
      body: 'Ela fica na bandeja do Windows. Para sair de vez, clique com o botão direito no ícone e escolha Sair.',
      silent: true,
    }).show();
  } catch { /* sem aviso */ }
}

// ---- registro de diagnóstico ----

async function writeLog(lines) {
  if (!Array.isArray(lines) || !lines.length) return false;
  const text = lines.slice(0, 200).map((l) => String(l).replace(/[\u0000-\u001f]/g, ' ').slice(0, 500)).join('\n') + '\n';
  const file = logFile();
  try {
    try {
      if ((await fs.promises.stat(file)).size > LOG_LIMIT) await fs.promises.rename(file, file.replace(/\.txt$/, '.antigo.txt'));
    } catch { /* ainda não existe */ }
    await fs.promises.appendFile(file, text, 'utf8');
    return true;
  } catch (error) {
    console.log('Registro:', error.message);
    return false;
  }
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

  const startHidden = process.argv.includes('--oculto') && prefs.tray && tray && !pendingLink;
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  // Com a bandeja ligada, fechar a janela só a esconde: a call e a transmissão continuam.
  win.on('close', (event) => {
    if (quitting || !prefs.tray || !tray) return;
    event.preventDefault();
    win.hide();
    trayNotice();
  });
  win.on('focus', () => win.flashFrame(false));
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
    server: builtinServer(),
  }));
  ipcMain.handle('app:turn', () => turnServers());
  ipcMain.handle('app:focus', () => { showWindow(); return true; });

  // Preferências do aplicativo (bandeja, início com o Windows, notificações)
  ipcMain.handle('app:prefs', (_event, patch) => {
    applyPrefs(patch);
    return { dnd };
  });
  ipcMain.handle('notify:show', (_event, data) => notify(data || {}));
  ipcMain.handle('log:write', (_event, lines) => writeLog(lines));
  ipcMain.handle('log:open', async () => {
    const file = logFile();
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else await shell.openPath(app.getPath('userData'));
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
    quitting = true;
    const { autoUpdater } = require('electron-updater');
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  });
}

// ---- atualização automática (GitHub Releases) ----

// Servidor da Telinha (pasta servidor-cloudflare), configurado em package.json.
function builtinServer() {
  const url = String(pkg.telinha?.server || '').trim().replace(/\/$/, '');
  return url ? url.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') : '';
}

// Credenciais temporárias do TURN, pedidas ao servidor e guardadas até perto de vencer.
let turnCache = null;
async function turnServers() {
  const server = builtinServer();
  if (!server) return [];
  if (turnCache && turnCache.expires - Date.now() > 60 * 60 * 1000) return turnCache.iceServers;
  try {
    const url = `${server.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')}/turn`;
    const res = await net.fetch(url, { headers: { 'x-telinha': 'telinha-app-v1-7d3f91c2' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return turnCache?.iceServers || [];
    const data = await res.json();
    const iceServers = Array.isArray(data.iceServers) ? data.iceServers.filter((x) => x && x.urls).slice(0, 6) : [];
    turnCache = { iceServers, expires: Number(data.expires) || Date.now() + 12 * 60 * 60 * 1000 };
    return iceServers;
  } catch {
    return turnCache?.iceServers || [];
  }
}

// Repositório das atualizações. O valor fixo garante que nenhuma versão saia
// sem atualização automática, mesmo se o package.json vier sem ele.
const DEFAULT_UPDATE_REPO = 'iguchileonardo-ux/telinha';

function updateRepo() {
  const repo = String(pkg.telinha?.updateRepo || DEFAULT_UPDATE_REPO).trim();
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
    else showWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverLink(url);
  });

  app.whenReady().then(() => {
    if (!profile) registerProtocol();
    readPrefs();
    setupMedia();
    setupIpc();
    syncTray();
    syncAutostart();
    createWindow();
    setupUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { quitting = true; audio.stop(); overlay.stop(); radio.stop(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
