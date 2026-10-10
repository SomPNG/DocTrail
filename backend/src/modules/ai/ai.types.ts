export interface SynthesizedStageDoc {
  documentType: string;
  title: string;
  description: string;
  isMandatory: boolean;
}

export interface SynthesizedStage {
  stageKey: string;
  name: string;
  departmentCode: string;
  departmentName: string;
  slaDays: number;
  slaHours: number;
  orderIndex: number;
  requiredDocuments: SynthesizedStageDoc[];
  checklists?: string[];
}

export interface SynthesizedService {
  serviceKey: string;
  name: string;
  category: string;
  description: string;
  statutoryCompensationPerDay: number;
  stages: SynthesizedStage[];
  reasoning: string;
  aiGenerated: boolean;
}

export interface DocumentVerificationResult {
  applicationId: string;
  stageKey: string;
  status: 'SATISFIED' | 'DOCUMENTS_MISSING' | 'DISCREPANCY_DETECTED';
  completenessScore: number; // 0 - 100
  verifiedDocuments: string[];
  missingDocuments: Array<{
    documentType: string;
    title: string;
    reason: string;
    urgency: 'CRITICAL' | 'NORMAL';
  }>;
  officerSummary: string;
  citizenGuidance: string;
}

export interface DelayDiagnosticResult {
  applicationId: string;
  trackingNumber: string;
  applicantName: string;
  serviceName: string;
  currentStage: string;
  slaStatus: string;
  primaryDelayCause: 'APPLICANT_PENDING_DOCS' | 'DEPARTMENTAL_BACKLOG' | 'INTER_AGENCY_HANDOFF' | 'ON_TRACK';
  reasonCode?: string;
  responsibleDepartment: string;
  totalWallClockHours: number;
  activeProcessingHours: number;
  pausedHours: number;
  dwellTimeBreakdown: Array<{
    stageName: string;
    department: string;
    status: string;
    activeHours: number;
    pausedHours: number;
  }>;
  citizenExplanation: string;
  supervisorActionRecommendation: string;
  compensationEvaluation: {
    isEligible: boolean;
    breachDays: number;
    estimatedAmount: number;
    currency: string;
  };
}
