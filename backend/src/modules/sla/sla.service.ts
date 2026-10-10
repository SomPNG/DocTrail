import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { Clock } from '../../common/clock.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { CompensationService } from '../compensation/compensation.service.js';

export type SlaStatus = 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'COMPLETED';

export interface SlaCalculationResult {
  stageInstanceId: string;
  stageKey: string;
  stageName: string;
  stageStartedAt: Date | null;
  slaDeadline: Date | null;
  totalAllowedSeconds: number;
  elapsedActiveSeconds: number;
  pausedSeconds: number;
  remainingSeconds: number;
  overdueSeconds: number;
  status: SlaStatus;
  isPaused: boolean;
  isBreached: boolean;
  isAtRisk: boolean;
  /** true if this stage has EVER breached (latched), even if it is now paused */
  stageBreached?: boolean;
  calculatedAt?: Date;
}

export interface SlaInstanceShape {
  id: string;
  startedAt: Date | null;
  completedAt: Date | null;
  pausedAt: Date | null;
  totalPausedSeconds: number;
  slaDeadline: Date | null;
  status: string;
  breachedAt?: Date | null;
  stage: {
    stageKey: string;
    name: string;
    slaHours: number;
    slaDays: number;
  };
}

export class SlaService {
  /**
   * Pure SLA maths for one stage instance (see .agents/MEMORY.md section 2).
   */
  static calculateStageSla(instance: SlaInstanceShape, referenceTime: Date = Clock.now()): SlaCalculationResult {
    const totalAllowedSeconds = Math.round(instance.stage.slaHours * 3600);
    const stageStartedAt = instance.startedAt ? new Date(instance.startedAt) : null;
    const base = {
      stageInstanceId: instance.id,
      stageKey: instance.stage.stageKey,
      stageName: instance.stage.name,
      totalAllowedSeconds,
      stageBreached: !!instance.breachedAt,
      calculatedAt: referenceTime,
    };

    if (!stageStartedAt) {
      return {
        ...base,
        stageStartedAt: null,
        slaDeadline: null,
        elapsedActiveSeconds: 0,
        pausedSeconds: 0,
        remainingSeconds: totalAllowedSeconds,
        overdueSeconds: 0,
        status: 'ON_TRACK',
        isPaused: false,
        isBreached: false,
        isAtRisk: false,
      };
    }

    if (instance.status === 'COMPLETED') {
      const completedAt = instance.completedAt ? new Date(instance.completedAt) : referenceTime;
      const totalWallSeconds = Math.max(0, Math.floor((completedAt.getTime() - stageStartedAt.getTime()) / 1000));
      const elapsedActive = Math.max(0, totalWallSeconds - instance.totalPausedSeconds);
      return {
        ...base,
        stageStartedAt,
        slaDeadline: instance.slaDeadline,
        elapsedActiveSeconds: elapsedActive,
        pausedSeconds: instance.totalPausedSeconds,
        remainingSeconds: Math.max(0, totalAllowedSeconds - elapsedActive),
        overdueSeconds: Math.max(0, elapsedActive - totalAllowedSeconds),
        status: 'COMPLETED',
        isPaused: false,
        isBreached: elapsedActive > totalAllowedSeconds,
        isAtRisk: false,
      };
    }

    const isPaused = instance.pausedAt !== null && instance.pausedAt !== undefined;
    let currentPausedSeconds = instance.totalPausedSeconds;
    if (isPaused && instance.pausedAt) {
      currentPausedSeconds += Math.max(0, Math.floor((referenceTime.getTime() - new Date(instance.pausedAt).getTime()) / 1000));
    }

    const totalWallSeconds = Math.max(0, Math.floor((referenceTime.getTime() - stageStartedAt.getTime()) / 1000));
    const elapsedActiveSeconds = Math.max(0, totalWallSeconds - currentPausedSeconds);
    const remainingSeconds = Math.max(0, totalAllowedSeconds - elapsedActiveSeconds);
    const effectiveDeadline = new Date(stageStartedAt.getTime() + (totalAllowedSeconds + currentPausedSeconds) * 1000);
    const atRiskThresholdSeconds = Math.round(totalAllowedSeconds * (env.SLA_AT_RISK_THRESHOLD_PERCENT / 100));

    let status: SlaStatus = 'ON_TRACK';
    if (isPaused) status = 'PAUSED';
    else if (elapsedActiveSeconds > totalAllowedSeconds) status = 'BREACHED';
    else if (remainingSeconds <= atRiskThresholdSeconds) status = 'AT_RISK';

    return {
      ...base,
      stageStartedAt,
      slaDeadline: effectiveDeadline,
      elapsedActiveSeconds,
      pausedSeconds: currentPausedSeconds,
      remainingSeconds,
      overdueSeconds: Math.max(0, elapsedActiveSeconds - totalAllowedSeconds),
      status,
      isPaused,
      isBreached: status === 'BREACHED',
      isAtRisk: status === 'AT_RISK',
    };
  }

  /** Read-only live metrics for an application's active stage (no writes). */
  static async previewApplicationSla(applicationId: string, referenceTime: Date = Clock.now()) {
    const inst = await prisma.applicationStageInstance.findFirst({
      where: { applicationId, status: 'ACTIVE' },
      include: { stage: true },
    });
    return inst ? this.calculateStageSla(inst, referenceTime) : null;
  }

  /**
   * Recalculates SLA for an application and persists it. This is the ONLY place where SLA
   * transitions produce side effects, and they are latched per stage (atRiskAt / breachedAt),
   * so pausing and resuming can never emit a second breach or a duplicate notification.
   */
  static async refreshApplicationSla(applicationId: string, referenceTime: Date = Clock.now()) {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        service: { select: { name: true } },
        stageInstances: {
          where: { status: 'ACTIVE' },
          include: { stage: { include: { department: true } } },
        },
      },
    });

    if (!app) return null;

    if (app.status === 'COMPLETED' || app.status === 'REJECTED') {
      if (app.slaStatus !== 'COMPLETED') {
        await prisma.application.update({ where: { id: applicationId }, data: { slaStatus: 'COMPLETED' } });
      }
      return null;
    }

    const active = app.stageInstances[0];
    if (!active) return null;

    const metrics = this.calculateStageSla(active, referenceTime);
    const deptName = active.stage.department?.name || active.stage.departmentCode;
    const vars = {
      trackingNumber: app.trackingNumber,
      serviceName: app.service.name,
      stageName: active.stage.name,
      departmentName: deptName,
      deadline: metrics.slaDeadline,
      hoursLeft: Math.round(metrics.remainingSeconds / 3600),
    };

    const firstAtRisk = (metrics.status === 'AT_RISK' || metrics.status === 'BREACHED') && !active.atRiskAt;
    const firstBreach = metrics.status === 'BREACHED' && !active.breachedAt;

    if (firstAtRisk || firstBreach) {
      await prisma.$transaction(async tx => {
        await tx.applicationStageInstance.update({
          where: { id: active.id },
          data: {
            ...(firstAtRisk ? { atRiskAt: referenceTime } : {}),
            ...(firstBreach ? { breachedAt: referenceTime } : {}),
          },
        });
        if (firstAtRisk && metrics.status === 'AT_RISK') {
          await EventService.record(tx, {
            applicationId,
            stageId: active.stageId,
            eventType: 'SLA_WARNING',
            actorRole: 'SYSTEM',
            metadata: {
              reason: `Stage entered the final ${env.SLA_AT_RISK_THRESHOLD_PERCENT}% of its time target`,
              remainingSeconds: metrics.remainingSeconds,
              department: active.stage.departmentCode,
            },
          });
        }
        if (firstBreach) {
          await tx.application.update({
            where: { id: applicationId },
            data: { breachedStageCount: { increment: 1 } },
          });
          await EventService.record(tx, {
            applicationId,
            stageId: active.stageId,
            eventType: 'SLA_BREACHED',
            actorRole: 'SYSTEM',
            metadata: {
              stage: active.stage.name,
              department: active.stage.departmentCode,
              elapsedSeconds: metrics.elapsedActiveSeconds,
              allowedSeconds: metrics.totalAllowedSeconds,
            },
          });
          await EventService.record(tx, {
            applicationId,
            stageId: active.stageId,
            eventType: 'ESCALATED',
            actorRole: 'SYSTEM',
            metadata: { to: 'SUPERVISOR', reason: `Time target exceeded at ${active.stage.name}` },
          });
        }
      });

      if (firstAtRisk && metrics.status === 'AT_RISK') {
        await NotificationService.notify('RUNNING_LATE', { recipientUserId: app.citizenId, applicationId, vars });
        await NotificationService.notifyDepartment(active.stage.departmentCode, 'STAFF_AT_RISK', applicationId, vars);
      }
      if (firstBreach) {
        await NotificationService.notify('DELAYED', { recipientUserId: app.citizenId, applicationId, vars });
        await NotificationService.notifySupervisors('STAFF_BREACH_ESCALATION', applicationId, vars);
        try {
          await CompensationService.evaluateAndRecord(applicationId, referenceTime);
        } catch (err) {
          console.warn('Compensation evaluation failed:', err);
        }
      }
    }

    const slaData = {
      currentStageInstanceId: active.id,
      stageKey: active.stage.stageKey,
      totalAllowedSeconds: metrics.totalAllowedSeconds,
      elapsedActiveSeconds: metrics.elapsedActiveSeconds,
      pausedSeconds: metrics.pausedSeconds,
      remainingSeconds: metrics.remainingSeconds,
      isAtRisk: metrics.isAtRisk,
      isBreached: metrics.isBreached || !!active.breachedAt || firstBreach,
      isPaused: metrics.isPaused,
      deadline: metrics.slaDeadline,
      lastCalculatedAt: referenceTime,
    };
    await prisma.slaRecord.upsert({
      where: { applicationId },
      create: { applicationId, ...slaData },
      update: slaData,
    });

    if (app.slaStatus !== metrics.status) {
      await prisma.application.update({ where: { id: applicationId }, data: { slaStatus: metrics.status } });
    }

    return { ...metrics, stageBreached: !!active.breachedAt || firstBreach };
  }
}
