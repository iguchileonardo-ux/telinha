// Escolha de microfone e de saída de áudio.
const bridge = window.telinha ?? null;

let speaker = { id: '', label: '' };

// Lista os dispositivos de áudio. As entradas "default"/"communications" do
// Windows ficam de fora: a opção "Padrão do sistema" já cobre esse caso.
export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind) => all
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label || 'Dispositivo sem nome' }));
    return { inputs: pick('audioinput'), outputs: pick('audiooutput') };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

// Restrições do microfone escolhido ('' = padrão do sistema).
export function micConstraints(micId) {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return micId ? { ...base, deviceId: { exact: micId } } : base;
}

export function applySink(el) {
  if (typeof el?.setSinkId !== 'function') return;
  if (el.sinkId === speaker.id) return;
  el.setSinkId(speaker.id).catch(() => {
    // Saída desconectada: volta para a padrão.
    if (speaker.id) el.setSinkId('').catch(() => {});
  });
}

function applyAll() {
  document.querySelectorAll('audio, video').forEach(applySink);
}

export function setSpeaker(id, label) {
  speaker = { id: id || '', label: id ? label || '' : '' };
  applyAll();
  bridge?.radioCommand('sink', speaker.label).catch(() => {});
}

// Elementos de áudio e vídeo criados depois também usam a saída escolhida.
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches('audio, video')) applySink(node);
      else node.querySelectorAll?.('audio, video').forEach(applySink);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
