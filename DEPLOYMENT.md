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

**It works with no configuration at all**, and it translates the *whole* ticket
— subject, card preview, internal notes, and the message body when the modal
opens. One action; the choice is remembered per ticket, so the body is
translated when it arrives from Outlook rather than by a second click.

By default this runs on **local models**, in-process: no key, no account, no
quota, and the text never leaves the server. That is what makes whole-ticket
translation affordable — a full thread is thousands of characters, which would
spend a hosted free tier on one ticket.

The models come from the optional `@huggingface/transformers` package that
`npm install` fetches (~380MB, and the install still succeeds without it — the
engine simply reports itself unavailable and the chain moves on). Individual
language packages are ~40–80MB each, downloaded the first time someone asks for
that language and then cached in `data/mt-models/`, which is gitignored. Delete
that directory to reclaim the space; the next translation re-fetches only what
it needs.

Expect roughly half a second per text run once a language is loaded, so a long
thread takes some tens of seconds the first time and is instant afterwards for
everyone — translations are cached server-side and shared. Inference runs in a
worker thread, so the board stays responsive while it works.

The engine runs behind a provider layer. Set `TRANSLATE_PROVIDER` to pin one, or
leave it at `auto` — which tries each configured engine in order and falls
through to the next when one is down, out of quota, or cannot handle the
language. Four separate services have four separate ways of being unavailable,
and an agent looking at a French ticket does not care which one answers.

| Provider | Cost | Where ticket text goes | Configure with |
| --- | --- | --- | --- |
| `local` | free | nowhere — stays in this process | nothing; `TRANSLATE_LOCAL=off` disables it, and see **Keeping the local engine small** below |
| `libretranslate` | free | your own server | `LIBRETRANSLATE_URL`, optional `LIBRETRANSLATE_API_KEY` |
| `anthropic` | per call | Anthropic | `ANTHROPIC_API_KEY`, optional `TRANSLATE_MODEL` |
| `mymemory` | free | MyMemory, a public service | nothing; `MYMEMORY_EMAIL` raises the daily allowance, `MYMEMORY_URL=off` disables it |
| `libretranslate-public` | free | a volunteer-run public instance | nothing; `TRANSLATE_PUBLIC_FALLBACK=off` disables it, or set it to your preferred instance |

That is also the auto order: local first, then anything self-hosted or already
paid for, and the two public engines last, reached only when nothing better is
set up. They complement each other — MyMemory cannot be asked to detect a
language, so a bare subject like "Annulation" goes to the public LibreTranslate,
which can.

The local models are pairwise, so they need to know the source language and
cannot serve every pair: where there is no direct model it pivots through
English, and where even that is unavailable (Greek and Hebrew, currently) the
request falls through to the next engine rather than failing.

To keep ticket text off public services entirely, set `MYMEMORY_URL=off` and
`TRANSLATE_PUBLIC_FALLBACK=off`. The local engine alone then handles everything
it has a model for, with nothing leaving the server at all.

### Keeping the local engine small

Translating locally costs memory while it runs, and the shape of that cost was
measured on this repo's model cache with a mail-sized body, three tickets in a
row:

| | after ticket 1 | 2 | 3 | peak |
| --- | --- | --- | --- | --- |
| ONNX arena on (the runtime's default) | 414MB | 571MB | 682MB | 675MB |
| arena off (what ships) | 414MB | 416MB | 409MB | 571MB |

The climb is the thing to avoid: ONNX Runtime keeps freed blocks in a per-session
arena for reuse, and since every ticket is a different shape it kept adding new
ones, so the footprint only ever went up until the worker was torn down. With the
arena off each batch hands its memory back and the engine sits flat at around
410MB, for roughly two thirds more wall clock.

The rest is the model: about 300MB per resident language pair once its ONNX
sessions are built. So one translation needs ~500–600MB peak, and that is the
floor unless the model changes. What it does *not* need is to hold that between
tickets — the worker is torn down once nobody has translated anything for
`TRANSLATE_LOCAL_IDLE_MS` (45s by default), which measured RSS going from 424MB
back to 54MB.

| Variable | Default | Effect |
| --- | --- | --- |
| `TRANSLATE_LOCAL_IDLE_MS` | `45000` | How long a loaded model is kept for the next ticket. `0` keeps it resident forever. Lower it to give memory back sooner, at a couple of seconds' reload on the next translation. |
| `TRANSLATE_LOCAL_MAX_MODELS` | `1` | Resident language pairs (~300MB each). `2` keeps a language and its reverse warm on a bigger box. |
| `TRANSLATE_LOCAL_ARENA` | off | `on` restores the runtime's own allocator: faster, and the climb above comes back. |
| `TRANSLATE_LOCAL_HEAP_MB` | unset | V8 heap ceiling for the worker thread. Bounds the JS side only — the weights and tensors are native — but on a small box a worker that dies with an error the app reports beats the kernel choosing a process to kill. |
| `TRANSLATE_LOCAL_BATCH_ROWS` / `_BATCH_COST` | `8` / `3200` | Rows per model call and rows × longest-row-chars. Lower them for a smaller working set per batch; below about 4 rows it stopped buying memory and only cost time. |
| `TRANSLATE_LOCAL_THREADS` | `0` (runtime decides) | Not a memory lever — measured within noise at 0 and 2. Set it to stop translation taking CPU from the web server. |
| `TRANSLATE_LOCAL_BATCH_RATIO` | `8` | How far apart in length two rows may be before they are batched separately. A correctness guard, not a tuning knob — see below. |
| `TRANSLATE_LOCAL_BEAMS` | `4` (the model's own) | A recorded dead end: greedy decoding measured within noise on peak RSS (539MB against 568MB) and was slower (7.3s against 6.1s over 24 rows), because it keeps generating where a beam search has settled. Lowering it buys nothing. |

**One thing to leave alone.** `TRANSLATE_LOCAL_BATCH_RATIO` exists because
batching a long paragraph beside a very short line makes
`@huggingface/transformers` 4.2.0 corrupt *every* row in that batch: it keeps
generating for rows that have already finished, and since Marian's pad token is
in the model's own `bad_words_ids` it emits periods instead — a run exactly as
long as the token budget that was left. Rows of similar length, or rows sent one
at a time, come back clean, so batches are capped by length spread. There is a
second guard after the fact that trims a trailing run of repeated punctuation the
source did not have, and logs when it does.

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
# Optional. Extra addresses the board's Reply composer may send as, on top of
# SUPPORT_MAILBOX which is always offered. Each one also needs Send As granted
# to the connected Outlook identity in Exchange, or Graph refuses the send.
REPLY_FROM_ADDRESSES=

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=https://YOUR_DOMAIN/auth/hubspot/callback
```

After production deploy, run `node seed-admin.js` once if your hosting platform does not run it automatically.

## Replying to a ticket from the board says Outlook refused the send

Symptom: the reply composer opens, but sending reports "Outlook refused the
send: reconnect it to grant mail-send permission".

Replying needs two Graph scopes the board did not use before it could reply:
`Mail.Send` and `Mail.Send.Shared`. `Mail.Send.Shared` is the one that matters -
the reply is drafted on the message where it lives, in the helpdesk mailbox,
which is not the connected identity's own.

Both are in the default `M365_SCOPES` now, but a connection made before they
were added still holds a token without them. Reconnect Outlook (the Microsoft
sign-in on the board) so consent is granted again, and if the tenant requires
admin consent for the app, grant that first.

The other cause of the same message is a From address that is not the helpdesk
mailbox: sending as it needs Send As granted to the connected identity in
Exchange, per address listed in `REPLY_FROM_ADDRESSES`.

## Tickets open with no formatting and no images

Symptom: opening a ticket shows one run-together paragraph of plain text, no
inline pictures, and the board otherwise works normally.

That is the Microsoft 365 connection failing, not a rendering bug. The board
itself (tickets, notes, assignment, SLA, KPIs) is served from our own database
and keeps working, so only the message body - which is fetched live from Graph -
disappears. Since the last change the modal says which failure it hit and offers
the action that fixes that particular one; before that it silently fell back to
the flattened `bodyPreview`.

Check the credential first:

```bash
npm run check:m365
```

* **`invalid_client` / AADSTS7000215 / AADSTS7000222** - the app's own client
  secret is wrong or expired. Reconnecting Outlook in the app cannot fix this.
  Azure portal -> App registrations -> this app -> Certificates & secrets ->
  New client secret -> copy the **Value** column into `M365_CLIENT_SECRET` and
  restart.

  `M365_CLIENT_SECRET` must be the secret **Value**, never the **Secret ID**.
  Azure shows both next to each other and only the Value is a credential. The ID
  is a GUID, so a 36-character hex-and-dashes value is always wrong - the server
  now says so at boot, and `npm run check:m365` refuses it outright. Client
  secrets also expire (6, 12 or 24 months), which is the usual way this breaks
  on a system that had been working.

* **`invalid_grant` / AADSTS70008x** - the secret is fine and the stored refresh
  token has expired or been revoked. Sign in again at `/auth/microsoft/start`.

* **HTTP 429/503/504** - Graph throttling. The server already retries these with
  backoff, and the pictures are fetched separately so a throttled attachment
  call no longer discards the whole message.

## Important security note

The uploaded ZIP contained a `.env` file. Rotate the Neon password and any Microsoft/HubSpot secrets before production deployment.
