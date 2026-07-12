import { useState, useEffect } from 'react';
import { css } from '@linaria/core';
import { pageContainer } from '@/styles/shared';
import NavHeader from '@/web/components/NavHeader';

const layout = css`
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
`;

const bodyGrid = css`
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 2rem;
  align-items: start;
`;

const toc = css`
  position: sticky;
  top: 1rem;
  font-size: 0.875rem;
`;

const tocTitle = css`
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--haze-color-text-secondary);
  margin-bottom: 0.5rem;
`;

const tocList = css`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const tocItem = css`
  display: block;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  border-left: 2px solid transparent;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-secondary); color: var(--haze-color-text); text-decoration: none; }
`;

const tocItemActive = css`
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-primary);
  border-left-color: var(--haze-color-primary);
  font-weight: 500;
`;

const section = css`
  margin-bottom: 2.5rem;
  scroll-margin-top: 1rem;
`;

const sectionTitle = css`
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
`;

const sectionBody = css`
  font-size: 0.9rem;
  line-height: 1.7;
  color: var(--haze-color-text);
`;

const paragraph = css`
  margin-bottom: 0.75rem;
`;

const table = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
  th, td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--haze-color-border);
  }
  th {
    font-weight: 600;
    color: var(--haze-color-text-secondary);
    background: var(--haze-color-bg-secondary);
  }
  td code {
    font-family: var(--haze-font-mono);
    font-size: 0.8rem;
    background: var(--haze-color-bg-secondary);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }
`;

const callout = css`
  border-left: 3px solid var(--haze-color-warning);
  background: var(--haze-color-bg-secondary);
  padding: 0.75rem 1rem;
  border-radius: 4px;
  margin-bottom: 0.75rem;
  font-size: 0.85rem;
`;

const calloutTitle = css`
  font-weight: 600;
  margin-bottom: 0.25rem;
`;

const ol = css`
  padding-left: 1.25rem;
  margin-bottom: 0.75rem;
  li { margin-bottom: 0.35rem; }
`;

const ul = css`
  padding-left: 1.25rem;
  margin-bottom: 0.75rem;
  list-style: disc;
  li { margin-bottom: 0.35rem; }
`;

const flow = css`
  font-family: var(--haze-font-mono);
  font-size: 0.8rem;
  background: var(--haze-color-bg-secondary);
  padding: 0.75rem;
  border-radius: 6px;
  margin-bottom: 0.75rem;
  overflow-x: auto;
  white-space: pre;
`;

const h3 = css`
  font-size: 1rem;
  font-weight: 600;
  margin-top: 1rem;
  margin-bottom: 0.5rem;
`;

interface Section {
  id: string;
  title: string;
}

const sections: Section[] = [
  { id: 'quickstart', title: '快速开始' },
  { id: 'workflow', title: '创作流程' },
  { id: 'writing', title: '触发 AI 写作' },
  { id: 'editor', title: '章节编辑与重写' },
  { id: 'quality', title: '质量检查' },
  { id: 'version', title: '版本与导出' },
  { id: 'best-practices', title: '最佳实践' },
  { id: 'faq', title: '常见问题' },
];

export default function HelpPage() {
  const [activeId, setActiveId] = useState(sections[0].id);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={layout}>
      <NavHeader />
      <div className={pageContainer}>
        <div className={bodyGrid}>
          <nav className={toc}>
            <div className={tocTitle}>目录</div>
            <ul className={tocList}>
              {sections.map((s) => (
                <li key={s.id}>
                  <a
                    className={`${tocItem} ${activeId === s.id ? tocItemActive : ''}`}
                    onClick={(e) => { e.preventDefault(); scrollTo(s.id); }}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <section id="quickstart" className={section}>
              <h2 className={sectionTitle}>快速开始</h2>
              <div className={sectionBody}>
                <p className={paragraph}>
                  Open Novel 通过调用本机 AI 编码 agent 完成从立意到成稿的全流程创作。开始前请确认前置条件：
                </p>
                <ul className={ul}>
                  <li>本机已安装 <code>claude</code>、<code>opencode</code> 或 <code>omp</code> 之一，并位于 PATH 中</li>
                  <li>启动开发服务器：<code>npm run dev</code>（默认端口 3006）</li>
                </ul>
                <p className={paragraph}>创建第一个项目：</p>
                <ol className={ol}>
                  <li>在「首页」点击新建项目，填写标题、选择题材（武侠 / 现实 / 小说）、目标章数与字数</li>
                  <li>进入项目后，左侧侧边栏列出所有创作阶段文档与已完成的章节</li>
                  <li>顶部进度条显示当前所处阶段，点击可在阶段间切换</li>
                  <li>右侧聊天面板用于向 AI 下达指令，中间区域为文档编辑器</li>
                </ol>
              </div>
            </section>

            <section id="workflow" className={section}>
              <h2 className={sectionTitle}>创作流程</h2>
              <div className={sectionBody}>
                <p className={paragraph}>创作分为六个阶段，每个阶段产出对应的设定文档：</p>
                <div className={flow}>{'概念 → 世界观 → 角色 → 大纲 → 场景 → 写作'}</div>
                <table className={table}>
                  <thead>
                    <tr><th>阶段</th><th>产出</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>概念</td><td><code>concept.md</code></td><td>核心概念、前提、主要冲突</td></tr>
                    <tr><td>世界观</td><td><code>world-building.md</code></td><td>世界设定、规则、历史、文化</td></tr>
                    <tr><td>角色</td><td><code>characters/profiles.md</code></td><td>角色动机、背景、关系、弧光</td></tr>
                    <tr><td>大纲</td><td><code>outline-detailed.md</code></td><td>逐章大纲（幕、节拍、字数）</td></tr>
                    <tr><td>场景</td><td><code>scenes.md</code></td><td>逐章场景（主动 Scene / 被动 Sequel）</td></tr>
                    <tr><td>写作</td><td><code>chapters/第N章.md</code></td><td>正文 + 摘要 + 状态记录</td></tr>
                  </tbody>
                </table>
                <p className={paragraph}>
                  在右侧聊天面板选择对应阶段后发送指令（如「请完善世界观设定」），AI 会读取前序阶段产出并写入本阶段文档。侧边栏还提供「总览」「伏笔」「故事脉络」「角色关系」等辅助视图。
                </p>
              </div>
            </section>

            <section id="writing" className={section}>
              <h2 className={sectionTitle}>触发 AI 写作</h2>
              <div className={sectionBody}>
                <p className={paragraph}>进入写作阶段后，通过右侧聊天面板驱动 AI 创作正文：</p>
                <ol className={ol}>
                  <li>在面板顶部选择 Agent（<code>claude</code> / <code>opencode</code> / <code>omp</code>，自动选首个可用者）</li>
                  <li>确认阶段已切到「写作」、技能已匹配题材</li>
                  <li>在输入框填写指令，例如「请写第 N 章正文，约 4000 字」</li>
                  <li>发送后，AI 的流式输出实时显示在面板中，完成后正文写入对应章节文件</li>
                </ol>
                <div className={callout}>
                  <div className={calloutTitle}>⚡ 上下文自动注入</div>
                  系统会按层级自动注入核心设定、角色状态、本章大纲、出场角色档案、前文滚动摘要和待兑现伏笔，无需手动粘贴。指令中只需说明本章要发生什么。
                </div>
              </div>
            </section>

            <section id="editor" className={section}>
              <h2 className={sectionTitle}>章节编辑与重写</h2>
              <div className={sectionBody}>
                <p className={paragraph}>在侧边栏点击某章即可打开编辑器：</p>
                <ul className={ul}>
                  <li><b>编辑器面板</b>：直接查看与编辑章节正文</li>
                  <li><b>局部重写工作台</b>：展开后可对选中片段进行指令式重写（换风格、改人称、压缩/扩写等）</li>
                  <li><b>质量检查面板</b>：展开后对当前章节跑 AI 味 / 一致性 / 节奏检查</li>
                </ul>
              </div>
            </section>

            <section id="quality" className={section}>
              <h2 className={sectionTitle}>质量检查</h2>
              <div className={sectionBody}>
                <p className={paragraph}>在章节编辑区的「质量检查面板」触发，或在写作指令中要求 AI 自检：</p>
                <ul className={ul}>
                  <li><b>AI 味检测</b>：检测碎片化句型、重复词、套话等 AI 痕迹</li>
                  <li><b>一致性检查</b>：核对角色状态、时间线、设定连贯性</li>
                  <li><b>节奏检查</b>：评估叙事张力的起伏是否合理</li>
                </ul>
                <p className={paragraph}>检查发现问题后，可用局部重写工作台针对性修改，再复查。</p>
              </div>
            </section>

            <section id="version" className={section}>
              <h2 className={sectionTitle}>版本与导出</h2>
              <div className={sectionBody}>
                <p className={paragraph}>项目页顶部工具栏提供以下操作：</p>
                <table className={table}>
                  <thead>
                    <tr><th>按钮</th><th>作用</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>MD / TXT</td><td>导出全文为 Markdown 或纯文本</td></tr>
                    <tr><td>撤销</td><td>撤销上一次更改（回退到上一版本）</td></tr>
                    <tr><td>存版本</td><td>保存当前状态为版本标签（自动 git commit + tag）</td></tr>
                    <tr><td>同步</td><td>同步到远程仓库</td></tr>
                    <tr><td>显示预览</td><td>展开/收起右侧文件预览面板</td></tr>
                  </tbody>
                </table>
                <p className={paragraph}>
                  每次写作完成后系统会自动创建快照；遇到不满意的结果用「撤销」回退，关键节点用「存版本」锁定。
                </p>
              </div>
            </section>

            <section id="best-practices" className={section}>
              <h2 className={sectionTitle}>最佳实践</h2>
              <div className={sectionBody}>
                <h3 className={h3}>逐章串行写作</h3>
                <p className={paragraph}>
                  每章依赖前章的滚动摘要与角色状态，<b>切勿并行触发多章写作</b>。一次只写一章，写完确认状态后再触发下一章。
                </p>
                <h3 className={h3}>明确字数与内容约束</h3>
                <p className={paragraph}>
                  在指令中写明字数范围和本章核心事件，例如「请写第 12 章正文，约 4000 字，重点写林冲识破令牌真相」。
                </p>
                <h3 className={h3}>监控 token 退化</h3>
                <p className={paragraph}>
                  长上下文运行可能导致重复词暴增。若发现某章出现高频重复词，用局部重写或质量检查处理，避免连续大量写作。
                </p>
                <h3 className={h3}>定期核对角色状态</h3>
                <p className={paragraph}>
                  在「总览」或「角色关系」视图中确认角色位置、情绪、已知信息是否准确。AI 偶尔会漏更新状态，发现偏差时手动修正再继续。
                </p>
                <h3 className={h3}>善用快照与撤销</h3>
                <p className={paragraph}>
                  关键节点前先「存版本」，不满意时一键撤销。养成「存版本 → 触发写作 → 满意则继续，不满意则撤销」的节奏。
                </p>
              </div>
            </section>

            <section id="faq" className={section}>
              <h2 className={sectionTitle}>常见问题</h2>
              <div className={sectionBody}>
                <h3 className={h3}>AI 写作中途卡住 / 超时？</h3>
                <p className={paragraph}>
                  Agent 子进程默认超时 30 分钟（<code>AGENT_TIMEOUT_MS</code>）。单章通常在几分钟内完成；若长时间无输出，检查本机 agent 进程与网络，再重试。
                </p>
                <h3 className={h3}>章节字数与预期偏差较大？</h3>
                <p className={paragraph}>
                  在指令中显式约束字数（如「约 4000 字，不要超过 5000」），并说明本章的核心事件密度。字数偏差较大时用局部重写调整。
                </p>
                <h3 className={h3}>角色状态似乎没更新？</h3>
                <p className={paragraph}>
                  AI 偶尔漏写状态文件。到「总览」视图检查 <code>state.json</code>，手动修正角色位置/情绪/已知信息后再继续后续章节。
                </p>
                <h3 className={h3}>流式输出似乎丢内容？</h3>
                <p className={paragraph}>
                  已知长输出偶有数据丢失。写作完成后请核对章节文件完整性，缺失部分用局部重写补齐。
                </p>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
