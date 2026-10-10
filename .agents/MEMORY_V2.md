# MEMORY_V2.md: backend v2 decisions & gotchas (read after MEMORY.md; this file wins where they conflict)

## Superseded statements in MEMORY.md / PROGRESS.md
- **ADR-08**: The watchdog *is* now started in `src/index.ts` (it was not before). Use `SLA_WATCHDOG_ENABLED` and `SLA_WATCHDOG_INTERVAL_MS`.
- **ADR-12**: Demo reset requires a SUPERVISOR or ADMIN token and `DEMO_MODE`. It creates no apps unless called with `{withSamples:true}`.
- **ADR-14**: The old seal used `JSON.stringify(obj, sortedTopLevelKeys)`. That replacer dropped every nested key, so the hash ignored the payload. Most events also bypassed sealing entirely. Both are fixed (see ADR-V2-03).
- **Gotcha I**: The checklist wildcard `{'*': true}` / `{all: true}` was a bypass and has been removed.
- **Section 4 tracking numbers** are now `GL-2026-000042` (sequential), no longer `KL-2026-<4 random digits>`.

## ADR-V2-01 Virtual clock (`src/common/clock.ts`)
- Never call `new Date()` for business time. Use `Clock.now()`.
- Events, notifications and created rows set `createdAt` explicitly from the clock.
- The offset is persisted in `simulation_state` and loaded at boot.
- Tests that need time to pass call `Clock.advance()` and reset it in `afterAll`. Do not back-date `startedAt`.

## ADR-V2-02 Latched SLA transitions
- `SlaService.refreshApplicationSla` is the only place that emits `SLA_WARNING`, `SLA_BREACHED`, `ESCALATED`, the related notifications and compensation.
- It latches `atRiskAt` / `breachedAt` on the stage instance.
- `Application.breachedStageCount` keeps the history for analytics.

## ADR-V2-03 Audit chain
- `EventService.record(tx, …)` must be used inside the caller's transaction. Never write `stageEvent.create` directly.
- Each event gets `seq`, `prevHash` and `chainHash`.
- The seal covers `{applicationId, stageId, eventType, actorId, actorRole, seq, createdAt, payload}` using `stableStringify`.
- The verifier recomputes every hash.

## ADR-V2-04 Hold types
- `holdType` is one of `CITIZEN_DOCS | ADMIN_HOLD | CORRECTION | EXTERNAL`.
- Only `CITIZEN_DOCS` auto-resumes on upload.
- Forwarding while paused returns 409.
- `closePauseData()` banks the pause time.

## ADR-V2-05 AccessPolicy (`src/common/access.ts`)
- One place answers view and act questions.
- Officers can view only files whose workflow involves their department, and can act only on the active stage of their own department.
- Officers with no department can do nothing.
- ADMIN does not do casework.

## ADR-V2-06 Diagnosis (`src/modules/diagnosis`)
- Deterministic reason codes, used everywhere: application detail, tracking, officer queue, stuck board, AI explain-delay, assistants.
- The watchdog persists `Application.stuckReasonCode`.

## ADR-V2-07 Simulation (`src/modules/simulation`)
- The simulator drives real services; it never inserts fake rows.
- Simulated apps have `isSimulated=true`. `POST /api/sim/reset` deletes only those.
- The queue model: capacity = `officers × parallelFilesPerOfficer`.
- Calibration rule: `normal_week` must keep every department utilisation below 0.9. This is asserted in `tests/core_logic.test.ts`. Re-check it when you change profiles.

## ADR-V2-08 Clean Slate Reset (`POST /api/demo/clear-data`)
- Destructive reset available when `DEMO_MODE=true` to wipe all applications, documents, events, notifications, and uploaded disk files across all upload directory locations.
- Accessible from top-right Reset button on both TopBar and SignIn pages.

## ADR-V2-09 Unified Frontend & Backend Serving
- Express backend (`src/app.ts`) detects and serves the built Vite frontend (`public/` or `frontend/dist/`), handling SPA client routing on GET requests for non-API routes.
- Development mode uses `concurrently` from root `package.json` to run backend (:4000) and Vite (:3000) with proxy. Production bundle is synced into `backend/public/`.

## Gotchas
- **Prisma nullable filters.** `{ field: { not: x } }` and `NOT: { field: x }` both exclude NULL rows. Add `OR: [{ field: null }, …]` when NULL should match.
- **Two config shapes.** Registered services use `stages[].key` with string `requiredDocuments` and `compensationRatePerDayDelayINR`. AI/admin services use `stageKey`, object docs and `compensationPerDay`. Always read them through `ServiceConfig`.
- **SQLite interactive transactions.** Inside `prisma.$transaction(async tx => …)` never call the root `prisma` client, because SQLite has a single writer and the call can deadlock.
- **Test database.** Tests use `prisma/test.db` (see `vitest.config.ts` and `tests/setup/global-setup.ts`). Never point tests at `dev.db`.
