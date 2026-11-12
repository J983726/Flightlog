# Flight Log

sUAS flight log for Jason Mann. Node + Express 5, EJS pages, SQLite (better-sqlite3), one shared password.

Live: https://flights.aegisrose.com (once DNS is set up)

## Run it locally

```
npm install
cp .env.example .env
npm run hash-password "pick a password"   # paste the output into ADMIN_PASSWORD_HASH
# put any long random string in SESSION_SECRET
npm run dev                               # http://localhost:3000
```

The database file is created at `DB_PATH` on first start. See `docs/schema.md` for the tables.

## Deploy (Railway)

- The Railway service deploys from this repo's `main` branch. Every push to `main` goes live.
- Volume mounted at `/data`.
- Variables: `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `DB_PATH=/data/flightlog.db`.
- Health check path: `/healthz`.
- Custom domain: `flights.aegisrose.com`, a CNAME in Namecheap pointing at the target Railway shows.

## Routes

| Route | What |
|---|---|
| `GET /login`, `POST /login`, `POST /logout` | Sign in and out. 5 wrong passwords lock login for 15 minutes. |
| `GET /` | Totals and the flight list, newest first |
| `GET /flights/new`, `POST /flights` | Log a flight (gear and field pre-filled from the last one) |
| `GET /flights/:id/edit`, `POST /flights/:id` | Edit |
| `GET /flights/:id/delete`, `POST /flights/:id/delete` | Confirm, then delete |
| `GET /aircraft`, `/aircraft/new`, `/aircraft/:id/edit` | List, add and edit aircraft. No delete; mark retired to hide from the flight form. |
| `GET /print?from=&to=` | Printable logbook: letter landscape, oldest first, totals, signature line, page numbers. Quick links for this month, last month, this year. |
| `GET /healthz` | Returns `ok`; no login |

Optional variable: `PILOT_NAME` (defaults to "Jason Mann") for the print header and signature line.

## Still to build

- Manage batteries, locations and certifications
- v1 import, CSV export
