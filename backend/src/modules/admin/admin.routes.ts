import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AdminService } from './admin.service.js';
import { authenticate, authorize, validateBody } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';

const router = Router();

const draftSchema = z.object({ prompt: z.string().min(5) });

// Legacy shape used by the React admin portal (api.synthesizeWorkflow)
const legacyDraftSchema = z.object({
  serviceName: z.string().min(2),
  description: z.string().optional(),
});

const createDeptSchema = z.object({
  code: z.string().min(2),
  name: z.string().min(2),
  description: z.string().optional(),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2),
  role: z.enum(['OFFICER', 'SUPERVISOR', 'ADMIN']),
  departmentCode: z.string().optional(),
  badgeNumber: z.string().optional(),
  phone: z.string().optional(),
});

router.use(authenticate);
router.use(authorize(['ADMIN']));

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

router.post(
  '/workflows/draft-with-ai',
  validateBody(draftSchema),
  wrap(async (req, res) => {
    const draft = await AdminService.draftWorkflowWithAi(req.body.prompt);
    sendSuccess(res, draft, 'AI workflow draft generated for admin review', 201);
  })
);

router.post(
  '/synthesize-workflow',
  validateBody(legacyDraftSchema),
  wrap(async (req, res) => {
    const draft = await AdminService.draftWorkflowWithAi(`${req.body.serviceName}. ${req.body.description ?? ''}`.trim());
    sendSuccess(res, draft, 'AI workflow draft generated for admin review', 201);
  })
);

router.post(
  '/workflows/publish',
  wrap(async (req, res) => {
    const { draft } = req.body;
    if (!draft) return res.status(400).json({ success: false, message: 'draft object is required' });
    const result = await AdminService.publishWorkflow(draft, req.user!);
    sendSuccess(res, result, result.message, 201);
  })
);

router.get(
  '/workflows/:serviceKey/versions',
  wrap(async (req, res) => {
    sendSuccess(res, await AdminService.getServiceVersions(req.params.serviceKey), 'Published workflow versions');
  })
);

router.get(
  '/departments',
  wrap(async (_req, res) => {
    sendSuccess(res, await AdminService.listDepartments(), 'Department list retrieved');
  })
);

router.post(
  '/departments',
  validateBody(createDeptSchema),
  wrap(async (req, res) => {
    sendSuccess(res, await AdminService.createDepartment(req.body), 'Department created successfully', 201);
  })
);

router.get(
  '/users',
  wrap(async (_req, res) => {
    sendSuccess(res, await AdminService.listStaff(), 'Staff accounts');
  })
);

router.post(
  '/users',
  validateBody(createUserSchema),
  wrap(async (req, res) => {
    sendSuccess(res, await AdminService.createStaffUser(req.body), 'Staff account created', 201);
  })
);

export default router;
