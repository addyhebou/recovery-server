# recovery-server

Express + Prisma API on Neon Postgres for the Recovery app. Single user, one password.

## Setup

```bash
cp .env.example .env      # fill in DATABASE_URL, DIRECT_URL, PASSWORD
npm install               # also runs prisma generate
npm run db:push           # creates the tables in Neon
npm run dev               # http://localhost:4000
```

The payoff list is seeded automatically the first time the client loads (credit card → utilities → parents $2k → car down → car remainder → Anjali → parents remainder).

## Deploy to Vercel

1. Import this repo in Vercel (framework preset: **Other**).
2. Add env vars: `DATABASE_URL`, `DIRECT_URL`, `PASSWORD`, and optionally `CLIENT_ORIGIN`.
3. Deploy. Health check: `https://<your-server>.vercel.app/api/health`.

Run `npm run db:push` locally (against Neon) whenever `prisma/schema.prisma` changes.

## API

All routes except `/api/health` and `/api/login` need `Authorization: Bearer <token>`.

| Method | Route | Body |
|---|---|---|
| POST | `/api/login` | `{ password }` → `{ token }` |
| GET | `/api/state` | → `{ settings, items, logs }` |
| PUT | `/api/settings` | `{ data: {...all calculator inputs} }` |
| POST | `/api/items` | `{ title, group?, amount, note? }` |
| PATCH | `/api/items/:id` | any of `{ title, group, amount, paid, done, note }` |
| DELETE | `/api/items/:id` | |
| PUT | `/api/items-order` | `{ ids: [...] }` |
| POST | `/api/logs` | `{ date, kind, source?, amount, note? }` where kind is `paycheck`, `stock`, `bonus`, `side`, or `expense` |
| DELETE | `/api/logs/:id` | |

Settings are stored as one JSON blob, so adding calculator fields never needs a migration.
# recovery-server
# recovery-server
