import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { Clock, DAY_MS } from '../../common/clock.js';
import { NotFoundError } from '../../common/errors.js';
import { round1, safeJsonParse } from '../../common/utils.js';
import { SlaService } from '../sla/sla.service.js';

/**
 * "Where is it stuck, and why?"
 *
 * Deterministic diagnosis of every active application from facts the system already holds:
 * hold type, pending document requests, assignment, last activity, SLA position and the
 * department's live queue (position, throughput). Produces one reason code plus a plain-language
 * sentence for the citizen and an operational one for officers/supervisors.
 */
export type StuckReason =
  | 'ON_TRACK'
  | 'IN_REVIEW'
  | 'WAITING_ON_CITIZEN'
  | 'RETURNED_FOR_CORRECTION'
  | 'ADMIN_HOLD'
  | 'EXTERNAL_DEPENDENCY'
  | 'DEPARTMENT_BACKLOG'
  | 'UNASSIGNED'
  | 'OFFICER_IDLE'
  | 'SLOW_PROCESSING'
  | 'COMPLETED'
  | 'REJECTED';

export type Severity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DeptQueueStats {
  departmentCode: string;
  activeCount: number;
  waitingCount: number; // active and not paused
  pausedCount: number;
  queueOrder: string[]; // stage instance ids, oldest first (not paused)
  completedLast7Days: number;
  throughputPerDay: number;
}

const REASON_LABEL: Record<StuckReason, string> = {
  ON_TRACK: 'On track',
  IN_REVIEW: 'Being reviewed',
  WAITING_ON_CITIZEN: 'Waiting for applicant documents',
  RETURNED_FOR_CORRECTION: 'Returned to applicant for correction',
  ADMIN_HOLD: 'On administrative hold',
  EXTERNAL_DEPENDENCY: 'Waiting on another agency',
  DEPARTMENT_BACKLOG: 'Department backlog',
  UNASSIGNED: 'Not yet picked up by an officer',
  OFFICER_IDLE: 'No officer activity',
  SLOW_PROCESSING: 'Review taking longer than target',
  COMPLETED: 'Completed',
  REJECTED: 'Closed (rejected)',
};

const RESPONSIBLE: Record<StuckReason, 'CITIZEN' | 'DEPARTMENT' | 'OFFICER' | 'EXTERNAL' | 'NONE'> = {
  ON_TRACK: 'NONE',
  IN_REVIEW: 'NONE',
  WAITING_ON_CITIZEN: 'CITIZEN',
  RETURNED_FOR_CORRECTION: 'CITIZEN',
  ADMIN_HOLD: 'DEPARTMENT',
  EXTERNAL_DEPENDENCY: 'EXTERNAL',
  DEPARTMENT_BACKLOG: 'DEPARTMENT',
  UNASSIGNED: 'DEPARTMENT',
  OFFICER_IDLE: 'OFFICER',
  SLOW_PROCESSING: 'OFFICER',
  COMPLETED: 'NONE',
  REJECTED: 'NONE',
};

const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '-';

const fmtDur = (hours: number) => (hours >= 48 ? `${round1(hours / 24)} days` : `${Math.round(hours)} hours`);

export const APPLICATION_DIAGNOSIS_INCLUDE = {
  service: { include: { stages: { orderBy: { orderIndex: 'asc' as const }, include: { department: true } } } },
  stageInstances: {
    include: {
      stage: { include: { department: true } },
      assignedOfficer: { select: { id: true, name: true } },
      documentRequests: true,
    },
  },
};

export class DiagnosisService {
  /** Live queue statistics for every department (one pass over active stages). */
  static async getQueueStats(now: Date = Clock.now()): Promise<Map<string, DeptQueueStats>> {
    const [active, completed] = await Promise.all([
      prisma.applicationStageInstance.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, startedAt: true, pausedAt: true, stage: { select: { departmentCode: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      prisma.applicationStageInstance.findMany({
        where: { status: 'COMPLETED', completedAt: { gte: new Date(now.getTime() - 7 * DAY_MS), lte: now } },
        select: { stage: { select: { departmentCode: true } } },
      }),
    ]);

    const map = new Map<string, DeptQueueStats>();
    const get = (code: string) => {
      let s = map.get(code);
      if (!s) {
        s = { departmentCode: code, activeCount: 0, waitingCount: 0, pausedCount: 0, queueOrder: [], completedLast7Days: 0, throughputPerDay: 0 };
        map.set(code, s);
      }
      return s;
    };

    for (const inst of active) {
      const s = get(inst.stage.departmentCode);
      s.activeCount++;
      if (inst.pausedAt) s.pausedCount++;
      else {
        s.waitingCount++;
        s.queueOrder.push(inst.id);
      }
    }
    for (const c of completed) get(c.stage.departmentCode).completedLast7Days++;
    for (const s of map.values()) s.throughputPerDay = round1(s.completedLast7Days / 7);
    return map;
  }

  static diagnose(app: any, queueStats: Map<string, DeptQueueStats>, now: Date = Clock.now(), audience: 'CITIZEN' | 'STAFF' = 'STAFF') {
    const stages: any[] = (app.service?.stages || []).filter((s: any) => s.isActive !== false || app.stageInstances?.some((i: any) => i.stageId === s.id));
    const instByStage = new Map<string, any>((app.stageInstances || []).map((i: any) => [i.stageId, i]));
    const current = (app.stageInstances || []).find((i: any) => i.status === 'ACTIVE');

    const pipeline = stages.map((s: any) => {
      const inst = instByStage.get(s.id);
      const sla = inst?.startedAt ? SlaService.calculateStageSla(inst, now) : null;
      return {
        stageName: s.name,
        departmentCode: s.departmentCode,
        departmentName: s.department?.name || s.departmentCode,
        state: !inst ? 'UPCOMING' : inst.status === 'ACTIVE' ? 'CURRENT' : 'DONE',
        targetHours: s.slaHours,
        startedAt: inst?.startedAt ?? null,
        completedAt: inst?.completedAt ?? null,
        activeHours: sla ? round1(sla.elapsedActiveSeconds / 3600) : 0,
        pausedHours: sla ? round1(sla.pausedSeconds / 3600) : 0,
        breached: !!inst?.breachedAt || !!sla?.isBreached,
      };
    });

    const base = {
      applicationId: app.id,
      trackingNumber: app.trackingNumber,
      serviceName: app.service?.name,
      status: app.status,
      slaStatus: app.slaStatus,
      pipeline,
      diagnosedAt: now,
    };

    if (app.status === 'COMPLETED' || app.status === 'REJECTED' || !current) {
      const reason: StuckReason = app.status === 'REJECTED' ? 'REJECTED' : 'COMPLETED';
      return {
        ...base,
        reasonCode: reason,
        reasonLabel: REASON_LABEL[reason],
        responsibleParty: 'NONE' as const,
        isStuck: false,
        severity: 'NONE' as Severity,
        location: null,
        timing: null,
        queue: null,
        pendingDocuments: [],
        headline: reason === 'COMPLETED' ? 'Application completed' : 'Application closed',
        citizenMessage:
          reason === 'COMPLETED'
            ? `Your application ${app.trackingNumber} has been completed.`
            : `Your application ${app.trackingNumber} was closed. Check the decision letter for details.`,
        officerMessage: REASON_LABEL[reason],
        recommendedAction: null,
      };
    }

    const stage = current.stage;
    const deptName = stage.department?.name || stage.departmentCode;
    const sla = SlaService.calculateStageSla(current, now);
    const slaHours = stage.slaHours as number;
    const lastActivity = current.lastActivityAt || current.assignedAt || current.startedAt;
    const idleHours = lastActivity ? (now.getTime() - new Date(lastActivity).getTime()) / 3_600_000 : 0;
    const idleThreshold = Math.max(4, Math.min(env.STUCK_IDLE_HOURS, slaHours * 0.3));
    const pendingDocs = (current.documentRequests || []).filter((r: any) => r.status === 'PENDING');

    const qs = queueStats.get(stage.departmentCode);
    const pos = qs ? qs.queueOrder.indexOf(current.id) : -1;
    const queueAhead = pos >= 0 ? pos : 0;
    const throughput = qs?.throughputPerDay ?? 0;
    const remainingHours = sla.remainingSeconds / 3600;
    const hoursToClearAhead = throughput > 0 ? (queueAhead / throughput) * 24 : queueAhead > 0 ? Infinity : 0;
    const backlogPressure = queueAhead >= 3 && hoursToClearAhead > Math.max(remainingHours, slaHours * 0.5);

    const stageBreached = sla.isBreached || !!current.breachedAt;
    let reason: StuckReason;

    if (current.pausedAt) {
      if (current.holdType === 'CORRECTION') reason = 'RETURNED_FOR_CORRECTION';
      else if (current.holdType === 'ADMIN_HOLD') reason = 'ADMIN_HOLD';
      else if (current.holdType === 'EXTERNAL') reason = 'EXTERNAL_DEPENDENCY';
      else reason = 'WAITING_ON_CITIZEN';
    } else if (sla.status === 'BREACHED' || sla.status === 'AT_RISK' || idleHours > idleThreshold) {
      if (backlogPressure) reason = 'DEPARTMENT_BACKLOG';
      else if (!current.assignedOfficerId) reason = 'UNASSIGNED';
      else if (idleHours > idleThreshold) reason = 'OFFICER_IDLE';
      else reason = 'SLOW_PROCESSING';
    } else if (backlogPressure) {
      reason = 'DEPARTMENT_BACKLOG';
    } else {
      reason = current.assignedOfficerId ? 'IN_REVIEW' : 'ON_TRACK';
    }

    const isStuck = !['ON_TRACK', 'IN_REVIEW'].includes(reason) || stageBreached;
    let severity: Severity = 'NONE';
    if (stageBreached && !current.pausedAt) severity = 'CRITICAL';
    else if (sla.status === 'AT_RISK') severity = 'HIGH';
    else if (['DEPARTMENT_BACKLOG', 'UNASSIGNED', 'OFFICER_IDLE', 'SLOW_PROCESSING', 'ADMIN_HOLD'].includes(reason)) severity = 'MEDIUM';
    else if (isStuck) severity = 'LOW';

    const since = current.startedAt;
    const overdueHours = sla.overdueSeconds / 3600;
    const lateText = overdueHours > 0 ? ` It is ${fmtDur(overdueHours)} past the ${fmtDur(slaHours)} target and has been escalated.` : '';
    const waitingDocs = pendingDocs.map((r: any) => ({
      title: r.title,
      documentType: r.documentType,
      requestedAt: r.requestedAt,
      waitingHours: round1((now.getTime() - new Date(r.requestedAt).getTime()) / 3_600_000),
    }));

    let citizenMessage = '';
    let officerMessage = '';
    let recommendedAction: string | null = null;

    switch (reason) {
      case 'WAITING_ON_CITIZEN':
        citizenMessage = `Your file is with ${deptName} ("${stage.name}") and is waiting for you to upload: ${waitingDocs.map((d: any) => `"${d.title}"`).join(', ') || 'requested documents'}. The waiting time is not counted against the department.`;
        officerMessage = `Paused for applicant documents (${waitingDocs.length} pending, oldest ${fmtDur(Math.max(0, ...waitingDocs.map((d: any) => d.waitingHours)))}).`;
        recommendedAction = 'Send a reminder to the applicant';
        break;
      case 'RETURNED_FOR_CORRECTION':
        citizenMessage = `${deptName} returned your application for a correction: ${current.holdReason || 'see notice'}. Please correct and resubmit.`;
        officerMessage = `Returned to applicant for correction: ${current.holdReason || '-'}.`;
        recommendedAction = 'Await applicant resubmission';
        break;
      case 'ADMIN_HOLD':
        citizenMessage = `Your file is on hold at ${deptName}. Reason: ${current.holdReason || 'administrative review'}. The hold time is not counted as delay.`;
        officerMessage = `On administrative hold for ${fmtDur((now.getTime() - new Date(current.pausedAt).getTime()) / 3_600_000)}: ${current.holdReason || '-'}.`;
        recommendedAction = 'Review whether the hold is still required';
        break;
      case 'EXTERNAL_DEPENDENCY':
        citizenMessage = `Your file at ${deptName} is waiting for information from another agency.`;
        officerMessage = `Waiting on external agency: ${current.holdReason || '-'}.`;
        recommendedAction = 'Follow up with the external agency';
        break;
      case 'DEPARTMENT_BACKLOG':
        citizenMessage = `Your file is with ${deptName} ("${stage.name}") since ${fmtDate(since)}. It is in a queue: ${queueAhead} file(s) are ahead of it and the department is completing about ${throughput} per day.${lateText}`;
        officerMessage = `Queue position ${queueAhead + 1} of ${qs?.waitingCount ?? '?'} in ${stage.departmentCode}; throughput ${throughput}/day; ~${Number.isFinite(hoursToClearAhead) ? fmtDur(hoursToClearAhead) : 'unknown time'} to clear files ahead.`;
        recommendedAction = 'Add officers to this department or re-prioritise overdue files';
        break;
      case 'UNASSIGNED':
        citizenMessage = `Your file reached ${deptName} on ${fmtDate(since)} but has not yet been picked up by an officer.${lateText}`;
        officerMessage = `Unassigned for ${fmtDur(idleHours)} at ${stage.name}.`;
        recommendedAction = 'Assign an officer';
        break;
      case 'OFFICER_IDLE':
        citizenMessage = `Your file is with ${deptName} ("${stage.name}"). There has been no progress recently.${lateText}`;
        officerMessage = `Assigned to ${current.assignedOfficer?.name || 'an officer'} but no activity for ${fmtDur(idleHours)}.`;
        recommendedAction = 'Follow up with the assigned officer or reassign';
        break;
      case 'SLOW_PROCESSING':
        citizenMessage = `Your file is being reviewed by ${deptName} ("${stage.name}"), but it is taking longer than the target.${lateText}`;
        officerMessage = `Under active review but ${sla.status === 'BREACHED' ? `${fmtDur(overdueHours)} overdue` : `${fmtDur(remainingHours)} left`}.`;
        recommendedAction = 'Prioritise completion of this review';
        break;
      default:
        citizenMessage = `Your file is with ${deptName} ("${stage.name}"). Expected to finish this step by ${fmtDate(sla.slaDeadline)}.`;
        officerMessage = `${reason === 'IN_REVIEW' ? 'Under review' : 'Waiting for pickup'}; ${fmtDur(remainingHours)} left.`;
    }

    const stageNo = stages.findIndex((s: any) => s.id === current.stageId) + 1;
    const result = {
      ...base,
      reasonCode: reason,
      reasonLabel: REASON_LABEL[reason],
      responsibleParty: RESPONSIBLE[reason],
      isStuck,
      severity,
      headline: `${REASON_LABEL[reason]} at ${deptName}`,
      location: {
        stageName: stage.name,
        stageNumber: stageNo,
        totalStages: stages.length,
        departmentCode: stage.departmentCode,
        departmentName: deptName,
        since,
        assignedOfficer: audience === 'STAFF' ? current.assignedOfficer?.name ?? null : undefined,
      },
      timing: {
        targetHours: slaHours,
        activeHours: round1(sla.elapsedActiveSeconds / 3600),
        pausedHours: round1(sla.pausedSeconds / 3600),
        remainingHours: round1(remainingHours),
        overdueHours: round1(overdueHours),
        deadline: sla.slaDeadline,
        idleHours: round1(idleHours),
        slaStatus: sla.status,
        stageBreached,
      },
      queue: {
        position: pos >= 0 ? pos + 1 : null,
        waitingInDepartment: qs?.waitingCount ?? 0,
        throughputPerDay: throughput,
        estimatedHoursToClearAhead: Number.isFinite(hoursToClearAhead) ? round1(hoursToClearAhead) : null,
      },
      pendingDocuments: waitingDocs,
      citizenMessage,
      officerMessage: audience === 'STAFF' ? officerMessage : undefined,
      recommendedAction: audience === 'STAFF' ? recommendedAction : undefined,
    };
    return result;
  }

  static async diagnoseById(applicationId: string, audience: 'CITIZEN' | 'STAFF' = 'STAFF') {
    const now = Clock.now();
    const [app, stats] = await Promise.all([
      prisma.application.findUnique({ where: { id: applicationId }, include: APPLICATION_DIAGNOSIS_INCLUDE }),
      this.getQueueStats(now),
    ]);
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);
    return this.diagnose(app, stats, now, audience);
  }

  /** All active applications with a diagnosis, most urgent first. */
  static async diagnoseActive(filter: { departmentCode?: string; onlyStuck?: boolean; includeSimulated?: boolean } = {}) {
    const now = Clock.now();
    const where: any = { status: { in: ['IN_PROGRESS', 'ON_HOLD', 'CREATED'] } };
    if (filter.departmentCode) where.currentStage = { departmentCode: filter.departmentCode };
    if (filter.includeSimulated === false) where.isSimulated = false;

    const [apps, stats] = await Promise.all([
      prisma.application.findMany({ where, include: APPLICATION_DIAGNOSIS_INCLUDE }),
      this.getQueueStats(now),
    ]);

    const rank: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };
    return apps
      .map(a => ({ app: a, d: this.diagnose(a, stats, now, 'STAFF') }))
      .filter(x => !filter.onlyStuck || x.d.isStuck)
      .sort((x, y) => {
        const s = rank[y.d.severity] - rank[x.d.severity];
        if (s !== 0) return s;
        return (y.d.timing?.overdueHours ?? 0) - (x.d.timing?.overdueHours ?? 0) || (y.d.timing?.idleHours ?? 0) - (x.d.timing?.idleHours ?? 0);
      })
      .map(x => ({
        id: x.app.id,
        trackingNumber: x.app.trackingNumber,
        applicantName: x.app.applicantName,
        isSimulated: x.app.isSimulated,
        diagnosis: x.d,
      }));
  }

  /** Persist the latest reason code (used by the watchdog so lists can filter on it). */
  static async persistReason(applicationId: string, reason: string) {
    await prisma.application.updateMany({
      // Prisma's `not` excludes NULLs, so match "never set" explicitly
      where: { id: applicationId, OR: [{ stuckReasonCode: null }, { stuckReasonCode: { not: reason } }] },
      data: { stuckReasonCode: reason },
    });
  }

  /** Citizen-safe, plain-language timeline (no officer identities or internal remarks). */
  static publicTimeline(
    events: Array<{ eventType: string; createdAt: Date; metadataJson: string; stageId: string | null }>,
    deptNames: Map<string, string>
  ) {
    const out: Array<{ at: Date; text: string; kind: string }> = [];
    for (const e of events) {
      const m = safeJsonParse<any>(e.metadataJson, {});
      const dept = (code?: string) => (code ? deptNames.get(code) || code : 'the department');
      let text: string | null = null;
      switch (e.eventType) {
        case 'APPLICATION_CREATED': text = 'Application submitted'; break;
        case 'STAGE_ENTERED': text = `Reached ${dept(m.department || m.departmentCode)} for "${m.stageName}"`; break;
        case 'STAGE_ASSIGNED': text = 'An officer started working on your file'; break;
        case 'STAGE_COMPLETED': text = `"${m.stageName}" completed`; break;
        case 'DOCUMENT_REQUESTED': text = `Document requested from you: ${m.title}`; break;
        case 'DOCUMENT_SUBMITTED': text = `Document received: ${m.title}`; break;
        case 'DOCUMENT_REMINDER_SENT': text = `Reminder sent for: ${m.title}`; break;
        case 'SLA_PAUSED': text = m.holdType === 'CITIZEN_DOCS' ? 'Paused while waiting for your document (time not counted)' : 'Put on hold (time not counted)'; break;
        case 'SLA_RESUMED': text = 'Processing resumed'; break;
        case 'SLA_WARNING': text = 'Close to the target date - office alerted'; break;
        case 'SLA_BREACHED': text = `Target time exceeded at ${dept(m.department)} - escalated to a senior officer`; break;
        case 'APPLICATION_RETURNED': text = 'Returned to you for correction'; break;
        case 'APPLICATION_RESUBMITTED': text = 'You resubmitted the application'; break;
        case 'COMPENSATION_ELIGIBLE': text = `Eligible for delay compensation (₹${m.amount})`; break;
        case 'APPLICATION_APPROVED': text = 'Application approved'; break;
        case 'APPLICATION_REJECTED': text = 'Application not approved'; break;
      }
      if (text) out.push({ at: e.createdAt, text, kind: e.eventType });
    }
    return out;
  }
}
