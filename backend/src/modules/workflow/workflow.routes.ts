import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client.js';
import { NotFoundError } from '../../common/errors.js';
import { sendSuccess } from '../../common/utils.js';
import { DocumentAnalyzer } from '../documents/document.analyzer.js';

const router = Router();

const stageInclude = { where: { isActive: true }, orderBy: { orderIndex: 'asc' as const }, include: { department: true } };

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const services = await prisma.service.findMany({ where: { isActive: true }, include: { stages: stageInclude } });
    sendSuccess(res, services, 'Available government services');
  } catch (err) {
    next(err);
  }
});

router.get('/:key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const service = await prisma.service.findUnique({ where: { key: req.params.key }, include: { stages: stageInclude } });
    if (!service) throw new NotFoundError(`Service with key ${req.params.key} not found`);
    sendSuccess(res, service, 'Service workflow details');
  } catch (err) {
    next(err);
  }
});

// POST /api/services/match - matches citizen intent / document type to a registered service
router.post('/match', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { intent, documentType } = req.body;
    if (!intent || typeof intent !== 'string') {
      return res.status(400).json({ success: false, message: 'intent string is required' });
    }
    sendSuccess(res, await DocumentAnalyzer.matchService(intent, documentType), 'Service matched successfully');
  } catch (err) {
    next(err);
  }
});

export default router;
