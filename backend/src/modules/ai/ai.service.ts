import { GoogleGenAI } from '@google/genai';
import { prisma } from '../../db/client.js';
import { AppError, NotFoundError } from '../../common/errors.js';
import { Clock } from '../../common/clock.js';
import { ServiceConfig } from '../../config/serviceConfig.js';
import { ApplicationService } from '../applications/application.service.js';
import { DocumentService } from '../documents/document.service.js';
import { CompensationService } from '../compensation/compensation.service.js';
import { DiagnosisService } from '../diagnosis/diagnosis.service.js';
import type { AuthUser } from '../../common/middleware.js';
import type { SynthesizedService, DocumentVerificationResult, DelayDiagnosticResult } from './ai.types.js';

export class AiService {
  private static getGeminiClient(): GoogleGenAI | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
  }

  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  }

  /**
   * Fallback Sovereign Knowledge Engine: Synthesizes realistic workflows for any government request
   */
  private static synthesizeWithSovereignEngine(query: string): SynthesizedService {
    const q = query.toLowerCase();

    if (q.includes('environment') || q.includes('industry') || q.includes('pollut') || q.includes('mine') || q.includes('factory') || q.includes('borewell')) {
      const isBorewell = q.includes('borewell') || q.includes('water');
      const name = isBorewell ? 'Agricultural Borewell Drilling Permission' : 'Industrial Environmental Clearance (PCB NOC)';
      return {
        serviceKey: this.slugify(name),
        name,
        category: 'Environment & Public Works',
        description: 'Statutory multi-department vetting and hydro-geological inspection for industrial/resource utilization.',
        statutoryCompensationPerDay: 250,
        aiGenerated: true,
        reasoning: 'Synthesized multi-tier verification covering physical site survey, pollution board clearance, and district sanction.',
        stages: [
          {
            stageKey: 'site_survey',
            name: 'Ground Water / Physical Site Survey',
            departmentCode: 'PWD_DEPT',
            departmentName: 'Public Works Department',
            slaDays: 3,
            slaHours: 72,
            orderIndex: 1,
            requiredDocuments: [
              { documentType: 'land_patta', title: 'Land Ownership Patta / Title Deed', description: 'Proof of land possession', isMandatory: true },
              { documentType: 'site_layout', title: 'Detailed Site Blueprint', description: 'Scaled layout showing proposed drilling/construction point', isMandatory: true },
            ],
          },
          {
            stageKey: 'pcb_scrutiny',
            name: 'Pollution & Ecological Impact Scrutiny',
            departmentCode: 'PCB_DEPT',
            departmentName: 'State Pollution Control Board',
            slaDays: 5,
            slaHours: 120,
            orderIndex: 2,
            requiredDocuments: [
              { documentType: 'impact_assessment', title: 'Environmental Impact Undertaking', description: 'Self-declaration of effluent & noise compliance', isMandatory: true },
            ],
          },
          {
            stageKey: 'magistrate_sanction',
            name: 'District Magistrate Sanction Order',
            departmentCode: 'DM_OFFICE',
            departmentName: 'District Magistrate Office',
            slaDays: 2,
            slaHours: 48,
            orderIndex: 3,
            requiredDocuments: [],
          },
        ],
      };
    }

    if (q.includes('food') || q.includes('cafe') || q.includes('restaurant') || q.includes('hospital') || q.includes('hotel') || q.includes('liquor')) {
      const isHospital = q.includes('hospital') || q.includes('clinic');
      const name = isHospital ? 'Clinical Establishment Registration' : 'Commercial Food & Hospitality Operation License';
      return {
        serviceKey: this.slugify(name),
        name,
        category: 'Health & Hospitality',
        description: 'Comprehensive civic sanitation inspection, fire safety certification, and commercial sanction workflow.',
        statutoryCompensationPerDay: 200,
        aiGenerated: true,
        reasoning: 'Synthesized health establishment pipeline covering municipal zoning, fire NOC, and statutory health certification.',
        stages: [
          {
            stageKey: 'fire_clearance',
            name: 'Fire & Emergency Safety Assessment',
            departmentCode: 'FIRE_DEPT',
            departmentName: 'Fire and Emergency Services',
            slaDays: 4,
            slaHours: 96,
            orderIndex: 1,
            requiredDocuments: [
              { documentType: 'fire_safety_plan', title: 'Fire Extinguisher & Evacuation Map', description: 'Certified building safety evacuation diagram', isMandatory: true },
              { documentType: 'occupancy_cert', title: 'Building Occupancy Certificate', description: 'Municipal approved structural occupancy clearance', isMandatory: true },
            ],
          },
          {
            stageKey: 'health_hygiene_audit',
            name: 'Health Officer On-Site Hygiene Audit',
            departmentCode: 'HEALTH_DEPT',
            departmentName: 'Department of Health & Family Welfare',
            slaDays: 3,
            slaHours: 72,
            orderIndex: 2,
            requiredDocuments: [
              { documentType: 'staff_medical', title: 'Staff Medical Fitness Records', description: 'Valid medical fitness and hygiene certificates for on-duty staff', isMandatory: true },
            ],
          },
          {
            stageKey: 'zonal_commissioner_grant',
            name: 'Zonal Commissioner Operational Sanction',
            departmentCode: 'MUNICIPAL_CORP',
            departmentName: 'Municipal Corporation',
            slaDays: 2,
            slaHours: 48,
            orderIndex: 3,
            requiredDocuments: [],
          },
        ],
      };
    }

    if (q.includes('land') || q.includes('mutation') || q.includes('property') || q.includes('deed') || q.includes('building') || q.includes('house') || q.includes('construction')) {
      const name = 'Land Mutation and Property Title Regularization';
      return {
        serviceKey: this.slugify(name),
        name,
        category: 'Revenue & Land Records',
        description: 'Official revenue records succession, field demarcation, and Tehsildar mutation grant.',
        statutoryCompensationPerDay: 250,
        aiGenerated: true,
        reasoning: 'Three-stage land administration pipeline: Village Administrative Officer verification -> Field Surveyor Demarcation -> Tehsildar Sanction.',
        stages: [
          {
            stageKey: 'vao_verification',
            name: 'Village Officer Title & Possession Inquiry',
            departmentCode: 'REVENUE_DEPT',
            departmentName: 'Department of Revenue & Land Records',
            slaDays: 4,
            slaHours: 96,
            orderIndex: 1,
            requiredDocuments: [
              { documentType: 'sale_deed', title: 'Registered Sale Deed / Gift Deed', description: 'Legally registered conveyance deed', isMandatory: true },
              { documentType: 'encumbrance_cert', title: 'Encumbrance Certificate (15 Years)', description: 'Sub-registrar issued non-encumbrance certificate', isMandatory: true },
              { documentType: 'id_proof', title: 'Applicant Aadhaar / National ID', description: 'Government issued identity card', isMandatory: true },
            ],
          },
          {
            stageKey: 'survey_demarcation',
            name: 'Cadastral Survey & Boundary Demarcation',
            departmentCode: 'SURVEY_DEPT',
            departmentName: 'Department of Survey & Land Records',
            slaDays: 5,
            slaHours: 120,
            orderIndex: 2,
            requiredDocuments: [
              { documentType: 'neighbor_consent', title: 'Boundary Demarcation Acknowledgement', description: 'Notice acknowledgement from adjacent plot owners', isMandatory: false },
            ],
          },
          {
            stageKey: 'tehsildar_mutation_order',
            name: 'Tehsildar Final Mutation & RoR Updation',
            departmentCode: 'REVENUE_DEPT',
            departmentName: 'Department of Revenue & Land Records',
            slaDays: 3,
            slaHours: 72,
            orderIndex: 3,
            requiredDocuments: [],
          },
        ],
      };
    }

    const cleanName = query.length > 5 ? query.trim() : 'Public Civic Service Clearance';
    const capitalizedName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
    return {
      serviceKey: this.slugify(capitalizedName),
      name: capitalizedName,
      category: 'General Public Services',
      description: `Public workflow pipeline dynamically created for: ${capitalizedName}.`,
      statutoryCompensationPerDay: 200,
      aiGenerated: true,
      reasoning: 'Configured standard three-department statutory scrutiny: Desk Intake Verification -> Departmental Field Review -> Executive Sanction.',
      stages: [
        {
          stageKey: 'intake_verification',
          name: 'Desk Document Verification',
          departmentCode: 'DM_OFFICE',
          departmentName: 'District Administrative Office',
          slaDays: 2,
          slaHours: 48,
          orderIndex: 1,
          requiredDocuments: [
            { documentType: 'identity_proof', title: 'Government Photo ID Proof', description: 'Aadhaar / Voter ID / Passport', isMandatory: true },
            { documentType: 'address_proof', title: 'Proof of Permanent Address', description: 'Recent Utility Bill or Domicile Certificate', isMandatory: true },
            { documentType: 'affidavit', title: 'Notarized Self-Declaration Affidavit', description: 'Affidavit certifying statements made in application', isMandatory: true },
          ],
        },
        {
          stageKey: 'field_inquiry',
          name: 'Field Verification & Departmental Review',
          departmentCode: 'POLICE_DEPT',
          departmentName: 'Field Inquiry & Enforcement Division',
          slaDays: 6,
          slaHours: 144,
          orderIndex: 2,
          requiredDocuments: [],
        },
        {
          stageKey: 'final_sanction',
          name: 'Final Executive Sanction & Certificate Issuance',
          departmentCode: 'DM_OFFICE',
          departmentName: 'District Administrative Office',
          slaDays: 2,
          slaHours: 48,
          orderIndex: 3,
          requiredDocuments: [],
        },
      ],
    };
  }

  /**
   * Synthesize a full government service workflow from any prompt using Gemini or Sovereign Engine
   */
  static async synthesizeService(prompt: string): Promise<SynthesizedService> {
    const gemini = this.getGeminiClient();

    if (gemini) {
      try {
        const systemPrompt = `You are the Lead Government Enterprise Architect for "DocTrail" (Parcel Tracking for Government Applications).
Given a user query for any government service, permit, license, or civic scheme, design a realistic, robust, multi-department statutory workflow.
Return strictly JSON matching this structure:
{
  "serviceKey": "slug_lowercase_no_spaces",
  "name": "Formal Official Service Name",
  "category": "Department Category",
  "description": "2-sentence official description",
  "statutoryCompensationPerDay": 250,
  "reasoning": "Why these departments and SLA timelines were selected",
  "stages": [
    {
      "stageKey": "unique_stage_slug",
      "name": "Stage Name",
      "departmentCode": "UPPERCASE_CODE (e.g. DM_OFFICE, POLICE_DEPT, HEALTH_DEPT, FIRE_DEPT, REVENUE_DEPT, MUNICIPAL_CORP)",
      "departmentName": "Full Department Name",
      "slaDays": 3,
      "slaHours": 72,
      "orderIndex": 1,
      "requiredDocuments": [
        { "documentType": "snake_case_type", "title": "Document Title", "description": "What is required and accepted", "isMandatory": true }
      ],
      "checklists": ["Officer verification criterion 1", "Officer verification criterion 2"]
    }
  ]
}
Include 3 to 4 sequential stages. Assign realistic SLAs (in days and hours), specific document requirements, and verification checklist criteria for each stage.`;

        const response = await gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: { systemInstruction: systemPrompt, responseMimeType: 'application/json' },
        });

        const rawText = typeof (response as any).text === 'function' ? (response as any).text() : (response as any).text;
        if (rawText && typeof rawText === 'string') {
          const parsed = JSON.parse(rawText) as SynthesizedService;
          if (parsed.stages && parsed.stages.length > 0) {
            parsed.aiGenerated = true;
            this.normalizeStages(parsed);
            return parsed;
          }
        }
      } catch (err) {
        console.warn('Gemini API call failed, falling back to Sovereign Engine:', err);
      }
    }

    const fallback = this.synthesizeWithSovereignEngine(prompt);
    this.normalizeStages(fallback);
    return fallback;
  }

  private static normalizeStages(service: SynthesizedService) {
    if (!service.stages) return;
    service.stages.forEach((stage, idx) => {
      if (!stage.departmentName) {
        stage.departmentName = (stage.departmentCode || 'DM_OFFICE').replace(/_/g, ' ');
      }
      if (!stage.slaHours || stage.slaHours <= 0) stage.slaHours = (stage.slaDays || 2) * 24;
      if (!stage.slaDays || stage.slaDays <= 0) stage.slaDays = Math.ceil(stage.slaHours / 24);
      if (!stage.orderIndex) stage.orderIndex = idx + 1;
      if (!stage.checklists || !Array.isArray(stage.checklists) || stage.checklists.length === 0) {
        stage.checklists = [
          `Verify submitted documents for ${stage.name || 'Stage ' + (idx + 1)}`,
          `Validate applicant identity & compliance prerequisites`,
          `Record official departmental inspection sign-off`,
        ];
      }
    });
  }

  /**
   * Ensures departments exist, persists the service and its stages. Stages missing from the new
   * definition are archived (isActive=false) so they are no longer part of the live workflow.
   */
  static async persistSynthesizedService(service: SynthesizedService) {
    this.normalizeStages(service);

    for (const stage of service.stages) {
      const deptCode = stage.departmentCode || 'DM_OFFICE';
      const existing = await prisma.department.findUnique({ where: { code: deptCode } });
      if (!existing) {
        const deptName = stage.departmentName || deptCode.replace(/_/g, ' ');
        await prisma.department.create({
          data: { code: deptCode, name: deptName, description: `Department managing ${deptName}` },
        });
      }
    }

    const departments = await prisma.department.findMany({ where: { code: { in: service.stages.map(s => s.departmentCode) } } });
    const deptMap = new Map(departments.map(d => [d.code, d.id]));

    const configJson = JSON.stringify({
      category: service.category,
      compensationPerDay: service.statutoryCompensationPerDay,
      reasoning: service.reasoning,
      stages: service.stages,
    });

    const dbService = await prisma.service.upsert({
      where: { key: service.serviceKey },
      update: { name: service.name, description: service.description, configJson },
      create: { key: service.serviceKey, name: service.name, description: service.description, configJson },
    });

    const ordered = [...service.stages].sort((a, b) => a.orderIndex - b.orderIndex);
    for (let i = 0; i < ordered.length; i++) {
      const stage = ordered[i];
      const data = {
        name: stage.name,
        orderIndex: i + 1,
        departmentId: deptMap.get(stage.departmentCode),
        departmentCode: stage.departmentCode,
        slaDays: stage.slaDays,
        slaHours: stage.slaHours,
        isFinalStage: i === ordered.length - 1,
        isActive: true,
        checklistJson: JSON.stringify(stage.checklists),
      };
      await prisma.workflowStage.upsert({
        where: { serviceId_stageKey: { serviceId: dbService.id, stageKey: stage.stageKey } },
        update: data,
        create: { serviceId: dbService.id, stageKey: stage.stageKey, ...data },
      });
    }

    await prisma.workflowStage.updateMany({
      where: { serviceId: dbService.id, stageKey: { notIn: ordered.map(s => s.stageKey) } },
      data: { isActive: false },
    });

    return dbService;
  }

  /**
   * AI-assisted submission: free-form intent -> synthesised service -> live application.
   */
  static async applyWithAi(userIntent: string, applicantName: string, applicantDetails: Record<string, any>, citizen: AuthUser) {
    const synthesized = await this.synthesizeService(userIntent);
    const existing = await prisma.service.findUnique({ where: { key: synthesized.serviceKey } });
    if (!existing) await this.persistSynthesizedService(synthesized);

    const app = await ApplicationService.createApplication(citizen, {
      serviceKey: synthesized.serviceKey,
      applicantName,
      applicantDetails,
    });
    return { application: app, service: synthesized };
  }

  /**
   * Stage document evaluator: required documents (from either config shape) vs uploaded documents.
   */
  static async evaluateStageDocuments(applicationId: string): Promise<DocumentVerificationResult> {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { service: true, currentStage: true, documents: true, documentRequests: true },
    });

    if (!app || !app.currentStage) {
      throw new NotFoundError(`Application ${applicationId} or active stage not found`);
    }

    const requiredDocs = ServiceConfig.requiredDocuments(app.service.configJson, app.currentStage.stageKey);
    const uploadedDocTypes = new Set(app.documents.map(d => d.documentType.toLowerCase()));
    const hasPendingRequests = app.documentRequests.some(r => r.status === 'PENDING');

    const verifiedDocs: string[] = [];
    const missingDocs: DocumentVerificationResult['missingDocuments'] = [];

    for (const req of requiredDocs) {
      if (uploadedDocTypes.has(req.documentType)) {
        verifiedDocs.push(req.title);
      } else {
        missingDocs.push({
          documentType: req.documentType,
          title: req.title,
          reason: `Mandatory compliance document for ${app.currentStage.name}${req.description ? `: ${req.description}` : ''}`,
          urgency: req.isMandatory ? 'CRITICAL' : 'NORMAL',
        });
      }
    }

    const completenessScore = requiredDocs.length > 0 ? Math.round((verifiedDocs.length / requiredDocs.length) * 100) : 100;
    const status: DocumentVerificationResult['status'] = missingDocs.length > 0 || hasPendingRequests ? 'DOCUMENTS_MISSING' : 'SATISFIED';

    return {
      applicationId: app.id,
      stageKey: app.currentStage.stageKey,
      status,
      completenessScore,
      verifiedDocuments: verifiedDocs,
      missingDocuments: missingDocs,
      officerSummary:
        status === 'SATISFIED'
          ? `All ${verifiedDocs.length} required documents for stage "${app.currentStage.name}" are on file. Application is eligible to advance.`
          : `${missingDocs.length} required document(s) are missing for stage "${app.currentStage.name}". Recommend issuing document request before stage sanction.`,
      citizenGuidance:
        status === 'SATISFIED'
          ? `Your documents are complete for ${app.currentStage.name}. Processing is actively underway.`
          : `Action required: Please provide ${missingDocs.map(m => `"${m.title}"`).join(', ') || 'the requested documents'} so officers can process your application without delay.`,
    };
  }

  /**
   * Explainable delay diagnostic built on the deterministic DiagnosisService (read-only).
   */
  static async explainDelay(applicationId: string): Promise<DelayDiagnosticResult> {
    const app = await prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        service: true,
        currentStage: { include: { department: true } },
        stageInstances: { include: { stage: { include: { department: true } } }, orderBy: { startedAt: 'asc' } },
      },
    });
    if (!app) throw new NotFoundError(`Application ${applicationId} not found`);

    const now = Clock.now();
    const diag = await DiagnosisService.diagnoseById(applicationId, 'STAFF');
    const totalWallClockHours = Math.max(0, Math.round(((now.getTime() - app.createdAt.getTime()) / 3_600_000) * 10) / 10);

    const dwellTimeBreakdown = diag.pipeline
      .filter(p => p.state !== 'UPCOMING')
      .map(p => ({
        stageName: p.stageName,
        department: p.departmentName,
        status: p.state === 'CURRENT' ? 'ACTIVE' : 'COMPLETED',
        activeHours: p.activeHours,
        pausedHours: p.pausedHours,
      }));
    const pausedHours = Math.round(dwellTimeBreakdown.reduce((s, d) => s + d.pausedHours, 0) * 10) / 10;
    const activeProcessingHours = Math.round(dwellTimeBreakdown.reduce((s, d) => s + d.activeHours, 0) * 10) / 10;

    const causeMap: Record<string, DelayDiagnosticResult['primaryDelayCause']> = {
      WAITING_ON_CITIZEN: 'APPLICANT_PENDING_DOCS',
      RETURNED_FOR_CORRECTION: 'APPLICANT_PENDING_DOCS',
      EXTERNAL_DEPENDENCY: 'INTER_AGENCY_HANDOFF',
      DEPARTMENT_BACKLOG: 'DEPARTMENTAL_BACKLOG',
      UNASSIGNED: 'DEPARTMENTAL_BACKLOG',
      OFFICER_IDLE: 'DEPARTMENTAL_BACKLOG',
      SLOW_PROCESSING: 'DEPARTMENTAL_BACKLOG',
      ADMIN_HOLD: 'DEPARTMENTAL_BACKLOG',
    };
    const primaryDelayCause = causeMap[diag.reasonCode] ?? 'ON_TRACK';
    const currentDeptName = diag.location?.departmentName || 'District Administration';

    let citizenExplanation: string;
    let supervisorActionRecommendation: string;
    if (primaryDelayCause === 'APPLICANT_PENDING_DOCS') {
      citizenExplanation = `${diag.citizenMessage} Your application is paused while the office waits for you; the clock resumes automatically when you respond.`;
      supervisorActionRecommendation = 'Delay is applicant-attributable. A reminder is sent automatically; consider a phone follow-up if it remains pending.';
    } else if (primaryDelayCause === 'ON_TRACK') {
      citizenExplanation = diag.citizenMessage;
      supervisorActionRecommendation = 'Workflow is operating on schedule. No administrative intervention required.';
    } else {
      citizenExplanation = `${diag.citizenMessage} The department is accountable for this time.`;
      supervisorActionRecommendation = `${diag.recommendedAction ?? 'Review this file'} (${diag.officerMessage}).`;
    }

    const comp = await CompensationService.getEligibility(applicationId);

    return {
      applicationId: app.id,
      trackingNumber: app.trackingNumber,
      applicantName: app.applicantName,
      serviceName: app.service.name,
      currentStage: app.currentStage?.name || 'Completed',
      slaStatus: app.slaStatus,
      primaryDelayCause,
      reasonCode: diag.reasonCode,
      responsibleDepartment: currentDeptName,
      totalWallClockHours,
      activeProcessingHours,
      pausedHours,
      dwellTimeBreakdown,
      citizenExplanation,
      supervisorActionRecommendation,
      compensationEvaluation: {
        isEligible: comp.isEligible,
        breachDays: comp.breachDays,
        estimatedAmount: comp.estimatedCompensationAmount,
        currency: 'INR (₹)',
      },
    };
  }

  /**
   * 1-Click request for a missing document diagnosed by the evaluator.
   */
  static async autoRequestDiagnosedDoc(applicationId: string, officer: AuthUser, documentType?: string) {
    const evaluation = await this.evaluateStageDocuments(applicationId);
    if (evaluation.missingDocuments.length === 0) {
      throw new AppError('No missing documents detected for this stage.', 400);
    }
    const targetDoc = documentType
      ? evaluation.missingDocuments.find(d => d.documentType.toLowerCase() === documentType.toLowerCase())
      : evaluation.missingDocuments[0];
    if (!targetDoc) {
      throw new NotFoundError(`Missing document of type "${documentType}" not found in AI evaluation`);
    }
    return DocumentService.requestDocument({
      applicationId,
      documentType: targetDoc.documentType,
      title: targetDoc.title,
      reason: targetDoc.reason,
      actor: officer,
    });
  }
}
