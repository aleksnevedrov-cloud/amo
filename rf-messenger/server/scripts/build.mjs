// Сборка двух процессов сервиса (api и connectors) в ESM-файлы; зависимости остаются внешними.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: { api: 'src/main-api.ts', connectors: 'src/main-connectors.ts', migrate: 'src/migrate-cli.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: [...Object.keys(pkg.dependencies ?? {}), 'pg-native'],
});
console.log('rf-messenger/server собран: dist/api.js, dist/connectors.js, dist/migrate.js');
