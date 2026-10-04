// Funções do Windows usadas pela Telinha (via koffi): processo dono de uma janela,
// caminho do executável, posição da janela e se ela está em primeiro plano.
let api = null;
let failed = false;

function load() {
  if (api || failed) return api;
  if (process.platform !== 'win32') { failed = true; return null; }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const RECT = koffi.struct('TELINHA_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    api = {
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)'),
      FindWindowExW: user32.func('intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'),
      GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ TELINHA_RECT *lpRect)'),
      IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
      GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
      OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'),
      CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t hObject)'),
      QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32_t dwFlags, uint8_t *lpExeName, _Inout_ uint32_t *lpdwSize)'),
      RECT,
    };
  } catch (error) {
    failed = true;
    console.error('Funções nativas indisponíveis:', error.message);
  }
  return api;
}

function hwndOf(sourceId) {
  const match = /^window:(\d+):/.exec(sourceId || '');
  return match ? Number(match[1]) : 0;
}

function windowPid(hwnd) {
  const out = [0];
  return api.GetWindowThreadProcessId(hwnd, out) ? out[0] : 0;
}

// PID do processo dono da janela. Apps da Microsoft Store (UWP) ficam dentro do
// ApplicationFrameHost; o processo real é o da janela filha "CoreWindow".
function pidFromSourceId(sourceId) {
  if (!load()) return 0;
  const hwnd = hwndOf(sourceId);
  if (!hwnd) return 0;
  const core = api.FindWindowExW(hwnd, 0, 'Windows.UI.Core.CoreWindow', null);
  if (core) {
    const pid = windowPid(core);
    if (pid) return pid;
  }
  return windowPid(hwnd);
}

function processPath(pid) {
  if (!load() || !pid) return '';
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(1024 * 2);
    const size = [1024];
    if (!api.QueryFullProcessImageNameW(handle, 0, buffer, size)) return '';
    return buffer.toString('utf16le', 0, size[0] * 2);
  } finally {
    api.CloseHandle(handle);
  }
}

// Retângulo da janela em pixels físicos, ou null se minimizada/invisível.
function windowRect(sourceId) {
  if (!load()) return null;
  const hwnd = hwndOf(sourceId);
  if (!hwnd || !api.IsWindowVisible(hwnd) || api.IsIconic(hwnd)) return null;
  const rect = {};
  if (!api.GetWindowRect(hwnd, rect)) return null;
  return { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top };
}

function isForeground(sourceId) {
  if (!load()) return true;
  return api.GetForegroundWindow() === hwndOf(sourceId);
}

// Heurística para reconhecer jogos pelo caminho do executável.
const GAME_PATH = /\\steamapps\\|\\epic games\\|\\riot games\\|\\xboxgames\\|\\gog galaxy\\games\\|\\ea games\\|\\ubisoft game launcher\\games\\|\\battle\.net\\|\\games\\|\\minecraft|\\\.minecraft\\|\\prismlauncher\\|\\modrinth|\\roblox\\|\\overwatch\\|\\marvelrivals|\\fortnitegame\\|\\valorant\\|\\league of legends\\|\\genshin|\\curseforge\\minecraft/i;
const GAME_EXE = /\\(javaw|minecraft\.windows|robloxplayerbeta|valorant-win64-shipping|league of legends|overwatch|r5apex|cs2|dota2|gta5|rocketleague|fortniteclient-win64-shipping|eldenring|terraria|stardew valley|hollow_knight|deadlock|marvel-win64-shipping|cyberpunk2077|bg3|bg3_dx11)\.exe$/i;

const NOT_GAMES = new Set(['steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe', 'riotclientservices.exe', 'riotclientux.exe', 'battle.net.exe', 'discord.exe', 'chrome.exe', 'vivaldi.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'code.exe', 'spotify.exe', 'explorer.exe', 'telinha.exe', 'electron.exe', 'modrinth app.exe', 'prismlauncher.exe', 'curseforge.exe', 'overwolf.exe']);

function isGamePath(path) {
  if (!path) return false;
  const exe = path.split('\\').pop().toLowerCase();
  if (NOT_GAMES.has(exe)) return false;
  return GAME_EXE.test(path) || GAME_PATH.test(path);
}

module.exports = { available: () => !!load(), hwndOf, pidFromSourceId, processPath, windowRect, isForeground, isGamePath };
