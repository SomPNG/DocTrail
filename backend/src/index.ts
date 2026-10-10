import { createApp } from './app.js';
import { env } from './config/env.js';
import { Clock } from './common/clock.js';
import { REGISTERED_SERVICES } from './config/workflowConfig.js';
import { WorkflowService } from './modules/workflow/workflow.service.js';
import { SlaWatchdog } from './modules/sla/sla.watchdog.js';

async function bootstrap() {
  try {
    await Clock.load();
    if (Clock.getOffsetMs() !== 0) {
      console.log(`⏱  Virtual clock is offset by ${(Clock.getOffsetMs() / 3_600_000).toFixed(1)}h (POST /api/sim/clock/reset to return to real time)`);
    }

    for (const serviceConfig of Object.values(REGISTERED_SERVICES)) {
      await WorkflowService.syncServiceConfig(serviceConfig);
      console.log(`✓ ${serviceConfig.serviceName} workflow configuration synchronized`);
    }

    const app = createApp();
    const server = app.listen(env.PORT, () => {
      console.log('====================================================');
      console.log(`🚀 DocTrail Backend Engine running on port ${env.PORT}`);
      console.log(`   Health: http://localhost:${env.PORT}/api/health`);
      console.log(`   Environment: ${env.NODE_ENV} | demo=${env.DEMO_MODE} | simulation=${env.SIMULATION_ENABLED}`);
      console.log('====================================================');
    });

    if (env.SLA_WATCHDOG_ENABLED) {
      SlaWatchdog.startWatchdog(env.SLA_WATCHDOG_INTERVAL_MS);
      SlaWatchdog.scanAllActiveApplications().catch(err => console.error('Initial SLA scan failed:', err));
      console.log(`✓ SLA watchdog running every ${Math.round(env.SLA_WATCHDOG_INTERVAL_MS / 1000)}s`);
    }

    const shutdown = async () => {
      console.log('\nGracefully shutting down DocTrail backend...');
      SlaWatchdog.stopWatchdog();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error('Fatal error during startup:', error);
    process.exit(1);
  }
}

bootstrap();
