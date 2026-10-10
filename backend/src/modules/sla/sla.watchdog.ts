import { prisma } from '../../db/client.js';
import { env } from '../../config/env.js';
import { Clock, HOUR_MS } from '../../common/clock.js';
import { SlaService } from './sla.service.js';
import { DiagnosisService, APPLICATION_DIAGNOSIS_INCLUDE } from '../diagnosis/diagnosis.service.js';
import { EventService } from '../events/event.service.js';
import { NotificationService } from '../notifications/notification.service.js';

export interface WatchdogScanReport {
  mode: 'LIVE' | 'PROJECTION';
  scannedCount: number;
  onTrackCount: number;
  atRiskCount: number;
  breachedCount: number;
  pausedCount: number;
  newlyBreached: string[];
  newlyAtRisk: string[];
  remindersSent: number;
  stuckInactive: Array<{
    applicationId: string;
    trackingNumber: string;
    stageName: string;
    departmentCode: string;
    daysInactive: number;
    reasonCode: string;
    delayType: 'APPLICANT_PENDING_DOCS' | 'DEPARTMENTAL_BACKLOG';
  }>;
  scannedAt: string;
}

const ACTIVE_STATUSES = ['IN_PROGRESS', 'ON_HOLD', 'CREATED'];

export class SlaWatchdog {
  private static timer: NodeJS.Timeout | null = null;
  private static intervalMs = 0;
  private static isScanning = false;
  private static lastReport: WatchdogScanReport | null = null;
  private static lastError: string | null = null;

  /**
   * LIVE scan (default): refreshes and persists SLA state at the current (virtual) time, latches
   * breaches, sends document reminders and stores the diagnosis reason of every active file.
   *
   * PROJECTION scan (referenceTime given): answers "what would be breached at time T?" without
   * writing anything, so supervisors can look ahead without corrupting real state.
   */
  static async scanAllActiveApplications(referenceTime?: Date): Promise<WatchdogScanReport> {
    const projection = !!referenceTime;
    const now = referenceTime ?? Clock.now();
    const empty: WatchdogScanReport = {
      mode: projection ? 'PROJECTION' : 'LIVE',
      scannedCount: 0,
      onTrackCount: 0,
      atRiskCount: 0,
      breachedCount: 0,
      pausedCount: 0,
      newlyBreached: [],
      newlyAtRisk: [],
      remindersSent: 0,
      stuckInactive: [],
      scannedAt: now.toISOString(),
    };
    if (!projection && this.isScanning) return empty;

    if (!projection) this.isScanning = true;
    try {
      const apps = await prisma.application.findMany({
        where: { status: { in: ACTIVE_STATUSES } },
        include: APPLICATION_DIAGNOSIS_INCLUDE,
      });
      const report = { ...empty, scannedCount: apps.length };
      const queueStats = await DiagnosisService.getQueueStats(now);

      for (const app of apps) {
        const active = app.stageInstances.find(i => i.status === 'ACTIVE');
        if (!active) continue;

        let status: string;
        if (projection) {
          const m = SlaService.calculateStageSla(active, now);
          status = m.status;
          if (m.status === 'BREACHED' && !active.breachedAt) report.newlyBreached.push(app.trackingNumber);
          else if (m.status === 'AT_RISK' && !active.atRiskAt) report.newlyAtRisk.push(app.trackingNumber);
        } else {
          const hadBreach = !!active.breachedAt;
          const hadRisk = !!active.atRiskAt;
          const m = await SlaService.refreshApplicationSla(app.id, now);
          status = m?.status ?? app.slaStatus;
          if (m?.status === 'BREACHED' && !hadBreach) report.newlyBreached.push(app.trackingNumber);
          else if (m?.status === 'AT_RISK' && !hadRisk) report.newlyAtRisk.push(app.trackingNumber);
        }

        if (status === 'ON_TRACK') report.onTrackCount++;
        else if (status === 'AT_RISK') report.atRiskCount++;
        else if (status === 'BREACHED') report.breachedCount++;
        else if (status === 'PAUSED') report.pausedCount++;

        const diag = DiagnosisService.diagnose(app, queueStats, now);
        if (!projection) {
          await DiagnosisService.persistReason(app.id, diag.reasonCode);
          report.remindersSent += await this.sendDocumentReminders(app, active, now);
        }

        const lastActivity = active.lastActivityAt || active.startedAt || app.createdAt;
        const daysInactive = Math.floor((now.getTime() - new Date(lastActivity).getTime()) / (24 * HOUR_MS));
        if (daysInactive >= 3 || diag.severity === 'CRITICAL') {
          report.stuckInactive.push({
            applicationId: app.id,
            trackingNumber: app.trackingNumber,
            stageName: active.stage.name,
            departmentCode: active.stage.departmentCode,
            daysInactive: Math.max(0, daysInactive),
            reasonCode: diag.reasonCode,
            delayType: diag.responsibleParty === 'CITIZEN' ? 'APPLICANT_PENDING_DOCS' : 'DEPARTMENTAL_BACKLOG',
          });
        }
      }

      if (!projection) {
        this.lastReport = report;
        this.lastError = null;
      }
      return report;
    } finally {
      if (!projection) this.isScanning = false;
    }
  }

  /** Remind the citizen about each pending document request every DOC_REMINDER_HOURS. */
  private static async sendDocumentReminders(app: any, active: any, now: Date): Promise<number> {
    let sent = 0;
    const thresholdMs = env.DOC_REMINDER_HOURS * HOUR_MS;
    for (const req of active.documentRequests.filter((r: any) => r.status === 'PENDING')) {
      const last = new Date(req.lastReminderAt || req.requestedAt).getTime();
      if (now.getTime() - last < thresholdMs) continue;
      await prisma.documentRequest.update({ where: { id: req.id }, data: { lastReminderAt: now } });
      await EventService.recordEvent({
        applicationId: app.id,
        stageId: active.stageId,
        eventType: 'DOCUMENT_REMINDER_SENT',
        actorRole: 'SYSTEM',
        metadata: { requestId: req.id, title: req.title },
      });
      await NotificationService.notify('DOCUMENT_REMINDER', {
        recipientUserId: app.citizenId,
        applicationId: app.id,
        vars: {
          trackingNumber: app.trackingNumber,
          documentTitle: req.title,
          departmentName: active.stage.department?.name || active.stage.departmentCode,
        },
      });
      sent++;
    }
    return sent;
  }

  static startWatchdog(intervalMs = env.SLA_WATCHDOG_INTERVAL_MS) {
    if (this.timer) return;
    this.intervalMs = intervalMs;
    this.timer = setInterval(async () => {
      try {
        await this.scanAllActiveApplications();
      } catch (err: any) {
        this.lastError = err?.message || String(err);
        console.error('SLA Watchdog scan cycle encountered error:', err);
      }
    }, intervalMs);
    this.timer.unref();
  }

  static stopWatchdog() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  static getStatus() {
    return {
      status: this.timer ? 'ACTIVE' : 'STOPPED',
      daemon: 'SlaWatchdog In-Process Worker',
      intervalMs: this.timer ? this.intervalMs : null,
      isScanning: this.isScanning,
      lastScanAt: this.lastReport?.scannedAt ?? null,
      lastReport: this.lastReport
        ? {
            scannedCount: this.lastReport.scannedCount,
            breachedCount: this.lastReport.breachedCount,
            atRiskCount: this.lastReport.atRiskCount,
            newlyBreached: this.lastReport.newlyBreached.length,
            remindersSent: this.lastReport.remindersSent,
          }
        : null,
      lastError: this.lastError,
      serverNow: Clock.now().toISOString(),
    };
  }
}
