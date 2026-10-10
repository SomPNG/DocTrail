import { Router, Request, Response, NextFunction } from 'express';
import { DemoService } from './demo.service.js';
import { sendSuccess } from '../../common/utils.js';
import { authenticate, authorize, requireFlag } from '../../common/middleware.js';
import { env } from '../../config/env.js';

const router = Router();

// POST /api/demo/reset  { withSamples?: boolean }
// Destructive: supervisors/admins only, and only when DEMO_MODE is on (default off in production).
router.post(
  '/reset',
  authenticate,
  authorize(['SUPERVISOR', 'ADMIN']),
  requireFlag(env.DEMO_MODE, 'Demo reset'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await DemoService.resetDemoState({ withSamples: req.body?.withSamples === true });
      return sendSuccess(res, result, result.message, 200);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/demo/clear-data
// Destructive: Available in DEMO_MODE to reset all previously uploaded data and applications
router.post(
  '/clear-data',
  requireFlag(env.DEMO_MODE, 'Demo reset'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await DemoService.resetDemoState({ withSamples: false });
      return sendSuccess(res, result, result.message, 200);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
