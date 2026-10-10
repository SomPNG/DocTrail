import { Request, Response, NextFunction } from 'express';
import { AiService } from './ai.service.js';
import { AiAssistants } from './ai.assistants.js';
import { ApplicationService } from '../applications/application.service.js';
import { ServiceConfig } from '../../config/serviceConfig.js';
import { sendSuccess } from '../../common/utils.js';
import { prisma } from '../../db/client.js';

export class AiController {
  /**
   * POST /api/ai/synthesize-service (ADMIN)
   * Drafts a workflow; persisted only when autoPersist === true.
   */
  static async synthesizeService(req: Request, res: Response, next: NextFunction) {
    try {
      const { prompt, autoPersist = false } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ success: false, message: 'prompt string is required' });
      }
      const synthesized = await AiService.synthesizeService(prompt);
      const persistedRecord = autoPersist === true ? await AiService.persistSynthesizedService(synthesized) : null;
      return sendSuccess(
        res,
        { synthesized, isPersisted: !!persistedRecord, dbServiceId: persistedRecord?.id },
        'Service workflow synthesized successfully',
        201
      );
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/ai/apply (CITIZEN) */
  static async applyWithAi(req: Request, res: Response, next: NextFunction) {
    try {
      const { intent, applicantName, applicantDetails = {} } = req.body;
      if (!intent || !applicantName) {
        return res.status(400).json({ success: false, message: 'intent and applicantName are required' });
      }
      const result = await AiService.applyWithAi(intent, applicantName, applicantDetails, req.user!);
      return sendSuccess(res, result, `Application ${result.application.trackingNumber} successfully created via dynamic AI synthesis`, 201);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/ai/evaluate-stage/:applicationId (staff with access) */
  static async evaluateStage(req: Request, res: Response, next: NextFunction) {
    try {
      await ApplicationService.assertCanView(req.params.applicationId, req.user!);
      const evaluation = await AiService.evaluateStageDocuments(req.params.applicationId);
      return sendSuccess(res, evaluation, 'Stage document evaluation generated');
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/ai/explain-delay/:applicationId (owner or staff with access) */
  static async explainDelay(req: Request, res: Response, next: NextFunction) {
    try {
      await ApplicationService.assertCanView(req.params.applicationId, req.user!);
      const diagnostic = await AiService.explainDelay(req.params.applicationId);
      if (req.user!.role === 'CITIZEN') {
        const { supervisorActionRecommendation: _hidden, ...citizenView } = diagnostic;
        return sendSuccess(res, { ...citizenView, supervisorActionRecommendation: 'Delay is applicant-attributable or under departmental review; see explanation.' }, 'Delay diagnostic analysis generated');
      }
      return sendSuccess(res, diagnostic, 'Delay diagnostic analysis generated');
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/ai/auto-request-doc/:applicationId (officer of the stage's department / supervisor) */
  static async autoRequestDoc(req: Request, res: Response, next: NextFunction) {
    try {
      const docRequest = await AiService.autoRequestDiagnosedDoc(req.params.applicationId, req.user!, req.body?.documentType);
      return sendSuccess(res, docRequest, 'Document requested automatically via AI diagnostic; SLA clock paused', 201);
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/ai/catalog (public) */
  static async getCatalog(_req: Request, res: Response, next: NextFunction) {
    try {
      const services = await prisma.service.findMany({
        where: { isActive: true },
        include: { stages: { where: { isActive: true }, include: { department: true }, orderBy: { orderIndex: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });

      const catalog = services.map(s => ({
        id: s.id,
        key: s.key,
        name: s.name,
        description: s.description,
        category: ServiceConfig.category(s.configJson),
        compensationPerDay: ServiceConfig.compensationRatePerDay(s.configJson),
        stageCount: s.stages.length,
        stages: s.stages.map(stg => ({
          key: stg.stageKey,
          name: stg.name,
          department: stg.department?.name || stg.departmentCode,
          slaDays: stg.slaDays,
          slaHours: stg.slaHours,
          orderIndex: stg.orderIndex,
          requiredDocuments: ServiceConfig.requiredDocuments(s.configJson, stg.stageKey),
        })),
      }));

      return sendSuccess(res, catalog, 'Service catalog retrieved');
    } catch (err) {
      next(err);
    }
  }

  static async askCitizenAssistant(req: Request, res: Response, next: NextFunction) {
    try {
      const { query, applicationId } = req.body;
      const result = await AiAssistants.askCitizenAssistant(req.user!, query, applicationId);
      return sendSuccess(res, result, 'Citizen assistant response generated');
    } catch (err) {
      next(err);
    }
  }

  static async askOfficerAssistant(req: Request, res: Response, next: NextFunction) {
    try {
      const { query, applicationId } = req.body;
      const result = await AiAssistants.askOfficerAssistant(req.user!, query, applicationId);
      return sendSuccess(res, result, 'Officer assistant guidance generated');
    } catch (err) {
      next(err);
    }
  }

  static async askSupervisorAssistant(req: Request, res: Response, next: NextFunction) {
    try {
      const { query, departmentCode } = req.body;
      const result = await AiAssistants.askSupervisorAssistant(req.user!, query, departmentCode);
      return sendSuccess(res, result, 'Supervisor executive insights generated');
    } catch (err) {
      next(err);
    }
  }
}
