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

// Same isolation for backup output: tests must never write into the
// development ./data/backups directory.
process.env.BACKUP_DIR = path.join(
  os.tmpdir(),
  `open-novel-backup-test-${process.pid}-${Date.now()}`,
);

// 认证默认关闭；显式清除，避免开发机 shell 里的 AUTH_TOKEN 让整套
// apiApp 集成测试意外 401（认证中间件自身的用例通过工厂注入令牌）。
delete process.env.AUTH_TOKEN;

// Node 26 在未指定 --localstorage-file 时会暴露一个可用但返回 undefined 的全局
// localStorage，jsdom 环境不会覆盖它，于是依赖 localStorage 的测试全部报
// "Cannot read properties of undefined (reading 'clear')"。补一个内存实现。
if (!globalThis.localStorage) {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

import '@testing-library/jest-dom';
