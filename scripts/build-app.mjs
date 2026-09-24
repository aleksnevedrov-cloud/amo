// Сборка приложения в один ESM-файл.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) throw new Error('usage: build-app.mjs <entry> <outfile>');

// Внешними остаются только прямые зависимости приложения: их node найдёт в его node_modules.
// Зависимости пакетов воркспейса (pg, jose, zod…) встраиваются в бандл — при строгой
// раскладке pnpm они не видны из каталога приложения.
const pkg = JSON.parse(readFileSync(new URL('package.json', `file://${process.cwd()}/`), 'utf8'));
const external = new Set(Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@ai-door/')));
external.add('pg-native'); // необязательный нативный драйвер pg

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: [...external],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
