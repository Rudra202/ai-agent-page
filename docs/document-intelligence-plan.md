# Document intelligence: implementation plan

Written after inspecting the whole project, before any code was changed. It follows the stability-first rules: small steps, a test after each, no changes to anything that already works unless the feature needs it.

## Outcome: what was built, and where it differs from the plan below

The plan below is kept as it was written, before the work. The system is built; this section says where reality differs. The README ("Document intelligence") describes the finished system.

| Plan said | What was done |
|---|---|
| In-process job runner on a Mongo job collection | One persistent job record per document in MongoDB (idempotent enqueue, lease-token claims, retry with back-off, recovery of stuck work), taken by a worker inside the server. Redis and BullMQ were added first and then removed on the owner's instruction: MongoDB is the only queue. |
| Statuses `pending, processing, ...` | `uploaded, queued, processing, retrying, completed, partially_completed, failed` (plus a separate AI status). |
| Shared `aiWireSchema` gains `sourceDocumentIds` | Not done. Document questions are answered by their own path (`server/src/documentChat`), which never enters the workflow engine, so the chat wire contract did not need to change. Sources travel in the message payload. |
| One answer path | Three: records (list / missing), AI answer from excerpts with checked citations, and quoted passages when there is no model or it fails. |
| Atlas Vector Search later | `Retriever` is one small interface; today it scores words in MongoDB-stored text. |
| `POST /:id/reprocess` | Added with the other endpoints (not in the first plan). |
| Business profile association | A document uploaded for an application takes that application's business profile. There is no other link to a profile. |
| Migration | `npm run migrate:documents` (dry run by default; `--apply`; `--rollback`). The real database had 0 document records, so a dry run found nothing to move and listed 3 unreferenced local files, which it only reports. |

Not verified: OpenAI document reading (no credit; Gemini is used and was run live).

## What the inspection found

| Area | Today |
|---|---|
| Storage | `StorageProvider` can only `put` and `delete`. Nothing can be read back, so there is no view or download. Files go to `server/uploads` (or memory in tests). |
| Upload | multer holds the whole file in memory (limit 10 MB). Content is checked by signature and extension only. |
| Documents | One `documents` collection: owner, optional application, type, name, MIME type, size, sha256, storage key. No status, no extraction, no business-profile link. |
| Real data | Atlas has **0** document records. The upload folder holds 3 files that no record points to (leftovers from my own test runs). Nothing to lose in a migration. |
| Auth | `requireAuth` on every document route, `userId` in every repository query, so another user's document is "not found". |
| AI | Provider chain (Gemini, Gemini backup model, OpenAI, built-in rules) with timeouts, retries and breakers. Only one call shape exists: `interpret` for chat. |
| Chat | The orchestrator builds a small context (no personal data), the planner validates every proposal, and a claims guard checks model text. |
| Client | Documents page, upload button and composer paperclip exist. Documents are shown as records only. |

## Reused as they are

Authentication and ownership middleware, the repository pattern with its contract tests (memory and Mongo), the provider chain and resilience wrapper, the claims guard, the planner and orchestrator, the error handler, rate limiters, the design system and the existing pages.

## Modified

| Component | Change |
|---|---|
| `StorageProvider` | Adds streaming write (with size cap and SHA-256), streaming read and delete by reference. |
| `documents` entity, schema and repository | Adds business profile, processing status, GridFS reference, soft-delete marker, pagination and filters. |
| Upload route | A multer storage engine streams straight into GridFS, checking the signature on the first bytes and the file's end markers on the last bytes. |
| `withResilience`, provider chain, OpenAI and Gemini providers | Gain a second call shape, `generate`, for structured output with any schema. `interpret` is untouched. |
| Shared `aiWireSchema` | Adds `sourceDocumentIds`, so an answer can say which documents it used. |
| Planner and orchestrator | Document-grounded answers get their own check and carry validated sources. |
| Documents page, composer, chat | Show status, view, download, delete, retry, details and sources. |

## New

- GridFS storage provider (bucket `tajir_documents`) and a read-only reader for old local files.
- Collections: `extracteddocuments`, `documentchunks`, `documentprocessingjobs`.
- Background processor: MongoDB-backed job queue with leases, retries and recovery after a restart.
- Extraction: PDF text per page (unpdf), OCR for images (tesseract.js, English), scanned-PDF fallback (render pages, then OCR).
- Classification (rules), AI structured understanding (per-type schemas), field grounding against the source text, redaction before anything is sent to a model.
- Retrieval: chunking and text scoring, shaped so embeddings and Atlas Vector Search can be added later.
- Endpoints: view, download, status, detail, retry, delete. Migration script with dry run, verification and rollback.

## Decisions I made, and why

1. **No AI is required for extraction.** Text extraction and OCR run without any model. AI understanding is an extra step that is skipped when no model is connected, and the document is still searchable.
2. **What is sent to a model.** Only extracted text, never the file or images. Machine-readable passport lines are removed, long digit runs such as account and card numbers are masked except the last four, and the text is capped. `DOCUMENT_AI_ENABLED=false` turns this step off completely. The Documents page says plainly that text goes to the configured AI provider.
3. **Facts versus interpretation.** Structured fields are only kept if their value really appears in the document text. Anything the model writes in its own words (summaries, transaction overview) is stored separately and labelled as an AI interpretation. Nothing is ever marked verified.
4. **Chat uses retrieval, not the whole library.** For each question: a short list of document names and statuses, plus the few most relevant excerpts. Document text is passed as untrusted data.
5. **Deleting.** A document is hidden at once (soft delete), then the file, extraction, chunks and jobs are removed, and finally the metadata. If any step fails, a cleanup sweep finishes it later. Atlas multi-document transactions do not cover GridFS, so this idempotent order is used instead. An application's event log is a historical record and is not rewritten when a document is deleted.
6. **Provider setting.** I keep `AI_PROVIDER=auto` (Gemini first, then OpenAI, then the built-in rules), because you chose that earlier. The built-in rules mode works without any key. OpenAI stays a backup and is not made primary.

## Migration plan

There are no document records to move today. The script is still provided and tested, because it will be needed for any local-disk documents created before the switch.

1. Dry run is the default: lists every record, whether its file exists and whether its size matches.
2. `--apply` copies each file into GridFS as a stream, re-reads it, and compares SHA-256 with the record. Only then is the record switched to GridFS.
3. Local files are never deleted by the script.
4. `--rollback` points records back to their original local file (still on disk) and removes only the GridFS copies it made.
5. Files with no record are reported and left alone.

## Regression risks and how they are covered

| Risk | Cover |
|---|---|
| Stricter file checks reject the old fake PNG and JPEG test fixtures | Fixtures are replaced with real minimal files. The checks are not loosened. |
| Wire schema change breaks provider tests | All provider and planner tests are run, fixtures updated, live Gemini check re-run. |
| Interface change for storage breaks uploads | Storage contract tests run against memory, local disk and GridFS on a throwaway database. |
| Background processor slows the server or loops | One job at a time, lease and retry limits, time limit per job, test with a failing extractor. |
| A document answer slips a claim past the guard | Separate check for document answers, sources must be ids that were offered, restricted topics still win. |
| Another user's document leaks into chat | Retrieval is filtered by owner in the query itself. Tests ask about another user's document. |
| Prompt injection inside a document | Text is data, output is schema-validated and grounded, no tools. Test with an injected PDF. |

## Order of work

1. Storage (GridFS, reader, streaming) and tests.
2. Data model, repositories and contract tests.
3. Secure document API and tests.
4. Migration script and tests.
5. Extraction pipeline, jobs and tests.
6. AI understanding and tests.
7. Document-aware chat and tests.
8. Client and browser tests.
9. README, full regression run, final report.
