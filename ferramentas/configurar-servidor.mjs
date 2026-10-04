// Grava o endereço do servidor da Telinha no package.json.
// Uso: node ferramentas/configurar-servidor.mjs <arquivo-de-log-do-deploy>
import { readFileSync, writeFileSync } from 'node:fs';

const log = readFileSync(process.argv[2] || '', 'utf8');
const match = log.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
if (!match) {
  console.error('Endereco do servidor nao encontrado na saida do deploy.');
  process.exit(1);
}
const url = match[0].toLowerCase();
const file = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.telinha = { ...(pkg.telinha || {}), server: url };
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(url);
