# MetaFlow — Social Scheduler v2

Meta Business Suite scheduler with MongoDB persistence, Google Drive OAuth, server-side Instagram scheduling, and Groq AI captions.

## What's new in v2

- ✅ **MongoDB Atlas** persistence (no more localStorage)
- ✅ **Server-side Instagram scheduling** via Vercel Cron — works 24/7 without a browser open
- ✅ **Google Drive OAuth** (one-click sign-in, no service-account JSON pasting)
- ✅ **IG Queue view** with cancel buttons for pending posts
- ✅ **Custom-dates calendar picker** for scheduling
- ✅ **Custom-days option** for Drive Bot per-client config
- ✅ **Longer, contact-aware AI captions** (4–6 sentences with website/phone/email)
- ✅ **One-time migration** from old localStorage data on first load

## Architecture

```
Vercel (single deployment)
├── /public/index.html           — frontend (modified original)
├── /api/*                       — serverless functions
│   ├── portfolios, clients, brand-details, meta-accounts,
│   │   scheduled-posts, post-history, ig-queue, config
│   ├── auth/google/*            — OAuth flow + access-token mint
│   ├── migrate                  — localStorage → MongoDB importer
│   └── cron/publish-ig          — runs every 5 min (Vercel Cron)
└── MongoDB Atlas (same cluster as chatgpt-automation)
    └── collections: mf_portfolios, mf_clients, mf_brandDetails,
                     mf_metaAccounts, mf_scheduledPosts, mf_postHistory,
                     mf_igQueue, mf_config, mf_googleTokens
```

## Deploy steps (one-time setup)

### 1. Push to GitHub

```bash
cd metaflow
git add -A
git commit -m "v2: MongoDB + OAuth + server-side IG scheduling"
git push origin main
```

Vercel will auto-deploy on push.

### 2. Add environment variables in Vercel

Go to **vercel.com → your project → Settings → Environment Variables** and add:

| Variable | Value | How to get it |
|---|---|---|
| `MONGODB_URI` | `mongodb+srv://...` | Copy from your existing chatgpt-automation Render server env vars |
| `GOOGLE_OAUTH_CLIENT_ID` | `...apps.googleusercontent.com` | See step 3 below |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `GOCSPX-...` | See step 3 below |
| `APP_BASE_URL` | `https://YOUR-APP.vercel.app` | Your Vercel deployment URL (no trailing slash) |
| `ADMIN_TOKEN` | random 32-char string | Generate with `openssl rand -hex 16` or any password generator |

After adding, **redeploy** (Deployments → click latest → "Redeploy").

### 3. Create a new Google OAuth client (separate from chatgpt-automation)

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `MetaFlow Scheduler`
5. **Authorized redirect URIs** — add:
   ```
   https://YOUR-APP.vercel.app/api/auth/google/callback
   ```
6. Click **Create**
7. Copy the **Client ID** and **Client Secret** → paste them into Vercel env vars from step 2
8. Make sure **Drive API** is enabled at [API Library](https://console.cloud.google.com/apis/library/drive.googleapis.com) — click Enable if not already

### 4. Open the app and finish setup

1. Visit `https://YOUR-APP.vercel.app`
2. **If you have old localStorage data:** a banner will ask "Migrate to database?" — click **OK**. Migration is one-shot and safe.
3. **Settings → Groq AI** → paste your Groq API key → Save
4. **Settings → Google Drive** → click **Connect Google Drive** → sign in with your Google account → grant Drive access (you do this ONCE, refresh token persists forever)
5. **Settings → Meta** → paste your User Access Token → click **Smart Import All Pages**

That's it. The app now runs 24/7 from the database.

## Daily use

- **Schedule from upload** → click *New Schedule* → tick page targets → pick files → generate AI captions → click Schedule. FB posts via Meta's native scheduler, IG posts are queued in MongoDB and published by the cron.
- **Schedule from Drive** → set Drive folder + frequency in client edit → click *Run Now* on dashboard, or wait for the daily 1 PM auto-run.
- **Cancel a queued IG post** → sidebar → *IG Queue* → click 🗑 Cancel on any pending row.

## Custom-dates calendar

In **New Schedule → Step 2 (Frequency)**, click the 📅 *Pick specific dates* option. A mini-calendar appears — click any future date to add/remove it. Picked dates show as chips below. The scheduler uses these dates verbatim instead of repeating weekdays.

## Maintenance

- **Cron schedule:** `/api/cron/publish-ig` runs every 5 minutes via Vercel Cron. View runs in Vercel → Deployments → Cron Logs.
- **Google token:** refreshes automatically. If revoked, Settings → Disconnect → Connect again.
- **MongoDB:** all data lives in `mf_*` collections. Safe to inspect/edit via Atlas Data Explorer.

## Files

| Path | Purpose |
|---|---|
| `public/index.html` | Frontend SPA (modified single-file app) |
| `api/_lib/db.js` | MongoDB connection helper (cached) |
| `api/_lib/helpers.js` | Shared response/auth helpers |
| `api/_lib/crud.js` | Generic CRUD route factory |
| `api/_lib/googleOAuth.js` | OAuth token mint/refresh helpers |
| `api/portfolios/*` | Portfolios CRUD |
| `api/clients/*` | Clients CRUD (with cascade delete) |
| `api/brand-details/[clientId].js` | Per-client brand info (upsert) |
| `api/meta-accounts/*` | Meta accounts CRUD |
| `api/scheduled-posts/*` | Scheduled posts CRUD |
| `api/post-history/*` | Post history (read) |
| `api/ig-queue/*` | IG pending jobs (list, add, delete) |
| `api/config/*` | App-level config (Groq key, Meta token, metaPages) |
| `api/auth/google/start.js` | OAuth step 1: redirect to Google |
| `api/auth/google/callback.js` | OAuth step 2: handle code, save tokens |
| `api/auth/google/status.js` | Connection status (for UI) |
| `api/auth/google/access-token.js` | Mint fresh access token for frontend |
| `api/migrate.js` | One-time localStorage → MongoDB import |
| `api/cron/publish-ig.js` | Runs every 5 min, publishes due IG jobs |
| `vercel.json` | Cron schedule + output dir |
| `package.json` | Dependencies (just mongodb) |

## Troubleshooting

**"GOOGLE_OAUTH_CLIENT_ID env var not set"** → add the env var in Vercel, then redeploy.

**"Authorized redirect URI mismatch"** → the callback URL in your Google OAuth client doesn't match `APP_BASE_URL/api/auth/google/callback`. Update Google Cloud Console.

**IG posts not publishing at scheduled time** → check Vercel → Crons. The cron only runs on production deployments (not preview).

**Migration banner keeps appearing** → click OK once; it clears `mf_db` from localStorage. If it still appears, manually open DevTools → Application → Local Storage → delete `mf_db` and `mf_ig_queue`.

**"Cannot delete a job that is currently processing"** → the cron is mid-publish for that job. Wait 1-2 minutes for it to finish, then it'll show as `done` or `failed` and you can delete it.

## Tech stack

- Vercel (frontend + serverless functions + cron)
- MongoDB Atlas (same cluster as chatgpt-automation, `mf_*` collections)
- Google OAuth 2.0 (refresh token)
- Meta Graph API v19.0
- Groq API (llama-3.1-8b-instant / 70b)
