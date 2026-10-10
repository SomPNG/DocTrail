import { prisma, type Db } from '../../db/client.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { AccessPolicy } from '../../common/access.js';
import { ChecklistGate, type ChecklistResponses } from '../../common/checklist.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { SlaService } from '../sla/sla.service.js';
import { AuthUser } from '../../common/middleware.js';
import { BASE_DEPARTMENTS, ServiceWorkflowConfig } from '../../config/workflowConfig.js';

export type HoldType = 'CITIZEN_DOCS' | 'ADMIN_HOLD' | 'CORRECTION' | 'EXTERNAL';

/** Fields that close an open pause and bank its duration. */
export function closePauseData(inst: { pausedAt: Date | null; totalPausedSeconds: number }, now: Date) {
  if (!inst.pausedAt) return { pausedSeconds: 0, data: {} as Record<string, unknown> };
  const pausedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(inst.pausedAt).getTime()) / 1000));
  return {
    pausedSeconds,
    data: {
      pausedAt: null,
      holdType: null,
      holdReason: null,
      totalPausedSeconds: inst.totalPausedSeconds + pausedSeconds,
    } as Record<string, unknown>,
  };
}

function deptName(stage: { departmentCode: string; department?: { name: string } | null }) {
  return stage.department?.name || stage.departmentCode;
}

async function loadForAction(applicationId: string) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      service: { include: { stages: { orderBy: { orderIndex: 'asc' }, include: { department: true } } } },
      stageInstances: {
        where: { status: 'ACTIVE' },
        include: {
          stage: { include: { department: true } },
          documentRequests: { where: { status: 'PENDING' } },
        },
      },
    },
  });
  if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
  if (app.status === 'COMPLETED' || app.status === 'REJECTED') {
    throw new ConflictError(`Application is already finalized with status: ${app.status}`);
  }
  const current = app.stageInstances[0];
  if (!current) throw new ConflictError('No active stage found for application');
  return { app, current };
}

export class WorkflowService {
  /**
   * Syncs/registers a service configuration in the database. Stages removed from the config are
   * archived (isActive=false) instead of silently remaining part of the live workflow.
   */
  static async syncServiceConfig(config: ServiceWorkflowConfig) {
    const service = await prisma.service.upsert({
      where: { key: config.serviceKey },
      create: {
        key: config.serviceKey,
        name: config.serviceName,
        description: config.description,
        configJson: JSON.stringify(config),
      },
      update: {
        name: config.serviceName,
        description: config.description,
        configJson: JSON.stringify(config),
      },
    });

    for (let i = 0; i < config.stages.length; i++) {
      const stageConfig = config.stages[i];
      const slaHours = stageConfig.slaHours ?? stageConfig.slaDays * 24;

      let dept = await prisma.department.findUnique({ where: { code: stageConfig.departmentCode } });
      if (!dept) {
        const known = BASE_DEPARTMENTS.find(d => d.code === stageConfig.departmentCode);
        dept = await prisma.department.create({
          data: known ?? { code: stageConfig.departmentCode, name: stageConfig.departmentCode.replace(/_/g, ' ') },
        });
      }

      const isFinal = stageConfig.isFinalStage ?? i === config.stages.length - 1;
      const data = {
        name: stageConfig.name,
        orderIndex: i + 1,
        departmentId: dept.id,
        departmentCode: stageConfig.departmentCode,
        slaDays: stageConfig.slaDays,
        slaHours,
        isFinalStage: isFinal,
        isActive: true,
        checklistJson: stageConfig.checklists ? JSON.stringify(stageConfig.checklists) : null,
      };

      await prisma.workflowStage.upsert({
        where: { serviceId_stageKey: { serviceId: service.id, stageKey: stageConfig.key } },
        create: { serviceId: service.id, stageKey: stageConfig.key, ...data },
        update: data,
      });
    }

    await prisma.workflowStage.updateMany({
      where: { serviceId: service.id, stageKey: { notIn: config.stages.map(s => s.key) } },
      data: { isActive: false },
    });

    return service;
  }

  /**
   * Moves an application from its current stage to the next one (or completes it at the final stage).
   * Rules: authorised department officer (or supervisor), no pending document requests, not on hold,
   * every mandatory checklist item verified, no skipping.
   */
  static async advanceStage(params: {
    applicationId: string;
    actor: AuthUser;
    remarks?: string;
    checklistResponses?: ChecklistResponses;
    /** set when called from recordDecision(APPROVED) at the final stage */
    decisionReason?: string;
  }) {
    const { applicationId, actor, remarks, checklistResponses } = params;
    const { app, current } = await loadForAction(applicationId);

    AccessPolicy.assertCanActOnStage(actor, current.stage.departmentCode);

    if (current.documentRequests.length > 0) {
      throw new ConflictError(
        `Cannot advance stage while there are ${current.documentRequests.length} pending document requests.`
      );
    }
    if (current.pausedAt) {
      throw new ConflictError(
        `Application is on hold (${current.holdType || 'PAUSED'}${current.holdReason ? `: ${current.holdReason}` : ''}). Resume it before forwarding.`
      );
    }

    const allStages = app.service.stages.filter(s => s.isActive || s.id === current.stageId);
    const idx = allStages.findIndex(s => s.id === current.stageId);
    if (idx === -1) throw new AppError('Invalid current stage configuration', 500);
    const isLastStage = idx === allStages.length - 1 || current.stage.isFinalStage;

    ChecklistGate.assertComplete(
      current.stage.checklistJson,
      checklistResponses,
      isLastStage ? 'approve application' : 'advance stage'
    );

    const now = Clock.now();
    const activeSeconds = current.startedAt
      ? Math.max(0, Math.floor((now.getTime() - new Date(current.startedAt).getTime()) / 1000) - current.totalPausedSeconds)
      : 0;

    const result = await prisma.$transaction(async tx => {
      await tx.applicationStageInstance.update({
        where: { id: current.id },
        data: {
          status: 'COMPLETED',
          completedAt: now,
          lastActivityAt: now,
          remarks: remarks ?? current.remarks,
          assignedOfficerId: current.assignedOfficerId ?? (actor.role === 'OFFICER' ? actor.id : null),
        },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'STAGE_COMPLETED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: {
          stageName: current.stage.name,
          department: current.stage.departmentCode,
          remarks,
          activeSeconds,
          withinTarget: activeSeconds <= current.stage.slaHours * 3600,
        },
      });

      if (isLastStage) {
        const updatedApp = await tx.application.update({
          where: { id: app.id },
          data: {
            status: 'COMPLETED',
            slaStatus: 'COMPLETED',
            completedAt: now,
            lastActivityAt: now,
            stuckReasonCode: null,
          },
        });

        const decision = await tx.applicationDecision.create({
          data: {
            applicationId: app.id,
            stageInstanceId: current.id,
            decisionType: 'APPROVED',
            reason: params.decisionReason ?? remarks ?? 'Final approval granted',
            decidedByUserId: actor.id,
            decidedAt: now,
          },
        });

        await EventService.record(tx, {
          applicationId: app.id,
          stageId: current.stageId,
          eventType: 'APPLICATION_APPROVED',
          actorId: actor.id,
          actorRole: actor.role,
          metadata: { remarks: params.decisionReason ?? remarks ?? 'Final approval granted' },
        });

        return { updatedApp, completedStage: current.stage, nextStage: null, nextInstance: null, decision };
      }

      const nextStage = allStages[idx + 1];
      const nextDeadline = new Date(now.getTime() + nextStage.slaHours * 3600 * 1000);
      const freshStage = {
        status: 'ACTIVE',
        startedAt: now,
        slaDeadline: nextDeadline,
        completedAt: null,
        pausedAt: null,
        holdType: null,
        holdReason: null,
        totalPausedSeconds: 0,
        atRiskAt: null,
        breachedAt: null,
        assignedOfficerId: null,
        assignedAt: null,
        lastActivityAt: now,
      };

      const nextInstance = await tx.applicationStageInstance.upsert({
        where: { applicationId_stageId: { applicationId: app.id, stageId: nextStage.id } },
        create: { applicationId: app.id, stageId: nextStage.id, ...freshStage },
        update: freshStage,
      });

      const updatedApp = await tx.application.update({
        where: { id: app.id },
        data: {
          currentStageId: nextStage.id,
          status: 'IN_PROGRESS',
          slaStatus: 'ON_TRACK',
          lastActivityAt: now,
          stuckReasonCode: null,
        },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: nextStage.id,
        eventType: 'APPLICATION_FORWARDED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: {
          fromStage: current.stage.name,
          toStage: nextStage.name,
          fromDepartment: current.stage.departmentCode,
          toDepartment: nextStage.departmentCode,
          remarks,
        },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: nextStage.id,
        eventType: 'STAGE_ENTERED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: { stageName: nextStage.name, department: nextStage.departmentCode, deadline: nextDeadline },
      });

      return { updatedApp, completedStage: current.stage, nextStage, nextInstance, decision: null };
    });

    if (result.nextStage) {
      const vars = {
        trackingNumber: app.trackingNumber,
        serviceName: app.service.name,
        stageName: current.stage.name,
        nextStageName: result.nextStage.name,
        departmentName: deptName(result.nextStage),
        deadline: result.nextInstance?.slaDeadline,
      };
      await NotificationService.notify('STAGE_MOVED', { recipientUserId: app.citizenId, applicationId: app.id, vars });
      await NotificationService.notifyDepartment(result.nextStage.departmentCode, 'STAFF_NEW_IN_QUEUE', app.id, {
        ...vars,
        stageName: result.nextStage.name,
      });
      await SlaService.refreshApplicationSla(app.id);
    } else {
      await NotificationService.notify('APPROVED', {
        recipientUserId: app.citizenId,
        applicationId: app.id,
        vars: { trackingNumber: app.trackingNumber, serviceName: app.service.name },
      });
    }

    return result;
  }

  /** Officer/supervisor claims the active stage (or a supervisor assigns it to an officer). */
  static async assignStage(params: { applicationId: string; actor: AuthUser; officerId?: string }) {
    const { app, current } = await loadForAction(params.applicationId);
    AccessPolicy.assertCanActOnStage(params.actor, current.stage.departmentCode);

    let officerId = params.actor.id;
    if (params.officerId && params.officerId !== params.actor.id) {
      if (params.actor.role !== 'SUPERVISOR') throw new ForbiddenError('Only supervisors can assign files to other officers');
      const officer = await prisma.user.findUnique({ where: { id: params.officerId }, include: { department: true } });
      if (!officer || officer.role !== 'OFFICER' || officer.department?.code !== current.stage.departmentCode) {
        throw new AppError(`Officer must belong to ${current.stage.departmentCode}`, 400);
      }
      officerId = officer.id;
    }

    const now = Clock.now();
    await prisma.$transaction(async tx => {
      await tx.applicationStageInstance.update({
        where: { id: current.id },
        data: { assignedOfficerId: officerId, assignedAt: now, lastActivityAt: now },
      });
      await tx.application.update({ where: { id: app.id }, data: { lastActivityAt: now } });
      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'STAGE_ASSIGNED',
        actorId: params.actor.id,
        actorRole: params.actor.role,
        metadata: { assignedOfficerId: officerId, stageName: current.stage.name },
      });
    });

    return { success: true, assignedOfficerId: officerId, stageName: current.stage.name };
  }

  /** Pause the clock for one of the hold types (shared by hold, document request and correction). */
  static async pauseInTx(
    tx: Db,
    p: { app: { id: string }; current: { id: string; stageId: string; pausedAt: Date | null }; actor: { id: string | null; role: string }; holdType: HoldType; reason: string; now: Date }
  ) {
    const wasPaused = !!p.current.pausedAt;
    await tx.applicationStageInstance.update({
      where: { id: p.current.id },
      data: {
        ...(wasPaused ? {} : { pausedAt: p.now }),
        holdType: p.holdType,
        holdReason: p.reason,
        lastActivityAt: p.now,
      },
    });
    await tx.application.update({
      where: { id: p.app.id },
      data: { status: 'ON_HOLD', slaStatus: 'PAUSED', lastActivityAt: p.now },
    });
    if (!wasPaused) {
      await EventService.record(tx, {
        applicationId: p.app.id,
        stageId: p.current.stageId,
        eventType: 'SLA_PAUSED',
        actorId: p.actor.id,
        actorRole: p.actor.role,
        metadata: { holdType: p.holdType, reason: p.reason },
      });
    }
    return !wasPaused;
  }

  static async holdApplication(params: { applicationId: string; actor: AuthUser; reason: string; holdType?: 'ADMIN_HOLD' | 'EXTERNAL' }) {
    const { applicationId, actor, reason } = params;
    const { app, current } = await loadForAction(applicationId);
    AccessPolicy.assertCanActOnStage(actor, current.stage.departmentCode);

    if (current.pausedAt) throw new ConflictError('Application stage is already on hold / paused');

    const now = Clock.now();
    const holdType = params.holdType ?? 'ADMIN_HOLD';
    await prisma.$transaction(async tx => {
      await this.pauseInTx(tx, { app, current, actor, holdType, reason, now });
      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'APPLICATION_HELD',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: { holdType, reason },
      });
    });

    await NotificationService.notify('ON_HOLD', {
      recipientUserId: app.citizenId,
      applicationId: app.id,
      vars: { trackingNumber: app.trackingNumber, departmentName: deptName(current.stage), reason },
    });
    await SlaService.refreshApplicationSla(app.id);

    return { success: true, message: 'Application paused successfully', holdType };
  }

  static async resumeApplication(params: { applicationId: string; actor: AuthUser; reason?: string }) {
    const { applicationId, actor, reason } = params;
    const { app, current } = await loadForAction(applicationId);
    AccessPolicy.assertCanActOnStage(actor, current.stage.departmentCode);

    if (!current.pausedAt) throw new ConflictError('Application stage is not paused');
    if (current.documentRequests.length > 0) {
      throw new ConflictError(
        `Waiting for ${current.documentRequests.length} document(s) from the applicant. The clock resumes automatically when they are uploaded.`
      );
    }

    const now = Clock.now();
    const { pausedSeconds, data } = closePauseData(current, now);

    await prisma.$transaction(async tx => {
      await tx.applicationStageInstance.update({ where: { id: current.id }, data: { ...data, lastActivityAt: now } });
      await tx.application.update({ where: { id: app.id }, data: { status: 'IN_PROGRESS', lastActivityAt: now } });
      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'SLA_RESUMED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: {
          reason: reason ?? 'Processing resumed',
          resumedHoldType: current.holdType,
          pausedPeriodSeconds: pausedSeconds,
          totalPausedSeconds: (data as any).totalPausedSeconds,
        },
      });
    });

    await NotificationService.notify('RESUMED', {
      recipientUserId: app.citizenId,
      applicationId: app.id,
      vars: { trackingNumber: app.trackingNumber, departmentName: deptName(current.stage) },
    });
    await SlaService.refreshApplicationSla(app.id);

    return { success: true, message: 'Application resumed successfully' };
  }

  /**
   * Official decision.
   *  APPROVED                - only valid at the FINAL stage (intermediate stages are forwarded, never "approved").
   *  REJECTED                - closes the application at any stage.
   *  RETURNED_FOR_CORRECTION - pauses the clock until the citizen resubmits.
   */
  static async recordDecision(params: {
    applicationId: string;
    decisionType: 'APPROVED' | 'REJECTED' | 'RETURNED_FOR_CORRECTION';
    reason: string;
    actor: AuthUser;
    checklistResponses?: ChecklistResponses;
  }) {
    const { applicationId, decisionType, reason, actor, checklistResponses } = params;
    const { app, current } = await loadForAction(applicationId);
    AccessPolicy.assertCanActOnStage(actor, current.stage.departmentCode);

    if (decisionType === 'APPROVED') {
      const active = app.service.stages.filter(s => s.isActive || s.id === current.stageId);
      const isFinal = current.stage.isFinalStage || active[active.length - 1]?.id === current.stageId;
      if (!isFinal) {
        // Validate the checklist first so officers get the most specific error
        ChecklistGate.assertComplete(current.stage.checklistJson, checklistResponses, 'approve application');
        throw new ConflictError(
          `"${current.stage.name}" is not the final stage. Use forward to send it to the next department; final approval happens at "${active[active.length - 1]?.name}".`
        );
      }
      const result = await this.advanceStage({ applicationId, actor, remarks: reason, checklistResponses, decisionReason: reason });
      return result.decision!;
    }

    const now = Clock.now();
    const decision = await prisma.$transaction(async tx => {
      const dec = await tx.applicationDecision.create({
        data: {
          applicationId: app.id,
          stageInstanceId: current.id,
          decisionType,
          reason,
          decidedByUserId: actor.id,
          decidedAt: now,
        },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'DECISION_RECORDED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: { decisionType, reason, stageName: current.stage.name },
      });

      if (decisionType === 'REJECTED') {
        const { data } = closePauseData(current, now);
        await tx.applicationStageInstance.update({
          where: { id: current.id },
          data: { ...data, status: 'COMPLETED', completedAt: now, remarks: reason, lastActivityAt: now },
        });
        await tx.documentRequest.updateMany({
          where: { applicationId: app.id, status: 'PENDING' },
          data: { status: 'CANCELLED', resolvedAt: now },
        });
        await tx.application.update({
          where: { id: app.id },
          data: { status: 'REJECTED', slaStatus: 'COMPLETED', completedAt: now, lastActivityAt: now, stuckReasonCode: null },
        });
        await EventService.record(tx, {
          applicationId: app.id,
          stageId: current.stageId,
          eventType: 'APPLICATION_REJECTED',
          actorId: actor.id,
          actorRole: actor.role,
          metadata: { reason },
        });
      } else {
        await this.pauseInTx(tx, { app, current, actor, holdType: 'CORRECTION', reason, now });
        await EventService.record(tx, {
          applicationId: app.id,
          stageId: current.stageId,
          eventType: 'APPLICATION_RETURNED',
          actorId: actor.id,
          actorRole: actor.role,
          metadata: { reason: `Returned for correction: ${reason}` },
        });
      }
      return dec;
    });

    await NotificationService.notify(decisionType === 'REJECTED' ? 'REJECTED' : 'RETURNED_FOR_CORRECTION', {
      recipientUserId: app.citizenId,
      applicationId: app.id,
      vars: { trackingNumber: app.trackingNumber, serviceName: app.service.name, departmentName: deptName(current.stage), reason },
    });
    await SlaService.refreshApplicationSla(app.id);

    return decision;
  }

  /** Citizen resubmits after "returned for correction"; the clock resumes. */
  static async resubmitApplication(params: { applicationId: string; actor: AuthUser; remarks?: string; applicantDetails?: Record<string, unknown> }) {
    const { app, current } = await loadForAction(params.applicationId);
    if (params.actor.role !== 'CITIZEN' || params.actor.id !== app.citizenId) {
      throw new ForbiddenError('Only the applicant can resubmit this application');
    }
    if (current.holdType !== 'CORRECTION') {
      throw new ConflictError('This application has not been returned for correction');
    }

    const now = Clock.now();
    const { pausedSeconds, data } = closePauseData(current, now);
    let details: Record<string, unknown> = {};
    try {
      details = JSON.parse(app.applicantDetails || '{}');
    } catch {}

    await prisma.$transaction(async tx => {
      await tx.applicationStageInstance.update({ where: { id: current.id }, data: { ...data, lastActivityAt: now } });
      await tx.application.update({
        where: { id: app.id },
        data: {
          status: 'IN_PROGRESS',
          lastActivityAt: now,
          ...(params.applicantDetails ? { applicantDetails: JSON.stringify({ ...details, ...params.applicantDetails }) } : {}),
        },
      });
      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'APPLICATION_RESUBMITTED',
        actorId: params.actor.id,
        actorRole: params.actor.role,
        metadata: { remarks: params.remarks, updatedFields: Object.keys(params.applicantDetails ?? {}) },
      });
      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'SLA_RESUMED',
        actorId: params.actor.id,
        actorRole: params.actor.role,
        metadata: { reason: 'Applicant resubmitted corrections', pausedPeriodSeconds: pausedSeconds },
      });
    });

    await NotificationService.notifyDepartment(current.stage.departmentCode, 'STAFF_DOCUMENT_RECEIVED', app.id, {
      trackingNumber: app.trackingNumber,
      documentTitle: 'corrected application',
      stageName: current.stage.name,
    });
    await SlaService.refreshApplicationSla(app.id);
    return { success: true, message: 'Application resubmitted; processing resumed' };
  }
}
