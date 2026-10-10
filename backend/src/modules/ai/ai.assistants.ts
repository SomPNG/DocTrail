import { GoogleGenAI } from '@google/genai';
import { prisma } from '../../db/client.js';
import { AppError, ForbiddenError, NotFoundError } from '../../common/errors.js';
import { AccessPolicy } from '../../common/access.js';
import { ChecklistGate } from '../../common/checklist.js';
import { SlaService } from '../sla/sla.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import type { AuthUser } from '../../common/middleware.js';

async function askGemini(systemInstruction: string, query: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    const gemini = new GoogleGenAI({ apiKey });
    const response = await gemini.models.generateContent({ model: 'gemini-2.5-flash', contents: query, config: { systemInstruction } });
    const text = typeof (response as any).text === 'function' ? (response as any).text() : (response as any).text;
    return text && typeof text === 'string' ? text.trim() : null;
  } catch (err) {
    console.warn('Gemini assistant call failed, using deterministic fallback:', err);
    return null;
  }
}

export class AiAssistants {
  /**
   * Citizen assistant: plain-language status, grounded in the deterministic diagnosis.
   * Never exposes officer names, internal remarks or other citizens' data.
   */
  static async askCitizenAssistant(user: AuthUser, query: string, applicationId?: string) {
    if (!query || query.trim().length === 0) throw new AppError('Query is required', 400);

    let applicationContext: any = null;
    if (applicationId) {
      const app = await prisma.application.findUnique({
        where: { id: applicationId },
        include: {
          service: { include: { stages: { select: { departmentCode: true } } } },
          stageInstances: { include: { stage: true } },
          documents: { select: { id: true } },
        },
      });
      if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
      if (user.role === 'CITIZEN' && app.citizenId !== user.id) {
        throw new ForbiddenError('You can only access your own applications');
      }
      AccessPolicy.assertCanView(user, app);

      const diag = await DiagnosisService.diagnoseById(applicationId, 'CITIZEN');
      const active = app.stageInstances.find(i => i.status === 'ACTIVE');
      const sla = active ? SlaService.calculateStageSla(active) : null;

      applicationContext = {
        trackingNumber: app.trackingNumber,
        serviceName: app.service.name,
        overallStatus: app.status,
        slaStatus: sla ? sla.status : app.slaStatus,
        currentStage: diag.location?.stageName ?? 'Completed / Closed',
        department: diag.location?.departmentName ?? 'None',
        slaHoursRemaining: sla ? Number((sla.remainingSeconds / 3600).toFixed(1)) : 0,
        slaDeadline: sla ? sla.slaDeadline : null,
        isPaused: sla ? sla.isPaused : false,
        whyStatus: diag.citizenMessage,
        reasonCode: diag.reasonCode,
        pendingDocumentsToUpload: diag.pendingDocuments.map((d: any) => ({ title: d.title })),
        uploadedDocumentsCount: app.documents.length,
      };
    }

    const suggestions = ['Where is my application?', 'What documents are still needed?', 'Am I eligible for delay compensation?'];

    const ai = await askGemini(
      `You are "DocTrail Citizen Companion", a polite civic assistant. Explain status in simple language.
Never reveal officer names, internal notes or confidential markings.
Citizen: ${user.name || user.email}
Context: ${JSON.stringify(applicationContext || { message: 'General civic question' })}`,
      query
    );
    if (ai) return { reply: ai, context: applicationContext, suggestions };

    const q = query.toLowerCase();
    let reply: string;
    if (applicationContext) {
      if (applicationContext.pendingDocumentsToUpload.length > 0) {
        reply = `${applicationContext.whyStatus} Your time is protected: the clock is paused while the office waits for you.`;
      } else if (q.includes('delay') || q.includes('compensation') || q.includes('money') || q.includes('breach')) {
        reply =
          applicationContext.slaStatus === 'BREACHED'
            ? `Your application ${applicationContext.trackingNumber} has passed its target time. A delay compensation claim is created automatically and sent to the supervisor for approval.`
            : `Your application ${applicationContext.trackingNumber} is ${applicationContext.slaStatus.replace('_', ' ').toLowerCase()}. There is no delay right now.`;
      } else {
        reply = applicationContext.whyStatus;
      }
    } else {
      reply = `Hello ${user.name || 'Citizen'}! I can tell you where your application is, why it is there, and what documents are needed.`;
    }
    return { reply, context: applicationContext, suggestions };
  }

  /**
   * Officer assistant: checklist guidance for the active stage of the officer's department.
   */
  static async askOfficerAssistant(user: AuthUser, query: string, applicationId: string) {
    if (!applicationId) throw new AppError('applicationId is required', 400);

    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        service: true,
        stageInstances: { include: { stage: true, documentRequests: true }, orderBy: { stage: { orderIndex: 'asc' } } },
      },
    });
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);

    const activeInstance = app.stageInstances.find(i => i.status === 'ACTIVE');
    if (!activeInstance) throw new AppError('Application does not have an active stage', 400);

    if (user.role === 'OFFICER' && user.departmentCode !== activeInstance.stage.departmentCode) {
      throw new ForbiddenError(`Officer from ${user.departmentCode} cannot review stage belonging to ${activeInstance.stage.departmentCode}`);
    }

    let checklist = ChecklistGate.parse(activeInstance.stage.checklistJson).map(c => c.label);
    if (checklist.length === 0) {
      checklist = ['Verify submitted identity credentials', 'Check departmental jurisdiction criteria', 'Ensure required statutory attachments are legible'];
    }

    const pendingRequests = activeInstance.documentRequests.filter(r => r.status === 'PENDING');
    const hasPendingDocs = pendingRequests.length > 0;
    const sla = SlaService.calculateStageSla(activeInstance);

    const checklistCompliance = checklist.map(label => {
      const isDocCheck = /doc|attach|credential/i.test(label);
      return isDocCheck && hasPendingDocs
        ? { item: label, status: 'CHECK_REQUIRED' as const, reason: `Pending document requests: ${pendingRequests.map(r => r.title).join(', ')}` }
        : { item: label, status: 'TO_VERIFY' as const, reason: 'Officer must verify this item before forwarding' };
    });

    const recommendedAction = hasPendingDocs ? 'HOLD' : 'VERIFY_AND_FORWARD';
    const suggestedRemarks = hasPendingDocs
      ? `Verification pending documents: ${pendingRequests.map(r => r.title).join(', ')}.`
      : `Verified statutory requirements for ${activeInstance.stage.name}. Recommended for forward progression.`;

    const ai = await askGemini(
      `You are "DocTrail Administrative Co-Pilot" advising a government officer. Be concise and legally grounded.
Application: ${app.trackingNumber} (${app.service.name}); Stage: ${activeInstance.stage.name} (${activeInstance.stage.departmentCode})
SLA: ${sla.status}, ${(sla.remainingSeconds / 3600).toFixed(1)}h remaining. Checklist: ${JSON.stringify(checklistCompliance)}`,
      query
    );

    const advice =
      ai ??
      `Stage "${activeInstance.stage.name}" (${activeInstance.stage.departmentCode}): ${
        hasPendingDocs
          ? `${pendingRequests.length} document request(s) are pending; the clock is paused until the applicant uploads them.`
          : `verify the ${checklist.length} checklist items, then forward.`
      } SLA status ${sla.status}, ${(sla.remainingSeconds / 3600).toFixed(1)}h remaining.`;

    return { advice, recommendedAction, checklistCompliance, suggestedRemarks };
  }

  /**
   * Supervisor assistant: bottlenecks (with the dominant reason), stuck files and compensation liability.
   */
  static async askSupervisorAssistant(user: AuthUser, query: string, departmentCode?: string) {
    if (user.role !== 'SUPERVISOR' && user.role !== 'ADMIN') {
      throw new ForbiddenError('Only supervisors and administrators can access executive AI assistant');
    }

    const [overview, bottlenecks, pendingClaims] = await Promise.all([
      AnalyticsService.getOverviewMetrics(),
      AnalyticsService.detectBottlenecks(),
      prisma.compensationRecord.findMany({ where: { status: 'ELIGIBLE_PENDING_APPROVAL' }, select: { standardCompensationAmount: true } }),
    ]);

    const projectedLiability = pendingClaims.reduce((acc, c) => acc + c.standardCompensationAmount, 0);
    const filtered = departmentCode ? bottlenecks.filter(b => b.departmentCode === departmentCode) : bottlenecks;
    const top = filtered[0];

    const recommendedInterventions = [
      top?.isBottleneck ? `Add capacity at ${top.departmentName} (${top.stageName}): ${top.explanation}` : 'Maintain current staffing allocation',
      pendingClaims.length > 0 ? `Review ${pendingClaims.length} pending delay compensation claim(s)` : 'No pending compensation claims',
      `Clear ${overview.stuckApplications} stuck application(s) flagged on the stuck dashboard`,
    ];

    const ai = await askGemini(
      `You are "DocTrail Operations Director" advising district supervisors. Recommend concrete interventions.
Overview: ${JSON.stringify(overview)}
Top bottlenecks: ${JSON.stringify(filtered.slice(0, 3))}
Pending compensation liability: ₹${projectedLiability}`,
      query
    );

    const insight =
      ai ??
      (top
        ? `Highest bottleneck: "${top.stageName}" at ${top.departmentName} (score ${top.bottleneckScore}/100, ${top.activeBacklog} active files). Main factor: ${top.explanation}. ${overview.stuckApplications} application(s) are stuck; ${overview.applicationsEverBreached} have breached a stage target. Pending compensation liability is ₹${projectedLiability}.`
        : `No active workload. Pending compensation liability is ₹${projectedLiability}.`);

    return {
      insight,
      bottleneckHighlights: filtered,
      projectedCompensationLiability: projectedLiability,
      pendingClaimsCount: pendingClaims.length,
      recommendedInterventions,
    };
  }
}
