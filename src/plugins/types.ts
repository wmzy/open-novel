export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  stages: string[];
  templates: string[];
  /** 题材自定义深化维度：按 stage 名索引。无此字段则用通用 DEEPEN_DIMENSIONS */
  dimensions?: Record<string, string[]>;
  legacyTools?: string[];
}

export interface Plugin {
  id: string;
  manifest: PluginManifest;
  skillContent: string;
  path: string;
}
