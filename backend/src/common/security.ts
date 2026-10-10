import crypto from 'crypto';
import fs from 'fs';
import { env } from '../config/env.js';

// Single source of truth for signing secrets (derived so file tokens and JWTs never share raw keys)
const FILE_TOKEN_SECRET = crypto.createHash('sha256').update(`file-token:${env.JWT_SECRET}`).digest('hex');

export interface CryptographicSeal {
  chainHash: string;
  prevHash: string;
  algorithm: 'SHA-256';
  sealedAt: string;
}

/** Deterministic JSON: object keys sorted recursively so the same data always hashes the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export class SecurityEngine {
  /**
   * Mask Citizen PII (Aadhaar, Phone, PAN, Passport) according to UIDAI / DPDP Act specifications
   */
  static maskPii(value: string | undefined | null): string {
    if (!value) return '';
    const clean = String(value).trim();

    // 1. Aadhaar (12 digits, optional spaces) -> XXXX-XXXX-1234
    if (/^\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(clean)) {
      const digits = clean.replace(/[\s-]/g, '');
      return `XXXX-XXXX-${digits.slice(-4)}`;
    }

    // 2. Indian Mobile (10 digits) -> +91 XXXXX-12345
    if (/^(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}$/.test(clean)) {
      const digits = clean.replace(/\D/g, '').slice(-10);
      return `+91 XXXXX-${digits.slice(-5)}`;
    }

    // 3. PAN (5 letters, 4 digits, 1 letter) -> ABC****4F
    if (/^[A-Z]{5}[0-9]{4}[A-Z]$/i.test(clean)) {
      return `${clean.slice(0, 3)}****${clean.slice(-2).toUpperCase()}`;
    }

    // 4. Passport (1 letter + 7 digits) -> Z****341
    if (/^[A-Z][0-9]{7}$/i.test(clean)) {
      return `${clean[0].toUpperCase()}****${clean.slice(-3)}`;
    }

    // 5. Generic tokenization for strings longer than 8 chars
    if (clean.length > 8) {
      return `${clean.slice(0, 2)}****${clean.slice(-3)}`;
    }

    return clean;
  }

  /** "Aarav Sharma" -> "A**** S*****" (for public, unauthenticated views). */
  static maskName(name: string | null | undefined): string {
    if (!name) return '';
    return name
      .split(/\s+/)
      .filter(Boolean)
      .map(part => `${part[0]}${'*'.repeat(Math.max(1, part.length - 1))}`)
      .join(' ');
  }

  /** "aarav.sharma@example.com" -> "aa****@example.com" */
  static maskEmail(email: string | null | undefined): string {
    if (!email) return '';
    const [user, domain] = email.split('@');
    if (!domain) return this.maskPii(email);
    return `${user.slice(0, 2)}****@${domain}`;
  }

  /**
   * Compute an immutable SHA-256 seal linking an event to its predecessor.
   * The hash covers the *entire* event payload (recursively key-sorted), not just top-level keys.
   */
  static createEventSeal(prevHash: string, eventData: Record<string, unknown>, sealedAt: Date = new Date()): CryptographicSeal {
    return {
      chainHash: this.computeChainHash(prevHash, eventData),
      prevHash,
      algorithm: 'SHA-256',
      sealedAt: sealedAt.toISOString(),
    };
  }

  static computeChainHash(prevHash: string, eventData: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(`${prevHash}:${stableStringify(eventData)}`).digest('hex');
  }

  /**
   * Generate a time-expiring, cryptographically signed token for document viewing (Self-Destructing URL)
   */
  static generateExpiringFileToken(fileUrl: string, expiresInSeconds = 300): string {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const payload = `${fileUrl}:${expiresAt}`;
    const signature = crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payload).digest('hex');
    return Buffer.from(JSON.stringify({ fileUrl, expiresAt, sig: signature })).toString('base64url');
  }

  /**
   * Verify an expiring file view token
   */
  static verifyExpiringFileToken(token: string): { valid: boolean; fileUrl?: string; error?: string } {
    try {
      const decodedStr = Buffer.from(token, 'base64url').toString('utf8');
      const { fileUrl, expiresAt, sig } = JSON.parse(decodedStr);

      if (!fileUrl || !expiresAt || !sig) {
        return { valid: false, error: 'Malformed token structure' };
      }

      if (Date.now() > Number(expiresAt)) {
        return { valid: false, error: 'Token has expired (Self-destructed for security)' };
      }

      const expectedSig = crypto
        .createHmac('sha256', FILE_TOKEN_SECRET)
        .update(`${fileUrl}:${expiresAt}`)
        .digest('hex');

      const a = Buffer.from(String(sig), 'hex');
      const b = Buffer.from(expectedSig, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return { valid: false, error: 'Cryptographic signature mismatch' };
      }

      return { valid: true, fileUrl };
    } catch {
      return { valid: false, error: 'Invalid token format' };
    }
  }

  /**
   * Secure Disk Shredder: Overwrite file bytes with random noise before unlinking
   */
  static secureShredFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size > 0) {
          fs.writeFileSync(filePath, crypto.randomBytes(stat.size));
        }
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn(`[SECURITY ENGINE] Secure shredding warning for ${filePath}:`, err);
    }
  }
}
