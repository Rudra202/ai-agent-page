/** Limits how many jobs run at once in this process, whether a new upload started them or the poller found them. */
export function createSemaphore(limit: number) {
  let used = 0;
  const waiting: Array<() => void> = [];

  const tryAcquire = (): boolean => {
    if (used < limit) {
      used += 1;
      return true;
    }
    return false;
  };

  return {
    tryAcquire,
    acquire(): Promise<void> {
      if (tryAcquire()) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    release(): void {
      const next = waiting.shift();
      // Hand the place straight to whoever waited longest.
      if (next) next();
      else used -= 1;
    },
    inFlight: () => used,
  };
}
