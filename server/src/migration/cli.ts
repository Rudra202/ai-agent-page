import path from 'node:path';
import { connectMongo } from '../config/db.js';
import { env, resolveMongoUri } from '../config/env.js';
import { createMongoRepositories } from '../repositories/mongo/index.js';
import { createGridFsStorage } from '../storage/gridfs.js';
import { createLocalStorage } from '../storage/local.js';
import { findOrphanFiles, migrateLocalDocuments, rollbackMigration } from './localToGridfs.js';
import type { MigrationReport } from './localToGridfs.js';

/**
 * Moves documents from local disk into GridFS.
 *
 *   npm run migrate:documents --workspace server                       dry run: reports, changes nothing
 *   npm run migrate:documents --workspace server -- --apply            does it
 *   npm run migrate:documents --workspace server -- --rollback         dry run of the undo
 *   npm run migrate:documents --workspace server -- --rollback --apply undoes it (local files are still there)
 *
 * Local files are never deleted, by this or anything else. See src/migration/localToGridfs.ts.
 */
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const rollback = args.has('--rollback');
const limitArg = process.argv.slice(2).find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : undefined;

function print(report: MigrationReport): void {
  const counts = new Map<string, number>();
  for (const item of report.items) counts.set(item.outcome, (counts.get(item.outcome) ?? 0) + 1);
  console.log(`[migration] ${report.mode}: ${report.examined} document(s) examined, ${report.moved} ${report.mode === 'apply' ? 'moved' : 'can be moved'}, ${report.problems.length} with a problem`);
  for (const [outcome, count] of counts) console.log(`[migration]   ${outcome}: ${count}`);
  // Document ids only: file names belong to the users and are not printed.
  for (const problem of report.problems) console.log(`[migration]   problem: ${problem.outcome} (document ${problem.documentId})`);
}

async function main(): Promise<void> {
  const uri = resolveMongoUri(env);
  if (!uri) {
    console.error('[migration] No MongoDB settings found in server/.env, so there is nothing to migrate.');
    process.exit(1);
  }
  const rootDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
  const connection = await connectMongo(uri, env.MONGODB_DB_NAME);
  let failed = false;
  try {
    const repos = createMongoRepositories(connection).repositories;
    const deps = { repos, local: createLocalStorage(rootDir), gridfs: createGridFsStorage(connection), log: (m: string) => console.warn(m) };
    console.log(`[migration] ${apply ? 'APPLYING' : 'DRY RUN (nothing will be changed; add --apply to do it)'}${rollback ? ' (rollback)' : ''}`);
    const report = rollback ? await rollbackMigration(deps, { apply, limit }) : await migrateLocalDocuments(deps, { apply, limit });
    print(report);
    failed = report.problems.length > 0;

    const orphans = await findOrphanFiles({ repos, rootDir });
    if (orphans.length > 0) {
      console.log(`[migration] ${orphans.length} file(s) in the upload folder have no document record. They are left exactly as they are:`);
      for (const key of orphans.slice(0, 50)) console.log(`[migration]   ${key}`);
    }
    console.log('[migration] No local file was deleted.');
  } finally {
    await connection.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error('[migration] failed:', error instanceof Error ? error.message.split('\n')[0] : String(error));
  process.exit(1);
});
