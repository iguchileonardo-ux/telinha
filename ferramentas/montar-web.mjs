// Monta a versão web da Telinha (para assistir pelo celular) em servidor-cloudflare/publico.
// É a mesma interface do app, servida pelo servidor da Telinha no Cloudflare.
// Uso: node ferramentas/montar-web.mjs (a partir da pasta da Telinha).
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

// Empacota a interface (app/renderer/dist/app.js).
await import('../build.mjs');

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const out = path.join('servidor-cloudflare', 'publico');
// Muda a cada montagem, para o navegador do celular não usar arquivos antigos.
const v = `${pkg.version}-${Date.now().toString(36)}`;

let html = await readFile(path.join('app', 'renderer', 'index.html'), 'utf8');
const swaps = [
  ['<html lang="pt-BR" data-theme="dark">', '<html lang="pt-BR" data-theme="dark" data-web="1">'],
  ['<link rel="stylesheet" href="style.css" />', [
    `<link rel="stylesheet" href="style.css?v=${v}" />`,
    '  <link rel="manifest" href="manifest.webmanifest" />',
    '  <link rel="icon" href="icon.png" />',
    '  <link rel="apple-touch-icon" href="icon.png" />',
    '  <meta name="theme-color" content="#0c0d0f" />',
    '  <meta name="mobile-web-app-capable" content="yes" />',
    '  <meta name="apple-mobile-web-app-capable" content="yes" />',
    '  <meta name="apple-mobile-web-app-title" content="Telinha" />',
    '  <meta name="description" content="Assista às telas da sua turma e entre na call pelo celular." />',
  ].join('\n')],
  ['<script defer src="dist/app.js"></script>', `<script defer src="dist/app.js?v=${v}"></script>`],
];
for (const [from, to] of swaps) {
  if (!html.includes(from)) throw new Error(`index.html mudou: não encontrei ${from}`);
  html = html.replace(from, to);
}

const manifest = {
  name: 'Telinha',
  short_name: 'Telinha',
  description: 'Assista às telas da sua turma e entre na call pelo celular.',
  lang: 'pt-BR',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0c0d0f',
  theme_color: '#0c0d0f',
  icons: [{ src: 'icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
};

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'dist'), { recursive: true });
await writeFile(path.join(out, 'index.html'), html);
await writeFile(path.join(out, 'manifest.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
// Lê e grava (em vez de copiar) para não levar o atributo de somente leitura dos originais.
const copy = async (from, to) => writeFile(to, await readFile(from));
await copy(path.join('app', 'renderer', 'style.css'), path.join(out, 'style.css'));
await copy(path.join('app', 'renderer', 'dist', 'app.js'), path.join(out, 'dist', 'app.js'));
await copy(path.join('app', 'icon.png'), path.join(out, 'icon.png'));
console.log(`Versão web ${v} montada em ${out}`);
