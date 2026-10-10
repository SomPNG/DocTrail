import { prisma } from '../../db/client.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { AccessPolicy } from '../../common/access.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { SlaService } from '../sla/sla.service.js';
import { WorkflowService, closePauseData } from '../workflow/workflow.service.js';
import { AuthUser } from '../../common/middleware.js';

export interface RequestDocumentParams {
  applicationId: string;
  documentType: string;
  title: string;
  reason: string;
  actor: AuthUser;
}

export interface UploadDocumentParams {
  applicationId: string;
  documentRequestId?: string;
  title: string;
  documentType: string;
  fileUrl: string;
  fileHash?: string;
  actor: AuthUser;
  notes?: string;
}

export class DocumentService {
  /**
   * Officer requests a missing document from the citizen. Pauses the SLA clock (hold type
   * CITIZEN_DOCS) so the department is not penalised for time the citizen takes.
   */
  static async requestDocument(params: RequestDocumentParams) {
    const { applicationId, documentType, title, reason, actor } = params;

    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        stageInstances: { where: { status: 'ACTIVE' }, include: { stage: { include: { department: true } } } },
      },
    });
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    if (app.status === 'COMPLETED' || app.status === 'REJECTED') {
      throw new ConflictError(`Application is already finalized with status: ${app.status}`);
    }

    const current = app.stageInstances[0];
    if (!current) throw new ConflictError('Application does not have an active stage');

    AccessPolicy.assertCanActOnStage(actor, current.stage.departmentCode);

    const now = Clock.now();
    const docRequest = await prisma.$transaction(async tx => {
      const request = await tx.documentRequest.create({
        data: {
          applicationId: app.id,
          stageInstanceId: current.id,
          requestedByOfficerId: actor.id,
          documentType,
          title,
          reason,
          status: 'PENDING',
          requestedAt: now,
        },
      });

      // Pause for the citizen unless an admin hold/correction is already in force
      if (!current.pausedAt || current.holdType === 'CITIZEN_DOCS') {
        await WorkflowService.pauseInTx(tx, {
          app,
          current,
          actor,
          holdType: 'CITIZEN_DOCS',
          reason: `Document requested: ${title}`,
          now,
        });
      }

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current.stageId,
        eventType: 'DOCUMENT_REQUESTED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: { documentType, title, reason, requestId: request.id },
      });

      return request;
    });

    await NotificationService.notify('DOCUMENT_NEEDED', {
      recipientUserId: app.citizenId,
      applicationId: app.id,
      vars: {
        trackingNumber: app.trackingNumber,
        departmentName: current.stage.department?.name || current.stage.departmentCode,
        documentTitle: title,
        reason,
      },
    });

    await SlaService.refreshApplicationSla(app.id);
    return docRequest;
  }

  /**
   * Citizen (or staff on their behalf) uploads a document. If it satisfies the last pending
   * request and the stage was paused for CITIZEN_DOCS, the clock resumes automatically.
   * Manual holds and corrections are NOT lifted by an upload.
   */
  static async uploadDocument(params: UploadDocumentParams) {
    const { applicationId, documentRequestId, title, documentType, fileUrl, fileHash, actor, notes } = params;

    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        service: { include: { stages: { select: { departmentCode: true } } } },
        stageInstances: { where: { status: 'ACTIVE' }, include: { stage: { include: { department: true } } } },
      },
    });
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);

    if (actor.role === 'CITIZEN' && app.citizenId !== actor.id) {
      throw new ForbiddenError('You can only upload documents for your own application');
    }
    if (actor.role !== 'CITIZEN') AccessPolicy.assertCanView(actor, app);

    if (documentRequestId) {
      const req = await prisma.documentRequest.findUnique({ where: { id: documentRequestId } });
      if (!req || req.applicationId !== app.id) {
        throw new AppError('documentRequestId does not belong to this application', 400);
      }
      if (req.status !== 'PENDING') {
        throw new ConflictError(`Document request is already ${req.status.toLowerCase()}`);
      }
    }

    const current = app.stageInstances[0];
    const now = Clock.now();
    let resumed = false;

    const document = await prisma.$transaction(async tx => {
      const doc = await tx.document.create({
        data: {
          applicationId: app.id,
          documentRequestId: documentRequestId ?? null,
          uploadedByUserId: actor.id,
          title,
          documentType,
          fileUrl,
          fileHash,
          notes,
          createdAt: now,
        },
      });

      if (documentRequestId) {
        await tx.documentRequest.update({
          where: { id: documentRequestId },
          data: { status: 'SUBMITTED', submittedAt: now },
        });
      }

      await EventService.record(tx, {
        applicationId: app.id,
        stageId: current?.stageId ?? null,
        eventType: 'DOCUMENT_SUBMITTED',
        actorId: actor.id,
        actorRole: actor.role,
        metadata: { documentId: doc.id, documentType, title, documentRequestId },
      });

      const pendingCount = await tx.documentRequest.count({ where: { applicationId: app.id, status: 'PENDING' } });
      const pausedForDocs = current?.pausedAt && (current.holdType === 'CITIZEN_DOCS' || current.holdType === null);

      if (current && pendingCount === 0 && pausedForDocs) {
        const { pausedSeconds, data } = closePauseData(current, now);
        await tx.applicationStageInstance.update({ where: { id: current.id }, data: { ...data, lastActivityAt: now } });
        await tx.application.update({ where: { id: app.id }, data: { status: 'IN_PROGRESS', lastActivityAt: now } });
        await EventService.record(tx, {
          applicationId: app.id,
          stageId: current.stageId,
          eventType: 'SLA_RESUMED',
          actorId: actor.id,
          actorRole: actor.role,
          metadata: {
            reason: 'All requested documents have been submitted by the applicant',
            resumedAfterSeconds: pausedSeconds,
            totalAccumulatedPausedSeconds: (data as any).totalPausedSeconds,
          },
        });
        resumed = true;
      } else {
        await tx.application.update({ where: { id: app.id }, data: { lastActivityAt: now } });
      }

      return doc;
    });

    if (actor.role === 'CITIZEN') {
      await NotificationService.notify('DOCUMENT_RECEIVED', {
        recipientUserId: app.citizenId,
        applicationId: app.id,
        vars: {
          trackingNumber: app.trackingNumber,
          documentTitle: title,
          departmentName: current?.stage.department?.name || current?.stage.departmentCode,
        },
      });
      if (current) {
        const vars = { trackingNumber: app.trackingNumber, documentTitle: title, stageName: current.stage.name };
        if (current.assignedOfficerId) {
          await NotificationService.notify('STAFF_DOCUMENT_RECEIVED', {
            recipientUserId: current.assignedOfficerId,
            applicationId: app.id,
            vars,
            audience: 'STAFF',
          });
        } else {
          await NotificationService.notifyDepartment(current.stage.departmentCode, 'STAFF_DOCUMENT_RECEIVED', app.id, vars);
        }
      }
    }

    await SlaService.refreshApplicationSla(app.id);
    return { ...document, slaResumed: resumed };
  }

  static async getApplicationDocuments(applicationId: string) {
    const [documents, requests] = await Promise.all([
      prisma.document.findMany({
        where: { applicationId },
        include: { uploadedByUser: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.documentRequest.findMany({
        where: { applicationId },
        include: {
          requestedByOfficer: { select: { id: true, name: true, role: true } },
          documents: true,
        },
        orderBy: { requestedAt: 'desc' },
      }),
    ]);

    return { documents, requests };
  }
}
