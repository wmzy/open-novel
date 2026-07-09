import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
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
      await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const [preferredAgent, setPreferredAgent] = useState('');

  useEffect(() => {
    if (settings?.preferred_agent) setPreferredAgent(settings.preferred_agent);
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
