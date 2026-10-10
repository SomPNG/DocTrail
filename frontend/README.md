# DocTrail frontend

React 19 + Vite + Tailwind CSS v4 + lucide icons, talking to the DocTrail v2 backend.

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000, /api is proxied to http://localhost:4000
npm run build      # production build in dist/
```

Start the backend first (`cd backend && npm run dev`). For realistic data run `npm run prisma:seed:samples` in the backend once.

## Screens

| Who | Screen | Backend endpoints |
|---|---|---|
| Everyone | Sign in, create a citizen account, one-click demo accounts | `/api/auth/*` |
| Citizen | Applications list. For each application: the route line, where the file is, why it is waiting, a live deadline clock, uploads for requested documents, resubmission after a correction, plain-language history, and documents | `/applications`, `/:id/tracking`, `/:id/documents`, `/documents/upload`, `/:id/documents/upload`, `/:id/resubmit`, `/documents/upload-and-route` |
| Officer | Department queue, most urgent first, with the reason for each file. Case workspace: diagnosis, checklist, verify and forward (or approve at the final stage), request document, hold or resume, return for correction, reject, documents, and audit trail | `/officer/queue`, `/:id`, `/:id/checklists`, `/:id/timeline`, `/:id/assign`, `/:id/forward`, `/:id/decision`, `/:id/hold`, `/:id/resume`, `/:id/documents/request` |
| Supervisor / Admin | **Dashboard**: headline numbers, stuck files by reason, bottlenecks with the reason, 14-day trends, and time per department. **Simulation**: clock, scripted stories, scenarios, and demo data. **Messages**: mock SMS, WhatsApp and email outbox. **Staff** (admin only) | `/dashboard/*`, `/sim/*`, `/notifications/outbox`, `/admin/users` |

## How it connects

- `src/lib/api.js` is the only place that calls the backend. It stores the JWT and turns error responses into readable messages. It signs out on an expired token.
- **Simulated time.** Every response carries `X-Server-Now`. The client keeps the offset, so countdowns follow the backend's clock (`useServerNow()` in `src/lib/format.js`). While a simulation is ahead of real time, the top bar shows "Simulated time".
- **Uploaded files** open through a 60-second signed link (`GET /api/applications/:id/documents/:docId/view-token`), never a public `/uploads` URL.

## Structure

```
src/
  lib/api.js            backend client + server clock
  lib/format.js         labels, durations, countdown, useServerNow
  components/ui.jsx     buttons, badges, panels, fields, dialog, toasts, useAsync
  components/RouteLine.jsx   the department route (horizontal, vertical on phones)
  components/CaseWorkspace.jsx   shared officer/supervisor case view and actions
  components/Records.jsx    audit trail, citizen timeline, documents
  components/BarChart.jsx   small accessible bar chart
  components/TopBar.jsx     header, notifications, simulated-time indicator
  pages/SignIn.jsx, CitizenHome.jsx, OfficerDesk.jsx, Oversight.jsx, SimulationRoom.jsx
```

## Design notes

- Colours are tokens in `src/index.css` (`@theme`):
  - paper, ink, muted and line for the base;
  - one accent: civic navy `#22408c`;
  - four status colours (ok, warn, bad, paused), each always paired with a text label.
- Typeface: Public Sans with tabular figures for tracking numbers and times.
- Respects `prefers-reduced-motion`. Keyboard focus is always visible.
