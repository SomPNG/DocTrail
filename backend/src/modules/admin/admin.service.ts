import { prisma } from '../../db/client.js';
import { AiService } from '../ai/ai.service.js';
import { AuthService } from '../auth/auth.service.js';
import { AppError, ConflictError, NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import type { AuthUser } from '../../common/middleware.js';
import type { SynthesizedService } from '../ai/ai.types.js';

export class AdminService {
  static async draftWorkflowWithAi(prompt: string): Promise<SynthesizedService> {
    return AiService.synthesizeService(prompt);
  }

  /**
   * Validates and publishes an immutable workflow version.
   */
  static async publishWorkflow(draft: any, admin: AuthUser) {
    if (!draft || !draft.serviceKey || !Array.isArray(draft.stages) || draft.stages.length === 0) {
      throw new AppError('Invalid workflow draft: serviceKey and at least one stage are required', 400);
    }

    const normalizedStages = draft.stages.map((st: any, idx: number) => {
      const name = st.name || st.stageName || `Stage ${idx + 1}`;
      const stageKey = st.stageKey || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const departmentCode = String(st.departmentCode || 'DM_OFFICE').toUpperCase();
      const slaHours = Number(st.slaHours) > 0 ? Number(st.slaHours) : (Number(st.slaDays) > 0 ? Number(st.slaDays) : 2) * 24;
      if (slaHours > 24 * 365) throw new AppError(`Stage "${name}" SLA is unrealistically long`, 400);

      const requiredDocs = Array.isArray(st.requiredDocuments)
        ? st.requiredDocuments.map((doc: any) =>
            typeof doc === 'string'
              ? { documentType: doc.toLowerCase().replace(/[^a-z0-9]+/g, '_'), title: doc.replace(/_/g, ' '), description: `Statutory verification: ${doc}`, isMandatory: true }
              : doc
          )
        : [];

      return {
        stageKey,
        name,
        departmentCode,
        departmentName: st.departmentName || departmentCode.replace(/_/g, ' '),
        slaDays: Number(st.slaDays) > 0 ? Number(st.slaDays) : Math.ceil(slaHours / 24),
        slaHours,
        orderIndex: st.orderIndex || idx + 1,
        requiredDocuments: requiredDocs,
        checklists: Array.isArray(st.checklists) && st.checklists.length ? st.checklists : [`Verify ${name} requirements`, 'Check statutory eligibility'],
      };
    });

    const keys = new Set(normalizedStages.map((s: any) => s.stageKey));
    if (keys.size !== normalizedStages.length) throw new AppError('Stage keys must be unique within a workflow', 400);

    const normalizedDraft: SynthesizedService = {
      serviceKey: draft.serviceKey,
      name: draft.name || draft.serviceKey,
      category: draft.category || 'Public Services',
      description: draft.description || `Configured workflow for ${draft.name || draft.serviceKey}`,
      statutoryCompensationPerDay: Number(draft.statutoryCompensationPerDay) > 0 ? Number(draft.statutoryCompensationPerDay) : 250,
      reasoning: draft.reasoning || 'Admin configured workflow pipeline',
      aiGenerated: !!draft.aiGenerated,
      stages: normalizedStages,
    };

    const service = await AiService.persistSynthesizedService(normalizedDraft);

    const latestVersion = await prisma.workflowVersion.findFirst({
      where: { serviceId: service.id },
      orderBy: { versionNumber: 'desc' },
    });
    const nextVersionNum = latestVersion ? latestVersion.versionNumber + 1 : 1;

    if (latestVersion) {
      await prisma.workflowVersion.update({ where: { id: latestVersion.id }, data: { status: 'ARCHIVED' } });
    }

    const versionRecord = await prisma.workflowVersion.create({
      data: {
        serviceId: service.id,
        versionNumber: nextVersionNum,
        configurationJson: JSON.stringify(normalizedDraft),
        status: 'PUBLISHED',
        publishedBy: admin.name || admin.email,
        publishedAt: Clock.now(),
      },
    });

    return {
      service,
      version: versionRecord,
      versionNumber: nextVersionNum,
      message: `Workflow "${normalizedDraft.name}" published successfully as Version ${nextVersionNum}.0`,
    };
  }

  static async getServiceVersions(serviceKey: string) {
    const service = await prisma.service.findUnique({
      where: { key: serviceKey },
      include: { versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!service) throw new NotFoundError(`Service with key ${serviceKey} not found`);

    return service.versions.map(v => {
      let stages: any[] = [];
      try {
        stages = JSON.parse(v.configurationJson).stages || [];
      } catch {}
      return { ...v, stagesSnapshot: stages };
    });
  }

  static async listDepartments() {
    return prisma.department.findMany({
      include: { _count: { select: { users: true, workflowStages: true } } },
      orderBy: { name: 'asc' },
    });
  }

  static async createDepartment(data: { code: string; name: string; description?: string }) {
    const code = data.code.toUpperCase();
    const existing = await prisma.department.findUnique({ where: { code } });
    if (existing) throw new ConflictError(`Department with code ${data.code} already exists`);
    return prisma.department.create({ data: { code, name: data.name, description: data.description } });
  }

  /** Staff accounts (officers, supervisors, admins) are provisioned by an administrator. */
  static async createStaffUser(data: {
    email: string;
    password: string;
    name: string;
    role: 'OFFICER' | 'SUPERVISOR' | 'ADMIN';
    departmentCode?: string;
    badgeNumber?: string;
    phone?: string;
  }) {
    return AuthService.register(data);
  }

  static async listStaff() {
    return prisma.user.findMany({
      where: { role: { in: ['OFFICER', 'SUPERVISOR', 'ADMIN'] } },
      select: { id: true, email: true, name: true, role: true, badgeNumber: true, department: { select: { code: true, name: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
  }
}
