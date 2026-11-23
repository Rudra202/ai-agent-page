import { randomBytes } from 'node:crypto';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo } from '../../config/db.js';
import { env, resolveMongoUri } from '../../config/env.js';
import { describeRepositoryContract } from '../contract.js';
import { createMongoRepositories } from './index.js';
import type { MongoRepositories } from './index.js';

/**
 * The shared repository contract, run against MongoDB Atlas. It uses a throwaway
 * database whose name starts with "tajir_test_" and drops only that database.
 */

const uri = resolveMongoUri(env);
const dbName = `tajir_test_${randomBytes(6).toString('hex')}`;

/** Safety net: refuse to wipe or drop anything that is not a throwaway test database. */
function assertTestDatabase(name: string): void {
  if (!name.startsWith('tajir_test_')) throw new Error(`Refusing to touch database "${name}"`);
}

if (!uri) {
  describe.skip('MongoDB Atlas (no credentials in server/.env)', () => {
    it('skipped', () => undefined);
  });
} else {
  let connection: Connection;
  let mongo: MongoRepositories;

  beforeAll(async () => {
    assertTestDatabase(dbName);
    connection = await connectMongo(uri, dbName);
    mongo = createMongoRepositories(connection);
    await mongo.ensureIndexes();
  });

  afterAll(async () => {
    if (!connection) return;
    assertTestDatabase(connection.name);
    await connection.dropDatabase();
    await connection.close();
  });

  describe('MongoDB Atlas connection', () => {
    it('is connected to the throwaway test database and has the unique indexes', async () => {
      expect(connection.name).toBe(dbName);
      const indexes = await mongo.models.ApplicationEvent.collection.indexes();
      expect(indexes.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ applicationId: 1, uniqueKey: 1 }))).toBe(true);
      const userIndexes = await mongo.models.User.collection.indexes();
      expect(userIndexes.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ email: 1 }))).toBe(true);
      const appIndexes = await mongo.models.Application.collection.indexes();
      expect(appIndexes.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ reference: 1 }))).toBe(true);
    });
  });

  describeRepositoryContract('MongoDB Atlas', async () => ({
    repos: mongo.repositories,
    cleanup: async () => {
      assertTestDatabase(connection.name);
      await Promise.all(Object.values(mongo.models).map((model) => model.deleteMany({})));
    },
  }));
}
