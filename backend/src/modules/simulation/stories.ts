/**
 * Scripted stories: deterministic, step-by-step journeys of ONE application, for live demos.
 * Each step waits `afterHours` of simulated time, then performs an action as the right actor.
 * After every step the engine runs the SLA watchdog and returns a diagnosis snapshot.
 */
export type StoryAction =
  | 'create'
  | 'assign'
  | 'forward'
  | 'requestDoc'
  | 'citizenUpload'
  | 'hold'
  | 'resume'
  | 'returnForCorrection'
  | 'resubmit'
  | 'reject'
  | 'wait';

export interface StoryStep {
  afterHours: number;
  action: StoryAction;
  narration: string;
  document?: { documentType: string; title: string; reason: string };
  reason?: string;
}

export interface StoryDefinition {
  key: string;
  title: string;
  serviceKey: string;
  applicantName: string;
  description: string;
  steps: StoryStep[];
}

export const STORIES: Record<string, StoryDefinition> = {
  stuck_at_police: {
    key: 'stuck_at_police',
    title: 'Moves through DM, then gets stuck at Police',
    serviceKey: 'gun_license',
    applicantName: 'Aarav Sharma',
    description:
      'The file moves quickly through the DM office, Police request a document (clock pauses - citizen time is not counted), then the file sits idle at Police until it breaches its 10-day target and is escalated. Finally it is cleared and moves to the SP office.',
    steps: [
      { afterHours: 0, action: 'create', narration: 'Citizen submits a gun-license application. One tracking ID is issued; the DM office has 24 hours.' },
      { afterHours: 3, action: 'assign', narration: 'DM officer picks up the file.' },
      { afterHours: 14, action: 'forward', narration: 'DM verifies identity and jurisdiction and forwards to the Police Department (10-day target starts).' },
      { afterHours: 20, action: 'assign', narration: 'Police inspector is assigned the file.' },
      {
        afterHours: 22,
        action: 'requestDoc',
        narration: 'Police ask for an address proof. The clock PAUSES: waiting for the citizen does not count against Police.',
        document: { documentType: 'address_proof', title: 'Address proof (utility bill)', reason: 'Residence verification for station jurisdiction' },
      },
      { afterHours: 30, action: 'citizenUpload', narration: 'Citizen uploads the bill 30 hours later. The clock resumes automatically.' },
      { afterHours: 100, action: 'wait', narration: '4 days pass with no activity at Police. Diagnosis: assigned but idle.' },
      { afterHours: 80, action: 'wait', narration: 'Over 80% of the Police target is used: AT_RISK. Citizen and Police are alerted.' },
      { afterHours: 60, action: 'wait', narration: 'The 10-day target is exceeded: BREACHED. Escalated to the supervisor; a compensation claim is created.' },
      { afterHours: 6, action: 'forward', narration: 'After escalation, Police complete verification and forward to the SP office.' },
    ],
  },
  happy_path: {
    key: 'happy_path',
    title: 'On-time approval across 3 departments',
    serviceKey: 'gun_license',
    applicantName: 'Meera Nair',
    description: 'A file that moves DM -> Police -> SP -> DM within every stage target.',
    steps: [
      { afterHours: 0, action: 'create', narration: 'Application submitted.' },
      { afterHours: 2, action: 'assign', narration: 'DM officer picks it up.' },
      { afterHours: 8, action: 'forward', narration: 'DM forwards to Police.' },
      { afterHours: 10, action: 'assign', narration: 'Police inspector assigned.' },
      { afterHours: 70, action: 'forward', narration: 'Police verification done in about 3 days; forwarded to SP.' },
      { afterHours: 5, action: 'assign', narration: 'SP office picks it up.' },
      { afterHours: 30, action: 'forward', narration: 'SP concurs; forwarded for final DM approval.' },
      { afterHours: 4, action: 'assign', narration: 'DM picks up the final approval.' },
      { afterHours: 10, action: 'forward', narration: 'Final approval granted. Application COMPLETED.' },
    ],
  },
  waiting_on_citizen: {
    key: 'waiting_on_citizen',
    title: 'Stuck because the citizen has not responded',
    serviceKey: 'passport_reissue',
    applicantName: 'Rohan Gupta',
    description: 'The passport office needs the old passport; the citizen does not respond. The file is stuck, but the diagnosis correctly blames nobody in government and reminders go out.',
    steps: [
      { afterHours: 0, action: 'create', narration: 'Passport re-issue application submitted.' },
      { afterHours: 3, action: 'assign', narration: 'Passport officer picks it up.' },
      {
        afterHours: 6,
        action: 'requestDoc',
        narration: 'Officer requests the old passport booklet. Clock paused.',
        document: { documentType: 'old_passport', title: 'Old passport booklet (scan)', reason: 'Required to cancel the previous passport' },
      },
      { afterHours: 50, action: 'wait', narration: '2 days without a response: automatic reminder sent (SMS / WhatsApp / email).' },
      { afterHours: 50, action: 'wait', narration: 'Still waiting. Second reminder. The stage is NOT breached because the clock is paused.' },
    ],
  },
  unassigned_backlog: {
    key: 'unassigned_backlog',
    title: 'Never picked up',
    serviceKey: 'trade_license',
    applicantName: 'Kavya Traders',
    description: 'A trade-license file reaches the Municipal Corporation and nobody picks it up.',
    steps: [
      { afterHours: 0, action: 'create', narration: 'Trade licence application submitted to the Municipal Corporation (3-day target).' },
      { afterHours: 30, action: 'wait', narration: '30 hours, not yet assigned to any officer.' },
      { afterHours: 30, action: 'wait', narration: 'Over 80% of the target used and still unassigned: AT_RISK.' },
      { afterHours: 20, action: 'wait', narration: 'Target exceeded: BREACHED and escalated. Diagnosis: UNASSIGNED.' },
    ],
  },
  correction_loop: {
    key: 'correction_loop',
    title: 'Returned for correction',
    serviceKey: 'trade_license',
    applicantName: 'Imran Ali',
    description: 'The ward officer returns the application for a correction; the citizen fixes it and the file continues.',
    steps: [
      { afterHours: 0, action: 'create', narration: 'Application submitted.' },
      { afterHours: 4, action: 'assign', narration: 'Ward officer picks it up.' },
      { afterHours: 10, action: 'returnForCorrection', narration: 'Returned: trade category does not match the premises.', reason: 'Trade category does not match the zoning of the premises' },
      { afterHours: 40, action: 'resubmit', narration: 'Citizen corrects the trade category and resubmits; the clock resumes.' },
      { afterHours: 12, action: 'forward', narration: 'Ward inspection complete; forwarded to the Health Department.' },
    ],
  },
};
