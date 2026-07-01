import path from 'node:path';
import os from 'node:os';

// Point PGlite at an isolated temp directory so integration tests never touch
// the development store (./data/pglite). This MUST execute before any test file
// imports src/api-app, because importing the app eagerly creates the PGlite
// singleton using PGLITE_DATA_DIR. Vitest runs setupFiles before test modules,
// so setting it here satisfies that ordering.
process.env.PGLITE_DATA_DIR = path.join(
  os.tmpdir(),
  `open-novel-test-${process.pid}-${Date.now()}`,
);

import '@testing-library/jest-dom';
