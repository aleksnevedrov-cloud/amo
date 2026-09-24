// Сборка архива виджета amo: dist/widget/ (manifest, script.js, i18n, images) и dist/widget.zip.
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { logoPng } from './png.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist/widget');
const apiUrl = process.env.WIDGET_API_URL ?? 'https://ai-agent.example.ru';
if (!/^https:\/\//.test(apiUrl)) throw new Error('WIDGET_API_URL должен начинаться с https://');

// Размеры логотипов — по официальному примеру виджета Kommo/amo.
export const LOGOS = {
  'logo.png': [130, 100],
  'logo_main.png': [400, 272],
  'logo_medium.png': [240, 84],
  'logo_min.png': [84, 84],
  'logo_small.png': [108, 108],
};

await rm(join(root, 'dist'), { recursive: true, force: true });
await mkdir(join(out, 'images'), { recursive: true });

const result = await build({
  entryPoints: [join(root, 'src/index.tsx')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__aiDoorWidget',
  target: 'es2020',
  minify: true,
  jsx: 'automatic',
  define: { __API_URL__: JSON.stringify(apiUrl), 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
const bundle = result.outputFiles[0].text;
// AMD-обёртка: переменная бандла остаётся внутри define и не попадает в window.
const script = `define([], function () {\n${bundle}\nreturn function () {\n  this.callbacks = __aiDoorWidget.createCallbacks(this);\n  return this;\n};\n});\n`;
await writeFile(join(out, 'script.js'), script);

const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
manifest.widget.version = pkg.version;
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(join(root, 'static/i18n'), join(out, 'i18n'), { recursive: true });
for (const [name, [w, h]] of Object.entries(LOGOS)) {
  await writeFile(join(out, 'images', name), logoPng(w, h));
}

// Файлы в корне архива, без вложенной папки — так требует загрузка виджета в amo.
const files = {};
const walk = async (dir) => {
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) await walk(p);
    else files[relative(out, p)] = new Uint8Array(await readFile(p));
  }
};
await walk(out);
await writeFile(join(root, 'dist/widget.zip'), zipSync(files, { level: 9 }));
console.log(`widget.zip собран: ${Object.keys(files).length} файлов, API ${apiUrl}, script.js ${(script.length / 1024).toFixed(0)} КБ`);
