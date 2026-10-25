import { useState } from 'react';
import { css } from '@linaria/core';
import { STAGES } from '@/shared/stages';
import {
  usePresets,
  usePresetDetail,
  usePresetPreview,
  type PresetSummaryEntry,
} from '@/web/hooks/usePresets';

/**
 * 提示词预设面板（P2，自包含）：项目级预设库 + 阶段绑定 + SKILL.md 导入 + 组装预览。
 * 只负责「存储 + 预览」；预设注入 composePrompt 的消费链路尚未接线（父任务决策点）。
 */

const wrap = css`
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  padding: 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
`;

const section = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const sectionTitle = css`
  font-weight: 600;
  font-size: 0.9rem;
`;

const hint = css`
  color: var(--haze-color-text-secondary);
  font-size: 0.78rem;
`;

const errText = css`
  color: var(--haze-color-danger, #d33);
  font-size: 0.78rem;
`;

const input = css`
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  font-size: 0.82rem;
`;

const textarea = css`
  padding: 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  font-size: 0.82rem;
  min-height: 120px;
  resize: vertical;
  font-family: inherit;
`;

const btn = css`
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  font-size: 0.8rem;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const primaryBtn = css`
  ${btn};
  background: var(--haze-color-primary);
  border-color: var(--haze-color-primary);
  color: var(--haze-color-bg);
`;

const badge = css`
  display: inline-block;
  padding: 0.0625rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 999px;
  font-size: 0.72rem;
  white-space: nowrap;
`;

const table = css`
  border-collapse: collapse;
  font-size: 0.82rem;
  th, td {
    border: 1px solid var(--haze-color-border);
    padding: 0.375rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: 600;
  }
`;

const pre = css`
  margin: 0.25rem 0 0;
  padding: 0.625rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.72rem;
  line-height: 1.5;
`;

const row = css`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
`;

const versionBlock = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
`;

const stageLabel: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));
const STAGE_OPTIONS = ['', ...STAGES.map((s) => s.id)];

interface Props {
  projectId: string;
}

export default function PromptPresetPanel({ projectId }: Props) {
  const { overview, createMut, addVersionMut, updateMut, deleteMut, importMut, bindMut } =
    usePresets(projectId);

  // 选中查看版本历史的预设
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = usePresetDetail(projectId, selectedId);

  // 新建表单
  const [newName, setNewName] = useState('');
  const [newStage, setNewStage] = useState('');
  const [newContent, setNewContent] = useState('');

  // 追加版本
  const [versionContent, setVersionContent] = useState('');
  const [versionNote, setVersionNote] = useState('');

  // 导入 SKILL.md
  const [skillPath, setSkillPath] = useState('');
  const [importName, setImportName] = useState('');
  const [importStage, setImportStage] = useState('');

  // 组装预览
  const [previewStage, setPreviewStage] = useState('writing');
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = usePresetPreview(projectId, previewStage, previewOpen);

  const presets = overview.data?.presets ?? [];
  const bindings = overview.data?.bindings ?? {};

  return (
    <div className={wrap}>
      {/* ── 阶段绑定 ── */}
      <div className={section}>
        <div className={sectionTitle}>阶段绑定</div>
        <div className={hint}>为各阶段选择生效预设（取其当前版本）；空 = 不使用预设。</div>
        {STAGES.map((s) => (
          <div key={s.id} className={row}>
            <label htmlFor={`preset-bind-${s.id}`}>{s.label}（{s.id}）</label>
            <select
              id={`preset-bind-${s.id}`}
              className={input}
              value={bindings[s.id] ?? ''}
              disabled={bindMut.isPending}
              onChange={(e) =>
                bindMut.mutate({ stage: s.id, presetId: e.target.value === '' ? null : e.target.value })}
            >
            <option value="">（不使用预设）</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          </div>
        ))}
        {bindMut.isError && <div className={errText}>{bindMut.error.message}</div>}
      </div>

      {/* ── 预设列表 ── */}
      <div className={section}>
        <div className={sectionTitle}>预设列表</div>
        {overview.isLoading && <div className={hint}>加载中...</div>}
        {overview.isError && <div className={errText}>加载失败：{overview.error.message}</div>}
        {!overview.isLoading && presets.length === 0 && (
          <div className={hint}>暂无预设——在下方新建或从 SKILL.md 导入。</div>
        )}
        {presets.length > 0 && (
          <table className={table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>适用阶段</th>
                <th>当前版本</th>
                <th>版本数</th>
                <th>绑定</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {presets.map((p: PresetSummaryEntry) => (
                <tr key={p.id}>
                  <td title={p.description || p.id}>{p.name}</td>
                  <td>{p.stage ? (stageLabel[p.stage] ?? p.stage) : '不限定'}</td>
                  <td>v{p.current}</td>
                  <td>{p.versionCount}</td>
                  <td>{p.boundStages.length > 0 ? p.boundStages.join('、') : '—'}</td>
                  <td>
                    <button
                      type="button"
                      className={btn}
                      onClick={() => {
                        setSelectedId(selectedId === p.id ? null : p.id);
                        setVersionContent('');
                        setVersionNote('');
                      }}
                    >
                      {selectedId === p.id ? '收起版本' : '版本历史'}
                    </button>{' '}
                    <button
                      type="button"
                      className={btn}
                      disabled={deleteMut.isPending}
                      onClick={() => {
                        if (window.confirm(`删除预设「${p.name}」及其全部版本？`)) deleteMut.mutate(p.id);
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {deleteMut.isError && <div className={errText}>{deleteMut.error.message}</div>}

        {/* 选中预设的版本历史：只读展示旧版 + 设为当前 + 追加新版 */}
        {selectedId && (
          <div className={section}>
            <div className={sectionTitle}>
              版本历史：{detail.data?.manifest.name ?? selectedId}
              {detail.data && <span className={hint}>（当前 v{detail.data.manifest.current}）</span>}
            </div>
            {detail.isLoading && <div className={hint}>加载版本中...</div>}
            {detail.isError && <div className={errText}>加载失败：{detail.error.message}</div>}
            {detail.data?.versions
              .slice()
              .sort((a, b) => b.version - a.version)
              .map((v) => (
                <div key={v.version} className={versionBlock}>
                  <div className={row}>
                    <strong>v{v.version}</strong>
                    <span className={hint}>{v.note} · {v.createdAt.slice(0, 19).replace('T', ' ')}</span>
                    {detail.data?.manifest.current === v.version ? (
                      <span className={badge}>当前</span>
                    ) : (
                      <button
                        type="button"
                        className={btn}
                        disabled={updateMut.isPending}
                        onClick={() => updateMut.mutate({ presetId: selectedId, current: v.version })}
                      >
                        设为当前
                      </button>
                    )}
                  </div>
                  <pre className={pre}>{v.content}</pre>
                </div>
              ))}
            <div className={section}>
              <div className={sectionTitle}>追加新版本（append-only，旧版本保留）</div>
              <input
                className={input}
                placeholder="版本说明（可空）"
                value={versionNote}
                onChange={(e) => setVersionNote(e.target.value)}
              />
              <textarea
                className={textarea}
                placeholder="新版提示词内容"
                value={versionContent}
                onChange={(e) => setVersionContent(e.target.value)}
              />
              <div className={row}>
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={addVersionMut.isPending || !versionContent.trim()}
                  onClick={() => {
                    addVersionMut.mutate(
                      { presetId: selectedId, content: versionContent, note: versionNote || undefined },
                      {
                        onSuccess: () => {
                          setVersionContent('');
                          setVersionNote('');
                        },
                      },
                    );
                  }}
                >
                  追加版本（并设为当前）
                </button>
              </div>
              {addVersionMut.isError && <div className={errText}>{addVersionMut.error.message}</div>}
            </div>
          </div>
        )}
      </div>

      {/* ── 新建预设 ── */}
      <div className={section}>
        <div className={sectionTitle}>新建预设</div>
        <div className={row}>
          <input className={input} placeholder="预设名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select className={input} value={newStage} onChange={(e) => setNewStage(e.target.value)}>
            {STAGE_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === '' ? '不限定阶段' : `${stageLabel[s]}（${s}）`}</option>
            ))}
          </select>
        </div>
        <textarea
          className={textarea}
          placeholder="提示词内容（v1）"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
        />
        <div className={row}>
          <button
            type="button"
            className={primaryBtn}
            disabled={createMut.isPending || !newName.trim() || !newContent.trim()}
            onClick={() =>
              createMut.mutate(
                { name: newName, stage: newStage || undefined, content: newContent },
                {
                  onSuccess: () => {
                    setNewName('');
                    setNewStage('');
                    setNewContent('');
                  },
                },
              )
            }
          >
            创建（v1）
          </button>
        </div>
        {createMut.isError && <div className={errText}>{createMut.error.message}</div>}
      </div>

      {/* ── 导入 SKILL.md ── */}
      <div className={section}>
        <div className={sectionTitle}>导入 SKILL.md</div>
        <div className={hint}>从服务器上的插件目录导入（自动剥离 YAML frontmatter，正文存为 v1）。例如 /home/you/projects/open-novel/plugins/wuxia/SKILL.md</div>
        <div className={row}>
          <input
            className={input}
            style={{ flex: 1, minWidth: 240 }}
            placeholder="SKILL.md 绝对路径"
            value={skillPath}
            onChange={(e) => setSkillPath(e.target.value)}
          />
          <input className={input} placeholder="名称（可空，取文件名）" value={importName} onChange={(e) => setImportName(e.target.value)} />
          <select className={input} value={importStage} onChange={(e) => setImportStage(e.target.value)}>
            {STAGE_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === '' ? '阶段自动识别' : `${stageLabel[s]}（${s}）`}</option>
            ))}
          </select>
          <button
            type="button"
            className={primaryBtn}
            disabled={importMut.isPending || !skillPath.trim()}
            onClick={() =>
              importMut.mutate(
                {
                  skillPath,
                  name: importName || undefined,
                  stage: importStage || undefined,
                },
                {
                  onSuccess: () => {
                    setSkillPath('');
                    setImportName('');
                    setImportStage('');
                  },
                },
              )
            }
          >
            导入
          </button>
        </div>
        {importMut.isError && <div className={errText}>{importMut.error.message}</div>}
      </div>

      {/* ── 组装预览 ── */}
      <div className={section}>
        <div className={sectionTitle}>组装预览</div>
        <div className={hint}>绑定预设内容 + 该阶段上下文层的完整 prompt 预览（preset:start/end 标记之间为预设部分）。</div>
        <div className={row}>
          <select className={input} value={previewStage} onChange={(e) => setPreviewStage(e.target.value)}>
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>{s.label}（{s.id}）</option>
            ))}
          </select>
          <button type="button" className={primaryBtn} onClick={() => setPreviewOpen(true)}>
            生成预览
          </button>
        </div>
        {preview.isError && <div className={errText}>预览失败：{preview.error.message}</div>}
        {preview.data && (
          <>
            <div className={row}>
              <span className={badge}>
                约 {preview.data.tokensApprox.toLocaleString()} tokens
              </span>
              {preview.data.presetId ? (
                <span className={badge}>预设：{preview.data.presetId}（v{preview.data.version}）</span>
              ) : (
                <span className={badge}>未绑定预设</span>
              )}
              {preview.data.note && <span className={hint}>{preview.data.note}</span>}
            </div>
            <pre className={pre}>{preview.data.prompt}</pre>
          </>
        )}
      </div>
    </div>
  );
}
