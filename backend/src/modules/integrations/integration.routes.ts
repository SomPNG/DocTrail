import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { IntegrationService } from './integration.service.js';
import { validateBody } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../common/errors.js';

const router = Router();

const externalEventSchema = z.object({
  sourceSystem: z.string().min(2),
  externalEventId: z.string().optional(),
  trackingNumber: z.string().min(2),
  eventType: z.string().min(2),
  status: z.string().optional(),
  officerRemarks: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

/** Machine-to-machine auth for external government systems (header: x-integration-key). */
function requireIntegrationKey(req: Request, _res: Response, next: NextFunction) {
  const provided = String(req.headers['x-integration-key'] || '');
  const expected = env.INTEGRATION_API_KEY;
  const ok =
    provided.length === expected.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!ok) return next(new UnauthorizedError('Missing or invalid x-integration-key'));
  next();
}

router.post('/events', requireIntegrationKey, validateBody(externalEventSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await IntegrationService.ingestExternalEvent(req.body);
    sendSuccess(res, result, 'External event processed and mapped to audit trail', 202);
  } catch (err) {
    next(err);
  }
});

// Public physical-file QR lookup (minimal, masked data)
router.get('/qr/:code', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await IntegrationService.resolveFileTracking(req.params.code), 'Physical file tracking details from QR');
  } catch (err) {
    next(err);
  }
});

router.get('/file-tracking/:trackingNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await IntegrationService.resolveFileTracking(req.params.trackingNumber), 'Physical file tracking details');
  } catch (err) {
    next(err);
  }
});

export default router;
