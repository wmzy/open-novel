export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  stages: string[];
  templates: string[];
  legacyTools?: string[];
}

export interface Plugin {
  id: string;
  manifest: PluginManifest;
  skillContent: string;
  path: string;
}
