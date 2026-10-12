import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Шифрование секретов (токенов amo) для хранения в БД.
 * Формат: v1:<iv b64>:<tag b64>:<ciphertext b64>.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, 'hex');
    if (key.length !== 32) throw new Error('Ключ шифрования должен быть 32 байта');
    this.key = key;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(':');
    if (version !== VERSION || !iv || !tag || !data) throw new Error('Неизвестный формат шифротекста');
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}
