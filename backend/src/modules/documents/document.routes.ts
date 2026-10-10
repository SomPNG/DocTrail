import { Router, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { DocumentAnalyzer } from './document.analyzer.js';
import { fileUpload, hashFile, uploadDir } from './file.upload.js';
import { prisma } from '../../db/client.js';
import { Clock } from '../../common/clock.js';
import { AccessPolicy } from '../../common/access.js';
import { ChecklistGate } from '../../common/checklist.js';
import { ServiceConfig } from '../../config/serviceConfig.js';
import { SlaService } from '../sla/sla.service.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { sendSuccess, generateTrackingNumber, generateQrCodeToken, trackingPrefixForService } from '../../common/utils.js';
import { SecurityEngine } from '../../common/security.js';
import { authenticate, authorize } from '../../common/middleware.js';
import { ForbiddenError, NotFoundError } from '../../common/errors.js';

const router = Router();

// POST /api/documents/analyze
// Analyzes OCR text and extracts entities (no persistence, so it stays public for intake previews)
router.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text, filename } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, message: 'text string is required for document analysis' });
    }
    const result = await DocumentAnalyzer.analyzeDocument(text, filename);
    sendSuccess(res, result, 'Document analyzed and entities extracted successfully');
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/upload  (authenticated) - stores a file and returns its internal URL
router.post('/upload', authenticate, fileUpload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    return sendSuccess(
      res,
      {
        fileUrl: `/uploads/${req.file.filename}`,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        fileHash: hashFile(req.file.path),
      },
      'File uploaded successfully',
      201
    );
  } catch (err) {
    next(err);
  }
});

// POST /api/documents/upload-and-route  (citizen)
// AI intake: analyse the uploaded form, match the statutory service, create the application and
// route it to the first department's queue with its verification checklist.
router.post(
  '/upload-and-route',
  authenticate,
  authorize(['CITIZEN']),
  fileUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a document file (.pdf, image, or text file) for AI intake and routing',
        });
      }
      const citizen = req.user!;

      const { text: extractedText, analysis } = await DocumentAnalyzer.analyzeFile(req.file.path, req.file.originalname, req.file.mimetype);
      const matchResult = await DocumentAnalyzer.matchService(extractedText || req.file.originalname, analysis.documentType);

      if (!matchResult.isRecognized || analysis.documentType === 'unrecognized_document') {
        SecurityEngine.secureShredFile(req.file.path);
        return res.status(400).json({
          success: false,
          message: `AI Intake Notice: The uploaded file ("${req.file.originalname}") could not be identified as a valid statutory government application. DocTrail supports Arms/Gun Licenses, Passport Re-issuance, Commercial Trade Licenses, and Borewell Permissions. Please upload an official government application form.`,
          data: { detectedType: analysis.documentType, confidence: analysis.confidenceScore, summary: analysis.summary },
        });
      }

      const service = await prisma.service.findUniqueOrThrow({
        where: { id: matchResult.bestMatch.serviceId },
        include: { stages: { where: { isActive: true }, orderBy: { orderIndex: 'asc' }, include: { department: true } } },
      });

      const entryStage = service.stages[0];
      if (!entryStage) {
        return res.status(500).json({ success: false, message: 'Configured service has no active workflow stages' });
      }

      const now = Clock.now();
      const slaDeadline = new Date(now.getTime() + entryStage.slaHours * 3600 * 1000);
      const applicantName = req.body.applicantName || analysis.applicantName || citizen.name;
      const fileUrl = `/uploads/${req.file.filename}`;
      const fileHash = hashFile(req.file.path);
      const prefix = trackingPrefixForService(service.key, ServiceConfig.parse(service.configJson).trackingPrefix);

      const application = await prisma.$transaction(async tx => {
        const trackingNumber = await generateTrackingNumber(tx, prefix);
        const app = await tx.application.create({
          data: {
            trackingNumber,
            serviceId: service.id,
            citizenId: citizen.id,
            applicantName,
            currentStageId: entryStage.id,
            status: 'IN_PROGRESS',
            slaStatus: 'ON_TRACK',
            qrCodeToken: generateQrCodeToken(),
            lastActivityAt: now,
            createdAt: now,
            applicantDetails: JSON.stringify({
              notes: req.body.notes || 'Automated AI document intake and routing',
              extractedEntities: analysis.extractedFields,
              originalFile: req.file?.originalname,
              aiSummary: analysis.summary,
            }),
          },
        });

        await tx.applicationStageInstance.create({
          data: { applicationId: app.id, stageId: entryStage.id, status: 'ACTIVE', startedAt: now, slaDeadline, lastActivityAt: now },
        });

        const doc = await tx.document.create({
          data: {
            applicationId: app.id,
            uploadedByUserId: citizen.id,
            title: req.file?.originalname || 'Uploaded Document',
            documentType: analysis.documentType,
            fileUrl,
            fileHash,
            notes: analysis.summary,
            createdAt: now,
          },
        });

        await EventService.record(tx, {
          applicationId: app.id,
          stageId: entryStage.id,
          eventType: 'APPLICATION_CREATED',
          actorId: citizen.id,
          actorRole: citizen.role,
          metadata: { trackingNumber, applicantName, service: service.name, source: 'AI_DOCUMENT_UPLOAD_INTAKE' },
        });
        await EventService.record(tx, {
          applicationId: app.id,
          stageId: entryStage.id,
          eventType: 'DOCUMENT_SUBMITTED',
          actorId: citizen.id,
          actorRole: citizen.role,
          metadata: { documentId: doc.id, title: doc.title, documentType: doc.documentType, fileHash },
        });
        await EventService.record(tx, {
          applicationId: app.id,
          stageId: entryStage.id,
          eventType: 'STAGE_ENTERED',
          actorRole: 'SYSTEM',
          metadata: { stageName: entryStage.name, department: entryStage.departmentCode, deadline: slaDeadline },
        });

        return app;
      });

      const vars = {
        trackingNumber: application.trackingNumber,
        serviceName: service.name,
        stageName: entryStage.name,
        departmentName: entryStage.department?.name || entryStage.departmentCode,
        deadline: slaDeadline,
      };
      await NotificationService.notify('APPLICATION_RECEIVED', { recipientUserId: citizen.id, applicationId: application.id, vars });
      await NotificationService.notifyDepartment(entryStage.departmentCode, 'STAFF_NEW_IN_QUEUE', application.id, vars);
      await SlaService.refreshApplicationSla(application.id);

      let checklistItems = ChecklistGate.parse(entryStage.checklistJson);
      if (checklistItems.length === 0) {
        checklistItems = [
          { id: 'verify_id', label: 'Verify applicant identity credentials', isMandatory: true },
          { id: 'verify_jurisdiction', label: 'Confirm local station / municipal territorial jurisdiction', isMandatory: true },
          { id: 'verify_attachments', label: 'Verify document validity and supporting attachments', isMandatory: true },
        ];
      }

      const summary = { id: service.id, key: service.key, name: service.name, stagesCount: service.stages.length };
      const dept = { code: entryStage.departmentCode, name: entryStage.department?.name || entryStage.departmentCode };
      const stageInfo = { id: entryStage.id, name: entryStage.name, slaHours: entryStage.slaHours, deadline: slaDeadline };
      const extraction = {
        applicantName: analysis.applicantName,
        idNumber: analysis.idNumber ? SecurityEngine.maskPii(analysis.idNumber) : undefined,
        address: analysis.address,
        documentType: analysis.documentType,
        summary: analysis.summary,
      };

      return sendSuccess(
        res,
        {
          application: {
            id: application.id,
            trackingNumber: application.trackingNumber,
            applicantName: application.applicantName,
            status: application.status,
            slaStatus: application.slaStatus,
            qrCodeToken: application.qrCodeToken,
            createdAt: application.createdAt,
          },
          targetService: summary,
          service: summary,
          targetDepartment: dept,
          receivingDepartment: dept,
          activeStage: stageInfo,
          initialStage: stageInfo,
          document: { title: req.file.originalname, fileUrl, documentType: analysis.documentType, fileHash },
          analysis: { ...extraction, confidenceScore: analysis.confidenceScore },
          extraction: { ...extraction, confidence: analysis.confidenceScore },
          verificationChecklists: checklistItems,
        },
        `Document successfully processed! Application ${application.trackingNumber} routed to ${dept.name}.`,
        201
      );
    } catch (err) {
      if (req.file?.path) SecurityEngine.secureShredFile(req.file.path);
      next(err);
    }
  }
);

// POST /api/documents/generate-token  (authenticated)
// Issues a short-lived signed URL, but only for a document the caller is allowed to see.
router.post('/generate-token', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { fileUrl } = req.body;
    const expiresInSeconds = Math.min(300, Math.max(10, Number(req.body.expiresInSeconds) || 60));
    if (!fileUrl) {
      return res.status(400).json({ success: false, message: 'fileUrl is required' });
    }
    const doc = await prisma.document.findFirst({
      where: { fileUrl },
      include: {
        application: {
          select: {
            citizenId: true,
            service: { select: { stages: { select: { departmentCode: true } } } },
            stageInstances: { select: { stage: { select: { departmentCode: true } } } },
            currentStage: { select: { departmentCode: true } },
          },
        },
      },
    });
    if (!doc) throw new NotFoundError('Document not found');
    if (!AccessPolicy.canView(req.user!, doc.application)) throw new ForbiddenError('You cannot view this document');

    const token = SecurityEngine.generateExpiringFileToken(fileUrl, expiresInSeconds);
    return sendSuccess(
      res,
      {
        token,
        expiresInSeconds,
        viewUrl: `/api/documents/secure-view/${token}`,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
      'Expiring document viewing token generated'
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/documents/secure-view/:token
router.get('/secure-view/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const verification = SecurityEngine.verifyExpiringFileToken(req.params.token);
    if (!verification.valid || !verification.fileUrl) {
      return res.status(403).json({ success: false, message: verification.error || 'Access denied: Token expired or invalid signature' });
    }

    const relative = verification.fileUrl.replace(/^\/+uploads\/+/, '');
    const diskPath = path.resolve(uploadDir, relative);
    if (!diskPath.startsWith(path.resolve(uploadDir) + path.sep)) {
      return res.status(403).json({ success: false, message: 'Access forbidden: Path restriction' });
    }
    if (!fs.existsSync(diskPath)) {
      return res.status(404).json({ success: false, message: 'Document not found' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    return res.sendFile(diskPath);
  } catch (err) {
    next(err);
  }
});

export default router;
