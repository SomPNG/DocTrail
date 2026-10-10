import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from '../../db/client.js';
import { Clock } from '../../common/clock.js';
import { SecurityEngine } from '../../common/security.js';
import { BASE_DEPARTMENTS, REGISTERED_SERVICES } from '../../config/workflowConfig.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { SimulationService } from '../simulation/simulation.service.js';

export const SEED_PASSWORD = 'Password123!';

export const SEED_USERS = [
  { email: 'citizen@example.com', name: 'Aarav Sharma (Citizen)', role: 'CITIZEN', dept: null, badgeNumber: undefined, phone: '+91 98765 43210' },
  { email: 'dm.officer@example.com', name: 'Rajesh Verma (DM Officer)', role: 'OFFICER', dept: 'DM_OFFICE', badgeNumber: 'DM-OFF-01', phone: '+91 98765 11111' },
  { email: 'police.officer@example.com', name: 'Inspector Vikram Singh (Police)', role: 'OFFICER', dept: 'POLICE_DEPT', badgeNumber: 'POL-772', phone: '+91 98765 22222' },
  { email: 'sp.officer@example.com', name: 'SP Anita Roy (Superintendent)', role: 'OFFICER', dept: 'SP_OFFICE', badgeNumber: 'SP-HQ-05', phone: '+91 98765 33333' },
  { email: 'passport.officer@example.com', name: 'Meenakshi Iyer (Passport Officer)', role: 'OFFICER', dept: 'PASSPORT_OFFICE', badgeNumber: 'RPO-DEL-04', phone: '+91 98765 44444' },
  { email: 'municipal.officer@example.com', name: 'Tariq Khan (Ward Officer)', role: 'OFFICER', dept: 'MUNICIPAL_CORP', badgeNumber: 'MC-WARD-12', phone: '+91 98765 55555' },
  { email: 'health.officer@example.com', name: 'Dr. Leela Menon (Health Officer)', role: 'OFFICER', dept: 'HEALTH_DEPT', badgeNumber: 'HLTH-07', phone: '+91 98765 66666' },
  { email: 'supervisor@example.com', name: 'Commissioner Sunita Rao (Supervisor)', role: 'SUPERVISOR', dept: null, badgeNumber: 'SUP-ADM-99', phone: '+91 98765 99999' },
  { email: 'admin@example.com', name: 'System Administrator', role: 'ADMIN', dept: null, badgeNumber: 'SYS-ADMIN-01', phone: '+91 98765 00000' },
] as const;

/** Idempotently ensures departments, seed users and registered services exist. */
export async function ensureBaseline() {
  for (const dept of BASE_DEPARTMENTS) {
    await prisma.department.upsert({ where: { code: dept.code }, create: dept, update: dept });
  }
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  for (const u of SEED_USERS) {
    const department = u.dept ? await prisma.department.findUniqueOrThrow({ where: { code: u.dept } }) : null;
    const data = {
      email: u.email,
      passwordHash,
      name: u.name,
      role: u.role,
      departmentId: department?.id ?? null,
      badgeNumber: u.badgeNumber ?? null,
      phone: u.phone,
    };
    await prisma.user.upsert({ where: { email: u.email }, create: data, update: data });
  }
  for (const s of Object.values(REGISTERED_SERVICES)) {
    await WorkflowService.syncServiceConfig(s);
  }
}

export class DemoService {
  /**
   * Wipes all case data (applications, events, documents, notifications, claims), shreds uploaded
   * files, resets the virtual clock and simulation state, restores baseline users/services.
   * Optionally regenerates realistic sample applications.
   */
  static async resetDemoState(opts: { withSamples?: boolean } = {}) {
    await prisma.$transaction([
      prisma.notificationDelivery.deleteMany(),
      prisma.notification.deleteMany(),
      prisma.stageEvent.deleteMany(),
      prisma.compensationRecord.deleteMany(),
      prisma.applicationDecision.deleteMany(),
      prisma.document.deleteMany(),
      prisma.documentRequest.deleteMany(),
      prisma.slaRecord.deleteMany(),
      prisma.applicationStageInstance.deleteMany(),
      prisma.application.deleteMany(),
    ]);

    try {
      const uploadDirs = [
        path.resolve(process.cwd(), 'uploads'),
        path.resolve(process.cwd(), 'backend', 'uploads'),
        path.resolve(__dirname, '../../../../uploads'),
        path.resolve(__dirname, '../../../uploads'),
      ];
      for (const uploadDir of uploadDirs) {
        if (fs.existsSync(uploadDir)) {
          for (const file of fs.readdirSync(uploadDir)) {
            const filePath = path.join(uploadDir, file);
            if (fs.statSync(filePath).isFile()) {
              try {
                SecurityEngine.secureShredFile(filePath);
              } catch {
                try { fs.unlinkSync(filePath); } catch {}
              }
            }
          }
        }
      }
    } catch {}

    await Clock.reset();
    await SimulationService.reset();
    await ensureBaseline();

    let samples: unknown = null;
    if (opts.withSamples) {
      samples = await SimulationService.generateSampleData({ days: 10 });
    }

    const [totalApplications, activeApplications] = await Promise.all([
      prisma.application.count(),
      prisma.application.count({ where: { status: { in: ['IN_PROGRESS', 'ON_HOLD'] } } }),
    ]);

    return {
      success: true,
      message: opts.withSamples
        ? `Demo reset. ${totalApplications} sample applications generated with realistic histories.`
        : 'All applications wiped. Clean slate ready for real document upload and routing.',
      totalApplications,
      activeApplications,
      samples,
    };
  }
}
