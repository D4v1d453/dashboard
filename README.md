# Personal Dashboard

A set of small, self-contained HTML apps that share a top bar.

## Deploy your own copy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRowanThistlebrooke%2FYTdashh1)

One click → Vercel signs you in, copies the repo to your GitHub, and deploys it. ~30 seconds to a live URL.

## How to use

Open any `.html` file directly in your browser — no build step, no install.

| File | What it is |
|---|---|
| [index.html](index.html) | Goals tracker (Day Ring, Goal Ticker, To Do list, Long-Term Goals) — the home page |
| [health.html](health.html) | Supplement / daily stack tracker |
| [po-water.html](po-water.html) | Water intake tracker |
| [finance.html](finance.html) | Finances |
| [gym.html](gym.html) | Progressive overload gym tracker |
| [uni.html](uni.html) | University — subjects, syllabus progress, deadlines, continuous-assessment grades |
| [auth.html](auth.html) | Sign in / create account / forgot & reset password |
| [auth.js](auth.js) | Supabase Auth for every page — session, page protection, sign-out |
| [topbar.js](topbar.js) | Shared top bar — auto-injected into pages that `<script src="topbar.js">` |

Each app keeps its state in browser `localStorage` and syncs it to Supabase (`app_state` table, one row per user and section) through [sync.js](sync.js), with live updates across devices. Run [supabase/enable-realtime.sql](supabase/enable-realtime.sql) once in the Supabase SQL Editor so changes arrive instantly; without it they arrive within ~20 s via polling.

## Accounts & security

Every page requires a signed-in Supabase account ([auth.js](auth.js)). Data is private per account: Row Level Security on `app_state` and on the `progress-photos` bucket only lets a user read and write their own rows/files. The publishable key in the frontend is public by design; never put a secret / service-role key in this repo.

One-time database setup (Supabase → SQL Editor), in order:

1. [supabase/00-inspect.sql](supabase/00-inspect.sql) — read-only overview of tables, policies, buckets.
2. [supabase/01-auth-migration.sql](supabase/01-auth-migration.sql) — backup, `user_id` column, assigns existing rows to your account, owner-only RLS. Edit the email line first.
3. [supabase/02-storage-migration.sql](supabase/02-storage-migration.sql) — private photo bucket with owner-only access. Edit the email line first.

## Building from scratch

[BUILD_DASHBOARD.md](BUILD_DASHBOARD.md) is the prompt I gave Claude to generate `index.html` — paste it into Claude if you want to rebuild that page yourself.
