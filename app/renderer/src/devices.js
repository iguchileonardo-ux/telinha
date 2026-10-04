// Escolha de microfone e de saída de áudio.
const bridge = window.telinha ?? null;

let speaker = { id: '', label: '' };

// Remove o código USB do fim do nome, ex.: "Fone (Astro A50) (9886:002c)".
function cleanName(label) {
  return String(label || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || 'Dispositivo sem nome';
}

// Lista os dispositivos de áudio. As entradas "default"/"communications" do
// Windows ficam de fora: a opção "Padrão do sistema" já cobre esse caso.
export async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const pick = (kind) => all
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ id: d.deviceId, label: d.label, name: cleanName(d.label) }));
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

// Saída em uso: a escolhida, ou a padrão enquanto ela estiver desconectada.
let effective = '';

export function applySink(el) {
  if (typeof el?.setSinkId !== 'function') return;
  if (el.sinkId === effective) return;
  el.setSinkId(effective).catch(() => {
    if (effective) el.setSinkId('').catch(() => {});
  });
}

async function refreshEffective() {
  let next = speaker.id;
  if (next) {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => null);
    if (devices && !devices.some((d) => d.kind === 'audiooutput' && d.deviceId === next)) next = '';
  }
  if (next === effective) return;
  effective = next;
  applyAll();
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshEffective());

function applyAll() {
  document.querySelectorAll('audio, video').forEach(applySink);
}

export function setSpeaker(id, label) {
  speaker = { id: id || '', label: id ? label || '' : '' };
  effective = speaker.id;
  applyAll();
  refreshEffective();
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
