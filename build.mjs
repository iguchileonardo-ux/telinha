// Empacota a interface (app/renderer/src) em um único arquivo.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

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
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Observando alterações em app/renderer/src');
} else {
  await esbuild.build(options);
}
