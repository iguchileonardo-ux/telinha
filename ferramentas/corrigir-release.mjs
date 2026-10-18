// Junta releases repetidas com a mesma tag no GitHub.
// O electron-builder envia os arquivos ao mesmo tempo e, às vezes, cria duas
// releases para a mesma versão: uma fica só com o .blockmap e a outra com o
// instalador e o latest.yml. Quando isso acontece, o endereço de download da tag
// aponta para a release sem o latest.yml e as atualizações automáticas param.
// Uso: node ferramentas/corrigir-release.mjs   (precisa do gh logado)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const repo = String(pkg.telinha?.updateRepo || '').trim();
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.log('Repositório de atualizações não configurado no package.json.');
  process.exit(1);
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

function listReleases() {
  const all = [];
  for (let page = 1; page < 10; page++) {
    const chunk = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100&page=${page}`]));
    all.push(...chunk);
    if (chunk.length < 100) break;
  }
  return all;
}

function downloadAsset(asset, file) {
  const result = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], { maxBuffer: 1 << 30 });
  if (result.status !== 0 || !result.stdout?.length) throw new Error(`não foi possível baixar ${asset.name}`);
  fs.writeFileSync(file, result.stdout);
}

async function check(tag) {
  try {
    const res = await fetch(`https://github.com/${repo}/releases/download/${tag}/latest.yml`);
    const text = res.ok ? await res.text() : '';
    const version = /^version:\s*(\S+)/m.exec(text)?.[1];
    return res.ok ? `latest.yml de ${tag} acessível (versão ${version || '?'})` : `latest.yml de ${tag} ainda não acessível (HTTP ${res.status})`;
  } catch (error) {
    return `não foi possível conferir ${tag}: ${error.message}`;
  }
}

const byTag = new Map();
for (const release of listReleases()) {
  if (release.draft) continue;
  if (!byTag.has(release.tag_name)) byTag.set(release.tag_name, []);
  byTag.get(release.tag_name).push(release);
}

let fixed = 0;
for (const [tag, releases] of byTag) {
  if (releases.length < 2) continue;
  const hasYml = (r) => r.assets.some((a) => a.name === 'latest.yml');
  const keeper = releases.filter(hasYml).sort((a, b) => b.assets.length - a.assets.length || a.id - b.id)[0];
  if (!keeper) {
    console.log(`${tag}: ${releases.length} releases, nenhuma com latest.yml. Nada foi alterado.`);
    continue;
  }
  const names = new Set(keeper.assets.map((a) => a.name));
  console.log(`${tag}: ${releases.length} releases com a mesma tag. Mantendo a ${keeper.id} (${[...names].join(', ')}).`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'telinha-release-'));
  const moved = [];
  try {
    for (const other of releases.filter((r) => r.id !== keeper.id)) {
      for (const asset of other.assets.filter((a) => !names.has(a.name))) {
        const file = path.join(tmp, asset.name);
        downloadAsset(asset, file);
        moved.push(file);
        names.add(asset.name);
      }
    }
    for (const other of releases.filter((r) => r.id !== keeper.id)) {
      gh(['api', '-X', 'DELETE', `repos/${repo}/releases/${other.id}`]);
      console.log(`${tag}: release repetida ${other.id} removida.`);
    }
    if (moved.length) {
      gh(['release', 'upload', tag, ...moved, '--repo', repo, '--clobber']);
      console.log(`${tag}: arquivos copiados para a release mantida: ${moved.map((f) => path.basename(f)).join(', ')}.`);
    }
    fixed++;
  } catch (error) {
    console.log(`${tag}: falhou (${String(error.stderr || error.message).trim()}).`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(await check(tag));
}

if (!fixed) console.log('Nenhuma release repetida encontrada.');
const latest = [...byTag.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
if (latest) console.log(await check(latest));
