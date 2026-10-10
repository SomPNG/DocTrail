import { Router, Request, Response, NextFunction } from 'express';
import { DiagnosisService } from './diagnosis.service.js';
import { authenticate, authorize } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';
import { Clock } from '../../common/clock.js';
import { AppError } from '../../common/errors.js';

const router = Router();

/**
 * GET /api/officer/queue
 * The officer's department queue, most urgent first, each file with "where + why" diagnosis.
 * Supervisors may pass ?departmentCode=.
 */
router.get('/queue', authenticate, authorize(['OFFICER', 'SUPERVISOR']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const departmentCode = req.user!.role === 'OFFICER' ? req.user!.departmentCode : (req.query.departmentCode as string | undefined);
    if (!departmentCode) throw new AppError('departmentCode is required', 400);

    const items = await DiagnosisService.diagnoseActive({ departmentCode });
    const summary = {
      total: items.length,
      stuck: items.filter(i => i.diagnosis.isStuck).length,
      breached: items.filter(i => i.diagnosis.timing?.stageBreached).length,
      atRisk: items.filter(i => i.diagnosis.timing?.slaStatus === 'AT_RISK').length,
      waitingOnCitizen: items.filter(i => i.diagnosis.responsibleParty === 'CITIZEN').length,
      unassigned: items.filter(i => i.diagnosis.reasonCode === 'UNASSIGNED' || i.diagnosis.reasonCode === 'ON_TRACK').length,
    };
    sendSuccess(res, { departmentCode, summary, items, serverNow: Clock.now() }, 'Department queue');
  } catch (err) {
    next(err);
  }
});

export default router;
