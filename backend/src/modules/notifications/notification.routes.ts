import { Router, Request, Response, NextFunction } from 'express';
import { NotificationService } from './notification.service.js';
import { authenticate, authorize } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';

const router = Router();

router.use(authenticate);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await NotificationService.getUserNotifications(req.user!.id), 'User notifications');
  } catch (err) {
    next(err);
  }
});

// Mock SMS / WhatsApp / Email "outbox" - shows exactly what citizens would have received
router.get('/outbox', authorize(['SUPERVISOR', 'ADMIN']), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const outbox = await NotificationService.getOutbox({
      applicationId: req.query.applicationId as string | undefined,
      channel: (req.query.channel as string | undefined)?.toUpperCase(),
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    sendSuccess(res, outbox, 'Mock outbound messages');
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await NotificationService.markAsRead(req.params.id, req.user!.id);
    sendSuccess(res, { success: true }, 'Notification marked as read');
  } catch (err) {
    next(err);
  }
});

export default router;
