import { useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import RevisionDialog from '../components/RevisionDialog';
import { useAgentSelection } from './useAgents';

export interface UseFileRevisionOptions {
  /** 项目 ID。 */
  projectId: string;
  /** 相对 .novel/ 的默认目标文件路径，如 'concept.md'。可为 ''（延迟指定场景）。 */
  targetFile: string;
  /** 语义 stage，写入 conversation 记录（revise 模式下不影响 agent 指令）。 */
  stage: string;
  /** 弹窗关闭回调。WritingView 用来清空 reviseChapter；三视图不传。 */
  onClose?: () => void;
}

export interface UseFileRevisionResult {
  /** 打开弹窗。
   *  @param targetFile 可选，覆盖 options.targetFile（WritingView 选完章节后传具体路径）
   *  @param sectionTitle 可选，section 级定向锚点（卡片级 ✎ 传入 section 标题） */
  openDialog: (targetFile?: string, sectionTitle?: string) => void;
  /** 关闭弹窗。 */
  closeDialog: () => void;
  /** 已挂载的 <RevisionDialog>；未打开或 targetFile 为空时为 null。 */
  dialog: ReactNode;
}

/**
 * 封装「修订某个 .novel/ 文件」的完整逻辑：弹窗状态 + RevisionDialog 渲染 + onSubmit fetch。
 * 复用于 ConceptView / WorldView / CharacterView（文件级与卡片级 section 定向）
 * 与 WritingView（章节级，延迟指定 targetFile）。
 *
 * 卡片级：openDialog 传入 sectionTitle 时，revise 提交会在 revisionNote 前置定向锚点
 * （【定向修订：仅修改「X」这一节】），引导 agent 只 Edit 对应 section。零后端改动。
 *
 * 刷新由 ProjectPage 的 SSE file-changed 监听统一处理，hook 内不重复。
 */
export function useFileRevision(options: UseFileRevisionOptions): UseFileRevisionResult {
  const { projectId, targetFile: defaultTargetFile, stage, onClose } = options;
  const [isOpen, setIsOpen] = useState(false);
  const [activeTargetFile, setActiveTargetFile] = useState(defaultTargetFile);
  const [activeSectionTitle, setActiveSectionTitle] = useState<string | undefined>(undefined);
  const [agentId] = useAgentSelection();

  const openDialog = useCallback((targetFile?: string, sectionTitle?: string) => {
    if (targetFile !== undefined) setActiveTargetFile(targetFile);
    setActiveSectionTitle(sectionTitle);
    setIsOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setIsOpen(false);
    setActiveSectionTitle(undefined);
    onClose?.();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (
      mode: 'revise' | 'rename',
      data: {
        revisionNote?: string;
        oldName?: string;
        newName?: string;
        scope?: string[] | undefined;
      },
    ) => {
      if (mode === 'revise') {
        // 卡片级 section 定向：sectionTitle 非空时在 revisionNote 前置锚点提示，
        // 引导 agent 只 Edit 对应 section；message 与 revisionNote 一致以保持对话记录可读。
        const note = activeSectionTitle
          ? `【定向修订：仅修改「${activeSectionTitle}」这一节（## 标题），其余原封不动】\n${data.revisionNote}`
          : data.revisionNote;
        await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            agentId,
            stage,
            message: note,
            mode: 'revise',
            targetFile: activeTargetFile,
            revisionNote: note,
          }),
        });
      } else {
        await fetch(`/api/projects/${projectId}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldName: data.oldName,
            newName: data.newName,
            scope: data.scope,
          }),
        });
      }
      closeDialog();
    },
    [projectId, agentId, stage, activeTargetFile, activeSectionTitle, closeDialog],
  );

  const dialog = useMemo<ReactNode>(() => {
    // 渲染规则：仅在打开且 targetFile 非空时渲染（防止空 targetFile 触发无效 run）
    if (!isOpen || !activeTargetFile) return null;
    return createElement(RevisionDialog, {
      projectId,
      targetFile: activeTargetFile,
      onClose: closeDialog,
      onSubmit: handleSubmit,
    });
  }, [isOpen, activeTargetFile, projectId, closeDialog, handleSubmit]);

  return { openDialog, closeDialog, dialog };
}
