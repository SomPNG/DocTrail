import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { ForbiddenError, NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { AccessPolicy } from '../../common/access.js';
import { SecurityEngine } from '../../common/security.js';
import { generateQrCodeToken, generateTrackingNumber, trackingPrefixForService } from '../../common/utils.js';
import { ServiceConfig } from '../../config/serviceConfig.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { SlaService } from '../sla/sla.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import { AuthUser } from '../../common/middleware.js';

export interface CreateApplicationDto {
  serviceKey: string;
  applicantName: string;
  applicantDetails?: Record<string, unknown>;
  trackingNumber?: string; // explicit override, honoured only in DEMO_MODE (tests / demos)
}

const ACCESS_INCLUDE = {
  service: { select: { stages: { select: { departmentCode: true } } } },
  stageInstances: { select: { stage: { select: { departmentCode: true } } } },
  currentStage: { select: { departmentCode: true } },
};

function maskCitizen<T extends { citizen?: any; citizenId: string }>(app: T, actor: AuthUser): T {
  if (!app.citizen || !AccessPolicy.shouldMaskCitizenContact(actor, app)) return app;
  return {
    ...app,
    citizen: {
      ...app.citizen,
      email: app.citizen.email ? SecurityEngine.maskEmail(app.citizen.email) : app.citizen.email,
      phone: app.citizen.phone ? SecurityEngine.maskPii(app.citizen.phone) : app.citizen.phone,
    },
  };
}

export class ApplicationService {
  /**
   * Citizen creates a new application. One tracking ID, first stage activated, clock started.
   */
  static async createApplication(citizen: AuthUser, dto: CreateApplicationDto, opts: { isSimulated?: boolean } = {}) {
    if (citizen.role !== 'CITIZEN') {
      throw new ForbiddenError('Only citizens can submit applications');
    }

    const service = await prisma.service.findUnique({
      where: { key: dto.serviceKey },
      include: { stages: { where: { isActive: true }, orderBy: { orderIndex: 'asc' }, include: { department: true } } },
    });

    if (!service || !service.isActive || service.stages.length === 0) {
      throw new NotFoundError(`Service with key ${dto.serviceKey} is not available`);
    }

    const firstStage = service.stages[0];
    const now = Clock.now();
    const slaDeadline = new Date(now.getTime() + firstStage.slaHours * 3600 * 1000);
    const prefix = trackingPrefixForService(service.key, ServiceConfig.parse(service.configJson).trackingPrefix);

    const application = await prisma.$transaction(async tx => {
      const trackingNumber =
        dto.trackingNumber && env.DEMO_MODE ? dto.trackingNumber : await generateTrackingNumber(tx, prefix);

      const app = await tx.application.create({
        data: {
          trackingNumber,
          serviceId: service.id,
          citizenId: citizen.id,
          applicantName: dto.applicantName,
          applicantDetails: JSON.stringify(dto.applicantDetails ?? {}),
          currentStageId: firstStage.id,
          status: 'IN_PROGRESS',
          slaStatus: 'ON_TRACK',
          qrCodeToken: generateQrCodeToken(),
          isSimulated: !!opts.isSimulated,
          lastActivityAt: now,
          createdAt: now,
        },
      });

      await tx.applicationStageInstance.create({
        data: {
          applicationId: app.id,
          stageId: firstStage.id,
          status: 'ACTIVE',
          startedAt: now,
          slaDeadline,
          lastActivityAt: now,
        },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: firstStage.id,
        eventType: 'APPLICATION_CREATED',
        actorId: citizen.id,
        actorRole: citizen.role,
        metadata: { serviceName: service.name, applicantName: dto.applicantName, initialStage: firstStage.name },
      });

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: firstStage.id,
        eventType: 'STAGE_ENTERED',
        actorRole: 'SYSTEM',
        metadata: { stageName: firstStage.name, department: firstStage.departmentCode, deadline: slaDeadline },
      });

      return app;
    });

    const vars = {
      trackingNumber: application.trackingNumber,
      serviceName: service.name,
      stageName: firstStage.name,
      departmentName: firstStage.department?.name || firstStage.departmentCode,
      deadline: slaDeadline,
    };
    await NotificationService.notify('APPLICATION_RECEIVED', { recipientUserId: citizen.id, applicationId: application.id, vars });
    await NotificationService.notifyDepartment(firstStage.departmentCode, 'STAFF_NEW_IN_QUEUE', application.id, vars);
    await SlaService.refreshApplicationSla(application.id);

    return this.getApplicationById(application.id, citizen);
  }

  /** Lightweight permission check (no SLA refresh, no side effects). */
  static async assertCanView(id: string, actor: AuthUser) {
    const app = await prisma.application.findUnique({ where: { id }, select: { id: true, citizenId: true, ...ACCESS_INCLUDE } });
    if (!app) throw new NotFoundError(`Application ${id} not found`);
    AccessPolicy.assertCanView(actor, app);
    return app;
  }

  /**
   * Application detail with live SLA, risk and "where/why stuck" diagnosis.
   */
  static async getApplicationById(id: string, actor: AuthUser) {
    await this.assertCanView(id, actor);

    const currentSlaMetrics = await SlaService.refreshApplicationSla(id);
    const riskAssessment = await AnalyticsService.calculateApplicationRisk(id);

    const app = await prisma.application.findUnique({
      where: { id },
      include: {
        service: { include: { stages: { orderBy: { orderIndex: 'asc' }, include: { department: true } } } },
        citizen: { select: { id: true, name: true, email: true, phone: true } },
        currentStage: { include: { department: true } },
        stageInstances: {
          include: {
            stage: { include: { department: true } },
            assignedOfficer: { select: { id: true, name: true, badgeNumber: true } },
            documentRequests: true,
          },
          orderBy: { stage: { orderIndex: 'asc' } },
        },
        documents: { orderBy: { createdAt: 'desc' } },
        slaRecord: true,
      },
    });
    if (!app) throw new NotFoundError(`Application ${id} not found`);

    const queueStats = await DiagnosisService.getQueueStats();
    const diagnosis = DiagnosisService.diagnose(app, queueStats, Clock.now(), actor.role === 'CITIZEN' ? 'CITIZEN' : 'STAFF');

    const shaped = maskCitizen(app, actor);
    if (actor.role === 'CITIZEN') {
      // Citizens never see officer identities
      shaped.stageInstances = shaped.stageInstances.map(i => ({ ...i, assignedOfficer: null, remarks: null })) as any;
    }

    return {
      ...shaped,
      currentSlaMetrics,
      riskAssessment,
      diagnosis,
      serverNow: Clock.now(),
    };
  }

  /**
   * Citizen-safe tracking view: where is it, why, what's next, and a plain-language timeline.
   */
  static async getTracking(id: string, actor: AuthUser) {
    await this.assertCanView(id, actor);
    await SlaService.refreshApplicationSla(id);

    const [diagnosis, events, depts, app] = await Promise.all([
      DiagnosisService.diagnoseById(id, actor.role === 'CITIZEN' ? 'CITIZEN' : 'STAFF'),
      prisma.stageEvent.findMany({ where: { applicationId: id }, orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }] }),
      prisma.department.findMany({ select: { code: true, name: true } }),
      prisma.application.findUnique({ where: { id }, select: { applicantName: true, createdAt: true, compensationStatus: true } }),
    ]);

    return {
      trackingNumber: diagnosis.trackingNumber,
      serviceName: diagnosis.serviceName,
      applicantName: app?.applicantName,
      submittedAt: app?.createdAt,
      status: diagnosis.status,
      whereIsIt: diagnosis.location,
      why: {
        reasonCode: diagnosis.reasonCode,
        reason: diagnosis.reasonLabel,
        message: diagnosis.citizenMessage,
        responsibleParty: diagnosis.responsibleParty,
      },
      timing: diagnosis.timing,
      pendingDocuments: diagnosis.pendingDocuments,
      pipeline: diagnosis.pipeline,
      compensationStatus: app?.compensationStatus,
      timeline: DiagnosisService.publicTimeline(events, new Map(depts.map(d => [d.code, d.name]))),
      serverNow: Clock.now(),
    };
  }

  /**
   * Lists applications visible to the actor.
   *  - citizens: their own
   *  - officers: their department's current queue; with allDepartments=true, every application
   *    whose workflow involves their department (so queue tabs/counts still work)
   *  - supervisors/admins: everything, optionally filtered by department
   */
  static async listApplications(
    actor: AuthUser,
    filters?: {
      status?: string;
      slaStatus?: string;
      serviceKey?: string;
      search?: string;
      departmentCode?: string;
      allDepartments?: boolean;
      stuckReason?: string;
      includeSimulated?: boolean;
    }
  ) {
    const where: any = {};

    if (actor.role === 'CITIZEN') {
      where.citizenId = actor.id;
    } else if (actor.role === 'OFFICER') {
      if (!actor.departmentCode) return [];
      if (filters?.allDepartments) {
        where.service = { stages: { some: { departmentCode: actor.departmentCode } } };
      } else {
        where.currentStage = { departmentCode: actor.departmentCode };
      }
    } else if (filters?.departmentCode && filters.departmentCode !== 'ALL') {
      where.currentStage = { departmentCode: filters.departmentCode };
    }

    if (filters?.status) where.status = filters.status;
    if (filters?.slaStatus) where.slaStatus = filters.slaStatus;
    if (filters?.stuckReason) where.stuckReasonCode = filters.stuckReason;
    if (filters?.includeSimulated === false) where.isSimulated = false;
    if (filters?.serviceKey) where.service = { ...(where.service || {}), key: filters.serviceKey };
    if (filters?.search) {
      where.OR = [{ trackingNumber: { contains: filters.search } }, { applicantName: { contains: filters.search } }];
    }

    const apps = await prisma.application.findMany({
      where,
      include: {
        service: true,
        currentStage: { include: { department: true } },
        citizen: { select: { id: true, name: true, email: true } },
        documents: { orderBy: { createdAt: 'desc' } },
        slaRecord: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return apps.map(a => maskCitizen(a, actor));
  }
}
