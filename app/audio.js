// Captura de áudio no Windows, sem eco.
//
// - Janela: captura só o áudio do programa dono da janela (e dos processos filhos).
// - Tela inteira: captura o som do computador EXCETO o da própria Telinha,
//   então o áudio dos amigos que você está ouvindo não volta para eles.
//
// Usa a API de "process loopback" do WASAPI (Windows 10 2004 ou mais novo)
// pelo pacote loopback-capture. O PCM sai em 16 bits, estéreo, 48 kHz.

const native = require('./native');

let addon;
let addonError = null;
let capture = null;
function loadAddon() {
  if (addon !== undefined) return addon;
  if (process.platform !== 'win32') {
    addon = null;
    addonError = 'Disponível apenas no Windows.';
    return addon;
  }
  try {
    const mod = require('loopback-capture');
    addon = mod.LoopbackCapture ? mod : mod.default;
  } catch (error) {
    addon = null;
    addonError = error.message;
    console.error('loopback-capture indisponível:', error);
  }
  return addon;
}

function support() {
  const available = !!loadAddon();
  return { available, reason: available ? null : addonError };
}

// onChunk(Buffer) recebe o PCM. Retorna { ok, mode, error }.
function start(sourceId, onChunk) {
  stop();
  const mod = loadAddon();
  if (!mod) return { ok: false, error: addonError || 'Captura de áudio indisponível.' };
  try {
    const instance = new mod.LoopbackCapture();
    if (sourceId.startsWith('window:')) {
      const pid = native.pidFromSourceId(sourceId);
      if (!pid) return { ok: false, error: 'Não foi possível identificar o programa dessa janela.' };
      if (pid === process.pid) return { ok: false, error: 'Essa janela é da própria Telinha.' };
      instance.start(pid, true, onChunk);
      capture = instance;
      return { ok: true, mode: 'window' };
    }
    // false = modo "excluir": tudo, menos a árvore de processos da Telinha.
    instance.start(process.pid, false, onChunk);
    capture = instance;
    return { ok: true, mode: 'system' };
  } catch (error) {
    console.error('Falha ao iniciar a captura de áudio:', error);
    return { ok: false, error: error.message };
  }
}

function stop() {
  const current = capture;
  capture = null;
  if (!current) return;
  try { current.stop(); } catch (error) { console.error('Falha ao parar o áudio:', error); }
}

module.exports = { support, start, stop };
