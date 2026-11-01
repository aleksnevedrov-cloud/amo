// Обновляет evals/fixtures/catalog-yml.ts из catalog.yml (каталог для прогона eval из API, где файлов fixtures нет).
// Файл встраивается байтами (base64): фид в windows-1251, кодировку разбирает импортёр.
import { readFileSync, writeFileSync } from 'node:fs';
const bytes = readFileSync(new URL('../fixtures/catalog.yml', import.meta.url));
writeFileSync(
  new URL('../fixtures/catalog-yml.ts', import.meta.url),
  `// Сгенерировано из catalog.yml (pnpm --filter @ai-door/evals run embed): тестовый каталог для прогона eval из API,\n// где файлов fixtures нет. Байты файла в base64 (фид в windows-1251); тест runner.test.ts проверяет совпадение с catalog.yml.\nexport const CATALOG_YML_BASE64 = '${bytes.toString('base64')}';\n`,
);
console.log('catalog-yml.ts обновлён');
