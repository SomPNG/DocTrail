import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const bool = (def: 'true' | 'false') =>
  z
    .string()
    .default(def)
    .transform(v => v === 'true' || v === '1');

const DEV_JWT_SECRET = 'doctrail-dev-only-jwt-secret-change-me';

const envSchema = z.object({
  PORT: z.string().default('4000').transform(val => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:./dev.db'),
  JWT_SECRET: z.string().optional(),
  JWT_EXPIRES_IN: z.string().default('7d'),
  SLA_AT_RISK_THRESHOLD_PERCENT: z.string().default('20').transform(val => parseFloat(val)),
  GEMINI_API_KEY: z.string().optional(),

  // Background SLA watchdog
  SLA_WATCHDOG_ENABLED: bool('true'),
  SLA_WATCHDOG_INTERVAL_MS: z.string().default('60000').transform(v => parseInt(v, 10)),

  // Demo / simulation features (never enable in production unless you mean it)
  DEMO_MODE: z.string().optional(),
  SIMULATION_ENABLED: z.string().optional(),

  // External system integration key (header: x-integration-key)
  INTEGRATION_API_KEY: z.string().default('doctrail-dev-integration-key'),

  // Serve /uploads publicly (legacy frontend links). Off by default: use signed view tokens instead.
  PUBLIC_UPLOADS: bool('false'),

  // Notifications
  NOTIFY_CHANNELS: z.string().default('SMS,WHATSAPP,EMAIL'), // outbound mock channels for citizens
  DOC_REMINDER_HOURS: z.string().default('48').transform(v => parseFloat(v)),
  STUCK_IDLE_HOURS: z.string().default('48').transform(v => parseFloat(v)),
});

const parsed = envSchema.parse(process.env);

if (parsed.NODE_ENV === 'production' && !parsed.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

const nonProd = parsed.NODE_ENV !== 'production';

export const env = {
  ...parsed,
  JWT_SECRET: parsed.JWT_SECRET || DEV_JWT_SECRET,
  DEMO_MODE: parsed.DEMO_MODE ? parsed.DEMO_MODE === 'true' : nonProd,
  SIMULATION_ENABLED: parsed.SIMULATION_ENABLED ? parsed.SIMULATION_ENABLED === 'true' : nonProd,
  NOTIFY_CHANNEL_LIST: parsed.NOTIFY_CHANNELS.split(',')
    .map(c => c.trim().toUpperCase())
    .filter(c => ['SMS', 'WHATSAPP', 'EMAIL'].includes(c)) as Array<'SMS' | 'WHATSAPP' | 'EMAIL'>,
};
