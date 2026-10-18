// Empacota a interface (app/renderer/src) em um único arquivo.
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

// Correção na biblioteca de rede (Trystero 0.25.4), aplicada ao empacotar.
// Depois de umas 6 tentativas seguidas sem conseguir abrir o socket de sinalização (cerca de
// 1 minuto sem internet, comum ao voltar da suspensão), ela desistia para sempre: a Telinha
// ficava sem encontrar ninguém até ser encerrada pela bandeja. Com a correção ela continua
// tentando, no máximo a cada 15 s. Se a biblioteca mudar, o build para com um aviso.
const trysteroReconnect = {
  name: 'trystero-reconexao',
  setup(build) {
    build.onLoad({ filter: /[\\/]@trystero-p2p[\\/]core[\\/]dist[\\/]utils\.mjs$/ }, async (args) => {
      const code = await readFile(args.path, 'utf8');
      const giveUp = /if \(period >= maxRetryMs\) \{\s*client\.isClosed = true;\s*return;\s*\}/;
      const max = 'const maxRetryMs = 6e4;';
      if (!giveUp.test(code) || !code.includes(max)) {
        throw new Error('Correção de reconexão do Trystero: código esperado não encontrado. Confira a versão de @trystero-p2p/core.');
      }
      return { contents: code.replace(giveUp, '').replace(max, 'const maxRetryMs = 15e3;'), loader: 'js' };
    });
  },
};

const options = {
  entryPoints: { app: 'app/renderer/src/main.js', overlay: 'app/renderer/src/overlay-main.js' },
  outdir: 'app/renderer/dist',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
  plugins: [trysteroReconnect],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Observando alterações em app/renderer/src');
} else {
  await esbuild.build(options);
}
