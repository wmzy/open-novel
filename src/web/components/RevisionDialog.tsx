import { useState } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

interface Props {
  projectId: string;
  targetFile: string;        // 相对路径，如 "chapters/第3章.md"
  onClose: () => void;
  onSubmit: (
    mode: 'revise' | 'rename',
    data: {
      revisionNote?: string;
      oldName?: string;
      newName?: string;
      scope?: string[];
    },
  ) => void;
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

const modeToggle = css`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const btn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  &.active {
    background: var(--haze-color-primary, #3b82f6);
    color: white;
    border-color: var(--haze-color-primary, #3b82f6);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const textarea = css`
  width: 100%;
  min-height: 80px;
  padding: 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.85rem;
  resize: vertical;
  box-sizing: border-box;
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

const title = css`
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
  color: var(--haze-color-text);
`;

interface StateFile {
  characters?: Array<{ name?: string }>;
}

/**
 * 统一修订弹窗：修订内容（语义，走 agent）/ 重命名（机械，确定性引擎）二选一。
 * 用户显式选择模式，不做模糊自动分类。
 */
export default function RevisionDialog({ projectId, targetFile, onClose, onSubmit }: Props) {
  const [mode, setMode] = useState<'revise' | 'rename'>('revise');
  const [revisionNote, setRevisionNote] = useState('');
  const [oldName, setOldName] = useState('');
  const [newName, setNewName] = useState('');
  const [nameWarning, setNameWarning] = useState('');
  const [scopeAll, setScopeAll] = useState(true);

  // 从 state.json 加载角色名列表（用于重命名下拉）
  const { data: characters } = useQuery<string[]>({
    queryKey: ['state-characters', projectId],
    queryFn: async () => {
      const res = await fetch(
        `/api/projects/${projectId}/files?path=${encodeURIComponent('state.json')}`,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as StateFile;
      return (data.characters || [])
        .map((c) => c.name)
        .filter((n): n is string => !!n);
    },
    enabled: mode === 'rename',
  });

  // 新名校验（失焦时调 checkName 预检）
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

  function handleSubmit() {
    if (mode === 'revise') {
      if (!revisionNote.trim()) return;
      onSubmit('revise', { revisionNote });
    } else {
      if (!oldName || !newName) return;
      onSubmit('rename', { oldName, newName, scope: scopeAll ? undefined : [targetFile] });
    }
  }

  const canSubmit = mode === 'revise'
    ? revisionNote.trim().length > 0
    : !!(oldName && newName);

  return (
    <div className={overlay} onClick={onClose}>
      <div className={dialog} onClick={(e) => e.stopPropagation()}>
        <div className={title}>修订 · {targetFile}</div>
        <div className={modeToggle}>
          <button
            className={`${btn} ${mode === 'revise' ? 'active' : ''}`}
            onClick={() => setMode('revise')}
          >
            修订内容
          </button>
          <button
            className={`${btn} ${mode === 'rename' ? 'active' : ''}`}
            onClick={() => setMode('rename')}
          >
            重命名
          </button>
        </div>

        {mode === 'revise' && (
          <>
            <label className={label}>修订意见</label>
            <textarea
              className={textarea}
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
              placeholder="例：主角太冷，加一场与师父的温情戏"
              autoFocus
            />
          </>
        )}

        {mode === 'rename' && (
          <>
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
            <label className={label} style={{ marginTop: '0.75rem' }}>新名</label>
            <input
              className={input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={(e) => checkNewName(e.target.value)}
              placeholder="输入新名字"
            />
            {nameWarning && <div className={warning}>{nameWarning}</div>}
            <label style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', fontSize: '0.82rem', alignItems: 'center' }}>
              <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} />
              全项目替换（取消则仅当前文件）
            </label>
          </>
        )}

        <div className={actions}>
          <button className={btn} onClick={onClose}>取消</button>
          <button
            className={`${btn} active`}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            执行修订
          </button>
        </div>
      </div>
    </div>
  );
}
