import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/client.js';
import { ApplicationService } from './application.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { DocumentService } from '../documents/document.service.js';
import { EventService } from '../events/event.service.js';
import { SlaService } from '../sla/sla.service.js';
import { CompensationService } from '../compensation/compensation.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import { ChecklistGate } from '../../common/checklist.js';
import { SecurityEngine } from '../../common/security.js';
import { NotFoundError } from '../../common/errors.js';
import { authenticate, authorize, validateBody } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';

const router = Router();

// Validation Schemas
const createApplicationSchema = z.object({
  serviceKey: z.string().default('gun_license'),
  applicantName: z.string().min(2),
  applicantDetails: z.record(z.any()).optional(),
  trackingNumber: z.string().optional(),
});

const checklistResponsesSchema = z.union([z.record(z.boolean()), z.array(z.string())]).optional();

const transitionSchema = z.object({
  remarks: z.string().optional(),
  checklistResponses: checklistResponsesSchema,
});

const holdSchema = z.object({
  reason: z.string().min(3),
  holdType: z.enum(['ADMIN_HOLD', 'EXTERNAL']).optional(),
});

const assignSchema = z.object({
  officerId: z.string().optional(),
});

const resubmitSchema = z.object({
  remarks: z.string().optional(),
  applicantDetails: z.record(z.any()).optional(),
});

const requestDocSchema = z.object({
  documentType: z.string().min(2),
  title: z.string().min(2),
  reason: z.string().min(3),
});

const uploadDocSchema = z.object({
  documentRequestId: z.string().optional(),
  documentType: z.string().min(1),
  title: z.string().min(1),
  fileUrl: z.string().min(2),
  fileHash: z.string().optional(),
  notes: z.string().optional(),
});

const reviewCompensationSchema = z.object({
  recordId: z.string(),
  action: z.enum(['APPROVE', 'REJECT']),
  remarks: z.string().optional(),
});

const decisionSchema = z.object({
  decisionType: z.enum(['APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION']),
  reason: z
    .string()
    .optional()
    .transform(val => {
      if (!val || val.trim().length === 0) {
        return 'Official statutory decision recorded following multi-stage verification.';
      }
      if (val.trim().length < 3) {
        return `${val.trim()} - Official statutory decision recorded.`;
      }
      return val.trim();
    }),
  checklistResponses: checklistResponsesSchema,
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

// 1. Applications Base Endpoints
router.post(
  '/',
  authenticate,
  authorize(['CITIZEN']),
  validateBody(createApplicationSchema),
  wrap(async (req, res) => {
    const app = await ApplicationService.createApplication(req.user!, req.body);
    sendSuccess(res, app, 'Application created successfully', 201);
  })
);

router.get(
  '/',
  authenticate,
  wrap(async (req, res) => {
    const { status, slaStatus, serviceKey, search, departmentCode, allDepartments, stuckReason, includeSimulated } = req.query;
    const apps = await ApplicationService.listApplications(req.user!, {
      status: status as string,
      slaStatus: slaStatus as string,
      serviceKey: serviceKey as string,
      search: search as string,
      departmentCode: departmentCode as string,
      stuckReason: stuckReason as string,
      allDepartments: allDepartments === 'true' || allDepartments === '1',
      includeSimulated: includeSimulated === 'false' ? false : undefined,
    });
    sendSuccess(res, apps, 'Applications retrieved');
  })
);

router.get(
  '/:id',
  authenticate,
  wrap(async (req, res) => {
    const app = await ApplicationService.getApplicationById(req.params.id, req.user!);
    sendSuccess(res, app, 'Application details');
  })
);

// "Where is it and why" - citizen-safe tracking view
router.get(
  '/:id/tracking',
  authenticate,
  wrap(async (req, res) => {
    const tracking = await ApplicationService.getTracking(req.params.id, req.user!);
    sendSuccess(res, tracking, 'Application tracking');
  })
);

router.get(
  '/:id/diagnosis',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const diag = await DiagnosisService.diagnoseById(req.params.id, req.user!.role === 'CITIZEN' ? 'CITIZEN' : 'STAFF');
    sendSuccess(res, diag, 'Application diagnosis');
  })
);

// 2. Workflow Transitions
const forwardHandler = (message: string) =>
  wrap(async (req, res) => {
    const result = await WorkflowService.advanceStage({
      applicationId: req.params.id,
      actor: req.user!,
      remarks: req.body.remarks,
      checklistResponses: req.body.checklistResponses,
    });
    sendSuccess(res, result, message);
  });

router.post('/:id/forward', authenticate, authorize(['OFFICER', 'SUPERVISOR']), validateBody(transitionSchema), forwardHandler('Application advanced to next stage'));
router.post('/:id/complete-stage', authenticate, authorize(['OFFICER', 'SUPERVISOR']), validateBody(transitionSchema), forwardHandler('Stage completed successfully'));

router.post(
  '/:id/assign',
  authenticate,
  authorize(['OFFICER', 'SUPERVISOR']),
  validateBody(assignSchema),
  wrap(async (req, res) => {
    const result = await WorkflowService.assignStage({ applicationId: req.params.id, actor: req.user!, officerId: req.body.officerId });
    sendSuccess(res, result, 'Stage assigned');
  })
);

router.post(
  '/:id/hold',
  authenticate,
  authorize(['OFFICER', 'SUPERVISOR']),
  validateBody(holdSchema),
  wrap(async (req, res) => {
    const result = await WorkflowService.holdApplication({
      applicationId: req.params.id,
      actor: req.user!,
      reason: req.body.reason,
      holdType: req.body.holdType,
    });
    sendSuccess(res, result, 'Application placed on hold, SLA paused');
  })
);

router.post(
  '/:id/resume',
  authenticate,
  authorize(['OFFICER', 'SUPERVISOR']),
  validateBody(transitionSchema),
  wrap(async (req, res) => {
    const result = await WorkflowService.resumeApplication({ applicationId: req.params.id, actor: req.user!, reason: req.body.remarks });
    sendSuccess(res, result, 'Application resumed, SLA unpaused');
  })
);

router.post(
  '/:id/resubmit',
  authenticate,
  authorize(['CITIZEN']),
  validateBody(resubmitSchema),
  wrap(async (req, res) => {
    const result = await WorkflowService.resubmitApplication({
      applicationId: req.params.id,
      actor: req.user!,
      remarks: req.body.remarks,
      applicantDetails: req.body.applicantDetails,
    });
    sendSuccess(res, result, 'Application resubmitted');
  })
);

// 3. Document Request & Submission
router.post(
  '/:id/documents/request',
  authenticate,
  authorize(['OFFICER', 'SUPERVISOR']),
  validateBody(requestDocSchema),
  wrap(async (req, res) => {
    const docRequest = await DocumentService.requestDocument({
      applicationId: req.params.id,
      documentType: req.body.documentType,
      title: req.body.title,
      reason: req.body.reason,
      actor: req.user!,
    });
    sendSuccess(res, docRequest, 'Document requested and SLA clock paused', 201);
  })
);

router.post(
  '/:id/documents/upload',
  authenticate,
  validateBody(uploadDocSchema),
  wrap(async (req, res) => {
    const doc = await DocumentService.uploadDocument({
      applicationId: req.params.id,
      documentRequestId: req.body.documentRequestId,
      documentType: req.body.documentType,
      title: req.body.title,
      fileUrl: req.body.fileUrl,
      fileHash: req.body.fileHash,
      notes: req.body.notes,
      actor: req.user!,
    });
    sendSuccess(res, doc, 'Document uploaded successfully', 201);
  })
);

router.get(
  '/:id/documents',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const docs = await DocumentService.getApplicationDocuments(req.params.id);
    sendSuccess(res, docs, 'Application documents');
  })
);

// Short-lived signed link to view one document (replaces public /uploads links)
router.get(
  '/:id/documents/:documentId/view-token',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const doc = await prisma.document.findFirst({ where: { id: req.params.documentId, applicationId: req.params.id } });
    if (!doc) throw new NotFoundError('Document not found for this application');
    const expiresInSeconds = 60;
    const token = SecurityEngine.generateExpiringFileToken(doc.fileUrl, expiresInSeconds);
    sendSuccess(res, {
      token,
      viewUrl: doc.fileUrl.startsWith('/uploads/') ? `/api/documents/secure-view/${token}` : doc.fileUrl,
      expiresInSeconds,
    }, 'Document view token issued');
  })
);

// 4. Audit Timeline & SLA
router.get(
  '/:id/timeline',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const timeline = await EventService.getApplicationTimeline(req.params.id);
    if (req.user!.role === 'CITIZEN') {
      // strip officer identities and internal remarks from the raw timeline for citizens
      const safe = timeline.map(e => {
        const { remarks, ...meta } = (e.metadata || {}) as Record<string, unknown>;
        return { ...e, actorId: e.actorRole === 'CITIZEN' ? e.actorId : null, metadata: meta };
      });
      return sendSuccess(res, safe, 'Application audit event timeline');
    }
    sendSuccess(res, timeline, 'Application audit event timeline');
  })
);

router.get(
  '/:id/verify-audit-chain',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const chainVerification = await EventService.verifyAuditChain(req.params.id);
    sendSuccess(res, chainVerification, 'Cryptographic audit chain verification result');
  })
);

router.get(
  '/:id/sla',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const sla = await SlaService.refreshApplicationSla(req.params.id);
    sendSuccess(res, sla, 'Application real-time SLA metrics');
  })
);

// 5. Compensation (read-only evaluation; claims are created automatically on breach)
router.get(
  '/:id/compensation',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    await SlaService.refreshApplicationSla(req.params.id);
    const comp = await CompensationService.getEligibility(req.params.id);
    sendSuccess(res, comp, 'Application compensation eligibility');
  })
);

router.post(
  '/:id/compensation/review',
  authenticate,
  authorize(['SUPERVISOR', 'ADMIN']),
  validateBody(reviewCompensationSchema),
  wrap(async (req, res) => {
    const reviewed = await CompensationService.reviewCompensation({
      recordId: req.body.recordId,
      applicationId: req.params.id,
      action: req.body.action,
      remarks: req.body.remarks,
      reviewer: req.user!,
    });
    sendSuccess(res, reviewed, 'Compensation decision processed');
  })
);

// 6. Checklists & Official Decisions
router.get(
  '/:id/checklists',
  authenticate,
  wrap(async (req, res) => {
    await ApplicationService.assertCanView(req.params.id, req.user!);
    const app = await prisma.application.findUnique({ where: { id: req.params.id }, include: { currentStage: true } });
    let items = app && app.status !== 'COMPLETED' && app.status !== 'REJECTED' ? ChecklistGate.parse(app.currentStage?.checklistJson) : [];
    if (items.length === 0 && app && app.status !== 'COMPLETED' && app.status !== 'REJECTED') {
      items = [
        { id: 'identity_verified', label: 'Applicant Identity Proof & Biometrics Verified', isMandatory: true },
        { id: 'jurisdiction_confirmed', label: 'Local Station / Ward Jurisdiction Confirmed', isMandatory: true },
        { id: 'clearance_inspected', label: 'Physical Site / Field Inquiry Clearance Validated', isMandatory: false },
      ];
    }
    sendSuccess(res, { checklists: items, items, stageName: app?.currentStage?.name ?? null }, 'Stage verification checklist items');
  })
);

router.post(
  '/:id/decision',
  authenticate,
  authorize(['OFFICER', 'SUPERVISOR']),
  validateBody(decisionSchema),
  wrap(async (req, res) => {
    const result = await WorkflowService.recordDecision({
      applicationId: req.params.id,
      decisionType: req.body.decisionType,
      reason: req.body.reason,
      checklistResponses: req.body.checklistResponses,
      actor: req.user!,
    });
    sendSuccess(res, result, `Application decision "${req.body.decisionType}" recorded successfully`, 201);
  })
);

export default router;
