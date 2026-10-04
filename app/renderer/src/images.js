// Preparação de imagens (foto de perfil e reações): recorte, redução e hash.

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export const MAX_IMAGE_BYTES = 700 * 1024;

export function validImage(data) {
  return typeof data === 'string' && data.length <= MAX_IMAGE_BYTES * 1.4 && IMAGE_RE.test(data);
}

export async function hashData(data) {
  const bytes = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Imagem inválida.'));
    img.src = src;
  });
}

function toCanvas(img, size, square) {
  const canvas = document.createElement('canvas');
  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2;
    sy = (sh - side) / 2;
    sw = side;
    sh = side;
    canvas.width = size;
    canvas.height = size;
  } else {
    const scale = Math.min(1, size / Math.max(sw, sh));
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
  }
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Foto de perfil: quadrada, 128 px, WebP.
export async function prepareAvatar(file) {
  const img = await loadImage(await readFile(file));
  return toCanvas(img, 128, true).toDataURL('image/webp', 0.85);
}

// Reação: até 256 px. GIFs pequenos são mantidos como estão para não perder a animação.
export async function prepareReaction(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use uma imagem PNG, JPG, WebP ou GIF.');
  const original = await readFile(file);
  if (file.type === 'image/gif') {
    if (file.size > 600 * 1024) throw new Error('GIF muito grande. O limite é 600 KB.');
    return original;
  }
  const img = await loadImage(original);
  const data = toCanvas(img, 256, false).toDataURL('image/webp', 0.88);
  if (data.length > MAX_IMAGE_BYTES * 1.33) throw new Error('Imagem muito grande.');
  return data;
}

export function pickFile(accept = 'image/png,image/jpeg,image/webp,image/gif') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}
