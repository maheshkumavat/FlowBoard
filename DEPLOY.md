# Deployment Guide: FlowBoard on Vercel & Supabase

This guide outlines the step-by-step instructions to deploy **FlowBoard** to Vercel and connect it to your Supabase project.

---

## 1. Database Setup in Supabase

1. Open your [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Go to the **SQL Editor** tab from the left sidebar.
3. If this is a fresh project without existing tables, paste and run:
   - `supabase/schema.sql`
4. If you already ran a previous version of the schema, run the idempotent migration file:
   - `supabase/migrations/002_fixes.sql`
   *(Both scripts are safe and idempotent to run multiple times)*.

---

## 2. Supabase Auth & Redirect URLs Configuration

In your Supabase project dashboard:
1. Navigate to **Authentication** -> **URL Configuration**.
2. Set **Site URL**:
   - For local development: `http://localhost:3000`
   - For production: `https://<your-vercel-app>.vercel.app`
3. In **Redirect URLs**, add:
   - `http://localhost:3000/auth/callback`
   - `http://localhost:3000/**`
   - `https://<your-vercel-app>.vercel.app/auth/callback`
   - `https://<your-vercel-app>.vercel.app/**`
4. (Optional) If enabling GitHub Login or GitHub Skill Matcher:
   - Go to **Authentication** -> **Providers** -> **GitHub**.
   - Enable GitHub and copy the **Callback URL (for OAuth)** provided by Supabase:
     `https://<your-supabase-project-id>.supabase.co/auth/v1/callback`
   - Go to your GitHub account -> **Settings** -> **Developer Settings** -> **OAuth Apps**.
   - Create a new OAuth app, set the Authorization callback URL to the Supabase URL above, and paste your GitHub Client ID & Secret into Supabase and into Vercel environment variables.

---

## 3. Environment Variables for Vercel

In your Vercel Project Dashboard (**Settings** -> **Environment Variables**), add the following:

### Required Variables
| Variable Name | Description | Where to find |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase Project URL | Supabase Dashboard -> Project Settings -> API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Anon Key | Supabase Dashboard -> Project Settings -> API |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret Service Role Key | Supabase Dashboard -> Project Settings -> API *(Keep confidential!)* |
| `JWT_SECRET` | Secret key for JWT signing & session validation | A strong 64-char random hex string (pre-generated in `.env`) |
| `NEXT_PUBLIC_SITE_URL` | Base production URL | `https://<your-vercel-app>.vercel.app` |
| `GROQ_API_KEY` | Groq LLM API Key | [Groq Console](https://console.groq.com/keys) (Used for AI Task Breakdown & Auto-Assignment) |

### Optional Variables
| Variable Name | Description | Where to find |
|---|---|---|
| `SUPABASE_JWT_SECRET` | Supabase Project JWT Secret | Supabase Dashboard -> Project Settings -> API -> JWT Settings |
| `GEMINI_API_KEY` | Google Gemini AI Key | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `RESEND_API_KEY` | Resend Email API Key | [Resend](https://resend.com/api-keys) (For project invite emails) |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | GitHub Developer Settings -> OAuth Apps |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | GitHub Developer Settings -> OAuth Apps |

---

## 4. Vercel Architecture & Real-Time Considerations

### Does FlowBoard depend on `server.js` (Socket.io)?
- **No.** Next.js on Vercel runs in a serverless environment and uses standard `next build` and `next start` semantics.
- Custom Express servers like `server.js` do not run on Vercel serverless functions.
- FlowBoard's real-time capabilities (live Kanban task movements, activity feeds, chat messages, notifications, and board columns) are handled via **Supabase Realtime** (`supabase.channel(...)`), which is edge-compatible, WebSocket-native, and runs completely independently of `server.js`.
- Verified: No component, page, or API route in the application imports or relies on `server.js` or `socket.io-client`.

---

## 5. Deployment Steps on Vercel

1. Push your repository to GitHub / GitLab / Bitbucket (verify `.env` is NOT committed; `.gitignore` includes `.env*`).
2. Log into [Vercel](https://vercel.com) and click **Add New** -> **Project**.
3. Import your FlowBoard repository.
4. Keep the Framework Preset as **Next.js**.
5. Ensure Build Command is `next build` and Output Directory is `.next`.
6. Expand **Environment Variables** and enter the variables listed in Section 3 above.
7. Click **Deploy**.
8. Once deployment is complete, copy your production domain (e.g. `https://flowboard-xyz.vercel.app`) and:
   - Update `NEXT_PUBLIC_SITE_URL` in Vercel environment variables.
   - Update **Site URL** and **Redirect URLs** in your Supabase Dashboard as described in Section 2.
