# DocTrail — AI Government Document & SLA platform

> **"Parcel tracking for government applications."**  
> *Track every application. Track every stage. Track every deadline. Make every delay explainable.*

---

## 1. Overview & Architecture

**DocTrail** is an enterprise-grade, event-sourced government application operating platform and SLA workflow engine. Instead of opaque, bureaucratic "black boxes", DocTrail treats citizen applications as auditable parcels moving through statutory departmental stages, tracking exact durations, enforcing regulatory checklists, pausing and resuming SLA clocks during citizen document submissions, automatically detecting bottlenecks, and calculating statutory delay compensation under the Right to Public Services Act.

### Core Architecture & Capabilities:
- **Strict 3-Portal Separation**: Gateway landing screen with dedicated, isolated portals for **Citizens**, **Officers**, and **Administrators / Supervisors** with explicit logout boundaries (no cross-role session bleed).
- **Dual-Engine AI Subsystem**: Powered by Google Gemini (`gemini-2.5-flash`) with full automatic fallback to an offline Sovereign Knowledge Base.
- **Natural Language AI Workflow Builder**: Administrators can specify any civic workflow (e.g. "Commercial Fire Safety NOC", "Borewell Drilling Clearance") in plain English to auto-synthesize multi-department pipelines with SLAs and verification checklists, and publish immutable versions.
- **Role-Specific Conversational AI Assistants**:
  - *Citizen Companion*: Empathetic status updates and document guidance strictly masked from confidential internal notes.
  - *Officer Copilot*: Statutory checklist evaluation, discrepancy detection, and standard regulatory approval remarks.
  - *Supervisor Forensics*: Systemic bottleneck analysis and delay compensation liability forecasting.
- **Autonomous Background SLA Watchdog Daemon**: Continuously scans active files, flags $<20\%$ at-risk stages, detects inactivity ($>3$ days), and auto-triggers compensation claims.
- **Immutable Event Sourcing**: Append-only `stage_events` audit trail enabling legal appellate review and RTI compliance.

```
                    ┌────────────────────────────┐
                    │      Citizen / Client      │
                    └─────────────┬──────────────┘
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │     REST API & RBAC        │
                    └─────────────┬──────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Workflow Engine │    │    SLA Engine    │    │  Event Sourcing  │
│  - Advance Stage │    │  - On-Track      │    │  - Immutable Log │
│  - Hold / Resume │    │  - At-Risk (<20%)│    │  - Full Timeline │
│  - Doc Requests  │    │  - Breached      │    │    Reconstruction│
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                     ┌───────────────────────┐
                     │ Relational DB (Prisma)│
                     └───────────────────────┘
```

---

## 2. Technology Stack

- **Runtime**: Node.js v24+ & TypeScript
- **Framework**: Express.js
- **ORM / Database**: Prisma ORM with SQLite (zero-config, portable; switchable to PostgreSQL via `DATABASE_URL`)
- **Authentication**: JWT & Bcrypt password hashing
- **Validation**: Zod schema validation
- **Testing**: Vitest & Supertest (Unit + End-to-End Workflow tests)

---

## 3. Seed Credentials

Run `npm run prisma:seed` to populate the default departments and test users (Password for all accounts: `Password123!`):

| Role | Name | Email | Department / Details |
| :--- | :--- | :--- | :--- |
| **Citizen** | Aarav Sharma | `citizen@example.com` | Individual Applicant |
| **DM Officer** | Rajesh Verma | `dm.officer@example.com` | `DM_OFFICE` (District Magistrate) |
| **Police Officer**| Insp. Vikram Singh | `police.officer@example.com` | `POLICE_DEPT` (Police Verification) |
| **SP Officer** | SP Anita Roy | `sp.officer@example.com` | `SP_OFFICE` (Superintendent of Police) |
| **Passport Officer** | Suresh Menon | `passport.officer@example.com` | `PASSPORT_OFFICE` (Regional Passport Office / PSK) |
| **Ward Officer** | Pooja Hegde | `municipal.officer@example.com` | `MUNICIPAL_CORP` (Municipal Corporation Inspection) |
| **Supervisor** | Comm. Sunita Rao | `supervisor@example.com` | Administrative Supervisor (Global) |

---

## 4. Multi-Service Workflows & SLA Rules

DocTrail supports extensible, declarative workflow pipelines across multiple public sectors:

### 4.1 Gun License (`gun_license`)
*Comprehensive arms license vetting pipeline across magistracy and law enforcement.*

| Stage # | Stage Key | Stage Name | Department | SLA Duration | Required Documents |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `dm_verification` | DM / Initial Verification | `DM_OFFICE` | 1 Day (24 hrs) | ID Proof, Address Proof |
| **2** | `police_verification` | Police Verification | `POLICE_DEPT` | 10 Days (240 hrs) | Character Certificate |
| **3** | `sp_review` | SP Review | `SP_OFFICE` | 5 Days (120 hrs) | - |
| **4** | `final_approval` | Final DM Approval | `DM_OFFICE` | 5 Days (120 hrs) | - |

### 4.2 Passport Re-issue (`passport_reissue`)
*Consular & police pipeline for citizen travel document verification and dispatch.*

| Stage # | Stage Key | Stage Name | Department | SLA Duration | Required Documents |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `psk_verification` | PSK Biometrics & Document Verification | `PASSPORT_OFFICE` | 2 Days (48 hrs) | Old Passport Copy, Address Proof |
| **2** | `police_inquiry` | Police Station Field Inquiry | `POLICE_DEPT` | 7 Days (168 hrs) | Local Residence Verification |
| **3** | `rpo_sanction` | RPO Sanction & Printing Dispatch | `PASSPORT_OFFICE` | 3 Days (72 hrs) | - |

### 4.3 Commercial Trade License (`trade_license`)
*Urban local body municipal license vetting and health inspection workflow.*

| Stage # | Stage Key | Stage Name | Department | SLA Duration | Required Documents |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `ward_inspection` | Ward Level Physical Site Inspection | `MUNICIPAL_CORP` | 3 Days (72 hrs) | Property Tax Receipt, Lease Deed |
| **2** | `health_clearance` | Health & Fire Safety NOC Verification | `HEALTH_DEPT` | 4 Days (96 hrs) | Fire Safety NOC, Food Safety License |
| **3** | `municipal_sanction` | Zonal Commissioner Final Sanction | `MUNICIPAL_CORP` | 2 Days (48 hrs) | - |

---

## 5. Quick Start & Setup

### Prerequisites
- Node.js v20+ / v24+
- npm v10+

### Installation & Run

```bash
# 1. Install root, backend, and frontend dependencies
npm install
cd backend && npm install
cd ../frontend && npm install
cd ..

# 2. Initialize database schema & seed accounts/workflows
cd backend
npm run prisma:push
npm run prisma:seed
cd ..

# 3. Run all automated tests (62/62 passing)
npm test

# 4. Launch unified full-stack application (Backend on :4000 + Frontend on :3000)
npm run dev
```

- **Frontend Application**: [http://localhost:3000](http://localhost:3000) (React 19 + Tailwind CSS)
- **Backend API Engine**: [http://localhost:4000/api](http://localhost:4000/api) (Express + Prisma)
- **Role Switcher**: Click any of the Quick-Switch actor buttons directly in the top header (Citizen, DM Officer, Police Officer, SP, Passport Officer, Ward Officer, Supervisor).

---

## 6. API Reference

### 6.1 Authentication

#### `POST /api/auth/register`
Create citizen or officer account.
```json
{
  "email": "applicant@test.com",
  "password": "Password123!",
  "name": "Jane Doe",
  "role": "CITIZEN",
  "phone": "+91 99999 88888"
}
```

#### `POST /api/auth/login`
Authenticate and obtain JWT Bearer token.
```json
{
  "email": "citizen@example.com",
  "password": "Password123!"
}
```

#### `GET /api/auth/me`
Retrieve authenticated user profile. (Requires `Authorization: Bearer <token>`)

---

### 6.2 Applications

#### `POST /api/applications`
Citizen submits new application. Supported `serviceKey` values: `gun_license`, `passport_reissue`, `trade_license`.
```json
{
  "serviceKey": "passport_reissue",
  "applicantName": "Aarav Sharma",
  "applicantDetails": {
    "passportNumber": "Z8912341",
    "district": "Ernakulam",
    "purpose": "Expiring validity renewal"
  }
}
```

#### `GET /api/applications`
List applications. Citizens see their own; Officers see their department's; Supervisors see all. Supports `?status=...&slaStatus=...&search=...`.

#### `GET /api/applications/:id`
Fetch application details with live SLA metrics and risk score.

---

### 6.3 Workflow & Stage Transitions

#### `POST /api/applications/:id/forward` (or `/complete-stage`)
Authorized officer completes current stage and advances application to next department.
```json
{
  "remarks": "Documents physically verified. Forwarded for field inquiry."
}
```

#### `POST /api/applications/:id/hold`
Puts application on hold; stops SLA timer.
```json
{
  "reason": "Court proceeding status check required"
}
```

#### `POST /api/applications/:id/resume`
Resumes an on-hold application; restarts SLA clock and adds elapsed paused duration.
```json
{
  "remarks": "Court clearance obtained"
}
```

---

### 6.4 Documents & SLA Pause Interaction

#### `POST /api/applications/:id/documents/request`
Officer requests missing document. Automatically records `SLA_PAUSED` and freezes SLA deadline.
```json
{
  "documentType": "address_proof",
  "title": "Valid Electricity Bill or Ration Card",
  "reason": "Address mismatch with local jurisdiction records"
}
```

#### `POST /api/applications/:id/documents/upload`
Citizen uploads required document. When all pending requests are resolved, records `SLA_RESUMED` and dynamically extends deadline by the exact paused seconds.
```json
{
  "documentRequestId": "<request_id>",
  "documentType": "address_proof",
  "title": "Electricity Bill - Oct 2026",
  "fileUrl": "https://storage.gov.in/doctrail/uploads/bill.pdf",
  "notes": "Verified address certificate attached"
}
```

#### `GET /api/applications/:id/documents`
List all uploaded documents and pending document requests.

---

### 6.5 Auditing, Timeline & SLA Status

#### `GET /api/applications/:id/timeline`
Retrieves chronological, immutable audit event log:
```json
{
  "success": true,
  "data": [
    { "eventType": "APPLICATION_CREATED", "timestamp": "2026-10-09T00:00:00Z" },
    { "eventType": "STAGE_ENTERED", "stageId": "...", "timestamp": "2026-10-09T00:00:01Z" },
    { "eventType": "STAGE_COMPLETED", "actorRole": "OFFICER", "timestamp": "2026-10-09T00:01:00Z" },
    { "eventType": "DOCUMENT_REQUESTED", "timestamp": "2026-10-09T00:02:00Z" },
    { "eventType": "SLA_PAUSED", "timestamp": "2026-10-09T00:02:00Z" },
    { "eventType": "DOCUMENT_SUBMITTED", "timestamp": "2026-10-09T00:03:00Z" },
    { "eventType": "SLA_RESUMED", "timestamp": "2026-10-09T00:03:00Z" }
  ]
}
```

#### `GET /api/applications/:id/sla`
Returns real-time SLA metrics:
```json
{
  "stageKey": "police_verification",
  "status": "ON_TRACK",
  "totalAllowedSeconds": 864000,
  "elapsedActiveSeconds": 14200,
  "pausedSeconds": 3600,
  "remainingSeconds": 849800,
  "slaDeadline": "2026-10-19T14:30:00Z"
}
```

---

### 6.6 Compensation Engine

#### `GET /api/applications/:id/compensation`
Evaluates whether active processing exceeded allowed SLA time (after subtracting valid paused durations).
```json
{
  "isEligible": true,
  "breachDurationSeconds": 432000,
  "breachDays": 5,
  "estimatedCompensationAmount": 1250,
  "record": {
    "status": "ELIGIBLE_PENDING_APPROVAL"
  }
}
```

#### `POST /api/applications/:id/compensation/review`
Supervisor approves or rejects compensation payout.
```json
{
  "recordId": "<compensation_record_id>",
  "action": "APPROVE",
  "remarks": "Approved statutory compensation for police department delay"
}
```

---

### 6.7 Supervisor Analytics & Dashboards

- `GET /api/dashboard/overview` — Total applications, active, completed, breached, and breach rate %.
- `GET /api/dashboard/departments` — Departmental processing times, breach rates, officer workloads.
- `GET /api/dashboard/bottlenecks` — Automatically detects stages with high backlog and delay severity scores.
- `GET /api/dashboard/breaches` — Lists all breached applications.
- `GET /api/dashboard/at-risk` — Applications with <= 20% SLA remaining.

---

### 6.8 Integrations & Physical File QR Tracking

#### `POST /api/integrations/events`
Adapter for external government legacy systems (e.g., CCTNS police records).
```json
{
  "sourceSystem": "POLICE_CCTNS",
  "externalEventId": "EV-9923",
  "trackingNumber": "KL-2026-1001",
  "eventType": "EXTERNAL_CLEARANCE",
  "status": "CLEAR"
}
```

#### `GET /api/integrations/qr/:code`
Instant lookup from physical paper file QR code tag, resolving current stage, responsible department, and SLA status.

---

### 6.9 AI Engine & Dynamic Workflow Synthesis (Versatile Automation)

DocTrail features a dual-engine AI subsystem (Google Gemini GenAI + Sovereign Knowledge Base fallback) enabling zero-code, instant provisioning of any public service and explainable delay forensics.

#### `POST /api/ai/synthesize-service`
Synthesizes a realistic, multi-stage statutory workflow with custom SLA hours, responsible departments, and mandatory document checklists for ANY government service prompt.
```json
{
  "prompt": "Industrial Environmental Clearance (PCB NOC) for chemical processing unit in Palakkad",
  "autoPersist": true
}
```

#### `POST /api/ai/apply`
End-to-end dynamic citizen intake: Citizen expresses their need in plain text; AI synthesizes the statutory workflow, creates departments/stages if needed, and launches the active tracking application with QR code and initial SLA deadline.
```json
{
  "intent": "Permission for Agricultural Borewell Drilling on family farmland",
  "applicantName": "Aarav Sharma",
  "applicantDetails": { "surveyNumber": "142/3", "district": "Palakkad" }
}
```

#### `GET /api/ai/evaluate-stage/:applicationId`
Examines active stage requirements against uploaded citizen documents. Returns a completeness score (0-100%), verified document list, and drafted missing document requests for the desk officer.

#### `POST /api/ai/auto-request-doc/:applicationId`
1-Click officer action: Issues an official document request based on AI diagnostic, automatically **pausing** the SLA clock and notifying the citizen.

#### `GET /api/ai/explain-delay/:applicationId`
Explainable AI delay forensic audit: Dissects wall-clock time vs. active time vs. paused time across departments, generating:
1. **Plain-English Citizen Summary**: RTI-compliant explanation of why the file is delayed and whether the delay is applicant-attributable or departmental.
2. **Supervisor Action Directive**: Specific interventions to resolve backlogs.

#### `GET /api/ai/catalog`
Returns all registered and AI-synthesized public services with their stage breakdowns and document requirements.

---

## 7. Testing & Verification

Run the test suite with Vitest:

```bash
npm test
```

Includes **62 automated tests** across 11 test suites (100% passing):
- **`file_upload_routing.test.ts`**: Real PDF/image upload, OCR entity extraction, auto-routing to entry department, non-government file rejection, and 1-click clean demo reset.
- **`checklist_enforcement.test.ts`**: Strict statutory verification checklist gate; officers cannot approve or advance without 100% verified legal checks.
- **`sla.test.ts`**: Pure deterministic SLA calculations (`ON_TRACK`, `AT_RISK`, `BREACHED`, `PAUSED`, deadline shifts).
- **`sla_watchdog.test.ts`**: Autonomous background SLA watchdog daemon detecting $<20\%$ at-risk stages, inactivity, and auto-triggering delay compensation.
- **`document_ai.test.ts`**: Identity & property document entity extraction (Aadhaar, utility bills, commercial trade).
- **`auth.test.ts`**: Authentication, JWT tokens, and strict role-based access control (RBAC).
- **`ai.test.ts`**: AI dynamic service synthesis, natural language application intake, stage document completeness evaluation, 1-click missing doc pause, and explainable delay diagnostics.
- **`ai_assistants.test.ts`**: Role-specific conversational AI assistants (Citizen Companion, Officer Copilot, Supervisor Forensics).
- **`admin.test.ts`**: Administrative workflow builder, schema modification, and immutable version publishing.
- **`workflow_e2e.test.ts`**: The complete 10-step demo lifecycle scenario.
- **`doctrail_acceptance.test.ts`**: Master golden path acceptance scenario for hackathon judges.
