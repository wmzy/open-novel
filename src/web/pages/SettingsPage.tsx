import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { pageContainer, pageTitle, card, input } from '@/styles/shared';
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
      </div>
    </div>
  );
}
