import { prisma } from '../../db/client.js';
import { NotFoundError, ForbiddenError, ConflictError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { ServiceConfig } from '../../config/serviceConfig.js';
import { NotificationService } from '../notifications/notification.service.js';
import { EventService } from '../events/event.service.js';
import { AuthUser } from '../../common/middleware.js';

interface StageInstanceLike {
  startedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  totalPausedSeconds: number;
  status: string;
  stage: { name: string; slaHours: number };
}

export interface CompensationEstimate {
  isEligible: boolean;
  breachDurationSeconds: number;
  breachDays: number;
  ratePerDay: number;
  estimatedCompensationAmount: number;
  stageBreakdown: Array<{ stageName: string; overrunHours: number }>;
}

/**
 * Statutory delay compensation.
 *
 * Semantics (consistent with the per-stage SLA the citizen is notified about): each stage that
 * overruns its own time target contributes its overrun. Being fast in one department does NOT
 * cancel a delay in another. Rate comes from the service's own configuration.
 * A breach never pays out automatically: it creates a claim pending supervisor approval.
 */
export class CompensationService {
  static estimate(instances: StageInstanceLike[], configJson: string, now: Date = Clock.now()): CompensationEstimate {
    const ratePerDay = ServiceConfig.compensationRatePerDay(configJson);
    let breachSeconds = 0;
    const stageBreakdown: CompensationEstimate['stageBreakdown'] = [];

    for (const inst of instances) {
      if (!inst.startedAt) continue;
      const allowed = Math.round(inst.stage.slaHours * 3600);
      const end = inst.status === 'COMPLETED' && inst.completedAt ? new Date(inst.completedAt) : now;
      let paused = inst.totalPausedSeconds;
      if (inst.status !== 'COMPLETED' && inst.pausedAt) {
        paused += Math.max(0, Math.floor((now.getTime() - new Date(inst.pausedAt).getTime()) / 1000));
      }
      const wall = Math.max(0, Math.floor((end.getTime() - new Date(inst.startedAt).getTime()) / 1000));
      const active = Math.max(0, wall - paused);
      const overrun = Math.max(0, active - allowed);
      if (overrun > 0) {
        breachSeconds += overrun;
        stageBreakdown.push({ stageName: inst.stage.name, overrunHours: Math.round((overrun / 3600) * 10) / 10 });
      }
    }

    const isEligible = breachSeconds > 0;
    const breachDays = isEligible ? Math.max(1, Math.ceil(breachSeconds / 86400)) : 0;
    return {
      isEligible,
      breachDurationSeconds: breachSeconds,
      breachDays,
      ratePerDay,
      estimatedCompensationAmount: breachDays * ratePerDay,
      stageBreakdown,
    };
  }

  private static async loadApp(applicationId: string) {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { service: true, stageInstances: { include: { stage: true } } },
    });
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    return app;
  }

  /** Read-only: what would the claim be right now? Returns the existing record if any. */
  static async getEligibility(applicationId: string) {
    const app = await this.loadApp(applicationId);
    const est = this.estimate(app.stageInstances, app.service.configJson);
    const record = await prisma.compensationRecord.findFirst({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
    });
    return { ...est, status: app.compensationStatus, record };
  }

  /**
   * Called on an SLA breach transition (and by the watchdog). Creates the claim once,
   * and keeps the amount current while it is still pending approval.
   */
  static async evaluateAndRecord(applicationId: string, now: Date = Clock.now()) {
    const app = await this.loadApp(applicationId);
    const est = this.estimate(app.stageInstances, app.service.configJson, now);
    if (!est.isEligible) return { ...est, record: null };

    let record = await prisma.compensationRecord.findFirst({ where: { applicationId }, orderBy: { createdAt: 'desc' } });
    const remarks = `Delay of ${est.breachDays} day(s) beyond stage targets: ${est.stageBreakdown
      .map(s => `${s.stageName} +${s.overrunHours}h`)
      .join(', ')}. Rate ₹${est.ratePerDay}/day.`;

    if (!record) {
      record = await prisma.compensationRecord.create({
        data: {
          applicationId,
          citizenId: app.citizenId,
          breachDurationSeconds: est.breachDurationSeconds,
          standardCompensationAmount: est.estimatedCompensationAmount,
          status: 'ELIGIBLE_PENDING_APPROVAL',
          remarks,
          createdAt: now,
        },
      });
      await prisma.application.update({
        where: { id: applicationId },
        data: { compensationStatus: 'ELIGIBLE_PENDING_APPROVAL' },
      });
      await EventService.recordEvent({
        applicationId,
        eventType: 'COMPENSATION_ELIGIBLE',
        actorRole: 'SYSTEM',
        metadata: { amount: est.estimatedCompensationAmount, breachDays: est.breachDays },
      });
      await NotificationService.notify('COMPENSATION_ELIGIBLE', {
        recipientUserId: app.citizenId,
        applicationId,
        vars: { trackingNumber: app.trackingNumber, amount: est.estimatedCompensationAmount },
      });
    } else if (record.status === 'ELIGIBLE_PENDING_APPROVAL') {
      record = await prisma.compensationRecord.update({
        where: { id: record.id },
        data: {
          breachDurationSeconds: est.breachDurationSeconds,
          standardCompensationAmount: est.estimatedCompensationAmount,
          remarks,
        },
      });
    }

    return { ...est, record };
  }

  /**
   * Back-compat name used by older callers: evaluates and records.
   */
  static async evaluateCompensationEligibility(applicationId: string) {
    const result = await this.evaluateAndRecord(applicationId);
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { compensationStatus: true } });
    return { ...result, status: app?.compensationStatus };
  }

  /**
   * Supervisor (or admin) reviews a pending claim.
   */
  static async reviewCompensation(params: {
    recordId: string;
    applicationId?: string;
    action: 'APPROVE' | 'REJECT';
    remarks?: string;
    reviewer: AuthUser;
  }) {
    const { recordId, action, remarks, reviewer } = params;

    if (reviewer.role !== 'SUPERVISOR' && reviewer.role !== 'ADMIN') {
      throw new ForbiddenError('Only supervisors can review compensation decisions');
    }

    const record = await prisma.compensationRecord.findUnique({
      where: { id: recordId },
      include: { application: true },
    });

    if (!record || (params.applicationId && record.applicationId !== params.applicationId)) {
      throw new NotFoundError(`Compensation record ${recordId} not found for this application`);
    }
    if (record.status !== 'ELIGIBLE_PENDING_APPROVAL') {
      throw new ConflictError(`Compensation claim already ${record.status.toLowerCase()}`);
    }

    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = await prisma.compensationRecord.update({
      where: { id: recordId },
      data: {
        status: newStatus,
        reviewedByUserId: reviewer.id,
        reviewedAt: Clock.now(),
        remarks: remarks ?? record.remarks,
      },
    });

    await prisma.application.update({
      where: { id: record.applicationId },
      data: { compensationStatus: newStatus },
    });

    await NotificationService.notify('COMPENSATION_DECIDED', {
      recipientUserId: record.citizenId,
      applicationId: record.applicationId,
      vars: { trackingNumber: record.application.trackingNumber, decision: newStatus },
    });

    return updated;
  }

  static async getApplicationCompensation(applicationId: string) {
    return prisma.compensationRecord.findFirst({
      where: { applicationId },
      include: { citizen: { select: { id: true, name: true, email: true } } },
    });
  }
}
