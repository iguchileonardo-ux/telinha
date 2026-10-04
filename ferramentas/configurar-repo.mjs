// Aponta a Telinha para o repositório do GitHub: node ferramentas/configurar-repo.mjs <usuario>
import { readFileSync, writeFileSync } from 'node:fs';

const owner = String(process.argv[2] || '').trim();
if (!/^[A-Za-z0-9-]+$/.test(owner)) {
  console.error('Usuario do GitHub invalido.');
  process.exit(1);
}
const file = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.repository = { type: 'git', url: `https://github.com/${owner}/telinha.git` };
pkg.telinha = { ...(pkg.telinha || {}), updateRepo: `${owner}/telinha` };
pkg.build.publish = [{ provider: 'github', owner, repo: 'telinha', releaseType: 'release' }];
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Atualizacao configurada para ${owner}/telinha`);
