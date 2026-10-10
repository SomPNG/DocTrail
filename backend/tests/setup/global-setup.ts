import { execSync } from 'child_process';

/** Recreate prisma/test.db from the schema and seed baseline users/services once per test run. */
export default function setup() {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'file:./test.db' };
  execSync('npx prisma db push --force-reset --skip-generate', { stdio: 'inherit', env });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit', env });
}
