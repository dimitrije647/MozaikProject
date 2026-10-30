import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for stored secrets (BYOK API keys).
 * The key is derived from APP_ENCRYPTION_KEY, a server-side master secret.
 * Payload format: base64(iv).base64(authTag).base64(ciphertext)
 */
@Injectable()
export class CryptoService {
  private get key(): Buffer {
    const secret = process.env.APP_ENCRYPTION_KEY;
    if (!secret || secret.length < 16) {
      throw new Error('APP_ENCRYPTION_KEY is missing or too short (min 16 chars)');
    }
    return createHash('sha256').update(secret).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
  }

  /** Server-side only. Future agents will call this to obtain a user's raw key. */
  decrypt(payload: string): string {
    const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  mask(secret: string): string {
    const s = secret.trim();
    if (s.length <= 8) return '••••••••';
    return `${s.slice(0, 3)}••••••••${s.slice(-4)}`;
  }
}
