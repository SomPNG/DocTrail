import { Router, Request, Response, NextFunction } from 'express';
import { SlaWatchdog } from './sla.watchdog.js';
import { authenticate, authorize } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';
import { AppError } from '../../common/errors.js';

const router = Router();

/**
 * POST /api/sla/watchdog/scan
 *  {}                       -> LIVE scan at the current (virtual) time; persists breaches, reminders, reasons
 *  { referenceTime: ISO }   -> PROJECTION: "what would be late at time T?" (read-only)
 * To actually move time forward, use the simulation clock: POST /api/sim/clock/advance
 */
async function scanHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const raw = req.body?.referenceTime;
    let ref: Date | undefined;
    if (raw) {
      ref = new Date(raw);
      if (Number.isNaN(ref.getTime())) throw new AppError('referenceTime must be an ISO date', 400);
    }
    const report = await SlaWatchdog.scanAllActiveApplications(ref);
    sendSuccess(res, report, ref ? 'SLA projection computed (no data changed)' : 'SLA Watchdog scan completed successfully');
  } catch (err) {
    next(err);
  }
}

router.post('/watchdog/scan', authenticate, authorize(['SUPERVISOR', 'ADMIN']), scanHandler);
// Alias used by the React admin portal (api.triggerSlaWatchdog)
router.post('/trigger-watchdog', authenticate, authorize(['SUPERVISOR', 'ADMIN']), scanHandler);

router.get('/watchdog/status', authenticate, authorize(['SUPERVISOR', 'ADMIN']), (_req: Request, res: Response) => {
  sendSuccess(res, SlaWatchdog.getStatus(), 'SLA Watchdog status');
});

export default router;
