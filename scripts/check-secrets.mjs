// Проверка на секреты в репозитории (раздел 12 и 14 ТЗ: «отсутствие секретов»).
// Ищет ключи API, токены и приватные ключи в отслеживаемых git файлах. Запускается в `pnpm check` и CI.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'ключ Anthropic'],
  [/sk-[A-Za-z0-9]{32,}/, 'ключ OpenAI'],
  [/AQVN[A-Za-z0-9_-]{30,}/, 'API-ключ Yandex Cloud'],
  [/AKIA[0-9A-Z]{16}/, 'ключ AWS'],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'приватный ключ'],
  [/\b\d{9,10}:[A-Za-z0-9_-]{35}\b/, 'токен Telegram-бота'],
  [/(?:client_secret|CLIENT_SECRET|api_key|API_KEY|password|PASSWORD)\s*[:=]\s*["'][A-Za-z0-9/+_-]{24,}["']/, 'секрет в коде'],
];
// Тестовые и служебные файлы, где заведомо стоят выдуманные значения.
const SKIP = /(^|\/)(\.env\.example|pnpm-lock\.yaml|.*\.test\.tsx?|.*\.md|scripts\/check-secrets\.mjs)$|(^|\/)test\//;

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => f && !SKIP.test(f));
const found = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const [re, what] of PATTERNS) {
    const m = re.exec(text);
    if (m) found.push(`${f}: ${what} («${m[0].slice(0, 12)}…»)`);
  }
}
if (found.length) {
  console.error('Похоже на секреты в репозитории:\n' + found.map((x) => `  - ${x}`).join('\n'));
  process.exit(1);
}
console.log(`Секретов не найдено (${files.length} файлов).`);
