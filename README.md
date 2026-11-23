# Tajir AI

AI-powered company setup platform (prototype). Users set up a company through a
conversation with an assistant called Tajir instead of long registration forms.

All fees, requirements and eligibility rules in this prototype are **sample
configuration data**, not real government or legal information. Nothing here
registers a real company or provides real financing.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Scaffolding, design system, app shell, shared contracts | Done |
| 2 | Frontend screens with sample data | Done |
| 3 | Backend, models, REST APIs, auth | Done (tested on in-memory and on MongoDB Atlas) |
| 4 | AI assistant (Gemini first, OpenAI as backup, built-in rules as the last fallback) | Done. Gemini is tested live. The OpenAI backup is built but its account has no credit yet |
| 5 | Frontend and API integration, real uploads, tracking | Done |
| 6 | End-to-end testing in a real browser (desktop and phone) | Done |

## Layout

```
client/   React + TypeScript + Vite + Tailwind (UI, design system, routes)
server/   Node + Express + TypeScript + Mongoose (REST API)
shared/   Zod schemas and workflow/status definitions used by both sides
docs/reference/   Place the reference screenshots here (design reference only)
```

## Running the app

Requires Node 20 or newer. From the project folder:

```powershell
npm install
npm run build --workspace shared
```

```powershell
npm run dev
```

That starts the server and the website together in one terminal, with each line tagged `[server]` or `[client]`. Press Ctrl+C to stop both. Open http://localhost:5173 and create an account. The server listens on port 4000 and the website forwards `/api` to it.

Prefer two terminals? `npm run dev:server` and `npm run dev:client` do the same job separately. Run `npm run build --workspace shared` again whenever you change anything in `shared`.

- **Data:** with `MONGODB_*` set in `server/.env` the server uses MongoDB Atlas, and only Atlas: it never switches to temporary storage when Atlas cannot be reached. With no `MONGODB_*` at all it uses an in-memory store and says so in its log.
- **"Origin not allowed. Your message was not sent."** The page is open at an address the server was not told about, most often because an old dev server was still running and the website started on another port (5174, 5175 and so on). The website now refuses to start on a second port, and the error names the page's address and the accepted ones. Stop the old servers (`Get-NetTCPConnection -LocalPort 4000,5173,5174,5175 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`) and start again with `npm run dev`.
- **If Atlas refuses the connection** (usually because this computer's IP address is not under Atlas > Network Access, or the password in `server/.env` is out of date), the server stays up, the website says the database is not connected, and both recover by themselves a few seconds after you fix it. No restart is needed.
- **AI:** set `GEMINI_API_KEY` (tried first) and/or `OPENAI_API_KEY` in `server/.env` for the full assistant that answers questions. Without a working key the chat can only follow the two guided flows. See "Turning the assistant on" below.
- **Files:** uploads are checked by content and stored in MongoDB (GridFS). They can be previewed, downloaded, read again and deleted, and the app reads each one so you can ask the chat about it. See "Document intelligence" below.
- **Nothing is kept in the browser** except the session cookie, which the page cannot read.

## Document intelligence

Uploaded documents are stored, read, and can be asked about in the chat. This is real, working code, not a simulation; the parts that depend on services you set up yourself are called out below.

### What happens to an upload

```
browser -> POST /api/documents/upload (signed in, rate limited)
        -> checked while streaming: real file signature (PDF / PNG / JPEG), matches the extension, not empty, not cut off, size limit, no scripts in a PDF
        -> streamed into MongoDB GridFS (bucket "tajir_documents"), never held whole in memory, never public
        -> record in MongoDB (documents) + one job record (documentprocessingjobs)
        -> the job is started at once, and a worker inside the server also checks MongoDB every few seconds for jobs that are due
        -> the worker reads the file back from GridFS and checks its SHA-256
        -> PDF text, or Tesseract OCR for scanned PDF pages and images   (no AI needed)
        -> text, searchable pieces and a guessed document type are saved  (no AI needed)
        -> optional: an AI model fills in the details of a trade licence, passport, bank statement or business plan
        -> status moves queued -> processing -> completed / partially_completed / failed (retrying in between)
```

**Statuses.** `uploaded`, `queued`, `processing`, `retrying`, `completed`, `partially_completed`, `failed`. `completed` only ever means text was really read. `partially_completed` means the text was read but something else did not work (the AI step was unavailable, some pages could not be read, or the document was very long). A file that cannot be read (blank, damaged, password protected, OCR off for a scan) is `failed` with the reason, never `completed`.

**MongoDB is the only queue. There is no Redis.** Each document has one job record in MongoDB (idempotent: uploading twice or pressing "read again" twice makes no second job). A worker inside the server takes due jobs with an atomic claim, so two workers can never take the same job. A worker that dies is recovered (its job lease runs out and another takes it), a document saved but never queued is queued by a recovery sweep, retries back off (5 s, 10 s...), and a file that keeps crashing the worker stops after `DOCUMENT_JOB_ATTEMPTS`. `GET /api/health` reports `queue.mode: "database"`.

**What the AI does and does not do.** It is optional (`DOCUMENT_AI_ENABLED`) and has no tools: it can only return JSON, which is then checked. Document text is treated as untrusted data (a document that says "ignore your instructions" is just words). ID numbers, IBANs, card-like numbers, passport machine-readable lines and emails are removed before text is sent. Every extracted fact must appear in the document's own text or it is blanked; missing information is `null`; the AI's own summary is stored separately as "interpretation"; any statement that a document is genuine, valid, expired, approved or compliant is removed, and so are links. Nothing is called verified: the app shows "Read automatically ... has not been checked with the issuing authority".

**Chat.** Questions about *your own* uploaded documents are answered from your documents only. This covers specific questions ("What is my licence number?", "What is the expiry date?"), whole-document questions ("What does my document contain?", "Summarize this document", "What information is available in my uploaded files?") and "Compare my uploaded documents". A file you have just attached in the conversation is what "it" and "this document" mean, and is looked at first; your other documents are used when it does not answer, or when you ask about all of them. For a specific question a few short excerpts are searched in MongoDB (filtered by your user id); for a whole-document question the start of each document and the details read from it are used. A model, if there is one, writes a short answer from those excerpts, names the file it came from and cites its sources; without a model, or when it fails, the passages are quoted instead. If a file has not been read yet, or could not be, the reply says so and says nothing about its content. If the documents do not contain the answer, the reply is exactly "I couldn't find this information in your uploaded documents." Questions that are not about your own documents ("What documents do I need for a free zone company?") go to the normal assistant, as before. Attach a file with the paperclip, or pick one already in Documents with the folder button: attaching the same file again, or picking an existing document, never makes a second copy.

**API** (all need sign-in; another person's document is always "not found"):

| Method and path | Purpose |
|---|---|
| `POST /api/documents/upload` | Multipart: `typeId`, optional `applicationId` + `requirementId`, optional `reuseExisting=true` (the chat's attach button: if the same file is already yours, that document is returned with `reused: true` and nothing new is kept), and `file`. |
| `GET /api/documents` | List, with `page`, `pageSize`, `status`, `typeId`, `applicationId`, `search`. |
| `GET /api/documents/:id` | Details, including what was read (not the raw text). |
| `GET /api/documents/:id/status` | Cheap status check for polling. |
| `GET /api/documents/:id/view` / `/download` | The file, inline or as an attachment, streamed from GridFS with the real type, `nosniff` and `Cache-Control: private, no-store`. |
| `POST /api/documents/:id/reprocess` | Read it again (queued; pressing twice makes no second job). |
| `DELETE /api/documents/:id` | Hidden at once; the file, text, pieces and job are then removed (finished by a sweep if interrupted). |

**Moving older documents from local disk to GridFS.** Documents uploaded before GridFS stay readable from `server/uploads` automatically. To move them, run the migration. It is a dry run unless you say `--apply`, it copies only files whose size and SHA-256 match their record, reads each copy back before pointing the record at it, never deletes a local file, can be undone, and can be run again safely:

```powershell
npm run migrate:documents --workspace server
npm run migrate:documents --workspace server -- --apply
npm run migrate:documents --workspace server -- --rollback --apply
```

It also lists files in `server/uploads` that no record points to (it only lists them).

**Known limits.** OCR is English only (`@tesseract.js-data/eng`; Arabic needs its language data added) and reads at most 10 scanned pages per document. PDF script detection is best effort (a PDF can hide the word). Search in chat is word-based over MongoDB, not semantic: the retriever is a single interface so Atlas Vector Search can replace it later. Rate limits are per server process. Deleting a document does not undo what an application already recorded about it. Upload progress is shown as "Uploading..." and then the processing status, not a percentage.

## Phase 5 and 6: the connected app

The browser app talks only to the server. Sign-in and sign-up pages guard every other page, and the data for each person is loaded again when they sign in, so nobody sees the previous person's data.

| Area | How it works |
|---|---|
| Sessions | httpOnly cookie. A request refused with 401 sends the user back to sign in with a note, and signing in returns them to the page they were on. |
| Chat | Every message and button goes to `POST /api/conversations/:id/messages`. The user's message shows at once, replies arrive when the server answers, and a failed turn shows what went wrong with a button to send it again. |
| Review screen | Edits go to `PATCH /api/conversations/:id/draft`, which checks them with the same rules as the chat. |
| Uploads | The browser sends the real file with the application and requirement it is for. The server checks its content, stores it and records the step. A refusal shows the server's reason. |
| Status | Status, progress and requirements are computed from each application's recorded events. Pages ask the server for the latest when opened, on focus and every 20 seconds. |
| Attention items | The urgent card and list on Home come from the user's real open requirements. There are no sample reminders. |

The loading, error, empty and success states are in `client/src/components/ui/StateViews.tsx` and the pages that use it.

### Browser tests

```powershell
npm run test:e2e
```

Playwright drives the installed Chrome (no browser download) against the real server and client, on a desktop window and on a phone, 32 tests each. The server runs on its own ports with in-memory data and the built-in rules, so a run never touches Atlas or OpenAI. It covers sign-up, sign-out and sign-in, the whole company journey including missing documents, clarification and uploads, Working Capital Finance on its own, every page on both screen sizes, and ownership checks between two accounts. Screenshots are written to `docs/e2e/`.

The server limits sign-ups to 10 per hour per address, and each run uses about 8, so run it once per server start (each run starts a fresh server).

## Phase 4 AI orchestration

The chat endpoint now understands free text. With an OpenAI key it uses the model; without one it uses the same deterministic rules as before. Either way the model never decides anything: it reads a message and proposes values, and the workflow engine validates them and does the rest.

### How one chat turn works

```
user message ──> provider (OpenAI, or the rules) ──> proposal (structured, untrusted)
                                                          │
   engine validates each value, one step at a time <──────┘
        │
        ├─ reply text, cards, options and quick replies: written by the engine from configured data
        └─ effects (create application, record an answer): carried out by the application service,
           the same validated code path the REST API uses, then the reply names the real result
```

- **The AI has no database access.** The provider receives the message and a small context (see below) and returns a structured proposal. It is given no repository, no service and no record id. Records change only when the engine asks for an effect and the application service accepts it.
- **Structured outputs.** The reply must match a strict JSON schema derived from the shared Zod contract (`shared/src/ai.ts`), and is validated again before use. Fields the contract does not know are dropped.
- **Provider architecture.** `server/src/ai/` holds the provider interface, the Gemini and OpenAI providers, the chain that tries them in order, the resilience wrapper and the factory. To add Anthropic, implement `LlmProvider` and add one case in `factory.ts`. The "rules" provider is the built-in guide: no model, used when no key is set and as the fallback when a model cannot be reached.
- **Context management.** The workflow state (stored with the conversation and re-validated on every turn) keeps the business facts across messages. The model gets only: where the workflow is, the facts collected so far, the open question, the catalogue ids it may choose from, and the last few messages trimmed short. It never gets an email, a name, a company name from the account, a token, a document or a record id.
- **Resilience.** Each attempt has a timeout and is aborted when it runs out. Transient failures (timeouts, 429, 5xx, network) are retried with exponential backoff and jitter. An unusable answer gets one repair attempt. Bad keys, unknown models and an empty account are not retried. After repeated failures a circuit breaker skips the model for a while. Whenever the model cannot be used, the turn is answered by the deterministic rules, so the user is never left with an error.

### What the AI is never allowed to do

| Rule | How it is enforced |
|---|---|
| Never invent fees, eligibility, approvals, legal requirements or financing terms | Factual content (options, packages, prices, summaries) is always written by the engine from the sample catalogue. Model text is shown only for general conversation, only after a claims guard that rejects amounts, percentages, timeframes, fee, eligibility, approval, financing and outcome wording, links and contact details. Questions about those topics get a fixed reply and the model text is not used at all. |
| Never pick an option for the user | A registration type, jurisdiction, package or company name proposed by the model is used only if the user's own message names it. Ids must also exist in the catalogue and belong together. |
| Never submit on its own | Submission happens only from the Confirm button, or from the user's own unmistakable typed confirmation at the review step that is not a question and not a refusal. A model saying "the user confirmed" is not enough. |
| Never write to MongoDB | See above: no access, proposals only, validated effects through the application service. |
| Never leak the key | The key is read from `server/.env` on the server only, is never logged, and provider errors are reduced to a status and a code. |

### Conversation API

`POST /api/conversations/:id/messages` takes either a typed message or a button action. Unknown fields, and bodies that mix both, are rejected.

```json
{ "text": "We do consulting, called Desert Rose" }
{ "action": { "type": "select", "step": "jurisdiction", "cardId": "shams" }, "display": "Shams" }
{ "action": { "type": "confirm", "step": "review" } }
{ "action": { "type": "clarify", "applicationId": "FIN-2026-050123" } }
{ "action": { "type": "uploaded", "applicationId": "FIN-2026-050123", "requirementId": "req-bank_statement_6m" } }
```

The response holds the new messages, the suggested quick replies, the workflow state and `assistant.mode` (`rules`, `ai` or `fallback`). A new conversation opens with a welcome message. Buttons and suggested replies never call the model.

### Turning the assistant on

Put your keys in `server/.env` (never in chat, never in a commit) and restart the server:

```
GEMINI_API_KEY=<your Gemini key>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_FALLBACK_MODEL=gemini-3.1-flash-lite
OPENAI_API_KEY=<your OpenAI key, optional>
OPENAI_MODEL=gpt-4.1-mini
```

`AI_PROVIDER` defaults to `auto`, which tries these in order and uses the first that works:

1. **Gemini** with `GEMINI_MODEL`
2. **Gemini** with `GEMINI_FALLBACK_MODEL` (the same key, a second model, in case the first is overloaded)
3. **OpenAI** (needs `OPENAI_API_KEY` and credit on the account)
4. **The built-in rules** (the guided steps only, and the chat says so)

Each model has its own timeout, retries and circuit breaker, so a model that is down is skipped quickly instead of making every user wait. `AI_PROVIDER=gemini` or `openai` limits it to one vendor, and `rules` never uses a model. Model names change over time: if the live check says "not found", list the models your key can use at https://ai.google.dev/gemini-api/docs/models and update `GEMINI_MODEL`.

The start-up log, `GET /api/health` and the Profile page say which assistant answers first and which is the backup, and the server log shows for each chat turn which model answered and which were skipped. The chat shows a note when no model is connected or when a reply had to come from the built-in guide.

**What it answers.** Ordinary questions (general knowledge, explanations, writing, maths, advice, small talk) get a real answer of up to about 1,200 characters, and it remembers the last ten messages so follow-ups work. It cannot browse the internet, so it says so for live information such as today's weather.

**What it will not do.** For anything about setting up a company in the UAE, licences, visas, taxes, fees, eligibility, legal rules, approvals or financing, it only gives short general information, or the fixed "I can't confirm that" reply for fees, eligibility, legal rules, approvals and financing, and never states figures, deadlines or promises. Any answer that contains a link, contact details, markup, a leak of its instructions, or a claim that the user's own application was submitted or approved is replaced by a neutral message. The fee and package figures in the app are sample catalogue data, not real UAE data.

```powershell
npm run test:live --workspace server   # optional: real Gemini and OpenAI calls with sample text, uses a little quota
```

## Phase 3 backend

Express, TypeScript and MongoDB (Atlas) with cookie-session authentication. The browser app uses it for all data (see Phase 5 and 6).

**What is real:** accounts and sessions, the eight MongoDB collections, the REST API, server-side validation of every input, ownership checks on every read and write, and real file storage on the server's disk with content inspection.
**What is not:** cloud file storage, and any real authority or lender.

### Run it

```powershell
npm install
npm run build --workspace shared
npm run dev:server
```

Settings live in `server/.env` (git-ignored; see `server/.env.example`). For Atlas set `MONGODB_USER`, `MONGODB_PASSWORD` and `MONGODB_HOST` (the URI is built and the password encoded), or set a full `MONGODB_URI`. With neither, the server uses an in-memory store for development and says so loudly. In production it refuses to start without a database, and refuses a weak `JWT_SECRET`. If Atlas is configured but unreachable the server stops instead of quietly losing data; check the Network Access list in Atlas.

### API

All routes except health, register and login need the session cookie. Every user-owned lookup includes the user id, so another user's data is reported as "not found".

| Route | Purpose |
|---|---|
| `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Accounts and session |
| `GET /api/services`, `GET /api/services/:id` | Service catalogue (sample data, marked as such) |
| `POST /api/applications`, `GET /api/applications?filter=`, `GET /api/applications/:id` | Create and read applications |
| `PATCH /api/applications/:id` | `provide_information` or `simulate_next` (simulation is off in production) |
| `GET /api/applications/:id/documents`, `GET /api/documents` | List documents |
| `POST /api/documents/upload` | Multipart upload, optionally attached to an application requirement |
| `POST /api/conversations`, `GET /api/conversations`, `GET /api/conversations/:id`, `POST /api/conversations/:id/messages` | Chat: history, and one assistant turn per message or button (see Phase 4) |
| `GET /api/health` | Mode report, no secrets |

### How progress stays honest

An application is its event log. Status, progress, requirements and dates are computed from the events by the shared package, on the server and in the client, and nothing can be recorded out of order (the same gate runs in both). A step shows as done only if its event exists. Under review and Completed can only be recorded by a labelled simulation in the prototype. The `status` stored on the application is only a cache.

### Security notes

- Passwords: bcrypt, 8 to 72 characters, common passwords refused, same answer and timing for a wrong password and an unknown account.
- Session: signed JWT (HS256 only) in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production. The account must still exist for a token to work.
- Requests: strict schemas (unknown fields are rejected, so a caller cannot set a status or a date), operator objects are rejected, JSON limited to 100 KB, an origin check on writes, rate limits on sign-in, sign-up, uploads and overall.
- Uploads: PDF, PNG or JPG only, checked by real file signature as well as extension, size limited, keys generated by the server (the file name never decides a path), no overwrite, owner-only metadata, a per-user cap, and cleanup if recording the step fails. There is no download route yet.
- Errors never include internals; the cause goes to the server log only.
- Concurrency: a unique index on each application's events means two simultaneous requests cannot record the same step twice.

### Tests

```powershell
npm test                                         # shared, server (in-memory repositories), client (against an in-memory stand-in for the server)
npm run test:integration --workspace server      # same contract and API journeys on MongoDB Atlas
npm run test:live --workspace server             # optional: real Gemini and OpenAI calls
```

The AI tests use a scripted stand-in for the model, so they are fast, free and repeatable. They cover invalid and missing values, unusable answers, API failures, timeouts, retries and the circuit breaker, fallback to the rules, prompt injection and compromised model output, and the guarantee that the model cannot write records.

The integration run creates a database named `tajir_test_<random>`, uses only that, and drops it. The repository contract in `server/src/repositories/contract.ts` runs against both the in-memory and the MongoDB implementation, so the in-memory stand-in is proven to behave like the real database.

## Phase 2 frontend (history)

This describes the original standalone prototype. The client now uses the server for all data; the screens and the sample catalogue are unchanged.

- **Workflow engine:** the deterministic workflow engine lives in `shared/src/chat/engine.ts` and is used by the browser prototype and by the server. It reads a message and proposes a reply and the next step. It never changes data itself: it returns effects that the caller carries out, and every step change is checked against the allowed order in `shared`.
- **Sample data:** `shared/src/catalog.ts` (registration types, jurisdictions, packages, documents) is shared by the client and the server, is configurable and clearly labelled as sample. A price is optional, and a missing price shows as "Pricing on request" instead of an invented figure.
- **Persistence and uploads:** in the standalone prototype these were kept in the browser, with only file names and sizes. That no longer applies: the server holds all data and stores uploaded files.
- **Screens:** `docs/screens/` holds captures of the finished mobile and desktop screens. `docs/reference/` holds the design reference.

Routes: `/login`, `/register`, `/dashboard` (Home), `/chat`, `/company-setup`, `/company-setup/review`, `/applications`, `/applications/:id`, `/activity`, `/documents`, `/profile`, and `/design` (style guide).

## Setup

Requires Node 20 or newer.

```powershell
npm install
npm run build --workspace shared
```

Copy `server/.env.example` to `server/.env` and fill in values. `.env` is
git-ignored and must never be committed. Without any configuration the server
runs with the built-in guide (no AI model) and no database, which is enough for the health endpoint
and the tests.

Run both apps in two terminals:

```powershell
npm run dev:server
npm run dev:client
```

The client runs on http://localhost:5173 and proxies `/api` to the server on
port 4000.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript check for shared, server and client |
| `npm run build` | Production build of all three packages |
| `npm test` | Vitest for all three packages |
| `npm run lint` | Lint client, shared and server |
| `npm run test:e2e` | Browser tests in Chrome, desktop and phone |
| `npm run test:integration --workspace server` | Repository contract and API journeys on MongoDB Atlas |
| `npm run test:live --workspace server` | Optional real Gemini and OpenAI checks with sample text, including reading sample documents |
| `npm run migrate:documents --workspace server` | Moves older local-disk documents into GridFS (dry run unless `-- --apply`) |

## Environment variables (server)

Set in `server/.env`, never committed. `server/.env.example` lists them all.

| Variable | Purpose |
|---|---|
| `MONGODB_USER`, `MONGODB_PASSWORD`, `MONGODB_HOST`, `MONGODB_DB_NAME` | Atlas connection parts. The URI is built and the password URL-encoded. |
| `MONGODB_URI` | Alternative: a full connection string. Takes priority. |
| `CLIENT_ORIGIN` | The exact address of the website (default `http://localhost:5173`). Several can be listed, separated by commas. Writes from any other page are refused with "Origin not allowed", and CORS answers only for these. In development `localhost` and `127.0.0.1` are treated as the same site, on the same port. No wildcards. |
| `JWT_SECRET` | Signs session tokens. At least 32 random characters in production. |
| `JWT_EXPIRES_IN`, `BCRYPT_ROUNDS` | Session lifetime and password hashing cost. |
| `AI_PROVIDER` | `auto` (default: Gemini, then OpenAI, then the built-in rules), `gemini`, `openai` or `rules`. |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | The Gemini assistant and its second model. The key is server-side only and must never be committed. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | The OpenAI backup. The key is server-side only and must never be committed. |
| `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_MAX_OUTPUT_TOKENS` | Per-attempt timeout (default 10000), retries for transient failures (default 2) and the cap on the reply (default 1500). |
| `STORAGE_PROVIDER`, `UPLOAD_DIR`, `MAX_UPLOAD_MB` | File storage. `gridfs` (default) keeps files in MongoDB; `local` keeps them on disk in `UPLOAD_DIR`. Files already on local disk stay readable either way. `MAX_UPLOAD_MB` is the size limit (default 10). There is no cloud object storage. |
| `DOCUMENT_OCR_ENABLED`, `DOCUMENT_AI_ENABLED` | Both default to on. OCR is local (Tesseract). Turning AI off means no document text is ever sent to a model. |
| `DOCUMENT_WORKER_CONCURRENCY`, `DOCUMENT_JOB_ATTEMPTS`, `DOCUMENT_JOB_BACKOFF_MS` | How many documents are read at once (default 2), how many tries a document gets (3), and the first retry delay (5000). |
| `COOKIE_SECURE`, `SIMULATION_ENABLED`, `TRUST_PROXY` | Optional overrides. Production defaults: secure cookies, no simulation. |

## Design reference

The three reference screenshots (Company Setup, Review and Submit, Status and
Clarifications) belong in `docs/reference/`. See the README there for file names.
