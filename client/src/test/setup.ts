import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// A busy machine (a build or a dev server running alongside) can be slow, so waits are generous. Passing tests are not slowed down.
configure({ asyncUtilTimeout: 5000 });

// jsdom does not implement scrolling. The chat scrolls to the newest message.
Object.defineProperty(window, 'scrollTo', { value: () => undefined, writable: true });

// jsdom has no object URLs. Previews and downloads use them, so each test gets a recognisable one.
let blobCounter = 0;
URL.createObjectURL = () => `blob:test/${(blobCounter += 1)}`;
URL.revokeObjectURL = () => undefined;

afterEach(() => cleanup());
