import { prisma } from '../../db/client.js';
import { NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { SecurityEngine } from '../../common/security.js';
import { EventService } from '../events/event.service.js';
import { SlaService } from '../sla/sla.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';

export interface ExternalEventPayload {
  sourceSystem: string;
  externalEventId?: string;
  trackingNumber: string;
  eventType: string; // e.g. 'EXTERNAL_CLEARANCE', 'POLICE_REPORT_ATTACHED'
  status?: string;
  officerRemarks?: string;
  metadata?: Record<string, unknown>;
}

export class IntegrationService {
  /**
   * Ingests an event from a legacy government system into the audit trail.
   * Recorded as EXTERNAL_UPDATE (never as a workflow transition: only an officer can move a file).
   * Idempotent on (sourceSystem, externalEventId).
   */
  static async ingestExternalEvent(payload: ExternalEventPayload) {
    const { sourceSystem, externalEventId, trackingNumber, eventType, status, officerRemarks, metadata } = payload;

    const app = await prisma.application.findUnique({ where: { trackingNumber }, include: { currentStage: true } });
    if (!app) throw new NotFoundError(`Application with tracking number ${trackingNumber} not found`);

    if (externalEventId) {
      const dup = await prisma.stageEvent.findFirst({
        where: { applicationId: app.id, eventType: 'EXTERNAL_UPDATE', metadataJson: { contains: `"externalEventId":"${externalEventId}"` } },
      });
      if (dup) {
        return { status: 'DUPLICATE_IGNORED', applicationId: app.id, trackingNumber, sourceSystem, eventId: dup.id };
      }
    }

    const recorded = await EventService.recordEvent({
      applicationId: app.id,
      stageId: app.currentStageId,
      eventType: 'EXTERNAL_UPDATE',
      actorRole: `EXTERNAL_${sourceSystem.toUpperCase()}`,
      metadata: { externalEventId, sourceSystem, rawEventType: eventType, externalStatus: status, remarks: officerRemarks, ...metadata },
    });

    return {
      status: 'PROCESSED',
      applicationId: app.id,
      trackingNumber: app.trackingNumber,
      sourceSystem,
      eventId: recorded.id,
      currentStage: app.currentStage?.name,
    };
  }

  /**
   * Public QR / tracking-number lookup (no login). Returns only where the file is and its status,
   * with the applicant name masked - no contact details, no internal remarks.
   */
  static async resolveFileTracking(identifier: string) {
    const found = await prisma.application.findFirst({
      where: { OR: [{ qrCodeToken: identifier }, { trackingNumber: identifier }] },
      select: { id: true },
    });
    if (!found) throw new NotFoundError(`No physical or digital file found for identifier: ${identifier}`);

    const sla = await SlaService.refreshApplicationSla(found.id);
    const app = await prisma.application.findUniqueOrThrow({
      where: { id: found.id },
      include: { service: true, currentStage: { include: { department: true } } },
    });
    const diag = await DiagnosisService.diagnoseById(found.id, 'CITIZEN');
    const closed = app.status === 'COMPLETED' || app.status === 'REJECTED';

    return {
      applicationId: app.id,
      trackingNumber: app.trackingNumber,
      serviceName: app.service.name,
      applicantName: SecurityEngine.maskName(app.applicantName),
      status: app.status,
      currentStage: closed ? app.status : app.currentStage?.name ?? 'N/A',
      currentDepartment: closed ? 'N/A' : app.currentStage?.department?.name ?? 'N/A',
      departmentCode: closed ? 'N/A' : app.currentStage?.departmentCode ?? 'N/A',
      slaStatus: app.slaStatus,
      slaRemainingSeconds: sla?.remainingSeconds ?? 0,
      isPaused: sla?.isPaused ?? false,
      isBreached: !!sla?.stageBreached || !!sla?.isBreached,
      whyStatus: diag.reasonLabel,
      serverNow: Clock.now(),
    };
  }
}
