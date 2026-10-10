import crypto from 'crypto';
import { prisma } from '../../db/client.js';
import { Clock, HOUR_MS, DAY_MS } from '../../common/clock.js';
import { AppError, ConflictError, NotFoundError } from '../../common/errors.js';
import { ChecklistGate } from '../../common/checklist.js';
import type { AuthUser, Role } from '../../common/middleware.js';
import { REGISTERED_SERVICES } from '../../config/workflowConfig.js';
import { ApplicationService } from '../applications/application.service.js';
import { WorkflowService } from '../workflow/workflow.service.js';
import { DocumentService } from '../documents/document.service.js';
import { SlaWatchdog } from '../sla/sla.watchdog.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import { Rng } from './rng.js';
import { SCENARIOS, profileFor, type DepartmentProfile, type ScenarioDefinition } from './scenarios.js';
import { STORIES, type StoryDefinition } from './stories.js';

const SIM_DOMAIN = 'sim.doctrail.local';
const SIM_PASSWORD_HASH = '!sim-account-cannot-login';
const CITIZEN_POOL = 24;

type Outcome = 'ADVANCE' | 'REQUEST_DOC' | 'REJECT';

interface PlannedWork {
  instanceId: string;
  applicationId: string;
  departmentCode: string;
  officerId: string;
  readyAtMs: number;
  outcome: Outcome;
}

interface CitizenReply {
  requestId: string;
  applicationId: string;
  citizenId: string;
  respondAtMs: number | null; // null = never responds
  title: string;
  documentType: string;
}

interface EngineState {
  scenarioKey: string | null;
  seed: number;
  rngState: number;
  scenarioStartMs: number | null;
  arrivalsPerDay: Record<string, number>;
  profileOverrides: Record<string, Partial<DepartmentProfile>>;
  disruptions: ScenarioDefinition['disruptions'];
  work: PlannedWork[];
  replies: CitizenReply[];
  docRequestedInstances: string[];
  lastScanMs: number | null;
  stats: { created: number; forwarded: number; completed: number; rejected: number; docRequests: number; uploads: number; errors: number };
  story: { key: string; applicationId: string | null; cursor: number; citizenId: string } | null;
}

const emptyState = (): EngineState => ({
  scenarioKey: null,
  seed: 1,
  rngState: 1,
  scenarioStartMs: null,
  arrivalsPerDay: {},
  profileOverrides: {},
  disruptions: [],
  work: [],
  replies: [],
  docRequestedInstances: [],
  lastScanMs: null,
  stats: { created: 0, forwarded: 0, completed: 0, rejected: 0, docRequests: 0, uploads: 0, errors: 0 },
  story: null,
});

/**
 * Simulation engine. It never writes fake rows: it moves the virtual clock and calls the real
 * Application / Workflow / Document services as virtual officers and citizens, so every event,
 * SLA transition, notification, escalation and compensation claim is produced by production code.
 */
export class SimulationService {
  private static busy = false;

  // ------------------------------------------------------------------ state

  private static async loadState(): Promise<EngineState> {
    const row = await prisma.simulationState.findUnique({ where: { id: 'singleton' } });
    try {
      return { ...emptyState(), ...(row ? JSON.parse(row.stateJson) : {}) };
    } catch {
      return emptyState();
    }
  }

  private static async saveState(state: EngineState) {
    await prisma.simulationState.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', clockOffsetMs: Clock.getOffsetMs(), scenarioKey: state.scenarioKey, stateJson: JSON.stringify(state) },
      update: { scenarioKey: state.scenarioKey, stateJson: JSON.stringify(state) },
    });
  }

  private static async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new ConflictError('A simulation step is already running');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ actors

  private static async ensureSimOfficer(departmentCode: string): Promise<AuthUser> {
    const email = `sim.officer.${departmentCode.toLowerCase()}@${SIM_DOMAIN}`;
    let user = await prisma.user.findUnique({ where: { email }, include: { department: true } });
    if (!user) {
      const dept = await prisma.department.findUnique({ where: { code: departmentCode } });
      if (!dept) throw new AppError(`Department ${departmentCode} does not exist`, 400);
      user = await prisma.user.create({
        data: { email, passwordHash: SIM_PASSWORD_HASH, name: `Sim Officer (${dept.name})`, role: 'OFFICER', departmentId: dept.id, badgeNumber: `SIM-${departmentCode}` },
        include: { department: true },
      });
    }
    return this.toActor(user);
  }

  /** Prefer a real seeded officer (so stories show up in the officer portal), else a virtual one. */
  private static async officerFor(departmentCode: string, preferReal: boolean): Promise<AuthUser> {
    if (preferReal) {
      const real = await prisma.user.findFirst({
        where: { role: 'OFFICER', department: { code: departmentCode }, NOT: { email: { endsWith: `@${SIM_DOMAIN}` } } },
        include: { department: true },
        orderBy: { createdAt: 'asc' },
      });
      if (real) return this.toActor(real);
    }
    return this.ensureSimOfficer(departmentCode);
  }

  private static async ensureCitizenPool(): Promise<AuthUser[]> {
    const existing = await prisma.user.findMany({ where: { role: 'CITIZEN', email: { endsWith: `@${SIM_DOMAIN}` } } });
    const firstNames = ['Aditi', 'Rahul', 'Sneha', 'Vikram', 'Pooja', 'Arjun', 'Neha', 'Karan', 'Divya', 'Sanjay', 'Ananya', 'Manoj'];
    const lastNames = ['Patel', 'Singh', 'Iyer', 'Khan', 'Das', 'Reddy', 'Joshi', 'Mehta'];
    for (let i = existing.length; i < CITIZEN_POOL; i++) {
      const name = `${firstNames[i % firstNames.length]} ${lastNames[(i * 7) % lastNames.length]}`;
      existing.push(
        await prisma.user.create({
          data: {
            email: `sim.citizen.${i + 1}@${SIM_DOMAIN}`,
            passwordHash: SIM_PASSWORD_HASH,
            name,
            role: 'CITIZEN',
            phone: `+91 9${String(800000000 + i * 7919).slice(0, 9)}`,
          },
        })
      );
    }
    return existing.map(u => this.toActor(u));
  }

  private static toActor(u: any): AuthUser {
    return { id: u.id, email: u.email, name: u.name, role: u.role as Role, departmentId: u.departmentId, departmentCode: u.department?.code ?? null };
  }

  // ------------------------------------------------------------------ clock

  static async getClock() {
    return { now: Clock.now(), offsetMs: Clock.getOffsetMs(), offsetHours: Math.round((Clock.getOffsetMs() / HOUR_MS) * 10) / 10 };
  }

  /** Jump the clock forward and let the watchdog catch up (breaches, reminders, reasons). */
  static async advanceClock(hours: number) {
    if (!(hours > 0) || hours > 24 * 60) throw new AppError('hours must be between 0 and 1440', 400);
    return this.exclusive(async () => {
      await Clock.advance(hours * HOUR_MS);
      const scan = await SlaWatchdog.scanAllActiveApplications();
      return { clock: await this.getClock(), scan };
    });
  }

  static async resetClock() {
    await Clock.reset();
    return this.getClock();
  }

  // ------------------------------------------------------------------ stochastic scenarios

  static listScenarios() {
    return Object.values(SCENARIOS).map(s => ({
      key: s.key,
      title: s.title,
      description: s.description,
      defaultDays: s.defaultDays,
      arrivalsPerDay: s.arrivalsPerDay,
      disruptions: s.disruptions ?? [],
      expectedOutcome: s.expectedOutcome,
    }));
  }

  /** Start a scenario (does not advance time). */
  static async startScenario(key: string, opts: { seed?: number } = {}) {
    const def = SCENARIOS[key];
    if (!def) throw new NotFoundError(`Unknown scenario ${key}`);
    await this.ensureCitizenPool();
    const state = await this.loadState();
    const seed = opts.seed ?? crypto.randomInt(1, 2 ** 31);
    Object.assign(state, {
      scenarioKey: key,
      seed,
      rngState: new Rng(seed).getState(),
      scenarioStartMs: Clock.nowMs(),
      arrivalsPerDay: def.arrivalsPerDay,
      profileOverrides: def.profileOverrides ?? {},
      disruptions: def.disruptions ?? [],
      work: [],
      replies: [],
      docRequestedInstances: [],
      lastScanMs: Clock.nowMs(),
      stats: emptyState().stats,
    });
    await this.saveState(state);
    return { scenario: def.key, seed, startedAt: Clock.now() };
  }

  /** Advance the running scenario by `hours` of simulated time in `tickHours` increments. */
  static async step(hours: number, tickHours = 2) {
    if (!(hours > 0) || hours > 24 * 60) throw new AppError('hours must be between 0 and 1440', 400);
    const tick = Math.min(12, Math.max(0.5, tickHours));
    return this.exclusive(async () => {
      const state = await this.loadState();
      if (!state.scenarioKey) throw new ConflictError('No scenario running. Start one with POST /api/sim/scenarios/:key/start');
      const rng = Rng.fromState(state.rngState);
      const citizens = await this.ensureCitizenPool();

      let remaining = hours;
      while (remaining > 1e-9) {
        const dt = Math.min(tick, remaining);
        remaining -= dt;
        await Clock.advance(dt * HOUR_MS);
        await this.tick(state, rng, citizens, dt);
        if (Clock.nowMs() - (state.lastScanMs ?? 0) >= 6 * HOUR_MS || remaining <= 1e-9) {
          await SlaWatchdog.scanAllActiveApplications();
          state.lastScanMs = Clock.nowMs();
        }
      }

      state.rngState = rng.getState();
      await this.saveState(state);
      return this.summary(state);
    });
  }

  /** Start + run a scenario for N days in one call. */
  static async runScenario(key: string, opts: { days?: number; tickHours?: number; seed?: number } = {}) {
    const def = SCENARIOS[key];
    if (!def) throw new NotFoundError(`Unknown scenario ${key}`);
    await this.startScenario(key, { seed: opts.seed });
    return this.step((opts.days ?? def.defaultDays) * 24, opts.tickHours ?? 2);
  }

  private static officersAt(state: EngineState, departmentCode: string, profile: DepartmentProfile): number {
    const hoursIn = state.scenarioStartMs ? (Clock.nowMs() - state.scenarioStartMs) / HOUR_MS : 0;
    let mult = 1;
    for (const d of state.disruptions ?? []) {
      if (d.departmentCode === departmentCode && hoursIn >= d.fromHour && hoursIn < d.toHour) mult *= d.officersMultiplier;
    }
    // capacity in concurrent file slots
    return Math.max(0, Math.round(profile.officers * mult)) * profile.parallelFilesPerOfficer;
  }

  private static async tick(state: EngineState, rng: Rng, citizens: AuthUser[], dtHours: number) {
    const nowMs = Clock.nowMs();

    // 1. Arrivals (Poisson per service)
    for (const [serviceKey, perDay] of Object.entries(state.arrivalsPerDay)) {
      const n = rng.poisson((perDay * dtHours) / 24);
      for (let i = 0; i < n; i++) {
        const citizen = rng.pick(citizens);
        try {
          await ApplicationService.createApplication(
            citizen,
            { serviceKey, applicantName: citizen.name, applicantDetails: { source: 'simulation', scenario: state.scenarioKey } },
            { isSimulated: true }
          );
          state.stats.created++;
        } catch {
          state.stats.errors++;
        }
      }
    }

    // 2. Citizens reply to document requests that are due
    const dueReplies = state.replies.filter(r => r.respondAtMs !== null && r.respondAtMs <= nowMs);
    state.replies = state.replies.filter(r => !(r.respondAtMs !== null && r.respondAtMs <= nowMs));
    for (const r of dueReplies) {
      const citizen = citizens.find(c => c.id === r.citizenId);
      if (!citizen) continue;
      try {
        await DocumentService.uploadDocument({
          applicationId: r.applicationId,
          documentRequestId: r.requestId,
          documentType: r.documentType,
          title: r.title,
          fileUrl: `sim://documents/${r.requestId}.pdf`,
          actor: citizen,
        });
        state.stats.uploads++;
      } catch {
        state.stats.errors++;
      }
    }

    // 3. Officers finish work that is due
    const due = state.work.filter(w => w.readyAtMs <= nowMs);
    state.work = state.work.filter(w => w.readyAtMs > nowMs);
    for (const w of due) await this.complete(state, rng, w);

    // 4. Idle officers pick up the next waiting files (FIFO per department)
    const waiting = await prisma.applicationStageInstance.findMany({
      where: { status: 'ACTIVE', pausedAt: null, application: { isSimulated: true } },
      select: { id: true, applicationId: true, stage: { select: { departmentCode: true } } },
      orderBy: { startedAt: 'asc' },
    });
    const inService = new Map<string, number>();
    for (const w of state.work) inService.set(w.departmentCode, (inService.get(w.departmentCode) ?? 0) + 1);
    const busyIds = new Set(state.work.map(w => w.instanceId));

    for (const inst of waiting) {
      if (busyIds.has(inst.id)) continue;
      const dept = inst.stage.departmentCode;
      const profile = profileFor(dept, state.profileOverrides);
      const capacity = this.officersAt(state, dept, profile);
      if ((inService.get(dept) ?? 0) >= capacity) continue;

      const officer = await this.ensureSimOfficer(dept);
      try {
        await WorkflowService.assignStage({ applicationId: inst.applicationId, actor: officer });
      } catch {
        continue;
      }
      const askedBefore = state.docRequestedInstances.includes(inst.id);
      const roll = rng.next();
      let outcome: Outcome = 'ADVANCE';
      if (!askedBefore && roll < profile.docRequestProbability) outcome = 'REQUEST_DOC';
      else if (rng.chance(profile.rejectionProbability)) outcome = 'REJECT';

      const workHours =
        rng.exponential(profile.pickupDelayHours) +
        (outcome === 'REQUEST_DOC' ? rng.lognormal(profile.medianHours * 0.3, profile.p90Hours * 0.3) : rng.lognormal(profile.medianHours, profile.p90Hours));

      state.work.push({
        instanceId: inst.id,
        applicationId: inst.applicationId,
        departmentCode: dept,
        officerId: officer.id,
        readyAtMs: nowMs + workHours * HOUR_MS,
        outcome,
      });
      busyIds.add(inst.id);
      inService.set(dept, (inService.get(dept) ?? 0) + 1);
    }
  }

  private static async complete(state: EngineState, rng: Rng, w: PlannedWork) {
    const inst = await prisma.applicationStageInstance.findUnique({
      where: { id: w.instanceId },
      include: { stage: true, application: { select: { citizenId: true, status: true } } },
    });
    if (!inst || inst.status !== 'ACTIVE' || inst.pausedAt) return; // changed meanwhile (manual action, hold, ...)
    const officer = await this.ensureSimOfficer(w.departmentCode);
    const profile = profileFor(w.departmentCode, state.profileOverrides);

    try {
      if (w.outcome === 'REQUEST_DOC') {
        const doc = rng.pick([
          { documentType: 'address_proof', title: 'Address proof' },
          { documentType: 'identity_proof', title: 'Identity proof' },
          { documentType: 'character_certificate', title: 'Character certificate' },
          { documentType: 'supporting_affidavit', title: 'Supporting affidavit' },
        ]);
        const req = await DocumentService.requestDocument({
          applicationId: w.applicationId,
          documentType: doc.documentType,
          title: doc.title,
          reason: `Required to complete ${inst.stage.name}`,
          actor: officer,
        });
        state.stats.docRequests++;
        state.docRequestedInstances.push(w.instanceId);
        state.replies.push({
          requestId: req.id,
          applicationId: w.applicationId,
          citizenId: inst.application.citizenId,
          respondAtMs: rng.chance(profile.citizenNoShowProbability)
            ? null
            : Clock.nowMs() + rng.lognormal(profile.citizenMedianHours, profile.citizenP90Hours) * HOUR_MS,
          title: doc.title,
          documentType: doc.documentType,
        });
      } else if (w.outcome === 'REJECT') {
        await WorkflowService.recordDecision({
          applicationId: w.applicationId,
          decisionType: 'REJECTED',
          reason: 'Eligibility criteria not met (simulated)',
          actor: officer,
        });
        state.stats.rejected++;
      } else {
        const result = await WorkflowService.advanceStage({
          applicationId: w.applicationId,
          actor: officer,
          remarks: 'Verified (simulated officer)',
          checklistResponses: ChecklistGate.allIds(inst.stage.checklistJson),
        });
        if (result.nextStage) state.stats.forwarded++;
        else state.stats.completed++;
      }
    } catch {
      state.stats.errors++;
    }
  }

  private static async summary(state: EngineState) {
    const [bottlenecks, overview, stuck] = await Promise.all([
      AnalyticsService.detectBottlenecks(),
      AnalyticsService.getOverviewMetrics(),
      DiagnosisService.diagnoseActive({ onlyStuck: true }),
    ]);
    const byReason: Record<string, number> = {};
    for (const s of stuck) byReason[s.diagnosis.reasonCode] = (byReason[s.diagnosis.reasonCode] || 0) + 1;

    const queues: Record<string, { inProgress: number; capacitySlotsNow: number }> = {};
    const depts = new Set([...state.work.map(w => w.departmentCode), ...Object.keys(state.profileOverrides), ...(state.disruptions ?? []).map(d => d.departmentCode)]);
    for (const code of depts) {
      queues[code] = {
        inProgress: state.work.filter(w => w.departmentCode === code).length,
        capacitySlotsNow: this.officersAt(state, code, profileFor(code, state.profileOverrides)),
      };
    }

    return {
      scenario: state.scenarioKey,
      seed: state.seed,
      clock: await this.getClock(),
      simulatedHours: state.scenarioStartMs ? Math.round(((Clock.nowMs() - state.scenarioStartMs) / HOUR_MS) * 10) / 10 : 0,
      stats: state.stats,
      awaitingCitizenReplies: state.replies.length,
      citizensNotResponding: state.replies.filter(r => r.respondAtMs === null).length,
      departments: queues,
      overview,
      stuck: { count: stuck.length, byReason, top: stuck.slice(0, 5).map(s => ({ trackingNumber: s.trackingNumber, ...pickDiag(s.diagnosis) })) },
      topBottlenecks: bottlenecks.slice(0, 5).map(b => ({
        stage: b.stageName,
        department: b.departmentName,
        score: b.bottleneckScore,
        isBottleneck: b.isBottleneck,
        dominantFactor: b.dominantFactor,
        explanation: b.explanation,
        backlog: b.activeBacklog,
        breachRatePercent: b.breachRatePercent,
      })),
    };
  }

  static async getState() {
    const state = await this.loadState();
    return { ...(await this.summary(state)), story: state.story };
  }

  // ------------------------------------------------------------------ scripted stories

  static listStories() {
    return Object.values(STORIES).map(s => ({
      key: s.key,
      title: s.title,
      serviceKey: s.serviceKey,
      description: s.description,
      steps: s.steps.map((st, i) => ({ index: i, afterHours: st.afterHours, action: st.action, narration: st.narration })),
    }));
  }

  /** Begin a story. The application belongs to the demo citizen (citizen@example.com) when present. */
  static async startStory(key: string) {
    const def = STORIES[key];
    if (!def) throw new NotFoundError(`Unknown story ${key}`);
    const state = await this.loadState();
    const seedCitizen = await prisma.user.findUnique({ where: { email: 'citizen@example.com' } });
    const citizen = seedCitizen ? this.toActor(seedCitizen) : (await this.ensureCitizenPool())[0];
    state.story = { key, applicationId: null, cursor: 0, citizenId: citizen.id };
    await this.saveState(state);
    return this.nextStoryStep();
  }

  /** Execute the next step of the running story and return a diagnosis snapshot. */
  static async nextStoryStep() {
    return this.exclusive(async () => {
      const state = await this.loadState();
      if (!state.story) throw new ConflictError('No story running. Start one with POST /api/sim/stories/:key/start');
      const def: StoryDefinition = STORIES[state.story.key];
      if (state.story.cursor >= def.steps.length) {
        return { done: true, story: def.key, message: 'Story finished', applicationId: state.story.applicationId };
      }

      const step = def.steps[state.story.cursor];
      if (step.afterHours > 0) await Clock.advance(step.afterHours * HOUR_MS);
      await SlaWatchdog.scanAllActiveApplications();

      const citizenUser = await prisma.user.findUniqueOrThrow({ where: { id: state.story.citizenId }, include: { department: true } });
      const citizen = this.toActor(citizenUser);
      const appId = state.story.applicationId;
      const current = appId
        ? await prisma.applicationStageInstance.findFirst({ where: { applicationId: appId, status: 'ACTIVE' }, include: { stage: true } })
        : null;
      const officer = current ? await this.officerFor(current.stage.departmentCode, true) : null;
      const needApp = () => {
        if (!appId || !current || !officer) throw new ConflictError('Story application has no active stage');
        return { appId, current, officer };
      };

      switch (step.action) {
        case 'create': {
          const created = await ApplicationService.createApplication(
            citizen,
            { serviceKey: def.serviceKey, applicantName: def.applicantName, applicantDetails: { source: 'simulation-story', story: def.key } },
            { isSimulated: true }
          );
          state.story.applicationId = created.id;
          break;
        }
        case 'assign': {
          const c = needApp();
          await WorkflowService.assignStage({ applicationId: c.appId, actor: c.officer });
          break;
        }
        case 'forward': {
          const c = needApp();
          await WorkflowService.advanceStage({
            applicationId: c.appId,
            actor: c.officer,
            remarks: step.narration,
            checklistResponses: ChecklistGate.allIds(c.current.stage.checklistJson),
          });
          break;
        }
        case 'requestDoc': {
          const c = needApp();
          await DocumentService.requestDocument({ applicationId: c.appId, actor: c.officer, ...step.document! });
          break;
        }
        case 'citizenUpload': {
          const c = needApp();
          const pending = await prisma.documentRequest.findMany({ where: { applicationId: c.appId, status: 'PENDING' } });
          for (const r of pending) {
            await DocumentService.uploadDocument({
              applicationId: c.appId,
              documentRequestId: r.id,
              documentType: r.documentType,
              title: r.title,
              fileUrl: `sim://documents/${r.id}.pdf`,
              actor: citizen,
            });
          }
          break;
        }
        case 'hold': {
          const c = needApp();
          await WorkflowService.holdApplication({ applicationId: c.appId, actor: c.officer, reason: step.reason || 'Administrative review' });
          break;
        }
        case 'resume': {
          const c = needApp();
          await WorkflowService.resumeApplication({ applicationId: c.appId, actor: c.officer, reason: step.narration });
          break;
        }
        case 'returnForCorrection': {
          const c = needApp();
          await WorkflowService.recordDecision({ applicationId: c.appId, decisionType: 'RETURNED_FOR_CORRECTION', reason: step.reason || 'Correction required', actor: c.officer });
          break;
        }
        case 'resubmit': {
          const c = needApp();
          await WorkflowService.resubmitApplication({ applicationId: c.appId, actor: citizen, remarks: step.narration, applicantDetails: { corrected: true } });
          break;
        }
        case 'reject': {
          const c = needApp();
          await WorkflowService.recordDecision({ applicationId: c.appId, decisionType: 'REJECTED', reason: step.reason || 'Not eligible', actor: c.officer });
          break;
        }
        case 'wait':
          break;
      }

      await SlaWatchdog.scanAllActiveApplications();
      const index = state.story.cursor;
      state.story.cursor++;
      await this.saveState(state);

      const diagnosis = state.story.applicationId ? await DiagnosisService.diagnoseById(state.story.applicationId, 'STAFF') : null;
      return {
        done: state.story.cursor >= def.steps.length,
        story: def.key,
        stepIndex: index,
        totalSteps: def.steps.length,
        action: step.action,
        narration: step.narration,
        clock: await this.getClock(),
        applicationId: state.story.applicationId,
        trackingNumber: diagnosis?.trackingNumber,
        snapshot: diagnosis ? pickDiag(diagnosis) : null,
      };
    });
  }

  /** Run a whole story in one call (returns every step's snapshot). */
  static async runStory(key: string) {
    const steps = [await this.startStory(key)];
    while (!(steps[steps.length - 1] as any).done) steps.push(await this.nextStoryStep());
    return { story: key, steps };
  }

  // ------------------------------------------------------------------ reset & sample data

  /** Remove everything the simulator created and reset the clock. Real data is untouched. */
  static async reset() {
    const apps = await prisma.application.findMany({ where: { isSimulated: true }, select: { id: true } });
    const ids = apps.map(a => a.id);
    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { applicationId: { in: ids } } }),
      prisma.compensationRecord.deleteMany({ where: { applicationId: { in: ids } } }),
      prisma.applicationDecision.deleteMany({ where: { applicationId: { in: ids } } }),
      prisma.application.deleteMany({ where: { id: { in: ids } } }),
    ]);
    await Clock.reset();
    await this.saveState(emptyState());
    return { removedApplications: ids.length, clock: await this.getClock() };
  }

  /**
   * Generate realistic sample applications whose histories END NOW: the clock is moved back
   * `days`, a scenario runs forward to the present, then the clock is reset to real time.
   */
  static async generateSampleData(opts: { days?: number; scenario?: string; seed?: number; withStories?: boolean } = {}) {
    const days = Math.min(30, Math.max(1, opts.days ?? 10));
    const scenario = opts.scenario ?? 'police_backlog';
    for (const cfg of Object.values(REGISTERED_SERVICES)) await WorkflowService.syncServiceConfig(cfg);

    // 1. Background load: the scenario runs from (now - days) up to now
    await Clock.setOffset(-(days * DAY_MS));
    const run = await this.runScenario(scenario, { days, seed: opts.seed ?? 42, tickHours: 3 });

    // 2. Hero stories, each timed so that its last step lands at "now"
    const stories: Array<{ story: string; trackingNumber?: string; applicationId?: string | null }> = [];
    if (opts.withStories !== false) {
      for (const key of ['stuck_at_police', 'waiting_on_citizen', 'happy_path']) {
        const totalHours = STORIES[key].steps.reduce((t, st) => t + st.afterHours, 0);
        await Clock.setOffset(-totalHours * HOUR_MS);
        const s = await this.runStory(key);
        const last = s.steps[s.steps.length - 1] as any;
        stories.push({ story: key, trackingNumber: last.trackingNumber, applicationId: last.applicationId });
      }
    }

    await Clock.reset();
    await SlaWatchdog.scanAllActiveApplications();
    const state = await this.loadState();
    state.story = null;
    await this.saveState(state);
    return { days, scenario, stats: run.stats, stories, summary: await this.summary(state) };
  }
}

function pickDiag(d: any) {
  return {
    reasonCode: d.reasonCode,
    reason: d.reasonLabel,
    severity: d.severity,
    isStuck: d.isStuck,
    where: d.location ? `${d.location.stageName} @ ${d.location.departmentName}` : d.status,
    slaStatus: d.timing?.slaStatus ?? d.slaStatus,
    activeHours: d.timing?.activeHours,
    targetHours: d.timing?.targetHours,
    overdueHours: d.timing?.overdueHours,
    citizenMessage: d.citizenMessage,
    officerMessage: d.officerMessage,
  };
}
