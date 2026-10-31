/**
 * scripts/verify-package-contents.mjs 的类型声明（脚本本体是 .mjs，运行时用 node 直接跑）。
 */

export declare const REQUIRED: string[];

export declare function readInput(argPath?: string): Promise<string>;

export declare function parsePackJson(raw: string): {
  filename?: string;
  files: Array<{ path: string; size?: number }>;
};

export declare function findMissing(files: string[]): string[];

export declare function verify(raw: string): Promise<{ filename: string; fileCount: number }>;
