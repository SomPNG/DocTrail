import { prisma } from '../../db/client.js';
import { Clock, DAY_MS } from '../../common/clock.js';
import { percentile, round1 } from '../../common/utils.js';
import { SlaService } from '../sla/sla.service.js';

interface InstanceRow {
  id: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  totalPausedSeconds: number;
  breachedAt: Date | null;
  atRiskAt: Date | null;
  slaDeadline: Date | null;
  stage: { id: string; stageKey: string; name: string; slaHours: number; slaDays: number; departmentCode: string };
}

function activeHoursOf(inst: InstanceRow, now: Date): number {
  return SlaService.calculateStageSla(inst, now).elapsedActiveSeconds / 3600;
}

function everBreached(inst: InstanceRow, now: Date): boolean {
  if (inst.breachedAt) return true;
  return SlaService.calculateStageSla(inst, now).isBreached;
}

const instanceSelect = {
  id: true,
  status: true,
  startedAt: true,
  completedAt: true,
  pausedAt: true,
  totalPausedSeconds: true,
  breachedAt: true,
  atRiskAt: true,
  slaDeadline: true,
  stage: { select: { id: true, stageKey: true, name: true, slaHours: true, slaDays: true, departmentCode: true } },
};

export class AnalyticsService {
  private static async loadInstances(where: any = {}): Promise<InstanceRow[]> {
    return prisma.applicationStageInstance.findMany({
      where: { startedAt: { not: null }, ...where },
      select: instanceSelect,
    }) as unknown as InstanceRow[];
  }

  /** Overall dashboard metrics for supervisors. */
  static async getOverviewMetrics() {
    const [total, active, onHold, completed, rejected, breachedNow, atRisk, everBreachedApps, stuck] = await Promise.all([
      prisma.application.count(),
      prisma.application.count({ where: { status: 'IN_PROGRESS' } }),
      prisma.application.count({ where: { status: 'ON_HOLD' } }),
      prisma.application.count({ where: { status: 'COMPLETED' } }),
      prisma.application.count({ where: { status: 'REJECTED' } }),
      prisma.application.count({ where: { slaStatus: 'BREACHED' } }),
      prisma.application.count({ where: { slaStatus: 'AT_RISK' } }),
      prisma.application.count({ where: { breachedStageCount: { gt: 0 } } }),
      prisma.application.count({
        where: {
          status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
          stuckReasonCode: { notIn: ['ON_TRACK', 'IN_REVIEW'] },
          NOT: { stuckReasonCode: null },
        },
      }),
    ]);

    const closed = await prisma.application.findMany({
      where: { status: 'COMPLETED', completedAt: { not: null } },
      select: { createdAt: true, completedAt: true },
    });
    const turnaroundDays = closed.map(a => (a.completedAt!.getTime() - a.createdAt.getTime()) / DAY_MS);

    return {
      totalApplications: total,
      activeApplications: active,
      onHoldApplications: onHold,
      completedApplications: completed,
      rejectedApplications: rejected,
      breachedApplications: breachedNow,
      atRiskApplications: atRisk,
      applicationsEverBreached: everBreachedApps,
      stuckApplications: stuck,
      slaBreachRatePercent: total > 0 ? round1((everBreachedApps / total) * 100) : 0,
      averageTurnaroundDays: turnaroundDays.length ? round1(turnaroundDays.reduce((a, b) => a + b, 0) / turnaroundDays.length) : 0,
      medianTurnaroundDays: round1(percentile(turnaroundDays, 50)),
      serverNow: Clock.now(),
    };
  }

  /**
   * Department performance: time spent (mean / median / p90 active hours, excluding citizen
   * waiting time), SLA compliance including historical breaches, throughput, arrivals, backlog.
   */
  static async getDepartmentMetrics() {
    const now = Clock.now();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [departments, instances] = await Promise.all([
      prisma.department.findMany({ include: { users: { where: { role: 'OFFICER' }, select: { id: true } } } }),
      this.loadInstances(),
    ]);

    return departments.map(dept => {
      const insts = instances.filter(i => i.stage.departmentCode === dept.code);
      const active = insts.filter(i => i.status === 'ACTIVE');
      const done = insts.filter(i => i.status === 'COMPLETED');
      const doneHours = done.map(i => activeHoursOf(i, now));
      const pausedHours = done.map(i => i.totalPausedSeconds / 3600);
      const breachedEver = insts.filter(i => everBreached(i, now)).length;
      const evaluated = done.length + active.filter(i => everBreached(i, now)).length;
      const completedLast7 = done.filter(i => i.completedAt && i.completedAt >= weekAgo).length;
      const arrivalsLast7 = insts.filter(i => i.startedAt && i.startedAt >= weekAgo).length;
      const officerCount = dept.users.length;

      return {
        departmentId: dept.id,
        code: dept.code,
        name: dept.name,
        officerCount,
        activeWorkload: active.length,
        waitingNotPaused: active.filter(i => !i.pausedAt).length,
        pausedOnCitizenOrHold: active.filter(i => i.pausedAt).length,
        completedCount: done.length,
        averageProcessingHours: doneHours.length ? round1(doneHours.reduce((a, b) => a + b, 0) / doneHours.length) : 0,
        medianProcessingHours: round1(percentile(doneHours, 50)),
        p90ProcessingHours: round1(percentile(doneHours, 90)),
        averagePausedHours: pausedHours.length ? round1(pausedHours.reduce((a, b) => a + b, 0) / pausedHours.length) : 0,
        averageAgeOfActiveHours: active.length ? round1(active.reduce((s, i) => s + activeHoursOf(i, now), 0) / active.length) : 0,
        breachCount: breachedEver,
        currentlyBreached: active.filter(i => SlaService.calculateStageSla(i, now).isBreached).length,
        breachRatePercent: insts.length ? round1((breachedEver / insts.length) * 100) : 0,
        slaCompliancePercent: evaluated ? round1(((evaluated - breachedEver) / evaluated) * 100) : 100,
        throughputPerDay: round1(completedLast7 / 7),
        arrivalsPerDay: round1(arrivalsLast7 / 7),
        averageWorkloadPerOfficer: officerCount > 0 ? round1(active.length / officerCount) : active.length,
      };
    });
  }

  /**
   * Bottleneck detection per workflow stage. Score (0-100) combines four normalised signals and
   * reports which one dominates, so the dashboard can say WHY a stage is a bottleneck:
   *   age      - average active age of waiting files relative to the stage target (35%)
   *   breaches - share of files that ever breached this stage's target (30%)
   *   inflow   - arrivals exceeding completions over the last 7 days, i.e. queue growing (20%)
   *   backlog  - number of files waiting (15%, saturates at 10)
   */
  static async detectBottlenecks() {
    const now = Clock.now();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const [stages, instances] = await Promise.all([
      prisma.workflowStage.findMany({ where: { isActive: true }, include: { department: true, service: { select: { name: true, key: true } } } }),
      this.loadInstances(),
    ]);

    const result = stages.map(stg => {
      const insts = instances.filter(i => i.stage.id === stg.id);
      const active = insts.filter(i => i.status === 'ACTIVE');
      const waiting = active.filter(i => !i.pausedAt);
      const done = insts.filter(i => i.status === 'COMPLETED');
      const metrics = active.map(i => SlaService.calculateStageSla(i, now));
      const breachedNow = metrics.filter(m => m.status === 'BREACHED').length;
      const atRiskNow = metrics.filter(m => m.status === 'AT_RISK').length;
      const breachedEver = insts.filter(i => everBreached(i, now)).length;
      const breachRate = insts.length ? breachedEver / insts.length : 0;

      const ageRatio = waiting.length
        ? waiting.reduce((s, i) => s + activeHoursOf(i, now) / Math.max(1, stg.slaHours), 0) / waiting.length
        : 0;
      const arrivals7 = insts.filter(i => i.startedAt && i.startedAt >= weekAgo).length;
      const completions7 = done.filter(i => i.completedAt && i.completedAt >= weekAgo).length;
      const inflowExcess = arrivals7 > 0 ? Math.max(0, (arrivals7 - completions7) / arrivals7) : 0;

      const components = {
        age: 35 * Math.min(1, ageRatio),
        breaches: 30 * Math.min(1, breachRate),
        inflow: 20 * Math.min(1, inflowExcess),
        backlog: 15 * Math.min(1, waiting.length / 10),
      };
      const bottleneckScore = Math.round(components.age + components.breaches + components.inflow + components.backlog);
      const dominant = (Object.entries(components).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'age') as keyof typeof components;

      const explain: Record<keyof typeof components, string> = {
        age: `Files wait on average ${round1(ageRatio * 100)}% of the ${stg.slaHours}h target`,
        breaches: `${round1(breachRate * 100)}% of files have breached this stage's target`,
        inflow: `${arrivals7} files arrived but only ${completions7} were completed in the last 7 days`,
        backlog: `${waiting.length} files are waiting`,
      };

      const doneHours = done.map(i => activeHoursOf(i, now));
      const activeHoursAvg = active.length ? active.reduce((s, i) => s + activeHoursOf(i, now), 0) / active.length : 0;

      return {
        stageId: stg.id,
        stageKey: stg.stageKey,
        stageName: stg.name,
        serviceKey: stg.service.key,
        serviceName: stg.service.name,
        departmentCode: stg.departmentCode,
        departmentName: stg.department?.name ?? stg.departmentCode,
        configuredSlaHours: stg.slaHours,
        activeBacklog: active.length,
        waitingNotPaused: waiting.length,
        breachedCount: breachedNow,
        breachedEverCount: breachedEver,
        atRiskCount: atRiskNow,
        breachRatePercent: round1(breachRate * 100),
        averageActiveHours: round1(activeHoursAvg),
        averageCompletedHours: doneHours.length ? round1(doneHours.reduce((a, b) => a + b, 0) / doneHours.length) : 0,
        p90CompletedHours: round1(percentile(doneHours, 90)),
        arrivalsLast7Days: arrivals7,
        completionsLast7Days: completions7,
        scoreComponents: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round1(v)])),
        bottleneckScore,
        isBottleneck: bottleneckScore >= 40,
        dominantFactor: dominant,
        explanation: bottleneckScore >= 40 ? explain[dominant] : 'Operating within normal limits',
      };
    });

    return result.sort((a, b) => b.bottleneckScore - a.bottleneckScore);
  }

  /**
   * Daily series for the last N days: backlog at end of day, arrivals, completions, new breaches.
   */
  static async getTrends(days = 14, departmentCode?: string) {
    const now = Clock.now();
    const span = Math.min(90, Math.max(1, days));
    const from = new Date(now.getTime() - span * DAY_MS);
    const instances = (await this.loadInstances({
      OR: [{ completedAt: null }, { completedAt: { gte: from } }],
      ...(departmentCode ? { stage: { departmentCode } } : {}),
    })) as InstanceRow[];

    const series: Array<{ date: string; backlog: number; arrivals: number; completions: number; newBreaches: number }> = [];
    for (let k = span - 1; k >= 0; k--) {
      const end = new Date(now.getTime() - k * DAY_MS);
      const start = new Date(end.getTime() - DAY_MS);
      const inWindow = (d: Date | null) => !!d && d > start && d <= end;
      series.push({
        date: end.toISOString().slice(0, 10),
        backlog: instances.filter(i => i.startedAt! <= end && (!i.completedAt || i.completedAt > end)).length,
        arrivals: instances.filter(i => inWindow(i.startedAt)).length,
        completions: instances.filter(i => inWindow(i.completedAt)).length,
        newBreaches: instances.filter(i => inWindow(i.breachedAt)).length,
      });
    }
    return { departmentCode: departmentCode ?? 'ALL', days: span, series };
  }

  /** Deterministic risk score for an application (uses the same SLA maths as the clock). */
  static async calculateApplicationRisk(applicationId: string, persist = true) {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        stageInstances: { where: { status: 'ACTIVE' }, include: { stage: true, documentRequests: true } },
        documentRequests: { select: { id: true } },
      },
    });
    if (!app) return null;
    if (app.status === 'COMPLETED' || app.status === 'REJECTED') {
      return { riskScore: 0, riskLevel: 'LOW', factors: [`Application ${app.status.toLowerCase()}`] };
    }

    let score = 0;
    const factors: string[] = [];
    const inst = app.stageInstances[0];
    if (inst) {
      const sla = SlaService.calculateStageSla(inst);
      const ratio = sla.totalAllowedSeconds > 0 ? sla.elapsedActiveSeconds / sla.totalAllowedSeconds : 0;
      if (ratio >= 1) {
        score += 45;
        factors.push('Stage time target has been exceeded');
      } else if (ratio >= 0.8) {
        score += 30;
        factors.push('Over 80% of the stage time target used');
      } else if (ratio >= 0.5) {
        score += 15;
        factors.push('Over 50% of the stage time target used');
      }
      if (sla.pausedSeconds > 86400) {
        score += 15;
        factors.push('Has spent more than 24h on hold');
      }
      const pending = inst.documentRequests.filter(r => r.status === 'PENDING').length;
      if (pending > 0) {
        score += 20;
        factors.push(`Blocked by ${pending} pending document request(s)`);
      }
      if (app.documentRequests.length > 2) {
        score += 15;
        factors.push('Multiple document requests during the application lifecycle');
      }
      if (app.breachedStageCount > 0) {
        score += 10;
        factors.push(`${app.breachedStageCount} earlier stage(s) breached`);
      }
    }

    const riskScore = Math.min(100, Math.max(0, score));
    const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
      riskScore >= 80 ? 'CRITICAL' : riskScore >= 60 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';

    if (persist && (app.riskScore !== riskScore || app.riskLevel !== riskLevel)) {
      await prisma.application.update({ where: { id: applicationId }, data: { riskScore, riskLevel } });
    }
    return { riskScore, riskLevel, factors };
  }
}
