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

## Ticket translation

**It works with no configuration at all.** With no key, no container and nothing
in `.env`, the button translates: two free public engines are in the chain by
default. Everything below is about making it faster, private, or better.

The engine runs behind a provider layer. Set `TRANSLATE_PROVIDER` to pin one, or
leave it at `auto` — which tries each configured engine in order and falls
through to the next when one is down, out of quota, or cannot handle the
language. Four separate services have four separate ways of being unavailable,
and an agent looking at a French ticket does not care which one answers.

| Provider | Cost | Where ticket text goes | Configure with |
| --- | --- | --- | --- |
| `libretranslate` | free | your own server | `LIBRETRANSLATE_URL`, optional `LIBRETRANSLATE_API_KEY` |
| `anthropic` | per call | Anthropic | `ANTHROPIC_API_KEY`, optional `TRANSLATE_MODEL` |
| `mymemory` | free | MyMemory, a public service | nothing; `MYMEMORY_EMAIL` raises the daily allowance, `MYMEMORY_URL=off` disables it |
| `libretranslate-public` | free | a volunteer-run public instance | nothing; `TRANSLATE_PUBLIC_FALLBACK=off` disables it, or set it to your preferred instance |

That is also the auto order. The two public engines sit last so they are only
reached when nothing better is set up, and they complement each other: MyMemory
cannot be asked to detect a language, so a bare subject like "Annulation" goes
to the public LibreTranslate, which can.

To keep ticket text off public services entirely, set both `MYMEMORY_URL=off`
and `TRANSLATE_PUBLIC_FALLBACK=off`, then configure one of the top two.

Translations are cached per ticket, target language and exact source text, and
the cache is shared across agents, so the second person to open the same French
ticket costs nothing on any provider. Switching provider invalidates the cache
rather than serving one engine's output under another's name.

**Recommended: self-hosted LibreTranslate.** It is free and it is the only
option where client mail stays on infrastructure you control — which is the
reason this feature exists, since agents were otherwise pasting ticket bodies
into public translators. Bring it up with:

```bash
docker compose -f docker/libretranslate.compose.yml up -d
```

Then set `TRANSLATE_PROVIDER=libretranslate` and
`LIBRETRANSLATE_URL=http://localhost:5000`. Language packages are downloaded on
first boot and chosen by `LT_LOAD_ONLY` in that compose file; add languages
there as the inbox starts receiving them. A target with no installed package
fails with a message saying so, rather than quietly returning the original text.

**MyMemory** needs no setup at all and exists so the button works on a fresh
checkout. It is last in the auto order on purpose: it is a third party, and its
free tier contributes translations to a public translation memory, so it should
be a deliberate choice for a support inbox rather than a default. The picker
names whichever engine is in force and warns when text leaves the server. To
rule it out entirely — so no misconfiguration elsewhere can fall through to a
public service — set `MYMEMORY_URL=off`. Its free allowance is 5,000 characters
a day anonymously, or 50,000 with `MYMEMORY_EMAIL` set.

**Anthropic** costs money per uncached ticket and is clearly the best of the
three at the things that matter on a support board: keeping a client's register,
translating support vocabulary the way the industry does, handling threads that
mix languages, and leaving product names like Jira and HubSpot alone. A server
that already has `ANTHROPIC_API_KEY` set keeps using it under `auto`.

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
