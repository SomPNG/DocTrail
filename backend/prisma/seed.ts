import { prisma } from '../src/db/client.js';
import { Clock } from '../src/common/clock.js';
import { ensureBaseline } from '../src/modules/demo/demo.service.js';
import { SimulationService } from '../src/modules/simulation/simulation.service.js';

/**
 * npm run prisma:seed                 -> departments, seed users, registered services (no applications)
 * npm run prisma:seed -- --with-samples -> plus ~10 days of realistic sample applications
 *                                         (police backlog scenario + 3 scripted stories)
 */
async function seed() {
  console.log('--- Starting DocTrail Database Seed ---');
  await Clock.load();
  await ensureBaseline();
  console.log('✓ Departments, seed users (password "Password123!") and services synchronized');

  if (process.argv.includes('--with-samples')) {
    console.log('… generating sample applications (this runs the simulator for ~10 virtual days)');
    const result = await SimulationService.generateSampleData({ days: 10 });
    console.log(`✓ Sample data: ${JSON.stringify(result.stats)}`);
    console.log(`✓ Stories: ${result.stories.map(s => `${s.story} -> ${s.trackingNumber}`).join(', ')}`);
  } else {
    console.log('✓ Clean slate: 0 applications (use --with-samples for sample data)');
  }
  console.log('--- DocTrail Database Seed Completed ---');
}

seed()
  .catch(e => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
