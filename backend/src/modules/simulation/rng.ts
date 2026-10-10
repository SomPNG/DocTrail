/**
 * Small seeded random number generator (mulberry32) + the distributions the simulator needs.
 * Seeded so that a scenario run is reproducible: same seed, same arrivals, same delays.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  getState(): number {
    return this.state;
  }

  static fromState(state: number): Rng {
    const r = new Rng(1);
    r.state = state >>> 0;
    return r;
  }

  /** Uniform [0, 1) */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller */
  normal(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * Log-normal parameterised by its median and 90th percentile, which is how process owners
   * describe durations ("usually 3 days, 1 in 10 takes over a week"). Gives a realistic long tail.
   */
  lognormal(median: number, p90: number): number {
    const m = Math.max(0.01, median);
    const sigma = Math.max(0.01, (Math.log(Math.max(p90, m * 1.01)) - Math.log(m)) / 1.2816);
    return Math.exp(Math.log(m) + sigma * this.normal());
  }

  exponential(mean: number): number {
    if (mean <= 0) return 0;
    let u = 0;
    while (u === 0) u = this.next();
    return -Math.log(u) * mean;
  }

  /** Poisson count (Knuth; fine for the small rates used per tick) */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
