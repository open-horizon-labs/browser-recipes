import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['extension/background.js', 'extension/options.js'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
});
await Promise.all(
  ['manifest.json', 'options.html', 'options.css', 'catalog.json', 'THIRD_PARTY_NOTICES.txt'].map(
    file => cp(`extension/${file}`, `dist/${file}`)
  )
);

await Promise.all(['standard_fonts', 'cmaps'].map(
  directory => cp(`node_modules/pdfjs-dist/${directory}`, `dist/${directory}`, { recursive: true })
));
