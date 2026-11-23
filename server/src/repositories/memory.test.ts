import { describeRepositoryContract } from './contract.js';
import { createMemoryRepositories } from './memory.js';

describeRepositoryContract('in-memory', async () => ({
  repos: createMemoryRepositories(),
  cleanup: async () => undefined,
}));
