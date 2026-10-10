import crypto from 'crypto';
import { Response } from 'express';
import type { Db } from '../db/client.js';
import { Clock } from './clock.js';

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: unknown;
}

export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode = 200): Response {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

/** Derives a 2-letter tracking prefix from a service key (gun_license -> GL, passport_reissue -> PR). */
export function trackingPrefixForService(serviceKey: string, explicit?: string): string {
  if (explicit) return explicit.toUpperCase();
  const parts = serviceKey.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (serviceKey.slice(0, 2) || 'DT').toUpperCase();
}

/**
 * Collision-free tracking number: <PREFIX>-<YEAR>-<6-digit sequence>, e.g. GL-2026-000042.
 * Uses an atomic counter row per prefix+year (SQLite serialises the upsert).
 */
export async function generateTrackingNumber(db: Db, prefix = 'DT'): Promise<string> {
  const year = Clock.now().getFullYear();
  const key = `${prefix}-${year}`;
  const counter = await db.counter.upsert({
    where: { key },
    create: { key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${key}-${String(counter.value).padStart(6, '0')}`;
}

/** Unguessable token printed as a QR code on the physical file. */
export function generateQrCodeToken(): string {
  return `DT-QR-${crypto.randomBytes(12).toString('base64url')}`;
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function hoursBetween(from: Date | string, to: Date | string): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / (3600 * 1000);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
