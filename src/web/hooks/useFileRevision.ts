import { useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import RenameDialog from '../components/RenameDialog';

export const REVISE_TO_CHAT_EVENT = 'open-novel:revise-to-chat';

export interface ReviseToChatDetail {
  targetFile: string;
  sectionTitle?: string;
}

export interface UseFileRevisionOptions {
  /** 项目 ID。 */
  projectId: string;
  /** 相对 .novel/ 的默认目标文件路径，如 'concept.md'。可为 ''（延迟指定场景）。 */
  targetFile: string;
  /** 语义 stage，写入 conversation 记录（不影响 agent 指令）。 */
  stage: string;
  /** rename 弹窗关闭回调。 */
  onClose?: () => void;
}

export interface UseFileRevisionResult {
  /** 进入修订模式：dispatch open-novel:revise-to-chat 事件，ChatPanel 监听后聚焦输入框。
   *  @param targetFile 可选，覆盖 options.targetFile（WritingView 选完章节后传具体路径）
   *  @param sectionTitle 可选，section 级定向锚点（卡片级 ✎ 传入 section 标题） */
  openRevise: (targetFile?: string, sectionTitle?: string) => void;
  /** 打开 rename 弹窗。 */
  openRename: (targetFile?: string) => void;
  /** 关闭 rename 弹窗。 */
  closeRename: () => void;
  /** 已挂载的 rename 弹窗；未打开或 targetFile 为空时为 null。 */
  renameDialog: ReactNode;
}

/**
 * 封装视图/卡片的修订与重命名入口。
 *
 * - revise：不再独立 POST，而是 dispatch open-novel:revise-to-chat 事件，
 *   ChatPanel 监听后进入「修订模式」，用户在对话框写意见手动发送，
 *   复用流式渲染 + diff 面板。agent 由 ChatPanel 提供，本 hook 不再读 useAgentSelection。
 * - rename：保留独立轻量弹窗（RenameDialog），走 /api/projects/:id/rename 机械改名。
 *
 * 刷新由 ProjectPage 的 SSE file-changed 监听统一处理，hook 内不重复。
 */
export function useFileRevision(options: UseFileRevisionOptions): UseFileRevisionResult {
  const { projectId, targetFile: defaultTargetFile, onClose } = options;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTargetFile, setRenameTargetFile] = useState(defaultTargetFile);

  const openRevise = useCallback(
    (targetFile?: string, sectionTitle?: string) => {
      const tf = targetFile ?? defaultTargetFile;
      if (!tf) return;
      const detail: ReviseToChatDetail = { targetFile: tf, sectionTitle };
      window.dispatchEvent(new CustomEvent(REVISE_TO_CHAT_EVENT, { detail }));
    },
    [defaultTargetFile],
  );

  const openRename = useCallback((targetFile?: string) => {
    if (targetFile !== undefined) setRenameTargetFile(targetFile);
    setRenameOpen(true);
  }, []);

  const closeRename = useCallback(() => {
    setRenameOpen(false);
    onClose?.();
  }, [onClose]);

  const renameDialog = useMemo<ReactNode>(() => {
    if (!renameOpen || !renameTargetFile) return null;
    return createElement(RenameDialog, {
      projectId,
      targetFile: renameTargetFile,
      onClose: closeRename,
    });
  }, [renameOpen, renameTargetFile, projectId, closeRename]);

  return { openRevise, openRename, closeRename, renameDialog };
}
