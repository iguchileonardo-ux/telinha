// Onde a interface está rodando: app do Windows (Electron) ou versão web (celular e navegador).
const bridge = window.telinha ?? null;

// Versão web publicada no servidor da Telinha (o index.html dela leva data-web="1").
export const isWeb = !bridge && document.documentElement.dataset.web === '1';

// Celulares e tablets: o navegador não captura a tela, então só dá para assistir.
const ua = navigator.userAgent || '';
export const mobile = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
  || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPad se apresenta como Mac
export const canShare = !!bridge || (!mobile && typeof navigator.mediaDevices?.getDisplayMedia === 'function');

// Tela de toque, sem mouse: os controles das telas aparecem com um toque.
export const touch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// No iPhone o volume de áudio e vídeo não pode ser mudado pela página (só o mudo).
export const volumeControl = (() => {
  try {
    const el = document.createElement('audio');
    el.volume = 0.5;
    return el.volume === 0.5;
  } catch {
    return true;
  }
})();

// Escolha da saída de áudio (não existe no iPhone nem no Android).
export const sinkControl = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// Cabeçalho que o servidor exige para entregar as credenciais do TURN.
export const APP_HEADER = 'telinha-app-v1-7d3f91c2';

// Endereço da versão web a partir do servidor da Telinha (wss://... -> https://...).
export function webOrigin(server) {
  const url = String(server || '').trim().replace(/\/$/, '');
  if (!/^wss?:\/\//i.test(url)) return '';
  return url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

// Convite que abre no navegador do celular.
export function webInviteLink(code, server) {
  const origin = webOrigin(server);
  return origin ? `${origin}/?sala=${code}` : '';
}
