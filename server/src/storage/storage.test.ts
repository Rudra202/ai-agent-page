import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { storageContract } from './contract.js';
import { createLocalStorage } from './local.js';
import { createMemoryStorage } from './memory.js';

storageContract('memory', async () => ({ storage: createMemoryStorage(), key: () => `owner/${randomUUID()}.pdf` }));

storageContract('local disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-storage-'));
  return { storage: createLocalStorage(dir), key: () => `owner/${randomUUID()}.pdf`, cleanup: () => rm(dir, { recursive: true, force: true }) };
});

describe('local disk specifics', () => {
  it('never leaves a partial file when an upload fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-storage-'));
    try {
      const storage = createLocalStorage(dir);
      await expect(storage.putStream('owner/abc.pdf', Readable.from([Buffer.alloc(100)]), { contentType: 'application/pdf', maxBytes: 10 })).rejects.toThrow();
      const owners = await readdir(dir);
      const files = owners.length ? await readdir(path.join(dir, owners[0]!)) : [];
      expect(files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a key that could escape the folder, for every operation', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-storage-'));
    try {
      const storage = createLocalStorage(dir);
      for (const key of ['../evil.pdf', 'a/../../evil.pdf', '/etc/passwd', 'a/b/c.pdf', 'owner/x.exe']) {
        await expect(storage.putStream(key, Readable.from([Buffer.from('x')]), { contentType: 'application/pdf', maxBytes: 10 })).rejects.toThrow('Invalid storage key');
        expect(await storage.getStream(key)).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tajir-storage-'));
    try {
      const storage = createLocalStorage(dir);
      await storage.put('owner/one.pdf', Buffer.from('first'), { contentType: 'application/pdf' });
      await expect(storage.putStream('owner/one.pdf', Readable.from([Buffer.from('second')]), { contentType: 'application/pdf', maxBytes: 100 })).rejects.toThrow();
      const found = await storage.getStream('owner/one.pdf');
      const chunks: Buffer[] = [];
      for await (const c of found!.stream) chunks.push(Buffer.from(c as Buffer));
      expect(Buffer.concat(chunks).toString()).toBe('first');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
