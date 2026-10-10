/**
 * Simulation model.
 *
 * Each department is an M/G/c queue with c = officers x parallelFilesPerOfficer slots; each file takes a log-normal
 * processing time (median / p90), after a pickup delay. While working on a file an officer may
 * ask the citizen for a document (the clock pauses; the citizen replies after a log-normal delay
 * or never). Disruptions change a department's officer count over a time window - that is how a
 * bottleneck is created: arrivals keep coming, capacity drops, the queue and waiting time grow,
 * files go AT_RISK then BREACHED, and the analytics flag the stage with the reason.
 */
export interface DepartmentProfile {
  officers: number;
  parallelFilesPerOfficer: number; // files one officer progresses at the same time (field inquiries run in parallel)
  medianHours: number; // processing time per file
  p90Hours: number;
  pickupDelayHours: number; // mean delay before an idle officer opens the next file
  docRequestProbability: number; // chance an officer asks the citizen for a document (once per stage)
  rejectionProbability: number;
  citizenMedianHours: number; // citizen response time to a document request
  citizenP90Hours: number;
  citizenNoShowProbability: number; // citizen never uploads
}

export interface Disruption {
  departmentCode: string;
  fromHour: number; // hours since scenario start
  toHour: number;
  officersMultiplier: number; // 0 = nobody working, 0.25 = a quarter of the staff
  label: string;
}

export interface ScenarioDefinition {
  key: string;
  title: string;
  description: string;
  defaultDays: number;
  arrivalsPerDay: Record<string, number>; // serviceKey -> mean new applications per day
  profileOverrides?: Record<string, Partial<DepartmentProfile>>;
  disruptions?: Disruption[];
  /** What the presenter should look at afterwards */
  expectedOutcome: string;
}

export const DEFAULT_PROFILE: DepartmentProfile = {
  officers: 2,
  parallelFilesPerOfficer: 4,
  medianHours: 24,
  p90Hours: 60,
  pickupDelayHours: 4,
  docRequestProbability: 0.15,
  rejectionProbability: 0.03,
  citizenMedianHours: 30,
  citizenP90Hours: 96,
  citizenNoShowProbability: 0.05,
};

export const DEPARTMENT_PROFILES: Record<string, Partial<DepartmentProfile>> = {
  DM_OFFICE: { officers: 2, parallelFilesPerOfficer: 3, medianHours: 6, p90Hours: 16, pickupDelayHours: 2, docRequestProbability: 0.12 },
  POLICE_DEPT: { officers: 3, parallelFilesPerOfficer: 8, medianHours: 60, p90Hours: 160, pickupDelayHours: 8, docRequestProbability: 0.3 },
  SP_OFFICE: { officers: 2, parallelFilesPerOfficer: 4, medianHours: 30, p90Hours: 80, pickupDelayHours: 6, docRequestProbability: 0.05 },
  PASSPORT_OFFICE: { officers: 3, parallelFilesPerOfficer: 3, medianHours: 10, p90Hours: 30, pickupDelayHours: 2, docRequestProbability: 0.2 },
  MUNICIPAL_CORP: { officers: 2, parallelFilesPerOfficer: 4, medianHours: 20, p90Hours: 55, pickupDelayHours: 4, docRequestProbability: 0.2 },
  HEALTH_DEPT: { officers: 1, parallelFilesPerOfficer: 5, medianHours: 28, p90Hours: 70, pickupDelayHours: 6, docRequestProbability: 0.15 },
};

export const SCENARIOS: Record<string, ScenarioDefinition> = {
  normal_week: {
    key: 'normal_week',
    title: 'Normal week',
    description: 'Steady arrivals, normal staffing. Most files finish within their stage targets.',
    defaultDays: 7,
    arrivalsPerDay: { gun_license: 2, passport_reissue: 3, trade_license: 1.5 },
    expectedOutcome: 'Low breach rate; bottleneck scores below 40 for most stages.',
  },
  police_backlog: {
    key: 'police_backlog',
    title: 'Police verification backlog',
    description:
      'From day 2 the Police Department loses three quarters of its verification staff (election duty) while gun-license and passport applications keep arriving.',
    defaultDays: 10,
    arrivalsPerDay: { gun_license: 4, passport_reissue: 4, trade_license: 1 },
    disruptions: [{ departmentCode: 'POLICE_DEPT', fromHour: 48, toHour: 24 * 30, officersMultiplier: 0.25, label: 'Police staff on election duty' }],
    expectedOutcome:
      'Police Verification and Police Security Verification climb to the top of /api/dashboard/bottlenecks (dominant factor: age/inflow); files there show DEPARTMENT_BACKLOG and breach.',
  },
  officer_leave: {
    key: 'officer_leave',
    title: 'SP office on leave',
    description: 'Nobody is working in the SP Office from day 1 to day 6. Files reach SP review and sit unassigned.',
    defaultDays: 8,
    arrivalsPerDay: { gun_license: 3, passport_reissue: 1, trade_license: 1 },
    profileOverrides: { POLICE_DEPT: { medianHours: 20, p90Hours: 48 } },
    disruptions: [{ departmentCode: 'SP_OFFICE', fromHour: 24, toHour: 144, officersMultiplier: 0, label: 'SP Office on leave' }],
    expectedOutcome: 'SP Review files are UNASSIGNED / DEPARTMENT_BACKLOG and breach their 5-day target.',
  },
  arrival_surge: {
    key: 'arrival_surge',
    title: 'Application surge',
    description: 'Trade-license applications triple for four days (licence renewal season). Staffing stays the same.',
    defaultDays: 8,
    arrivalsPerDay: { gun_license: 1, passport_reissue: 2, trade_license: 6 },
    expectedOutcome: 'Municipal Corporation and Health Department queues grow (dominant factor: inflow).',
  },
  slow_citizens: {
    key: 'slow_citizens',
    title: 'Slow citizen responses',
    description: 'Officers often need extra documents and citizens take days to respond. Delays are real but NOT the department\'s fault.',
    defaultDays: 8,
    arrivalsPerDay: { gun_license: 2, passport_reissue: 3, trade_license: 2 },
    profileOverrides: Object.fromEntries(
      Object.keys(DEPARTMENT_PROFILES).map(code => [
        code,
        { docRequestProbability: 0.55, citizenMedianHours: 90, citizenP90Hours: 240, citizenNoShowProbability: 0.25 },
      ])
    ),
    expectedOutcome:
      'Many files show WAITING_ON_CITIZEN (paused, reminders sent) while department breach rates stay low - the diagnosis separates citizen delay from department delay.',
  },
};

export function profileFor(departmentCode: string, overrides?: Record<string, Partial<DepartmentProfile>>): DepartmentProfile {
  return { ...DEFAULT_PROFILE, ...(DEPARTMENT_PROFILES[departmentCode] || {}), ...(overrides?.[departmentCode] || {}) };
}
