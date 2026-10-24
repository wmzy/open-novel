import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { pageContainer, pageTitle, card, input, primaryBtn } from '@/styles/shared';
import NavHeader from '@/web/components/NavHeader';

const formGroup = css`
  margin-bottom: 1rem;
`;

const label = css`
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
`;

const formHint = css`
  display: block;
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.35rem;
  line-height: 1.4;
`;

/* 设置页面根布局 */
const settingsLayout = css`
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
`;

const agentSectionTitle = css`
  margin-top: 2rem;
  margin-bottom: 1rem;
`;

const agentItem = css`
  margin-bottom: 0.5rem;
  padding: 0.5rem;
  background: var(--haze-color-bg-secondary);
  border-radius: 6px;
`;

const installLink = css`
  margin-left: 0.5rem;
`;

const buttonRow = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
`;

const secondaryBtn = css`
  background: transparent;
  color: var(--haze-color-text-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const checkboxRow = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
  font-weight: 500;
`;

const sectionTitle = css`
  margin-bottom: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
`;

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      const data = await res.json();
      return data.settings;
    },
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents');
      const data = await res.json();
      return data.agents;
    },
  });

  const saveSettings = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const res = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('设置已保存');
    },
    onError: () => toast.error('保存失败，请重试'),
  });

  const [preferredAgent, setPreferredAgent] = useState('');

  useEffect(() => {
    // 同步后端值（含清空回退到「选择...」的情况；旧逻辑 if(settings?.preferred_agent) 无法回退为空）。
    setPreferredAgent(settings?.preferred_agent ?? '');
  }, [settings]);

  // ===== 语义检索（可选，默认关闭）=====
  const [embeddingEnabled, setEmbeddingEnabled] = useState(false);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');

  useEffect(() => {
    setEmbeddingBaseUrl(settings?.embedding_baseUrl ?? '');
    setEmbeddingModel(settings?.embedding_model ?? '');
    const configured = !!(settings?.embedding_baseUrl && settings?.embedding_model);
    // 未显式关闭且已配置地址/模型 → 视为启用；默认（无配置）为关闭。
    setEmbeddingEnabled(configured && settings?.embedding_enabled !== 'false');
  }, [settings]);

  const apiKeyConfigured = settings?.embedding_apiKeySet === 'true';

  const saveEmbedding = () => {
    const body: Record<string, string> = {
      embedding_enabled: embeddingEnabled ? 'true' : 'false',
      embedding_baseUrl: embeddingBaseUrl.trim(),
      embedding_model: embeddingModel.trim(),
    };
    // 留空表示不修改已保存密钥；清除请用下方「清除已保存密钥」。
    if (embeddingApiKey.trim()) body.embedding_apiKey = embeddingApiKey.trim();
    saveSettings.mutate(body, { onSuccess: () => setEmbeddingApiKey('') });
  };

  return (
    <div className={settingsLayout}>
      <NavHeader />
      <div className={pageContainer}>
      <h1 className={pageTitle}>设置</h1>
      <div className={card}>
        <div className={formGroup}>
          <label className={label}>首选 Agent</label>
          <select className={input} value={preferredAgent} onChange={(e) => { setPreferredAgent(e.target.value); saveSettings.mutate({ preferred_agent: e.target.value }); }}>
            <option value="">选择...</option>
            {agents?.map((a: { id: string; name: string; available: boolean }) => (
              <option key={a.id} value={a.id} disabled={!a.available}>{a.name} {!a.available ? '(未安装)' : ''}</option>
            ))}
          </select>
          <span className={formHint}>默认 agent：未在会话面板手动选择时生效（手动选择会覆盖此项）。</span>
        </div>
        <h3 className={agentSectionTitle}>可用 Agent</h3>
        {agents?.map((a: { id: string; name: string; available: boolean; version?: string; installUrl?: string }) => (
          <div key={a.id} className={agentItem}>
            <strong>{a.name}</strong> — {a.available ? `✓ ${a.version}` : `✗ 未安装`}
            {a.installUrl && !a.available && <a href={a.installUrl} target="_blank" rel="noopener" className={installLink}>安装指南</a>}
          </div>
        ))}
      </div>

      <div className={card} style={{ marginTop: '1.5rem' }}>
        <h3 className={sectionTitle}>语义检索（可选，默认关闭）</h3>
        <label className={checkboxRow}>
          <input
            type="checkbox"
            checked={embeddingEnabled}
            onChange={(e) => setEmbeddingEnabled(e.target.checked)}
          />
          <span>启用语义检索</span>
        </label>
        <div className={formGroup}>
          <label className={label}>嵌入服务 Base URL</label>
          <input
            className={input}
            value={embeddingBaseUrl}
            onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
          <span className={formHint}>OpenAI 兼容的 /embeddings 端点前缀，例如 https://api.openai.com/v1；本地 Ollama 可填 http://localhost:11434/v1。</span>
        </div>
        <div className={formGroup}>
          <label className={label}>嵌入模型</label>
          <input
            className={input}
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            placeholder="text-embedding-3-small"
            autoComplete="off"
          />
          <span className={formHint}>模型名由嵌入服务定义。更换模型后，下一次索引会自动重建全部向量。</span>
        </div>
        <div className={formGroup}>
          <label className={label}>API Key</label>
          <input
            className={input}
            type="password"
            value={embeddingApiKey}
            onChange={(e) => setEmbeddingApiKey(e.target.value)}
            placeholder={apiKeyConfigured ? '已保存（留空保持不变）' : '可选；本地服务可留空'}
            autoComplete="new-password"
          />
          <span className={formHint}>密钥只保存在服务端，接口不会回显。留空保存不会覆盖已保存的密钥。</span>
        </div>
        <div className={buttonRow}>
          <button type="button" className={primaryBtn} onClick={saveEmbedding} disabled={saveSettings.isPending}>
            {saveSettings.isPending ? '保存中...' : '保存嵌入设置'}
          </button>
          <button
            type="button"
            className={secondaryBtn}
            disabled={!apiKeyConfigured || saveSettings.isPending}
            onClick={() => saveSettings.mutate({ embedding_apiKey: '' })}
          >
            清除已保存密钥
          </button>
        </div>
        <span className={formHint}>启用后，章节正文与摘要会发送到该嵌入服务建立索引，并在写作时用于检索相关前文；索引与检索失败时自动回退为文本搜索，不影响写作与保存。</span>
      </div>
      </div>
    </div>
  );
}
