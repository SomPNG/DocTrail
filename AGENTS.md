# AGENTS.md — DocTrail Workspace Guide for AI Agents

> **Project Identity**: **DocTrail** (Government Application Tracking & SLA Workflow Engine)  
> **Core Concept**: *"Parcel tracking for government applications."* Track every application, track every stage, track every deadline, and make every delay explainable.

---

## 0. Mandatory Agent Protocol (READ & UPDATE)

> ⚠️ **MANDATORY INSTRUCTION FOR ALL AI AGENTS**:
> 1. **Before beginning work**: You MUST view and read:
>    - [`.agents/MEMORY.md`](.agents/MEMORY.md) (Architectural decisions, SLA mathematical formulas, and gotchas)
>    - [`.agents/PROGRESS.md`](.agents/PROGRESS.md) (Current completion matrix, passing tests, and roadmap)
>    - [`.agents/INSTRUCTIONS.md`](.agents/INSTRUCTIONS.md) (How to add services, run commands, and write code)
> 2. **After completing any task**:
>    - You MUST update [`.agents/PROGRESS.md`](.agents/PROGRESS.md) with any newly implemented features, test runs, or milestone updates.
>    - If you made architectural decisions or found new gotchas, you MUST document them in [`.agents/MEMORY.md`](.agents/MEMORY.md).
>    - All tests (`npm test`) must pass before concluding.

---

## 1. Quick Reference & Commands

| Task | Command | Description |
| :--- | :--- | :--- |
| **Start Dev Server** | `npm run dev` | Runs Express backend with `tsx watch` on `http://localhost:4000` |
| **Run All Tests** | `npm test` | Runs 20 unit and E2E tests with Vitest |
| **Run Demo Flow** | `npm run demo` | Headless automated simulation of the full application lifecycle |
| **Inspect Database** | `npx prisma studio` | Visual database viewer at `http://localhost:5555` |
| **Apply DB Changes** | `npx prisma db push` | Pushes `prisma/schema.prisma` updates to SQLite |
| **Seed Database** | `npm run prisma:seed` | Populates default departments, seed users, and demo applications |
| **Build Project** | `npm run build` | Compiles TypeScript into `dist/` |

---

## 2. Seed Users & Credentials

All test accounts share the default password: **`Password123!`**

| Actor | Email | Role | Department Code | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Citizen** | `citizen@example.com` | `CITIZEN` | `null` | Primary citizen applicant (Aarav Sharma) |
| **DM Officer** | `dm.officer@example.com` | `OFFICER` | `DM_OFFICE` | District Magistrate verification & sanction |
| **Police Officer** | `police.officer@example.com` | `OFFICER` | `POLICE_DEPT` | Field verification & character inquiry |
| **SP Officer** | `sp.officer@example.com` | `OFFICER` | `SP_OFFICE` | Superintendent of Police review |
| **Passport Officer**| `passport.officer@example.com`| `OFFICER`| `PASSPORT_OFFICE` | Regional Passport Officer (Suresh Menon) |
| **Ward Officer** | `municipal.officer@example.com`| `OFFICER`| `MUNICIPAL_CORP` | Municipal Corporation Ward Officer (Pooja Hegde) |
| **Supervisor** | `supervisor@example.com` | `SUPERVISOR` | `null` | Global oversight, bottlenecks, compensation approval |

---

## 3. Technology Stack

- **Runtime**: Node.js (v24.x)
- **Language**: TypeScript (`ES2022`, strict mode)
- **API Server**: Express.js
- **Database & ORM**: SQLite via Prisma ORM (portable, zero-daemon; configurable to PostgreSQL)
- **Authentication**: JWT with Bearer tokens & bcryptjs
- **Validation**: Zod schema validation
- **Testing**: Vitest + Supertest
- **Frontend**: Vanilla CSS & modern JavaScript served statically from `public/`

---

## 4. Architecture & Module Map

```text
src/
├── app.ts                  # Express application setup, routes mount, and static public assets
├── index.ts                # Server entry point, service workflow synchronization
├── config/
│   ├── env.ts              # Zod environment variables validator
│   └── workflowConfig.ts   # Configurable SLA durations & Gun License stage definitions
├── db/
│   └── client.ts           # PrismaClient singleton
├── common/
│   ├── errors.ts           # Custom AppError, NotFoundError, ForbiddenError, ConflictError
│   ├── middleware.ts       # authenticate (JWT), authorize (RBAC), validateBody (Zod)
│   └── utils.ts            # Standard sendSuccess, tracking number, and QR token generators
└── modules/
    ├── auth/               # Registration, Login, Current User profile
    ├── applications/       # Application creation, retrieval, role filtering
    ├── workflow/           # Stage transitions (advance, complete), hold/resume logic
    ├── sla/                # Real-time SLA engine (on-track, at-risk, breached, paused duration)
    ├── events/             # Immutable audit event log (event sourcing) & timeline generator
    ├── documents/          # Document requests, uploads, SLA pause/resume interaction
    ├── analytics/          # Supervisor metrics, department workload, bottleneck detector, risk score
    ├── compensation/       # SLA breach delay compensation evaluation & supervisor sign-off
    ├── notifications/      # Multi-channel notification dispatcher (SYSTEM, EMAIL, SMS)
    └── integrations/       # Legacy government event adapter & QR physical file resolver
```

---

## 5. Critical Domain Rules (Enforce at All Times)

1. **Rule 1 (Authorized Progression)**: Only an authorized officer belonging to the active stage's department (or a supervisor) can advance an application.
2. **Rule 2 (Citizen Data Privacy)**: Citizens can strictly view and upload documents only to their own applications.
3. **Rule 3 (No Premature Advance)**: A stage cannot be completed if there are unresolved `PENDING` document requests.
4. **Rule 4 (Document Attribution)**: All document requests must link to the active application and stage instance.
5. **Rule 5 (Event-Driven Pauses)**: Putting an application on hold or requesting a document MUST record `SLA_PAUSED`. Uploading all requested documents or manual resumption MUST record `SLA_RESUMED`.
6. **Rule 6 (Accurate Paused Math)**: The SLA clock must never overwrite timestamps. It calculates active elapsed duration by subtracting valid accumulated paused duration.
7. **Rule 7 (Audit Immutability)**: Historical events in `stage_events` are append-only. Never modify or delete past events.
8. **Rule 8 (Sequential Progression)**: Applications must follow the configured `orderIndex` and cannot skip stages arbitrarily.
9. **Rule 9 (Supervisor Supremacy)**: Supervisors possess global visibility across all departments and sole authority to sign off on delay compensations.
10. **Rule 10 (Separation of Concerns)**: Keep business status (`CREATED`, `IN_PROGRESS`, `ON_HOLD`, `COMPLETED`) cleanly separate from SLA status (`ON_TRACK`, `AT_RISK`, `BREACHED`, `PAUSED`).
