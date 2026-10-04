// Escolha do que compartilhar e captura (tela, janela ou só o som, sem eco).
// No app (Electron) mostramos um seletor próprio; no navegador usamos o nativo.
import { icon } from './icons.js';
import { createPcmTrack } from './audio.js';

const bridge = window.telinha ?? null;
const FRAME_RATE = { detail: 30, motion: 60, movie: 24 };

let audioSupport = null;
let pcm = null;

bridge?.onAudio?.((chunk) => pcm?.push(chunk));

async function getAudioSupport() {
  if (!bridge) return { available: false, fallback: false };
  if (!audioSupport) {
    const res = await bridge.audioSupport().catch(() => ({ available: false }));
    audioSupport = { available: !!res.available, fallback: bridge.platform === 'win32' };
  }
  return audioSupport;
}

export function stopCapture() {
  if (pcm) {
    pcm.close();
    pcm = null;
  }
  bridge?.stopAudio?.().catch(() => {});
}

// Retorna { stream, kind: 'screen' | 'audio', label, audio, sourceId, warning } ou null se cancelar.
// audio: 'window' | 'system' | 'system-echo' | 'browser' | null
export async function captureScreen({ quality = 'detail', audio = true, lastSource = null } = {}) {
  const frameRate = FRAME_RATE[quality] || 30;
  const video = { frameRate: { ideal: frameRate, max: frameRate } };

  if (!bridge) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video,
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: audio ? 'include' : 'exclude',
      windowAudio: audio ? 'window' : 'exclude',
    });
    return { stream, kind: 'screen', label: '', audio: stream.getAudioTracks().length ? 'browser' : null, sourceId: null };
  }

  const support = await getAudioSupport();
  const choice = await openPicker({ audio, support, lastSource });
  if (!choice) return null;
  stopCapture();

  // Só o som: nenhuma imagem, apenas a faixa de áudio capturada sem eco.
  if (choice.kind === 'audio') {
    pcm = await createPcmTrack();
    const result = await bridge.startAudio(choice.id);
    if (!result?.ok) { stopCapture(); throw new Error(result?.error || 'Falha ao capturar o som.'); }
    const stream = new MediaStream([pcm.track]);
    return { stream, kind: 'audio', label: choice.name, audio: result.mode, sourceId: null, source: choice };
  }

  const useFallback = choice.audio && !support.available && choice.kind === 'screen' && support.fallback;
  await bridge.selectSource(choice.id, useFallback);
  const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: useFallback });
  const base = { stream, kind: 'screen', label: choice.name, sourceId: choice.id, source: choice };

  if (useFallback) return { ...base, audio: stream.getAudioTracks().length ? 'system-echo' : null };
  if (!choice.audio || !support.available) return { ...base, audio: null };

  try {
    pcm = await createPcmTrack();
    const result = await bridge.startAudio(choice.id);
    if (!result?.ok) throw new Error(result?.error || 'Falha ao capturar o áudio.');
    stream.addTrack(pcm.track);
    return { ...base, audio: result.mode };
  } catch (error) {
    stopCapture();
    console.error(error);
    return { ...base, audio: null, warning: `Compartilhando sem áudio: ${error.message}` };
  }
}

// ---- seletor de fontes ----

function openPicker({ audio, support, lastSource }) {
  const dlg = document.getElementById('picker');
  const grid = document.getElementById('sourceGrid');
  const tabs = document.getElementById('pickerTabs');
  const confirm = document.getElementById('pickerConfirm');
  const cancel = document.getElementById('pickerCancel');
  const audioToggle = document.getElementById('audioToggle');
  const audioWrap = document.getElementById('audioWrap');
  const audioLabel = document.getElementById('audioLabel');
  const audioHint = document.getElementById('audioHint');
  const audioTab = tabs.querySelector('[data-kind="audio"]');
  audioTab.hidden = !support.available;

  let sources = [];
  let kind = 'screen';
  let selected = null;
  let wantAudio = audio;

  function syncAudio() {
    if (kind === 'audio') {
      audioWrap.hidden = false;
      audioToggle.disabled = true;
      audioToggle.checked = true;
      audioLabel.textContent = 'Só o som';
      audioHint.textContent = 'Sem imagem. Ideal para música: o som da Telinha fica de fora.';
      return;
    }
    const isWindow = kind === 'window';
    const possible = support.available || (!isWindow && support.fallback);
    audioWrap.hidden = !support.available && !support.fallback;
    audioToggle.disabled = !possible;
    audioToggle.checked = possible && wantAudio;
    audioLabel.textContent = isWindow ? 'Áudio desta janela' : 'Áudio do computador';
    if (!possible) audioHint.textContent = 'Áudio de janela não está disponível neste Windows.';
    else if (!support.available) audioHint.textContent = 'Pode dar eco se você estiver ouvindo alguém.';
    else if (isWindow) audioHint.textContent = 'Só o som do programa escolhido.';
    else audioHint.textContent = 'Sem o som da Telinha, então não dá eco.';
  }

  function listFor(k) {
    if (k === 'audio') {
      return [
        { id: 'system', name: 'Todo o som do computador', kind: 'audio', thumb: null, icon: null, system: true },
        ...sources.filter((s) => s.kind === 'window').map((s) => ({ ...s, kind: 'audio' })),
      ];
    }
    const list = sources.filter((s) => s.kind === k);
    // Jogos primeiro
    return [...list.filter((s) => s.game), ...list.filter((s) => !s.game)];
  }

  return new Promise((resolve) => {
    const finish = (result) => {
      cleanup();
      if (dlg.open) dlg.close();
      resolve(result);
    };
    const onConfirm = () => {
      if (!selected) return;
      const source = listFor(kind).find((s) => s.id === selected);
      finish({
        id: selected,
        kind,
        name: source?.name || '',
        audio: kind === 'audio' ? true : !audioWrap.hidden && !audioToggle.disabled && audioToggle.checked,
      });
    };
    const onCancel = () => finish(null);
    const onClose = () => finish(null);
    const onTab = (e) => {
      const btn = e.target.closest('button[data-kind]');
      if (!btn) return;
      kind = btn.dataset.kind;
      selected = null;
      render();
    };
    const onToggle = () => { wantAudio = audioToggle.checked; };

    function select(id) {
      selected = id;
      for (const card of grid.querySelectorAll('.source')) {
        card.classList.toggle('selected', card.dataset.id === id);
        card.setAttribute('aria-pressed', String(card.dataset.id === id));
      }
      confirm.disabled = !selected;
    }

    function render(preferred) {
      for (const b of tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.kind === kind);
      syncAudio();
      const list = listFor(kind);
      grid.replaceChildren();
      if (!list.length) {
        grid.append(textNode(kind === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta para compartilhar.'));
      }
      list.forEach((s, index) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'source' + (kind === 'audio' ? ' compact' : '');
        card.dataset.id = s.id;
        if (kind !== 'audio') {
          const thumb = document.createElement('div');
          thumb.className = 'source-thumb';
          if (s.thumb) {
            const img = document.createElement('img');
            img.src = s.thumb;
            img.alt = '';
            thumb.append(img);
          } else {
            thumb.append(icon(kind === 'screen' ? 'monitor' : 'window', 28));
          }
          if (s.game) {
            const badge = document.createElement('span');
            badge.className = 'source-badge';
            badge.append(icon('game', 13), 'Jogo');
            thumb.append(badge);
          }
          card.append(thumb);
        }
        const label = document.createElement('div');
        label.className = 'source-name';
        if (s.icon) {
          const ico = document.createElement('img');
          ico.src = s.icon;
          ico.alt = '';
          label.append(ico);
        } else if (kind === 'audio') {
          label.append(icon(s.system ? 'volume' : 'window', 16));
        }
        const text = document.createElement('span');
        text.textContent = s.kind === 'screen' ? screenLabel(s, index, list.length) : s.name;
        text.title = s.name;
        label.append(text);
        card.append(label);
        card.addEventListener('click', () => select(s.id));
        card.addEventListener('dblclick', () => { select(s.id); onConfirm(); });
        grid.append(card);
      });
      const keep = list.find((s) => s.id === (preferred || selected));
      select(keep ? keep.id : list[0]?.id ?? null);
    }

    function cleanup() {
      confirm.removeEventListener('click', onConfirm);
      cancel.removeEventListener('click', onCancel);
      tabs.removeEventListener('click', onTab);
      audioToggle.removeEventListener('change', onToggle);
      dlg.removeEventListener('close', onClose);
    }

    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', onCancel);
    tabs.addEventListener('click', onTab);
    audioToggle.addEventListener('change', onToggle);
    dlg.addEventListener('close', onClose);

    syncAudio();
    grid.replaceChildren(loadingNode());
    confirm.disabled = true;
    dlg.showModal();

    bridge.listSources().then((list) => {
      sources = list;
      // Sugestão: um jogo aberto; senão, a última fonte usada.
      const game = sources.find((s) => s.game);
      const last = lastSource && sources.find((s) => s.name === lastSource.name && (lastSource.kind === 'audio' || s.kind === lastSource.kind));
      let preferred = null;
      if (game) { kind = 'window'; preferred = game.id; }
      else if (last) { kind = lastSource.kind === 'audio' && support.available ? 'audio' : last.kind; preferred = last.id; }
      else if (lastSource?.kind === 'audio' && lastSource.name === 'Todo o som do computador' && support.available) { kind = 'audio'; preferred = 'system'; }
      else if (!sources.some((s) => s.kind === 'screen')) kind = 'window';
      render(preferred);
    }).catch(() => {
      grid.replaceChildren(textNode('Não foi possível listar as telas.'));
    });
  });
}

function screenLabel(source, index, total) {
  if (total === 1) return 'Tela inteira';
  return /^screen/i.test(source.name) || /^entire/i.test(source.name) ? `Tela ${index + 1}` : source.name;
}

function loadingNode() {
  const p = textNode('Carregando');
  p.classList.add('loading');
  return p;
}

function textNode(text) {
  const p = document.createElement('p');
  p.className = 'source-empty';
  p.textContent = text;
  return p;
}
