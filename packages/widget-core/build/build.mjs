// Сборка архива виджета amo: dist/widget/ (manifest, script.js, style.css, i18n, images) и dist/widget.zip.
// Общая для обоих виджетов; у приложения остаются только вход src/index.tsx, static/ и package.json.
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { logoPng } from './png.mjs';

const core = fileURLToPath(new URL('..', import.meta.url));

// Размеры логотипов — по официальному примеру виджета Kommo/amo.
export const LOGOS = {
  'logo.png': [130, 100],
  'logo_main.png': [400, 272],
  'logo_medium.png': [240, 84],
  'logo_min.png': [84, 84],
  'logo_small.png': [108, 108],
};

/**
 * @param {{ root: string | URL, globalName: string }} opts
 *   root — каталог приложения виджета; globalName — имя IIFE-бандла внутри AMD-обёртки.
 */
export async function buildWidgetArchive({ root, globalName }) {
  root = typeof root === 'string' ? root : fileURLToPath(root);
  const out = join(root, 'dist/widget');
  const apiUrl = process.env.WIDGET_API_URL ?? 'https://ai-agent.example.ru';
  if (!/^https:\/\//.test(apiUrl)) throw new Error('WIDGET_API_URL должен начинаться с https://');

  await rm(join(root, 'dist'), { recursive: true, force: true });
  await mkdir(join(out, 'images'), { recursive: true });

  // Стилевой слой по макету Figma: вшивается в бандл (define __STYLES__) и кладётся в архив файлом style.css.
  const styles = await readFile(join(core, 'src/styles.css'), 'utf8');
  await writeFile(join(out, 'style.css'), styles);

  const result = await build({
    entryPoints: [join(root, 'src/index.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName,
    target: 'es2020',
    minify: true,
    jsx: 'automatic',
    define: { __API_URL__: JSON.stringify(apiUrl), __STYLES__: JSON.stringify(styles), 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
  });
  const bundle = result.outputFiles[0].text;
  // AMD-обёртка: переменная бандла остаётся внутри define и не попадает в window.
  const script = `define([], function () {\n${bundle}\nreturn function () {\n  this.callbacks = ${globalName}.createCallbacks(this);\n  return this;\n};\n});\n`;
  await writeFile(join(out, 'script.js'), script);

  const manifest = JSON.parse(await readFile(join(root, 'static/manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  manifest.widget.version = pkg.version;
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await cp(join(root, 'static/i18n'), join(out, 'i18n'), { recursive: true });
  // Логотипы: свои из static/images приложения, иначе фирменные из widget-core (нарезка из логотипа
  // РФ-Двери), иначе заглушка нужного размера.
  for (const [name, [w, h]] of Object.entries(LOGOS)) {
    const own = join(root, 'static/images', name);
    const branded = join(core, 'static/images', name);
    const file = (await stat(own).catch(() => null)) ? own : (await stat(branded).catch(() => null)) ? branded : null;
    await writeFile(join(out, 'images', name), file ? await readFile(file) : logoPng(w, h));
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
  const zip = zipSync(files, { level: 9 });
  await writeFile(join(root, 'dist/widget.zip'), zip);
  console.log(
    `${pkg.name} ${pkg.version}: widget.zip ${(zip.length / 1024).toFixed(0)} КБ, ${Object.keys(files).length} файлов, API ${apiUrl}, script.js ${(script.length / 1024).toFixed(0)} КБ, style.css ${(styles.length / 1024).toFixed(1)} КБ`,
  );
}
