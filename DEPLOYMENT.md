# DocTrail Deployment Guide (Render + Vercel)

This repository is structured for quick, decoupled deployment:
- **Backend**: Hosted on [Render](https://render.com) (Node.js + Express + Prisma SQLite)
- **Frontend**: Hosted on [Vercel](https://vercel.com) (Vite + React)

---

## 1. Deploy Backend to Render

### Option A: Using Render Blueprint (1-Click)
1. Go to your [Render Dashboard](https://dashboard.render.com/) and click **New +** $\rightarrow$ **Blueprint**.
2. Connect your GitHub repository: `https://github.com/SomPNG/DocTrail.git`.
3. Render will automatically detect [`render.yaml`](./render.yaml).
4. Click **Apply**. Render will:
   - Install dependencies
   - Run `npx prisma generate && npx prisma db push && npm run prisma:seed && npm run build`
   - Start the server on `node dist/index.js`
   - Automatically generate a secure `JWT_SECRET`
5. Once deployed, copy your backend URL (e.g. `https://doctrail-backend.onrender.com`).

### Option B: Manual Web Service Setup on Render
1. In Render Dashboard, click **New +** $\rightarrow$ **Web Service**.
2. Connect the repository.
3. Configure the service:
   - **Name**: `doctrail-backend`
   - **Root Directory**: `backend`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run render-build`
   - **Start Command**: `npm run start`
4. Under **Environment Variables**, set:
   - `NODE_ENV`: `production`
   - `JWT_SECRET`: *(Enter any random 32+ character string)*
   - `DATABASE_URL`: `file:./dev.db`
   - `DEMO_MODE`: `true`
   - `SIMULATION_ENABLED`: `true`
   - `SLA_WATCHDOG_ENABLED`: `true`
   - `SLA_WATCHDOG_INTERVAL_MS`: `30000`
   - `PUBLIC_UPLOADS`: `true`
5. Click **Create Web Service**. Note down the URL once live.

---

## 2. Deploy Frontend to Vercel

1. Go to your [Vercel Dashboard](https://vercel.com/dashboard) and click **Add New...** $\rightarrow$ **Project**.
2. Import the `SomPNG/DocTrail` repository.
3. In **Project Configuration**:
   - **Root Directory**: Click edit and select `frontend` (or keep `./` as root, supported via [`vercel.json`](./vercel.json)).
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Under **Environment Variables**, add:
   - **Name**: `VITE_API_URL`
   - **Value**: `https://<your-render-backend-url>.onrender.com` *(no trailing slash)*
5. Click **Deploy**.

---

## 3. Seed Accounts for Live Demos & Judges

All accounts share the default password: **`Password123!`**

| Role | Email | Purpose |
| :--- | :--- | :--- |
| **Citizen** | `citizen@example.com` | Submit applications, upload required docs, track live SLA |
| **DM Officer** | `dm.officer@example.com` | First stage intake, assign & forward |
| **Police Officer** | `police.officer@example.com` | Field inquiry, request documents, trigger delays |
| **SP Officer** | `sp.officer@example.com` | Final review & approval |
| **Supervisor** | `supervisor@example.com` | Full bottleneck oversight, simulation room, delay compensation approval |
| **Admin** | `admin@example.com` | Department configuration & staff management |
