/**
 * 写作流程中的角色分工提示。
 *
 * 外部 Agent 时代这里负责把 chapter-reviewer / state-patcher 写进 Claude/OMP
 * 的配置目录；切换到内置 Pi 后不再部署任何外部 subagent，只保留 prompt 指导。
 * agent 在本轮 session 内自行完成“先审查、后回写状态”的职责分离。
 */
export function getSubagentGuidance(agentId?: string): string {
  if (!agentId) return '';
  return `## 职责分离（内置 Pi）

完成章节正文后，按以下顺序自检并落盘，不要跳过：

1. **审稿视角**：以只读审查员身份检查本章的剧情连续性、角色一致性、节奏、文风与 AI 痕迹；发现问题先修订正文，再进入下一步。
2. **状态回写**：正文定稿后，更新 \`.novel/chapters/第N章.summary.md\`、\`.novel/state.json\`、\`.novel/character-states.md\`、\`.novel/character-knowledge.json\` 与伏笔文件；已有内容只增不覆盖。
3. **不要声称已经调用子代理**：你只有当前会话的工具；所有读写都由你自己完成。`;
}
