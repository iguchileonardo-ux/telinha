// Códigos de sala: 12 caracteres aleatórios (≈ 59 bits), fáceis de ler.
// O código funciona como a "chave" da sala: só entra quem tem o convite.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PATTERN = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

export function newRoomCode() {
  const chars = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (chars.length < 12) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    for (const b of bytes) {
      if (b < limit && chars.length < 12) chars.push(ALPHABET[b % ALPHABET.length]);
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

export function inviteLink(code) {
  return `telinha://sala/${code}`;
}

// Aceita "telinha://sala/abcd-efgh-jkmn", o código com ou sem traços, maiúsculo ou não.
// strict = true exige que o texto seja só o link/código (usado ao ler a área de transferência).
export function parseRoomCode(text, { strict = false } = {}) {
  if (typeof text !== 'string') return null;
  let value = text.trim().toLowerCase();
  const fromLink = value.match(/^telinha:\/\/(?:sala\/)?([a-z0-9-]+)\/?$/);
  if (fromLink) value = fromLink[1];
  else if (strict && value.length > 14) return null;
  const compact = value.replace(/[\s-]/g, '');
  if (compact.length !== 12) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
  return PATTERN.test(code) ? code : null;
}
