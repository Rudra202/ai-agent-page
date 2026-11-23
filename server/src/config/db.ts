import mongoose from 'mongoose';
import type { Connection } from 'mongoose';

/**
 * Opens a MongoDB connection. The URI contains credentials, so it must never be
 * logged. Errors from the driver mention hosts, not passwords.
 */
export async function connectMongo(uri: string, dbName: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
  await connection.asPromise();
  return connection;
}
