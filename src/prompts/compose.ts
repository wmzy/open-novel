import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPlugin } from '../plugins/registry';

interface ComposeOptions {
  skillId: string;
  stage: string;
  userMessage: string;
  projectDir: string;
}

export function composePrompt({ skillId, stage, userMessage, projectDir }: ComposeOptions): string {
  const plugin = getPlugin(skillId);
  if (!plugin) return userMessage;

  const parts: string[] = [];

  // Base system instructions
  parts.push(`# Open Novel - AI 小说创作助手

你是一个专业的小说创作助手。你通过阅读和写作文件来帮助用户创作小说。

## 工作目录
所有小说文件都在 .novel/ 目录下。使用你的文件工具（Read, Write, Edit）来操作这些文件。

## 当前阶段: ${stage}
`);

  // Inject skill content
  parts.push(plugin.skillContent);

  // Stage-specific instructions
  const stageInstructions: Record<string, string> = {
    concept: '现在处于概念设计阶段。帮助用户设计故事的核心概念：一句话梗概、五句话简介、核心冲突、道德前提、两难困境。',
    world: '现在处于世界观构建阶段。帮助用户设计地理、社会、力量体系、文化、世界规则。',
    characters: '现在处于角色设计阶段。帮助用户设计主角（驱动三角）、反派（动机合理化）、配角、关系图。',
    outline: '现在处于大纲阶段。先写简要大纲（三幕结构），再写详细大纲（每章规划）。',
    scenes: '现在处于场景设计阶段。将每章分解为主动场景（目标-冲突-灾难）和被动场景（反应-困境-决定）。',
    writing: '现在处于写作阶段。按照大纲逐章写作，注意反AI词汇规则、感官描写、Show Don\'t Tell。',
  };
  if (stageInstructions[stage]) {
    parts.push(`## 阶段说明\n${stageInstructions[stage]}`);
  }

  // Project context - read existing files
  const novelDir = path.join(projectDir, '.novel');
  const contextFiles = ['config.json', 'concept.md', 'summary.md'];
  for (const file of contextFiles) {
    const filePath = path.join(novelDir, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      parts.push(`## ${file}\n${content}`);
    }
  }

  parts.push(`## 用户消息\n${userMessage}`);

  return parts.join('\n\n');
}
