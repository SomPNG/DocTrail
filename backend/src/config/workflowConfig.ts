export interface StageChecklistItem {
  id: string;
  label: string;
  isMandatory: boolean;
}

export interface StageConfig {
  key: string;
  name: string;
  departmentCode: string;
  slaDays: number;
  slaHours?: number;
  isFinalStage?: boolean;
  requiredDocuments?: string[];
  checklists?: StageChecklistItem[];
}

export interface ServiceWorkflowConfig {
  serviceKey: string;
  serviceName: string;
  description: string;
  trackingPrefix?: string; // e.g. GL -> GL-2026-000042
  stages: StageConfig[];
  compensationRatePerDayDelayINR: number;
}

export const GUN_LICENSE_CONFIG: ServiceWorkflowConfig = {
  serviceKey: 'gun_license',
  serviceName: 'Gun License',
  description: 'Arms and Gun License Application Workflow with Cross-Department SLA Tracking',
  trackingPrefix: 'GL',
  compensationRatePerDayDelayINR: 250, // Rs. 250 per day of breach delay
  stages: [
    {
      key: 'dm_verification',
      name: 'DM / Initial Verification',
      departmentCode: 'DM_OFFICE',
      slaDays: 1,
      slaHours: 24,
      requiredDocuments: ['identity_proof', 'address_proof'],
      checklists: [
        { id: 'dm_id_verify', label: 'Verify applicant government photo identity (Aadhaar / Passport / Voter ID)', isMandatory: true },
        { id: 'dm_jurisdiction', label: 'Confirm applicant resides within District Magistrate administrative jurisdiction', isMandatory: true },
        { id: 'dm_threat_validity', label: 'Evaluate genuine necessity / self-defense / crop-protection grounds', isMandatory: true },
        { id: 'dm_age_threshold', label: 'Confirm applicant has completed statutory minimum age of 21 years', isMandatory: true },
      ],
    },
    {
      key: 'police_verification',
      name: 'Police Verification',
      departmentCode: 'POLICE_DEPT',
      slaDays: 10,
      slaHours: 240,
      requiredDocuments: ['character_certificate', 'address_proof'],
      checklists: [
        { id: 'police_cctns_search', label: 'Search Crime and Criminal Tracking Network & Systems (CCTNS) for prior FIRs or convictions', isMandatory: true },
        { id: 'police_field_inquiry', label: 'Conduct in-person field inquiry with two independent local neighborhood referees', isMandatory: true },
        { id: 'police_residence_check', label: 'Verify physical residence dwell time in local station jurisdiction (min 1 year)', isMandatory: true },
        { id: 'police_sobriety_peace', label: 'Assess applicant mental stability, sobriety, and lack of domestic conflict history', isMandatory: true },
      ],
    },
    {
      key: 'sp_review',
      name: 'SP Review',
      departmentCode: 'SP_OFFICE',
      slaDays: 5,
      slaHours: 120,
      requiredDocuments: [],
      checklists: [
        { id: 'sp_dossier_audit', label: 'Scrutinize Sub-Divisional Police Officer (SDPO) field inquiry docket', isMandatory: true },
        { id: 'sp_intel_clearance', label: 'Special Branch / Intelligence security clearance review', isMandatory: true },
        { id: 'sp_security_concurrence', label: 'Superintendent of Police security concurrence and recommendation endorsement', isMandatory: true },
      ],
    },
    {
      key: 'final_approval',
      name: 'Final DM Approval',
      departmentCode: 'DM_OFFICE',
      slaDays: 5,
      slaHours: 120,
      isFinalStage: true,
      requiredDocuments: [],
      checklists: [
        { id: 'dm_statutory_order', label: 'Execute District Magistrate Statutory Sanction Order under Arms Act 1959', isMandatory: true },
        { id: 'dm_ndal_ledger', label: 'Record entry into National Database for Arms Licenses (NDAL) ledger', isMandatory: true },
        { id: 'dm_smartcard_dispatch', label: 'Authorize printing and dispatch of NDAL biometric license card', isMandatory: true },
      ],
    },
  ],
};

export const PASSPORT_CONFIG: ServiceWorkflowConfig = {
  serviceKey: 'passport_reissue',
  serviceName: 'Passport Re-issuance',
  description: 'Ordinary Passport Re-issuance and Renewal with Biometrics and Police Verification',
  trackingPrefix: 'PP',
  compensationRatePerDayDelayINR: 300,
  stages: [
    {
      key: 'psk_biometrics',
      name: 'PSK Biometric & Document Verification',
      departmentCode: 'PASSPORT_OFFICE',
      slaDays: 2,
      slaHours: 48,
      requiredDocuments: ['old_passport', 'address_proof'],
      checklists: [
        { id: 'psk_physical_surrender', label: 'Verify physical surrender and validity of previous passport booklet', isMandatory: true },
        { id: 'psk_biometric_capture', label: 'Capture ten-finger biometric fingerprint scans and facial photograph', isMandatory: true },
        { id: 'psk_annexure_compliance', label: 'Verify Annexure-E non-ECR proof and self-declaration of nationality', isMandatory: true },
      ],
    },
    {
      key: 'police_clearance',
      name: 'Police Security Verification',
      departmentCode: 'POLICE_DEPT',
      slaDays: 7,
      slaHours: 168,
      requiredDocuments: ['character_certificate'],
      checklists: [
        { id: 'police_nbw_clearance', label: 'Verify absence of pending non-bailable warrants (NBW) or travel bans', isMandatory: true },
        { id: 'police_address_tenure', label: 'Verify current residential address in jurisdiction for past 12 months', isMandatory: true },
      ],
    },
    {
      key: 'rpo_dispatch',
      name: 'RPO Sanction & Printing Dispatch',
      departmentCode: 'PASSPORT_OFFICE',
      slaDays: 3,
      slaHours: 72,
      isFinalStage: true,
      requiredDocuments: [],
      checklists: [
        { id: 'rpo_gazetted_signoff', label: 'Regional Passport Officer (RPO) gazetted sanction & digital signature', isMandatory: true },
        { id: 'rpo_security_dispatch', label: 'Authorize printing at Security Printing Press & speed-post dispatch tracking', isMandatory: true },
      ],
    },
  ],
};

export const TRADE_LICENSE_CONFIG: ServiceWorkflowConfig = {
  serviceKey: 'trade_license',
  serviceName: 'Commercial Trade License',
  description: 'Municipal Commercial Establishment and Business Operation Sanction',
  trackingPrefix: 'TL',
  compensationRatePerDayDelayINR: 200,
  stages: [
    {
      key: 'ward_inspection',
      name: 'Ward Site & Fire Safety Inspection',
      departmentCode: 'MUNICIPAL_CORP',
      slaDays: 3,
      slaHours: 72,
      requiredDocuments: ['property_tax_receipt', 'fire_safety_noc'],
      checklists: [
        { id: 'ward_property_tax', label: 'Confirm zero outstanding property tax dues for commercial premises', isMandatory: true },
        { id: 'ward_zoning_compliance', label: 'Verify Master Plan commercial land-use and trade zoning compliance', isMandatory: true },
        { id: 'ward_fire_safety_inspection', label: 'Inspect fire extinguishers, emergency egress routes, and electrical load sanction', isMandatory: true },
      ],
    },
    {
      key: 'health_clearance',
      name: 'Public Health & Sanitation Clearance',
      departmentCode: 'HEALTH_DEPT',
      slaDays: 4,
      slaHours: 96,
      requiredDocuments: ['health_noc'],
      checklists: [
        { id: 'health_sanitation_audit', label: 'Conduct municipal hygiene, potable water test, and waste disposal audit', isMandatory: true },
        { id: 'health_trade_noc', label: 'Validate Medical Officer of Health sanitary clearance order', isMandatory: true },
      ],
    },
    {
      key: 'municipal_sanction',
      name: 'Municipal Commissioner Sanction',
      departmentCode: 'MUNICIPAL_CORP',
      slaDays: 3,
      slaHours: 72,
      isFinalStage: true,
      requiredDocuments: [],
      checklists: [
        { id: 'munc_commissioner_order', label: 'Executive Ward Officer / Commissioner statutory license execution', isMandatory: true },
        { id: 'munc_fee_reconciliation', label: 'Reconcile commercial trade fee schedule and generate QR license certificate', isMandatory: true },
      ],
    },
  ],
};

export const REGISTERED_SERVICES: Record<string, ServiceWorkflowConfig> = {
  gun_license: GUN_LICENSE_CONFIG,
  passport_reissue: PASSPORT_CONFIG,
  trade_license: TRADE_LICENSE_CONFIG,
};

/** Official department names (single source used by seed, demo reset and workflow sync). */
export const BASE_DEPARTMENTS = [
  { code: 'DM_OFFICE', name: 'District Magistrate Office', description: 'Licensing Authority & Final Sanction' },
  { code: 'POLICE_DEPT', name: 'Police Department', description: 'Field Inquiries & Character Verification' },
  { code: 'SP_OFFICE', name: 'Superintendent of Police Office', description: 'Senior Police Review & Security Appraisal' },
  { code: 'PASSPORT_OFFICE', name: 'Regional Passport Office (RPO)', description: 'Ministry of External Affairs Passport Division' },
  { code: 'MUNICIPAL_CORP', name: 'Municipal Corporation', description: 'Urban Local Body Ward & Trade Administration' },
  { code: 'HEALTH_DEPT', name: 'Public Health Department', description: 'Municipal Health Inspection & Sanitary Clearances' },
];
