import { Router, Request, Response, NextFunction } from 'express';
import { AnalyticsService } from './analytics.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import { prisma } from '../../db/client.js';
import { Clock } from '../../common/clock.js';
import { SecurityEngine } from '../../common/security.js';
import { authenticate, authorize } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';

const router = Router();

// Dashboards are for staff. Officers see their own department where a filter applies.
router.use(authenticate, authorize(['SUPERVISOR', 'OFFICER', 'ADMIN']));

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

/** Officers are scoped to their department; oversight roles may pass ?departmentCode. */
function scopeDept(req: Request): string | undefined {
  if (req.user!.role === 'OFFICER') return req.user!.departmentCode ?? '__none__';
  const d = req.query.departmentCode as string | undefined;
  return d && d !== 'ALL' ? d : undefined;
}

function maskForOfficer(req: Request, apps: any[]) {
  if (req.user!.role !== 'OFFICER') return apps;
  return apps.map(a => ({
    ...a,
    citizen: a.citizen ? { name: a.citizen.name, email: SecurityEngine.maskEmail(a.citizen.email), phone: SecurityEngine.maskPii(a.citizen.phone) } : a.citizen,
  }));
}

router.get('/overview', wrap(async (_req, res) => {
  sendSuccess(res, await AnalyticsService.getOverviewMetrics(), 'Dashboard overview metrics');
}));

router.get('/departments', wrap(async (_req, res) => {
  sendSuccess(res, await AnalyticsService.getDepartmentMetrics(), 'Department performance metrics');
}));

router.get('/bottlenecks', wrap(async (_req, res) => {
  sendSuccess(res, await AnalyticsService.detectBottlenecks(), 'Identified workflow bottlenecks');
}));

router.get('/trends', wrap(async (req, res) => {
  const days = req.query.days ? Number(req.query.days) : 14;
  sendSuccess(res, await AnalyticsService.getTrends(days, scopeDept(req)), 'Daily backlog / arrival / completion / breach series');
}));

// Every active file that is stuck, with where + why, most urgent first
router.get('/stuck', wrap(async (req, res) => {
  const items = await DiagnosisService.diagnoseActive({
    departmentCode: scopeDept(req),
    onlyStuck: req.query.all !== 'true',
    includeSimulated: req.query.includeSimulated === 'false' ? false : undefined,
  });
  const byReason: Record<string, number> = {};
  for (const i of items) byReason[i.diagnosis.reasonCode] = (byReason[i.diagnosis.reasonCode] || 0) + 1;
  sendSuccess(res, { count: items.length, byReason, items, serverNow: Clock.now() }, 'Stuck applications with diagnosis');
}));

const listInclude = {
  service: true,
  currentStage: { include: { department: true } },
  citizen: { select: { name: true, email: true, phone: true } },
  slaRecord: true,
};

router.get('/breaches', wrap(async (req, res) => {
  const dept = scopeDept(req);
  const breaches = await prisma.application.findMany({
    where: {
      status: { in: ['IN_PROGRESS', 'ON_HOLD'] },
      OR: [{ slaStatus: 'BREACHED' }, { stageInstances: { some: { status: 'ACTIVE', breachedAt: { not: null } } } }],
      ...(dept ? { currentStage: { departmentCode: dept } } : {}),
    },
    include: listInclude,
    orderBy: { updatedAt: 'desc' },
  });
  sendSuccess(res, maskForOfficer(req, breaches), 'SLA breached applications');
}));

router.get('/at-risk', wrap(async (req, res) => {
  const dept = scopeDept(req);
  const atRisk = await prisma.application.findMany({
    where: { slaStatus: 'AT_RISK', ...(dept ? { currentStage: { departmentCode: dept } } : {}) },
    include: listInclude,
    orderBy: { updatedAt: 'desc' },
  });
  sendSuccess(res, maskForOfficer(req, atRisk), 'At-risk applications nearing deadline');
}));

export default router;
