import { Router } from 'express';
import { AiController } from './ai.controller.js';
import { authenticate, authorize } from '../../common/middleware.js';

const router = Router();

// 1. Synthesize (and optionally persist) a workflow - workflow configuration is an ADMIN capability
router.post('/synthesize-service', authenticate, authorize(['ADMIN']), AiController.synthesizeService);

// 2. Dynamic intake: citizen provides free-text intent -> AI provisions service + application
router.post('/apply', authenticate, authorize(['CITIZEN']), AiController.applyWithAi);

// 3. Stage document checklist evaluation (staff)
router.get('/evaluate-stage/:applicationId', authenticate, authorize(['OFFICER', 'SUPERVISOR', 'ADMIN']), AiController.evaluateStage);

// 4. Explainable delay diagnostic (owner or staff with access)
router.get('/explain-delay/:applicationId', authenticate, AiController.explainDelay);

// 5. 1-Click auto-request for an AI-identified missing document (pauses SLA)
router.post('/auto-request-doc/:applicationId', authenticate, authorize(['OFFICER', 'SUPERVISOR']), AiController.autoRequestDoc);

// 6. Public service catalog with document requirements
router.get('/catalog', AiController.getCatalog);

// 7. Role-Specific Conversational AI Assistants
router.post('/citizen-assistant', authenticate, authorize(['CITIZEN', 'SUPERVISOR', 'ADMIN']), AiController.askCitizenAssistant);
router.post('/officer-assistant', authenticate, authorize(['OFFICER', 'SUPERVISOR', 'ADMIN']), AiController.askOfficerAssistant);
router.post('/supervisor-assistant', authenticate, authorize(['SUPERVISOR', 'ADMIN']), AiController.askSupervisorAssistant);

export default router;
