// Сборка приложения в один ESM-файл.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) throw new Error('usage: build-app.mjs <entry> <outfile>');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// Внешними остаются только зависимости приложения из npm: их node найдёт в его node_modules.
// Пакеты воркспейса (версия `workspace:*`) встраиваются в бандл независимо от имени — при строгой
// раскладке pnpm их исходники .ts из node_modules приложения node загрузить не сможет.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const external = new Set(
  Object.entries(pkg.dependencies ?? {})
    .filter(([, version]) => !String(version).startsWith('workspace:'))
    .map(([name]) => name),
);
external.add('pg-native'); // необязательный нативный драйвер pg

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  metafile: true,
  external: [...external],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

// Защита от повтора: ни один пакет воркспейса не должен остаться внешним импортом бандла.
const leaked = externalWorkspaceImports(result.metafile, workspacePackageNames(repoRoot));
if (leaked.length) {
  throw new Error(`В бандле ${outfile} остались внешними пакеты воркспейса: ${leaked.join(', ')} — они должны быть встроены`);
}

/** Имена всех пакетов воркспейса по шаблонам из pnpm-workspace.yaml (поддерживаются `*` в сегментах пути). */
function workspacePackageNames(root) {
  const patterns = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\s+-\s+(\S+)\s*$/)?.[1])
    .filter(Boolean);
  const names = new Set();
  for (const pattern of patterns) {
    for (const dir of expand(root, pattern.split('/'))) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) names.add(JSON.parse(readFileSync(manifest, 'utf8')).name);
    }
  }
  return names;
}

function expand(base, segments) {
  if (!segments.length) return [base];
  const [head, ...rest] = segments;
  if (head !== '*') return existsSync(join(base, head)) ? expand(join(base, head), rest) : [];
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules')
    .flatMap((d) => expand(join(base, d.name), rest));
}

/** Внешние импорты бандла, которые ведут в пакеты воркспейса (с учётом подпутей вида @core/llm/types). */
function externalWorkspaceImports(metafile, names) {
  const found = new Set();
  for (const out of Object.values(metafile.outputs)) {
    for (const imp of out.imports ?? []) {
      if (!imp.external) continue;
      const parts = imp.path.split('/');
      const name = imp.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (names.has(name)) found.add(imp.path);
    }
  }
  return [...found].sort();
}
