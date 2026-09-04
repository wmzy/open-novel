import { useState, useEffect } from 'react';
import { css, cx } from '@linaria/core';
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

const h3Sm = css`
  font-size: 0.95rem;
`;

const ulWithGap = css`
  margin-top: 0.5rem;
`;

interface Section {
  id: string;
  title: string;
}

const sections: Section[] = [
  { id: 'quickstart', title: '快速开始' },
  { id: 'workflow', title: '创作流程' },
  { id: 'wuxia', title: '武侠创作' },
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
                <p className={paragraph}>
                  创作分为六个阶段，每个阶段产出对应的设定文档。但这<b>不是单向流水线</b>——小说需要反复修改，你可以随时回到任意阶段调整设定、修订章节或重做某个环节，写作阶段会自动引用最新设定。
                </p>
                <div className={flow}>{'概念 → 世界观 → 角色 → 大纲 → 场景 → 写作'}</div>
                <div className={callout}>
                  <div className={calloutTitle}>🔄 迭代而非流水线</div>
                  六个阶段是工具箱，不是必须一次走完的传送带。实际创作中你会不断回头：写到第 10 章发现世界观有漏洞，切回 <code>/world</code> 修设定；角色弧光不合理，切回 <code>/characters</code> 调整。工具提供三种修改粒度：
                  <ul className={ul}>
                    <li><b>单节修订</b>（✎）：在任意卡片上点 ✎，对那一节发指令式重写——AI 只改相关段落，不碰其余（外科手术规则：改动不超 30%）</li>
                    <li><b>深化循环</b>（🔁）：让 AI 自主迭代改写，审查→修订→评分，直到改进饱和</li>
                    <li><b>阶段重做</b>：切回任意阶段重新生成，或用 <code>/revision</code>（检查逻辑/伏笔/OOC）、<code>/polish</code>（润色行文）系统打磨</li>
                  </ul>
                  所有修改都有安全网：每次写入自动创建快照，不满意用「撤销」回退；关键节点用「存版本」锁定。放心改。
                </div>

                <h3 className={h3}>各阶段详解</h3>

                <p className={paragraph}>
                  <b>1. 概念</b>{' '}— 快捷指令 <code>/concept</code>
                </p>
                <p className={paragraph}>
                  构思核心概念、一句话梗概、核心冲突与情感基调。AI 会先用范例展示「好的概念长什么样」，再用选择题确认主角原型、核心冲突方向、主题和基调，综合选择后生成。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/concept/</code> 目录下每个要素一个独立 <code>.md</code> 文件 + <code>index.md</code> 索引</li>
                  <li><b>视图操作</b>：每张卡片支持 ✎ 修订（重写某一节）、⇄ 重命名；梗概自动编号显示</li>
                  <li><b>适用场景</b>：项目刚创建、只有模糊想法时，用本阶段把灵感精炼成可执行的故事前提</li>
                </ul>

                <p className={paragraph}>
                  <b>2. 世界观</b>{' '}— 快捷指令 <code>/world</code>
                </p>
                <p className={paragraph}>
                  构建世界设定——时代背景、地理环境、社会结构、力量体系、文化规则等。AI 会确认世界类型（现实/架空/异世界）、力量体系风格、社会结构后生成。卡片按类别自动分配主题色。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/world/</code> 目录下每个 <code>##</code> 节一个独立 <code>.md</code> 文件 + <code>index.md</code> 索引</li>
                  <li><b>视图操作</b>：✎ 修订、⇄ 重命名、🔁 <b>深化</b>（自主循环补全设定空缺，见下文）、Markdown/源码模式切换</li>
                  <li><b>适用场景</b>：需要建立完整、自洽的世界规则和势力格局时</li>
                </ul>

                <p className={paragraph}>
                  <b>3. 角色</b>{' '}— 快捷指令 <code>/characters</code>
                </p>
                <p className={paragraph}>
                  撰写角色档案——主角、反派与关键配角。每个角色需落出驱动力三角（外在目标 / 内在需求 / 核心缺陷），涵盖动机、背景、关系与角色弧光。AI 会确认主角目标、内在需求、核心缺陷、配角规模后生成。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/characters/profiles.md</code>（全部角色集中在一个文件）</li>
                  <li><b>视图操作</b>：✎ 修订（重写整个文件或某个角色节）、⇄ 重命名</li>
                  <li><b>适用场景</b>：需要丰满的、有弧光的角色阵容时；大纲和写作阶段会引用此处定义的角色状态</li>
                </ul>

                <p className={paragraph}>
                  <b>4. 大纲</b>{' '}— 快捷指令 <code>/outline</code>
                </p>
                <p className={paragraph}>
                  将故事拆解为逐章大纲，包括三幕结构、章节节拍与字数分配。AI 会先与你敲定三幕骨架（起点、触发事件、中点转折、高潮走向），确认后再展开逐章规划。同时自动登记全书伏笔。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/outline/chapters/第N章.md</code>（每章一个文件）+ <code>index.md</code> 索引 + <code>outline-meta.json</code>（三幕分界 + 视点角色）+ <code>foreshadow.json</code>（伏笔登记）</li>
                  <li><b>视图操作</b>：概览/详细标签切换；概览展示三幕结构图，详细展示逐章 POV 时间线；✎ 修订</li>
                  <li><b>脚手架</b>：输入「生成大纲脚手架」可调用 API 自动生成与章节数匹配的逐章骨架，作为起点打磨</li>
                  <li><b>适用场景</b>：需要清晰的叙事结构和节奏控制时；生成的伏笔表会在写作阶段自动追踪</li>
                </ul>

                <p className={paragraph}>
                  <b>5. 场景</b>{' '}— 快捷指令 <code>/scenes</code>
                </p>
                <p className={paragraph}>
                  将大纲拆解为详细场景，规划主动场景（Scene：目标→冲突→灾难/转折）与被动场景（Sequel：反应→困境→新决定）的交替节奏。AI 会确认场景密度、节奏模式和自动化程度后生成。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/scenes.md</code>（全部场景集中在一个文件）</li>
                  <li><b>视图操作</b>：按章节分组展示，主动/被动场景以不同颜色徽标区分；✎ 修订</li>
                  <li><b>脚手架</b>：输入「生成场景脚手架」可自动生成逐章主动/被动场景配对模板</li>
                  <li><b>适用场景</b>：写作前需要精确规划每一章的节奏起伏和情绪弧线时</li>
                </ul>

                <p className={paragraph}>
                  <b>6. 写作</b>{' '}— 快捷指令 <code>/draft</code>
                </p>
                <p className={paragraph}>
                  逐章创作正文。AI 进入自治模式（不再提问），按层级自动注入核心设定、角色状态、本章大纲、出场角色档案、前文摘要和待兑现伏笔。详见下方「触发 AI 写作」。
                </p>
                <ul className={ul}>
                  <li><b>产出</b>：<code>.novel/chapters/第N章.md</code>（正文 + 摘要 + 状态记录）</li>
                  <li><b>视图操作</b>：统计面板（已写章数/总字数/平均字数）；章节列表点击进入编辑器；每章 ✎ 修订</li>
                  <li><b>适用场景</b>：设定完成后的正文创作；也可在 <code>/revision</code>（修改）和 <code>/polish</code>（润色）阶段进一步打磨</li>
                </ul>

                <h3 className={h3}>三种交互模式</h3>
                <table className={table}>
                  <thead>
                    <tr><th>模式</th><th>触发方式</th><th>行为</th><th>适用场景</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><b>采访式</b>（默认）</td>
                      <td>直接发送指令</td>
                      <td>AI 先展示范例，用选择题收集创作偏好，追问细节后落盘，最后列清单确认</td>
                      <td>规划阶段（概念~场景）日常使用，想把控创作方向</td>
                    </tr>
                    <tr>
                      <td><b>自治式</b></td>
                      <td><code>/explore</code></td>
                      <td>AI 不提问，所有创作决策自主做出，直接落盘</td>
                      <td>夜间探索、想看 AI 独立产出的方案、批量推进</td>
                    </tr>
                    <tr>
                      <td><b>Plan Mode</b></td>
                      <td>输入框旁 📋 规划按钮</td>
                      <td>AI 只分析规划、输出方案卡，不修改任何文件，等确认后再执行</td>
                      <td>想先看 AI 的计划再决定是否执行、评估改动范围</td>
                    </tr>
                  </tbody>
                </table>

                <h3 className={h3}>深化循环（🔁）</h3>
                <p className={paragraph}>
                  适用于<b>概念/世界观/角色/大纲/场景</b>五个规划阶段（写作阶段不用）。在阶段视图点击 🔁 <b>深化</b> 后，AI 进入自主循环，不需你逐轮操作。
                </p>

                <h4 className={cx(h3, h3Sm)}>工作原理：审查者-作者双相循环</h4>
                <p className={paragraph}>
                  每两轮为一个周期——第 1 轮 AI 扮演<b>审查者</b>找出问题，第 2 轮切换为<b>作者</b>逐条修订，第 3 轮又换回审查者……如此交替。关键设计：
                </p>
                <ul className={ul}>
                  <li><b>盲审机制</b>：审查者<b>不看</b>历史改进日志，每轮形成独立判断，避免“自我满足”</li>
                  <li><b>视角轮替</b>：每轮审查用不同专家视角（如角色阶段轮换：心理分析师 → 戏剧冲突专家 → 读者代入测试 → 叙事功能审计师 → 跨阶段一致性审计师），确保各维度都被覆盖</li>
                  <li><b>跨阶段校验</b>：每阶段的最后一个视角会读取前序/后序阶段产出，检查一致性（如审查角色时会检查是否与世界观体系脱节）</li>
                </ul>

                <h4 className={cx(h3, h3Sm)}>每轮产出</h4>
                <table className={table}>
                  <thead>
                    <tr><th>轮次</th><th>角色</th><th>做什么</th><th>写入文件</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>奇数轮（1, 3, 5…）</td><td>🔍 审查者</td><td>按当前专家视角审查产出，逐维度打 1-5 分，挑出 2-3 个最薄弱问题并给改进建议</td><td><code>deepen-critique.md</code>（覆盖上一轮）</td></tr>
                    <tr><td>偶数轮（2, 4, 6…）</td><td>✏️ 作者</td><td>读审查报告 → 逐条回应（成立则修订，不成立则说明原因）→ 主动扩展缺失内容 → 记录评分变化</td><td>阶段产出文件 + <code>deepen-log.md</code>（追加）</td></tr>
                  </tbody>
                </table>

                <h4 className={cx(h3, h3Sm)}>评分维度（每阶段 5 个）</h4>
                <table className={table}>
                  <thead>
                    <tr><th>阶段</th><th>5 个质量维度</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>概念</td><td>核心冲突锐度 · 主题深度 · 独特性 · 情感钩子 · 可展开性</td></tr>
                    <tr><td>世界观</td><td>体系自洽性 · 历史纵深 · 文化丰富度 · 冲突潜力 · 感官沉浸</td></tr>
                    <tr><td>角色</td><td>动机清晰度 · 关系丰富度 · 弧光完整性 · 差异化程度 · 功能性覆盖</td></tr>
                    <tr><td>大纲</td><td>三幕结构 · 因果链紧密度 · 伏笔密度 · 情感节奏 · 主题贯穿</td></tr>
                    <tr><td>场景</td><td>场景目的性 · 主动被动交替 · 冲突烈度 · 感官落地 · 信息节制</td></tr>
                  </tbody>
                </table>

                <h4 className={cx(h3, h3Sm)}>具体示例：角色阶段深化</h4>
                <div className={callout}>
                  <div className={calloutTitle}>场景：你的反派“墨先生”动机单薄，想自动完善</div>
                  <p className={cx(paragraph, ulWithGap)}>
                    <b>启动</b>：在角色视图点 🔁，设截止时间 06:00，特别指导填「墨先生是反派，他的动机太单薄了，需要更深的执念和内心矛盾」
                  </p>
                  <p className={paragraph}>
                    <b>第 1 轮（审查 · 心理分析师视角）</b>：AI 扮演心理分析师审查角色档案，输出：<br/>
                    「动机清晰度 3分：墨先生的“复仇”动机缺乏心理根基，读者不知道为什么他非复仇不可。<br/>
                    问题1：墨先生对主角的恨意只用了“灭门之仇”一笔带过，没有展现创伤如何扭曲了他的价值观。<br/>
                    问题2：他的核心缺陷未定义——是偏执？恐惧被遗忘？还是自我毁灭倾向？」
                  </p>
                  <p className={paragraph}>
                    <b>第 2 轮（修订 · 作者角色）</b>：AI 读审查报告，回应：为墨先生补充创伤闪回段、定义核心缺陷为“对被遗忘的极度恐惧”、新增他与师父的决裂因果链。评分变化：动机清晰度 3→5。记录到 <code>deepen-log.md</code>。
                  </p>
                  <p className={paragraph}>
                    <b>第 3 轮（审查 · 戏剧冲突专家视角）</b>：换新视角再审，这次关注关系张力：<br/>
                    「关系丰富度 2分：墨先生与主角只有单维对立，缺少暧昧或误解层。<br/>
                    问题1：两人没有共通过去的纠葛，纯粋的敌人关系缺乏戏剧燃料。」
                  </p>
                  <p className={paragraph}>
                    <b>第 4 轮（修订）</b>：新增墨先生与主角师父曾是同门的设定，二人有“同门相残”的宿命感……
                  </p>
                  <p className={paragraph}>
                    循环继续，直到 <b>连续 2 次审查都找不到实质问题</b>（饱和信号）、截止时间到、或你手动点 ✕ 停止。
                  </p>
                </div>

                <h4 className={cx(h3, h3Sm)}>停止条件</h4>
                <ul className={ul}>
                  <li><b>改进饱和</b>：连续 2 轮审查报告都标记「无实质改进」，说明产出已足够好</li>
                  <li><b>截止时间到</b>：达到你设的截止时间自动停止</li>
                  <li><b>连续 2 轮失败</b>：连续 2 轮运行出错（如 Agent 崩溃），自动退出</li>
                  <li><b>最大轮数</b>：最多 20 轮（10 个审查-修订周期）作为兜底</li>
                  <li><b>手动停止</b>：随时点状态条上的 ✕，或发送任意消息中断</li>
                </ul>
                <p className={paragraph}>
                  最低运行 6 轮——在此之前即使出现饱和信号也不会停止，确保有足够的迭代深度。
                </p>

                <h4 className={cx(h3, h3Sm)}>启动前与运行中</h4>
                <ul className={ul}>
                  <li><b>安全网</b>：启动时自动创建里程碑快照（<code>deepen-{`{stage}`}-start</code>），不满意可用「撤销」一键回退到深化前状态</li>
                  <li><b>状态条</b>：底部实时显示「🔁 深化中 · 第 N 轮（审查/修订） · 截止 HH:MM」+ 📊 评分轨迹（如「动机清晰度 3→5, 关系丰富度 2→4」）</li>
                  <li><b>特别指导</b>：可选文本，给 AI 一个方向（如「增加更多女性角色」「加强反派动机深度」），每轮都会注入</li>
                </ul>

                <div className={callout}>
                  <div className={calloutTitle}>💡 什么时候用深化？</div>
                  <ul className={cx(ul, ulWithGap)}>
                    <li>初版设定太薄、缺乏深度时（如角色动机单薄、世界观体系有漏洞）</li>
                    <li>想要无人值守地迭代改写（睡前启动，设定截止时间，早上看结果）</li>
                    <li>卡壳时想看 AI 从不同视角能挑出什么问题</li>
                  </ul>
                  深化只作用于<b>规划阶段</b>（概念/世界观/角色/大纲/场景），不改章节正文。正文打磨用 <code>/revision</code> 和 <code>/polish</code>。
                </div>

                <h3 className={h3}>辅助命令与视图</h3>
                <table className={table}>
                  <thead>
                    <tr><th>命令 / 视图</th><th>作用</th><th>何时使用</th></tr>
                  </thead>
                  <tbody>
                    <tr><td><code>/enrich</code></td><td>扫描并补全缺失的结构化数据（state / outline-meta / 关系图 / 模板新增维度节，只增不覆盖）</td><td>从旧项目迁移、手动编辑后修复元数据、或插件模板更新后补充新增维度</td></tr>
                    <tr><td><code>/import {'<路径>'}</code></td><td>导入源文本并逆向拆书（自动切章 + 分析）</td><td>有已有小说文本想导入系统分析</td></tr>
                    <tr><td><code>/draft</code></td><td>进入写作阶段，逐章创作正文</td><td>设定完成后开始写正文</td></tr>
                    <tr><td><code>/revision</code></td><td>审阅阶段：检查逻辑/伏笔遗漏/OOC/AI 味，逐章修订</td><td>初稿完成后系统排查问题</td></tr>
                    <tr><td><code>/polish</code></td><td>润色阶段：用词精准度、句式节奏、对话自然度</td><td>修订后最终行文打磨</td></tr>
                    <tr><td><code>/retry</code></td><td>重试上一条消息</td><td>上一次结果不满意想重新生成</td></tr>
                    <tr><td>侧边栏「伏笔」</td><td>查看全书伏笔埋设/回收状态</td><td>检查伏笔回收率、追踪未兑现的线索</td></tr>
                    <tr><td>侧边栏「故事脉络」</td><td>可视化叙事弧线走势</td><td>检视整体节奏和张分布</td></tr>
                    <tr><td>侧边栏「角色关系」</td><td>角色关系图谱</td><td>审视角色间的连接和势力结构</td></tr>
                    <tr><td>侧边栏「总览」</td><td>项目统计、进度条、最近章节与快照</td><td>了解项目整体状态和写作进度</td></tr>
                  </tbody>
                </table>

                <div className={callout}>
                  <div className={calloutTitle}>💡 修改设定后的善后</div>
                  回到前期阶段调整设定后，用 <code>/enrich</code> 同步更新结构化元数据（state / outline-meta / 角色关系图），确保后续写作引用的是最新状态。已写成的章节不会自动追溯修改，如需调整已完成章节以匹配新设定，用章节编辑器的✎ 修订逐一处理。
                </div>
              </div>
            </section>

            <section id="wuxia" className={section}>
              <h2 className={sectionTitle}>武侠创作</h2>
              <div className={sectionBody}>
                <p className={paragraph}>
                  创建项目时选择「武侠」题材，系统会自动加载武侠专属模板与写作技能（<code>plugins/wuxia/SKILL.md</code>），
                  并在侧边栏增加「武侠」视图入口。
                </p>

                <h3 className={h3}>武侠仪表盘</h3>
                <p className={paragraph}>
                  侧边栏点击「武侠」进入设定仪表盘，它聚合两个数据源：
                </p>
                <ul className={ul}>
                  <li><b>独立设定文件</b>（<code>.novel/wuxia/</code>）：按内容自动归类到「功法体系」「神兵利器」「势力总览」「势力详情」等分组</li>
                  <li><b>世界观维度</b>（<code>world-building.md</code> 的武侠 <code>##</code> 节）+ <b>角色武学路数</b>（<code>characters/profiles.md</code> 中的能力/手段/功法/兵器子节）</li>
                </ul>
                <p className={paragraph}>仪表盘以彩色卡片按维度展示，支持以下操作：</p>
                <table className={table}>
                  <thead>
                    <tr><th>操作</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    <tr><td>✎ 修订</td><td>对单张卡片（某一节）发指令式重写，如「给这个门派增加一个隐藏派规」</td></tr>
                    <tr><td>⇄ 重命名</td><td>重命名节标题或文件</td></tr>
                    <tr><td>🔁 深化</td><td>让 AI 自主循环补全世界观中的武侠设定空缺</td></tr>
                    <tr><td>💡 灵感</td><td>为势力详情卡片生成即兴灵感（门派风格、势力弱点等）</td></tr>
                  </tbody>
                </table>

                <h3 className={h3}>专属模板</h3>
                <p className={paragraph}>
                  武侠项目的概念与世界观文档使用定制模板，包含武侠特有的结构化区块：
                </p>
                <ul className={ul}>
                  <li><code>concept.md</code>：江湖背景、核心冲突（正邪之争 / 门派纷争 / 个人命运）、武侠元素、道德主题</li>
                  <li><code>world-building.md</code>：时代背景、江湖格局（正派 / 邪派 / 中立势力表格）、武功体系（内功 / 外功 / 轻功 / 暗器）、百工技艺、神兵利器、江湖规矩、历史恩怨</li>
                </ul>

                <h3 className={h3}>武侠写作技法</h3>
                <p className={paragraph}>
                  武侠技能在通用写作纪律之外注入题材专属约束，核心要点：
                </p>
                <ul className={ul}>
                  <li><b>打斗场景</b>：用动词链与距离感写动作，一招一果；招式命名点缀画面，不可取代画面</li>
                  <li><b>武功内力</b>：写代价与限制——发一成力伤一分己，内力有尽时，强招有反噬；比拼写体内具体感受，不写「冲击波」</li>
                  <li><b>门派江湖</b>：门派落到戒律、传承、立场上，江湖张力来自道义两难而非正邪脸谱</li>
                  <li><b>反 AI 味</b>：武侠版六种模式自检——抽象情绪标签、模板心理独白、排比堆砌、万能形容词、转折连词滥用、情节概括代替演绎</li>
                </ul>
                <div className={callout}>
                  <div className={calloutTitle}>⚔ 写作提示</div>
                  武侠的质量检查面板会额外审视：武学体系自洽（战力是否膨胀失控）、江湖生态完整（正邪对立是否有深度）、武学成长曲线（主角实力提升节奏）、恩怨因果链是否完整。
                </div>
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
                    <tr><td>MD / MD稿</td><td>导出全文 Markdown（MD 含设定文档；MD稿 仅正文，适合投稿）</td></tr>
                    <tr><td>TXT</td><td>导出纯文本</td></tr>
                    <tr><td>回滚</td><td>回到任一历史快照（快照之后产生的文件会被删除，回滚前自动保存当前状态）</td></tr>
                    <tr><td>存版本</td><td>保存当前状态为版本标签（自动 git commit + tag）</td></tr>
                    <tr><td>同步</td><td>同步到远程仓库</td></tr>
                    <tr><td>显示预览</td><td>展开/收起右侧文件预览面板</td></tr>
                  </tbody>
                </table>
                <p className={paragraph}>
                  每次写作完成后系统会自动创建快照；遇到不满意的结果用「回滚」回到之前的状态，关键节点用「存版本」锁定。质检不通过被归档的章节可在写作视图底部「已归档」分组一键恢复。
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
