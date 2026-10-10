import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { env } from './config/env.js';
import { Clock } from './common/clock.js';
import { errorHandler } from './common/middleware.js';
import authRouter from './modules/auth/auth.routes.js';
import applicationRouter from './modules/applications/application.routes.js';
import analyticsRouter from './modules/analytics/analytics.routes.js';
import workflowRouter from './modules/workflow/workflow.routes.js';
import notificationRouter from './modules/notifications/notification.routes.js';
import integrationRouter from './modules/integrations/integration.routes.js';
import aiRouter from './modules/ai/ai.routes.js';
import documentRouter from './modules/documents/document.routes.js';
import slaRouter from './modules/sla/sla.routes.js';
import adminRouter from './modules/admin/admin.routes.js';
import demoRouter from './modules/demo/demo.routes.js';
import officerRouter from './modules/diagnosis/officer.routes.js';
import simulationRouter from './modules/simulation/simulation.routes.js';

export function createApp(): Express {
  const app = express();

  app.use(cors({ exposedHeaders: ['X-Server-Now'] }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Security headers + server (virtual) time so frontends can render countdowns in simulated time
  app.use((req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('X-Server-Now', Clock.now().toISOString());
    if (req.path.startsWith('/api/')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  const candidateFrontendDirs = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(__dirname, '../../../frontend/dist'),
  ];
  const frontendStaticDir = candidateFrontendDirs.find(d => fs.existsSync(d) && fs.existsSync(path.join(d, 'index.html')));

  if (frontendStaticDir) {
    app.use(express.static(frontendStaticDir, { index: false }));
  } else {
    app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
  }

  // Uploaded files are private by default (use /api/applications/:id/documents/:docId/view-token).
  // PUBLIC_UPLOADS=true re-enables direct links for legacy frontends, served as inert downloads.
  if (env.PUBLIC_UPLOADS) {
    app.use(
      '/uploads',
      express.static(path.join(process.cwd(), 'uploads'), {
        setHeaders: res => {
          res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
          res.setHeader('X-Content-Type-Options', 'nosniff');
        },
      })
    );
  }

  app.get('/', (req: Request, res: Response) => {
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      return res.json({
        name: 'DocTrail API',
        description: 'Track one application across departments: where it is, why it is stuck, and how long each department takes.',
        version: '2.0.0',
        status: 'UP',
        serverNow: Clock.now(),
        endpoints: {
          health: 'GET /api/health',
          services: 'GET /api/services',
          auth: { register: 'POST /api/auth/register (citizens)', login: 'POST /api/auth/login', me: 'GET /api/auth/me' },
          applications: {
            list: 'GET /api/applications',
            create: 'POST /api/applications',
            details: 'GET /api/applications/:id',
            tracking: 'GET /api/applications/:id/tracking',
            diagnosis: 'GET /api/applications/:id/diagnosis',
            assign: 'POST /api/applications/:id/assign',
            forward: 'POST /api/applications/:id/forward',
            hold: 'POST /api/applications/:id/hold',
            resume: 'POST /api/applications/:id/resume',
            resubmit: 'POST /api/applications/:id/resubmit',
            decision: 'POST /api/applications/:id/decision',
            timeline: 'GET /api/applications/:id/timeline',
            sla: 'GET /api/applications/:id/sla',
            requestDoc: 'POST /api/applications/:id/documents/request',
            uploadDoc: 'POST /api/applications/:id/documents/upload',
            compensation: 'GET /api/applications/:id/compensation',
          },
          officer: { queue: 'GET /api/officer/queue' },
          dashboard: {
            overview: 'GET /api/dashboard/overview',
            departments: 'GET /api/dashboard/departments',
            bottlenecks: 'GET /api/dashboard/bottlenecks',
            stuck: 'GET /api/dashboard/stuck',
            trends: 'GET /api/dashboard/trends?days=14',
            breaches: 'GET /api/dashboard/breaches',
            atRisk: 'GET /api/dashboard/at-risk',
          },
          notifications: { inbox: 'GET /api/notifications', outbox: 'GET /api/notifications/outbox' },
          simulation: {
            clock: 'GET /api/sim/clock',
            advance: 'POST /api/sim/clock/advance',
            scenarios: 'GET /api/sim/scenarios',
            runScenario: 'POST /api/sim/scenarios/:key/run',
            step: 'POST /api/sim/step',
            stories: 'GET /api/sim/stories',
            startStory: 'POST /api/sim/stories/:key/start',
            nextStoryStep: 'POST /api/sim/stories/next',
            samples: 'POST /api/sim/samples',
            reset: 'POST /api/sim/reset',
          },
          integrations: {
            events: 'POST /api/integrations/events (x-integration-key)',
            qrLookup: 'GET /api/integrations/qr/:code',
            fileTracking: 'GET /api/integrations/file-tracking/:trackingNumber',
          },
        },
        seedCredentials: env.DEMO_MODE
          ? {
              citizen: 'citizen@example.com / Password123!',
              dmOfficer: 'dm.officer@example.com / Password123!',
              policeOfficer: 'police.officer@example.com / Password123!',
              spOfficer: 'sp.officer@example.com / Password123!',
              supervisor: 'supervisor@example.com / Password123!',
              admin: 'admin@example.com / Password123!',
            }
          : undefined,
      });
    }
    if (frontendStaticDir) {
      return res.sendFile(path.join(frontendStaticDir, 'index.html'));
    }
    if (fs.existsSync(path.join(process.cwd(), 'public', 'index.html'))) {
      return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
    }
    return res.json({
      name: 'DocTrail API',
      status: 'UP',
      message: 'DocTrail backend is running. Build frontend with `npm run build` or run Vite on port 3000.',
    });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'UP',
      system: 'DocTrail Backend Engine',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      serverNow: Clock.now().toISOString(),
      clockOffsetMs: Clock.getOffsetMs(),
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/applications', applicationRouter);
  app.use('/api/officer', officerRouter);
  app.use('/api/dashboard', analyticsRouter);
  app.use('/api/services', workflowRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/integrations', integrationRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/documents', documentRouter);
  app.use('/api/sla', slaRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/demo', demoRouter);
  app.use('/api/sim', simulationRouter);

  app.use((req: Request, res: Response) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      if (frontendStaticDir) {
        return res.sendFile(path.join(frontendStaticDir, 'index.html'));
      }
      if (fs.existsSync(path.join(process.cwd(), 'public', 'index.html'))) {
        return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
      }
    }
    res.status(404).json({ success: false, message: `Cannot ${req.method} ${req.originalUrl}` });
  });

  app.use(errorHandler);
  return app;
}
