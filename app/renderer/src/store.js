// Armazenamento local (IndexedDB): Turmas, mensagens e imagens.
// Tudo fica só neste computador; os amigos sincronizam entre si pela rede.

const DB_NAME = 'telinha';
const STORE = 'kv';
const MAX_MESSAGES = 500;
const MAX_REACTIONS = 48;
const MAX_IMAGES = 400;

let dbPromise = null;
const memory = new Map(); // fallback se o IndexedDB falhar

function db() {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function get(key, fallback = null) {
  const d = await db();
  if (!d) return memory.has(key) ? memory.get(key) : fallback;
  return new Promise((resolve) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result === undefined ? fallback : req.result);
    req.onerror = () => resolve(fallback);
  });
}

export async function set(key, value) {
  const d = await db();
  if (!d) { memory.set(key, value); return; }
  await new Promise((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

export async function del(key) {
  const d = await db();
  if (!d) { memory.delete(key); return; }
  await new Promise((resolve) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

// Grava em série por chave, para evitar sobrescritas fora de ordem.
const queues = new Map();
function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

// ---- Turmas ----
// { code, name, nameTs, createdAt, lastOpened, pinned, members: { uid: { name, avatar, lastSeen } } }

export async function listTurmas() {
  const list = await get('turmas', []);
  return Array.isArray(list) ? list : [];
}

export function saveTurma(turma) {
  return serial('turmas', async () => {
    const list = await listTurmas();
    const index = list.findIndex((t) => t.code === turma.code);
    if (index >= 0) list[index] = turma;
    else list.push(turma);
    await set('turmas', list);
  });
}

export function updateTurma(code, change) {
  return serial('turmas', async () => {
    const list = await listTurmas();
    const index = list.findIndex((t) => t.code === code);
    if (index < 0) return null;
    list[index] = { ...list[index], ...change(list[index]) };
    await set('turmas', list);
    return list[index];
  });
}

export function removeTurma(code) {
  return serial('turmas', async () => {
    const list = await listTurmas();
    await set('turmas', list.filter((t) => t.code !== code));
    await del(`msgs:${code}`);
    await del(`gallery:${code}`);
  });
}

export function newTurma(code, name) {
  return {
    code,
    name: name || '',
    nameTs: 0,
    createdAt: Date.now(),
    lastOpened: Date.now(),
    pinned: null,
    members: {},
  };
}

// ---- Mensagens ----
// { id, uid, name, text, ts }

export async function messages(code) {
  const list = await get(`msgs:${code}`, []);
  return Array.isArray(list) ? list : [];
}

// Junta mensagens novas, sem duplicar; retorna só as que eram novas.
export function addMessages(code, incoming) {
  return serial(`msgs:${code}`, async () => {
    const list = await messages(code);
    const known = new Set(list.map((m) => m.id));
    const fresh = incoming.filter((m) => !known.has(m.id));
    if (!fresh.length) return [];
    const merged = [...list, ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_MESSAGES);
    await set(`msgs:${code}`, merged);
    return fresh;
  });
}

// ---- Imagens (fotos de perfil e reações) ----
// images: { hash: dataUrl } compartilhado entre Turmas
// gallery:<code>: [{ hash, by, ts }] reações da Turma

export async function image(hash) {
  const all = await get('images', {});
  return all?.[hash] || null;
}

export async function imageHashes() {
  return Object.keys((await get('images', {})) || {});
}

export function putImage(hash, data) {
  return serial('images', async () => {
    const all = (await get('images', {})) || {};
    if (all[hash]) return false;
    all[hash] = data;
    const keys = Object.keys(all);
    if (keys.length > MAX_IMAGES) for (const k of keys.slice(0, keys.length - MAX_IMAGES)) delete all[k];
    await set('images', all);
    return true;
  });
}

export async function gallery(code) {
  const list = await get(`gallery:${code}`, []);
  return Array.isArray(list) ? list : [];
}

// Itens removidos ficam marcados (deleted) para não voltarem pela sincronização.
export function addToGallery(code, items) {
  return serial(`gallery:${code}`, async () => {
    const list = await gallery(code);
    const byHash = new Map(list.map((g) => [g.hash, g]));
    const changed = [];
    for (const item of items) {
      if (!item?.hash) continue;
      const current = byHash.get(item.hash);
      if (!current) {
        byHash.set(item.hash, item);
        changed.push(item);
      } else if (item.deleted && !current.deleted) {
        byHash.set(item.hash, { ...current, deleted: true });
        changed.push(item);
      }
    }
    if (!changed.length) return [];
    const all = [...byHash.values()].sort((a, b) => a.ts - b.ts);
    const live = all.filter((g) => !g.deleted).slice(-MAX_REACTIONS);
    const tombstones = all.filter((g) => g.deleted).slice(-200);
    await set(`gallery:${code}`, [...tombstones, ...live]);
    return changed;
  });
}
