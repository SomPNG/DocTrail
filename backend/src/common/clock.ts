import { prisma } from '../db/client.js';

/**
 * Virtual clock.
 *
 * Every piece of business logic (SLA maths, events, notifications, analytics, watchdog)
 * reads time from Clock.now() instead of `new Date()`. In normal operation the offset is 0
 * and the clock is real time. The simulation engine shifts the offset to "fast-forward"
 * days in seconds, so SLA breaches, reminders and bottlenecks happen for real, with
 * consistent timestamps on every record.
 */
export class Clock {
  private static offsetMs = 0;
  private static loaded = false;

  static now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  static nowMs(): number {
    return Date.now() + this.offsetMs;
  }

  static getOffsetMs(): number {
    return this.offsetMs;
  }

  /** Load the persisted offset (call once at startup). */
  static async load(): Promise<void> {
    try {
      const state = await prisma.simulationState.findUnique({ where: { id: 'singleton' } });
      this.offsetMs = state?.clockOffsetMs ?? 0;
    } catch {
      this.offsetMs = 0;
    }
    this.loaded = true;
  }

  static isLoaded(): boolean {
    return this.loaded;
  }

  static async setOffset(offsetMs: number): Promise<void> {
    this.offsetMs = offsetMs;
    await prisma.simulationState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', clockOffsetMs: offsetMs },
      update: { clockOffsetMs: offsetMs },
    });
  }

  static async advance(ms: number): Promise<Date> {
    await this.setOffset(this.offsetMs + ms);
    return this.now();
  }

  static async reset(): Promise<void> {
    await this.setOffset(0);
  }
}

export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;
