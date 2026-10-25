import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { toast } from 'sonner';
import { pageContainer, pageTitle, card, input, primaryBtn } from '@/styles/shared';
import { STAGES } from '@/shared/stages';
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

/* 订阅反代 / 本地模型快捷预设：只填充表单，不触发保存 */
const PI_PRESETS = [
  {
    id: 'openai-proxy',
    label: 'OpenAI 兼容反代',
    provider: 'custom',
    api: 'openai-completions',
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    hint: '模型 ID 填反代声明的名称（如反代暴露的 gpt-5 / claude-sonnet-4-5）。',
  },
  {
    id: 'anthropic-proxy',
    label: 'Anthropic 兼容反代',
    provider: 'anthropic',
    api: 'anthropic-messages',
    defaultBaseUrl: 'http://127.0.0.1:8080',
    hint: '模型 ID 填反代声明的名称；Base URL 填反代根地址。',
  },
  {
    id: 'ollama',
    label: 'Ollama 本地',
    provider: 'custom',
    api: 'openai-completions',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    hint: 'Ollama 的 Base URL 必须带 /v1；模型 ID 填 ollama list 中的名称。',
  },
] as const;

/** 解析 pi_stage_models JSON 用于回显；损坏/非对象回退空。过滤逻辑与后端 readStagePiModels 同构。 */
function parseStageModels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const source = parsed as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const stage of STAGES) {
      const value = source[stage.id];
      if (typeof value === 'string' && value.trim()) result[stage.id] = value.trim();
    }
    return result;
  } catch {
    return {};
  }
}

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
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['models'] });
      toast.success('设置已保存');
    },
    onError: () => toast.error('保存失败，请重试'),
  });

  // ===== 内置 Pi 模型（BYOK）=====
  const [piProvider, setPiProvider] = useState('anthropic');
  const [piModel, setPiModel] = useState('');
  const [piBaseUrl, setPiBaseUrl] = useState('');
  const [piApi, setPiApi] = useState('anthropic-messages');
  const [piThinking, setPiThinking] = useState('medium');
  const [piApiKey, setPiApiKey] = useState('');
  // 按阶段默认模型：stage → modelId；空值表示「跟随全局默认」。
  const [piStageModels, setPiStageModels] = useState<Record<string, string>>({});

  useEffect(() => {
    setPiProvider(settings?.pi_provider ?? 'anthropic');
    setPiModel(settings?.pi_model ?? '');
    setPiBaseUrl(settings?.pi_base_url ?? '');
    setPiApi(settings?.pi_api ?? 'anthropic-messages');
    setPiThinking(settings?.pi_thinking_level ?? 'medium');
    setPiStageModels(parseStageModels(settings?.pi_stage_models));
  }, [settings]);

  const piKeyConfigured = settings?.pi_apiKeySet === 'true';
  const piAgent = agents?.find((a: { id: string }) => a.id === 'pi') as
    | { id: string; name: string; available: boolean; models?: Array<{ id: string; label: string }> }
    | undefined;

  const savePi = () => {
    if (piProvider === 'custom' && !piBaseUrl.trim()) {
      toast.error('自定义 provider 必须填写 API Base URL');
      return;
    }
    const body: Record<string, string> = {
      pi_provider: piProvider,
      pi_model: piModel.trim(),
      pi_base_url: piBaseUrl.trim(),
      pi_api: piApi,
      pi_thinking_level: piThinking,
    };
    // 只保存非空的阶段配置；全部清空等价于存 '{}'（全部跟随全局默认）。
    const stageModels: Record<string, string> = {};
    for (const stage of STAGES) {
      const value = (piStageModels[stage.id] ?? '').trim();
      if (value) stageModels[stage.id] = value;
    }
    body.pi_stage_models = JSON.stringify(stageModels);
    if (piApiKey.trim()) body.pi_api_key = piApiKey.trim();
    saveSettings.mutate(body, { onSuccess: () => setPiApiKey('') });
  };

  const applyPiPreset = (preset: (typeof PI_PRESETS)[number]) => {
    setPiProvider(preset.provider);
    setPiApi(preset.api);
    setPiBaseUrl((prev) => (prev.trim() ? prev : preset.defaultBaseUrl));
    toast.info(`${preset.label}：${preset.hint}`);
  };

  const testPi = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/agents/pi/test', { method: 'POST' });
      return res.json() as Promise<{ ok: boolean; provider: string; model: string; message: string }>;
    },
    onSuccess: (data) => {
      if (data.ok) toast.success(`配置可解析：${data.model}`);
      else toast.error(data.message || '配置不完整');
    },
    onError: () => toast.error('配置检查失败'),
  });

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
        <h3 className={sectionTitle}>内置 Pi 模型（BYOK）</h3>
        <span className={formHint}>
          Pi 已内置在应用中，无需安装 Claude Code / OpenCode / OMP。填写你自己的 API Key；
          订阅用户可先启动本地反向代理，把订阅暴露成 OpenAI/Anthropic 兼容接口，再在此填反代地址。
        </span>

        <div className={formGroup} style={{ marginTop: '1rem' }}>
          <label className={label}>Provider</label>
          <select
            className={input}
            value={piProvider}
            onChange={(e) => {
              const provider = e.target.value;
              setPiProvider(provider);
              const defaults: Record<string, string> = {
                anthropic: 'anthropic-messages',
                openai: 'openai-responses',
                deepseek: 'openai-completions',
                google: 'google-generative-ai',
                openrouter: 'openai-completions',
                custom: 'openai-completions',
              };
              setPiApi(defaults[provider] ?? 'openai-completions');
            }}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="google">Google Gemini</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">自定义 / 本地反代</option>
          </select>
          <span className={formHint}>自定义 provider 支持 Ollama、LM Studio 与任意 OpenAI-compatible 反代。</span>
          <div className={buttonRow} style={{ marginTop: '0.5rem' }}>
            {PI_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={secondaryBtn}
                onClick={() => applyPiPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <span className={formHint}>
            快捷预设只填充表单，不会自动保存。反代场景的模型 ID 必须填反代声明的名称，不能用订阅官方模型名；
            Ollama 的 Base URL 必须带 <code>/v1</code>。
          </span>
        </div>

        <div className={formGroup}>
          <label className={label}>模型 ID</label>
          <input
            className={input}
            value={piModel}
            onChange={(e) => setPiModel(e.target.value)}
            placeholder="例如 claude-sonnet-4-5 / gpt-4o / deepseek-chat"
            list="pi-model-options"
            autoComplete="off"
          />
          <datalist id="pi-model-options">
            {piAgent?.models?.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </datalist>
          <span className={formHint}>留空时自动选当前 provider 首个可用模型。自定义 provider 建议显式填写。</span>
        </div>

        <div className={formGroup}>
          <label className={label}>API Base URL（可选 / 反代必填）</label>
          <input
            className={input}
            value={piBaseUrl}
            onChange={(e) => setPiBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:8080/v1"
            autoComplete="off"
          />
          <span className={formHint}>
            内置 provider 可留空。订阅反代示例：OpenAI 兼容填 <code>http://127.0.0.1:&lt;port&gt;/v1</code>；
            Anthropic 兼容填反代根地址。反代只监听 127.0.0.1，不要暴露到公网。
          </span>
        </div>

        <div className={formGroup}>
          <label className={label}>API 协议</label>
          <select className={input} value={piApi} onChange={(e) => setPiApi(e.target.value)}>
            <option value="openai-completions">openai-completions</option>
            <option value="openai-responses">openai-responses</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="google-generative-ai">google-generative-ai</option>
          </select>
          <span className={formHint}>内置 provider 通常无需修改；反代按其实际协议选择。</span>
        </div>

        <div className={formGroup}>
          <label className={label}>API Key</label>
          <input
            className={input}
            type="password"
            value={piApiKey}
            onChange={(e) => setPiApiKey(e.target.value)}
            placeholder={piKeyConfigured ? '已保存（留空保持不变）' : 'sk-...；本地反代可留空'}
            autoComplete="new-password"
          />
          <span className={formHint}>密钥只保存在服务端，接口不会回显。留空保存不会覆盖已保存的密钥。</span>
        </div>

        <div className={formGroup}>
          <label className={label}>思考等级</label>
          <select className={input} value={piThinking} onChange={(e) => setPiThinking(e.target.value)}>
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </div>

        <div className={formGroup}>
          <label className={label}>按阶段默认模型（可选）</label>
          <span className={formHint}>
            为各创作阶段指定默认模型；run 未显式选择模型时按当前阶段取此处的配置。
            写作子模式（drafting/revision/polish/decompose/enrich/retro）沿用「写作」的配置；
            选「跟随全局默认」表示该阶段使用上方全局模型 ID。
          </span>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.5rem',
            }}
          >
            {STAGES.map((stage) => (
              <div key={stage.id}>
                <label className={label}>{stage.label}</label>
                <select
                  className={input}
                  value={piStageModels[stage.id] ?? ''}
                  disabled={(piAgent?.models?.length ?? 0) === 0}
                  onChange={(e) =>
                    setPiStageModels((prev) => ({ ...prev, [stage.id]: e.target.value }))
                  }
                >
                  <option value="">跟随全局默认</option>
                  {(piAgent?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {(piAgent?.models?.length ?? 0) === 0 && (
            <span className={formHint}>
              当前 provider 模型目录为空：请先在上方配置 Provider / API Key 并保存，再设置阶段模型。
            </span>
          )}
        </div>

        <div className={buttonRow}>
          <button type="button" className={primaryBtn} onClick={savePi} disabled={saveSettings.isPending}>
            {saveSettings.isPending ? '保存中...' : '保存模型设置'}
          </button>
          <button type="button" className={secondaryBtn} onClick={() => testPi.mutate()} disabled={testPi.isPending}>
            {testPi.isPending ? '检查中...' : '测试已保存配置'}
          </button>
          <button
            type="button"
            className={secondaryBtn}
            disabled={!piKeyConfigured || saveSettings.isPending}
            onClick={() => saveSettings.mutate({ pi_api_key: '' })}
          >
            清除已保存密钥
          </button>
        </div>
        <span className={formHint}>
          当前状态：{piAgent?.available ? `可用（${piAgent.models?.length ?? 0} 个模型）` : '待配置'}。
          保存后重新进入项目即可使用；测试配置只校验 provider/model/auth，不产生生成费用。
        </span>
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
