# Support Kanban Deployment

## What this version includes

- Existing Outlook/HubSpot board behavior is kept intact.
- Users are stored in Neon/Postgres through Prisma.
- Admin user management is available at `/admin/users` after logging in as an admin.
- Tickets from the Outlook-powered board state are mirrored into the `Ticket`, `TicketComment`, `TicketEvent`, and `SyncLog` tables whenever `/api/state` is saved.
- Original email data for each ticket is stored in `Ticket.emailRaw` for audit/debug reference.

## Local setup

1. Create `.env` from `.env.example`.
2. Set `DATABASE_URL` to your Neon connection string.
3. Set a strong `SESSION_SECRET`.
4. Install dependencies and prepare Prisma:

```bash
npm install
npm run db:generate
npm run db:migrate
node seed-admin.js
npm start
```

Open:

- App: `http://localhost:3000`
- Health check: `http://localhost:3000/healthz`
- Admin users: `http://localhost:3000/admin/users`
- Ticket database API: `http://localhost:3000/api/tickets`

## Production deployment

Recommended start command:

```bash
npm start
```

Recommended build command:

```bash
npm install && npm run db:generate && npm run db:migrate
```

Required production environment variables:

```env
NODE_ENV=production
TRUST_PROXY=true
DATABASE_URL="your_neon_connection_string"
SESSION_SECRET="long-random-secret"
KANBAN_USER=admin
KANBAN_PASS="temporary-first-admin-password"

M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
M365_REDIRECT_URI=https://YOUR_DOMAIN/auth/microsoft/callback
SUPPORT_MAILBOX=helpdesk@quinta.im

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=https://YOUR_DOMAIN/auth/hubspot/callback
```

After production deploy, run `node seed-admin.js` once if your hosting platform does not run it automatically.

## Important security note

The uploaded ZIP contained a `.env` file. Rotate the Neon password and any Microsoft/HubSpot secrets before production deployment.
