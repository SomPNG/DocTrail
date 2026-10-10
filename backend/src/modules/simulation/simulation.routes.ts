import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SimulationService } from './simulation.service.js';
import { authenticate, authorize, requireFlag, validateBody } from '../../common/middleware.js';
import { sendSuccess } from '../../common/utils.js';
import { env } from '../../config/env.js';

const router = Router();

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

// Anyone logged in may read the clock (frontends use it to render countdowns in simulated time)
router.get('/clock', authenticate, wrap(async (_req, res) => {
  sendSuccess(res, await SimulationService.getClock(), 'Simulation clock');
}));

// Everything else: supervisors/admins, and only when SIMULATION_ENABLED
router.use(authenticate, authorize(['SUPERVISOR', 'ADMIN']), requireFlag(env.SIMULATION_ENABLED, 'Simulation'));

const hoursSchema = z.object({ hours: z.coerce.number().positive().max(1440) });
const stepSchema = z.object({ hours: z.coerce.number().positive().max(1440), tickHours: z.coerce.number().min(0.5).max(12).optional() });
const runSchema = z.object({
  days: z.coerce.number().positive().max(60).optional(),
  tickHours: z.coerce.number().min(0.5).max(12).optional(),
  seed: z.coerce.number().int().positive().optional(),
});
const samplesSchema = z.object({
  days: z.coerce.number().int().min(1).max(30).optional(),
  scenario: z.string().optional(),
  seed: z.coerce.number().int().positive().optional(),
  withStories: z.boolean().optional(),
});

router.get('/state', wrap(async (_req, res) => {
  sendSuccess(res, await SimulationService.getState(), 'Simulation state');
}));

// Virtual clock
router.post('/clock/advance', validateBody(hoursSchema), wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.advanceClock(req.body.hours), `Clock advanced by ${req.body.hours}h`);
}));
router.post('/clock/reset', wrap(async (_req, res) => {
  sendSuccess(res, await SimulationService.resetClock(), 'Clock reset to real time');
}));

// Stochastic scenarios (department queues, delays, disruptions)
router.get('/scenarios', wrap(async (_req, res) => {
  sendSuccess(res, SimulationService.listScenarios(), 'Available scenarios');
}));
router.post('/scenarios/:key/start', validateBody(runSchema.pick({ seed: true })), wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.startScenario(req.params.key, { seed: req.body.seed }), 'Scenario started');
}));
router.post('/scenarios/:key/run', validateBody(runSchema), wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.runScenario(req.params.key, req.body), 'Scenario run complete');
}));
router.post('/step', validateBody(stepSchema), wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.step(req.body.hours, req.body.tickHours), `Simulated ${req.body.hours}h`);
}));

// Scripted stories (one application, step by step, for live demos)
router.get('/stories', wrap(async (_req, res) => {
  sendSuccess(res, SimulationService.listStories(), 'Available stories');
}));
router.post('/stories/:key/start', wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.startStory(req.params.key), 'Story started (step 1 executed)');
}));
router.post('/stories/next', wrap(async (_req, res) => {
  sendSuccess(res, await SimulationService.nextStoryStep(), 'Story step executed');
}));
router.post('/stories/:key/run', wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.runStory(req.params.key), 'Story run complete');
}));

// Housekeeping
router.post('/samples', validateBody(samplesSchema), wrap(async (req, res) => {
  sendSuccess(res, await SimulationService.generateSampleData(req.body), 'Sample applications generated', 201);
}));
router.post('/reset', wrap(async (_req, res) => {
  sendSuccess(res, await SimulationService.reset(), 'Simulated data removed and clock reset');
}));

export default router;
