import { useState } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

interface Props {
  projectId: string;
  targetFile: string;
  onClose: () => void;
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const dialog = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  padding: 1.5rem;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
`;

const btn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const primaryBtn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-primary, #3b82f6);
  border-radius: 6px;
  background: var(--haze-color-primary, #3b82f6);
  color: white;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const input = css`
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.85rem;
  box-sizing: border-box;
`;

const label = css`
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
  color: var(--haze-color-text);
`;

const warning = css`
  color: #dc2626;
  font-size: 0.78rem;
  margin-top: 0.3rem;
`;

const actions = css`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
`;

const titleCls = css`
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
  color: var(--haze-color-text);
`;

const field = css`
  margin-bottom: 0.75rem;
`;

const scopeLabel = css`
  display: flex;
  gap: 0.5rem;
  font-size: 0.82rem;
  align-items: center;
  margin-top: 0.75rem;
`;

interface StateFile {
  characters?: Array<{ name?: string }>;
}

/**
 * 重命名弹窗：确定性改名引擎，走 /api/projects/:id/rename，不走 agent。
 * 从原 RevisionDialog 的 rename 模式拆出（revise 改为走对话框后，rename 保留独立 UI）。
 */
export default function RenameDialog({ projectId, targetFile, onClose }: Props) {
  const [oldName, setOldName] = useState('');
  const [newName, setNewName] = useState('');
  const [nameWarning, setNameWarning] = useState('');
  const [scopeAll, setScopeAll] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const { data: characters } = useQuery<string[]>({
    queryKey: ['state-characters', projectId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/files?path=${encodeURIComponent('state.json')}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as StateFile;
      return (data.characters || []).map((c) => c.name).filter((n): n is string => !!n);
    },
  });

  async function checkNewName(name: string) {
    if (!name || name.length < 2) {
      setNameWarning('');
      return;
    }
    try {
      const res = await fetch(`/api/projects/${projectId}/naming/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, existingNames: characters || [] }),
      });
      const data = await res.json();
      if (data.warnings && data.warnings.length > 0) {
        setNameWarning(data.warnings.join('；'));
      } else {
        setNameWarning('');
      }
    } catch {
      setNameWarning('');
    }
  }

  async function handleSubmit() {
    if (!oldName || !newName) return;
    setSubmitting(true);
    try {
      await fetch(`/api/projects/${projectId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldName,
          newName,
          scope: scopeAll ? undefined : [targetFile],
        }),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = !!(oldName && newName) && !submitting;

  return (
    <div className={overlay} onClick={onClose}>
      <div className={dialog} onClick={(e) => e.stopPropagation()}>
        <div className={titleCls}>重命名 · {targetFile}</div>
        <div className={field}>
          <label className={label}>旧名（从角色列表选择）</label>
          <select
            className={input}
            value={oldName}
            onChange={(e) => setOldName(e.target.value)}
          >
            <option value="">— 选择角色 —</option>
            {(characters || []).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div className={field}>
          <label className={label}>新名</label>
          <input
            className={input}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={(e) => checkNewName(e.target.value)}
            placeholder="输入新名字"
          />
          {nameWarning && <div className={warning}>{nameWarning}</div>}
        </div>
        <label className={scopeLabel}>
          <input
            type="checkbox"
            checked={scopeAll}
            onChange={(e) => setScopeAll(e.target.checked)}
          />
          全项目替换（取消则仅当前文件）
        </label>
        <div className={actions}>
          <button className={btn} onClick={onClose} disabled={submitting}>取消</button>
          <button
            className={primaryBtn}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            确认重命名
          </button>
        </div>
      </div>
    </div>
  );
}
