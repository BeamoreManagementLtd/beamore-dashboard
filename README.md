# Beamore dashboard

Private staff dashboard for Beamore Management: finance (director only), overdue invoice chasing, projects against allowance, the diary, clerk reports, personnel and team due lists.

Decisions behind the design: `G:\My Drive\Business\Beamore Management\Beamore Dashboard - Decisions and To-do.docx`.

## Stack

| Part | Service | Notes |
|---|---|---|
| Web app | Next.js on **Vercel** (same account as the snagging app, separate project) | Vercel's own address for now (`beamore-dashboard.vercel.app`). `dashboard.beamore.co.uk` is in use by the Codex build until Ronan chooses which dashboard to keep |
| Database, sign-in, files | **Supabase** (same organisation as the snagging app, separate project) | Row-level security enforces roles |
| Sign-in | Google, `@beamore.co.uk` accounts only | Ronan = director, everyone else = admin |
| Data in | Scheduled sync jobs (Vercel Cron) | Xero, Google Drive (diary, register, report sheets), Gmail labels |

## Roles

- **director**: everything.
- **admin**: operations and the overdue chase queue. Fees, rates, margins, cash, unbilled work, clerk costs and DBS evidence live in director-only tables (`project_finance`, `proposal_revision_fees`, `clerk_costs`, `finance_snapshots`, `rates`, `clerk_evidence`), so the database refuses them to admin accounts whatever page or API call asks.

## Data sources

| Source | What | How |
|---|---|---|
| Xero | Invoices, overdue, P&L, cash, bills | Xero API (OAuth app) |
| `Diary\Diary 2026.xlsx` | Planned (grey) and charged (salmon) visits, clerks, rates, invoice emails | Google Drive API, read xlsx |
| `Cost Proposals\Beamore Cost Proposals Register.xlsx` | Projects, stages, agreed days, fees | Google Drive API |
| Sheet "Beamore Reports Ready To Check" | Reports waiting to check | Google Sheets API |
| `Diary\Beamore Report Turnaround Dashboard.xlsx` | Report turnaround log | Google Drive API |
| Gmail | Threads labelled `Dashboard/...` | Gmail API |

## Setup steps that need Ronan

These create accounts or credentials, so only you can do them. Each takes a few minutes.

1. **GitHub repository**: at github.com/new, signed in as BeamoreManagementLtd, create a **private** repo called `beamore-dashboard` with no README. (The GitHub connection used by Claude can read but not create repositories.)
2. **Supabase project**: in the Supabase dashboard (same organisation as the snagging app) choose *New project*, name it `beamore-dashboard`, region London (eu-west-2). Save the database password in your password manager.
3. **Google sign-in**: in Google Cloud Console create an OAuth client (Web application) for the Beamore Workspace, then paste its client ID and secret into Supabase → Authentication → Providers → Google. Claude will give you the exact redirect URL once step 2 exists.
4. **Xero app**: at developer.xero.com create an app called "Beamore dashboard" (Web app). Its client ID and secret go into Vercel's environment variables, not into chat.
5. **Vercel project**: import the GitHub repo from step 1 into the same Vercel team as the snagging app, and add the environment variables from `.env.example`.
6. **Domain (later, not now)**: `dashboard.beamore.co.uk` currently points at the Codex dashboard. Only if this build is chosen, repoint that `CNAME` to `cname.vercel-dns.com`. Until then use the `.vercel.app` address.

Never paste passwords, client secrets or service keys into chat. Put them straight into Supabase, Vercel or your local `.env.local`.

## Local development

```bash
npm install
npm run dev
```

Database changes live in `supabase/migrations/`.
