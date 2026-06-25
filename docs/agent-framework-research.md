# 主流 AI Agent 框架调研报告（2025）

> 调研时间：2025年
> 调研方式：5个子Agent并行网络调研 + 汇总整理
> 目标读者：正在开发自己Agent的开发者

---

## 一、框架全景概览

| 框架 | 开发方 | GitHub Stars | 语言支持 | 定位 |
|------|--------|-------------|----------|------|
| **LangChain / LangGraph** | LangChain Inc. | ~134K / ~15K | Python, JS/TS, Go | 通用Agent框架 + 有状态图编排 |
| **CrewAI** | CrewAI Inc. | ~45K | Python | 多Agent角色扮演协作 |
| **AutoGen / AG2** | 微软研究院 | ~42K | Python, .NET | 多Agent对话框架 |
| **Semantic Kernel** | 微软 | ~28K | Python, C#, Java | 企业级AI编排SDK |
| **Dify** | Dify.AI（开源） | ~62K | Python + React | 可视化AI工作流平台 |
| **FastGPT** | 环界云（开源） | ~28K | TypeScript | 知识库问答系统 |
| **OpenAI Agents SDK** | OpenAI | 新兴 | Python, TS | 轻量官方Agent SDK |
| **CAMEL-AI** | CAMEL社区 | ~20K | Python | 多Agent角色扮演研究 |

---

## 二、架构对比

| 维度 | LangChain/LangGraph | CrewAI | AutoGen | Semantic Kernel | Dify | FastGPT | OpenAI SDK |
|------|---------------------|--------|---------|-----------------|------|---------|------------|
| **架构范式** | 有向图状态机 | 角色扮演团队 | 对话驱动 | Skill编排+Planner | 可视化工作流 | Flow模块 | Agent Loop |
| **单/多Agent** | 两者皆可 | 原生多Agent | 原生多Agent | 两者皆可 | 两者皆可 | 单Agent为主 | 两者皆可 |
| **编排方式** | 图节点边定义 | 顺序/层级流程 | 对话协商 | 插件组合 | 拖拽连线 | 预设Flow | 代码循环 |
| **记忆机制** | 持久化StateGraph | 短期+长期记忆 | 对话历史 | 插件状态 | 会话变量 | 知识库 | 内置Handoff |
| **工具调用** | 丰富生态 | 内置 | 函数调用 | Plugin/Skill | 可视化配置 | API集成 | 内置工具 |
| **可观测性** | LangSmith（强） | 内置日志 | Studio UI | 集成Azure Monitor | 内置日志 | 内置日志 | 有限 |
| **学习曲线** | 中高 | 低 | 中 | 中 | 低 | 低 | 低 |

---

## 三、2025年最新版本与更新

### 3.1 LangChain / LangGraph
- **LangChain v1.0**（2025年10月GA）：全新 `create_agent` 函数、中间件系统、内置LangGraph引擎
- **LangGraph v1.0**（2025年10月GA）：持久化状态、Human-in-the-loop、细粒度节点控制
- **趋势**：达到生产就绪里程碑，Uber/LinkedIn/Klarna等在生产使用

### 3.2 CrewAI
- **v1.1.0**（2025年）：Flows架构、Crews协作、企业级特性
- **定位**：从"多Agent协作"扩展为"完整Agent开发平台"

### 3.3 AutoGen / AG2
- **AG2 v0.4+**：从AutoGen分叉，社区驱动
- **微软原版AutoGen**：三层架构（AgentChat/Core/Extensions）+ Studio无代码UI
- **注意**：微软正将AutoGen + Semantic Kernel合并为 **Microsoft Agent Framework 1.0**

### 3.4 Semantic Kernel
- **已升级为 Microsoft Agent Framework 1.0**
- 统一AutoGen和SK的运行时
- 支持Python/C#/Java三语言

### 3.5 Dify
- 从RAG工具进化为**可视化Agent工作流编排平台**
- 支持MCP协议
- 62K Stars，国内最受欢迎

### 3.6 OpenAI Agents SDK
- 2025年新发布
- 极简设计：4个核心原语（Agent、Handoff、Guardrails、Tracing）
- 支持Python和TypeScript

---

## 四、生产实践案例

### 案例1：Klarna（金融科技）— 客服自动化
- **框架**：LangChain + LangGraph + LangSmith
- **效果**：AI助手承担700名全职员工工作量；平均解决时间降低80%
- **关键**：LangGraph构建可控多Agent路由；LangSmith做TDD

### 案例2：C.H. Robinson（全球物流）— 邮件订单自动化
- **框架**：LangChain + LangGraph + LangSmith
- **效果**：5,500个订单/天完全自动化，每天节省600+小时人工
- **关键**：LangGraph处理复杂逻辑状态追踪

### 案例3：Rakuten（乐天）— 企业级多AI应用平台
- **框架**：LangChain + LangSmith（OpenGPTs）
- **效果**：为32,000名员工构建AI应用
- **关键**：统一平台降低AI应用开发门槛

### 案例4：国内运维Agent
- **场景**：云原生运维知识库
- **效果**：3,000+运维案例；一次扫描从13条异常日志归纳为3类核心问题
- **关键**：关键词规则 + LLM语义判断结合，降低成本

---

## 五、选型决策指南

### 5.1 决策树

```
开始选型
├─ 你的技术栈是什么？
│  ├─ .NET/C#/Java → Semantic Kernel / Microsoft Agent Framework
│  ├─ TypeScript/JS → LangChain.js / Mastra / OpenAI Agents SDK
│  └─ Python → 继续往下
│
├─ 任务复杂度如何？
│  ├─ 简单任务 + 快速原型 → CrewAI / OpenAI Agents SDK
│  ├─ 中等复杂度 + 多Agent协作
│  │  ├─ 角色分工明确 → CrewAI
│  │  └─ 对话式协作 → AutoGen
│  └─ 高复杂度 + 长流程 + 状态管理 → LangGraph
│
├─ 生产部署要求？
│  ├─ 需要可观测性/调试 → LangGraph + LangSmith
│  ├─ 需要低代码/可视化 → Dify / Coze
│  └─ 快速验证想法 → CrewAI / AutoGen
│
└─ 特殊场景？
   ├─ 大规模Agent集群(100+) → Swarms
   ├─ 软件工程自动化 → MetaGPT
   └─ 知识库问答 → FastGPT
```

### 5.2 场景推荐表

| 场景 | 首选 | 备选 | 理由 |
|------|------|------|------|
| 快速原型 | CrewAI | OpenAI SDK | 上手最快 |
| 复杂工作流 | LangGraph | - | 精细控制 |
| 多Agent协作 | CrewAI | AutoGen | 角色分工直觉 |
| 企业生产 | LangGraph + LangSmith | Semantic Kernel | 可观测性强 |
| 低代码/非技术 | Dify | Coze | 可视化编排 |
| 知识库问答 | FastGPT | Dify | 国产优化 |
| .NET企业 | Semantic Kernel | - | 微软生态 |

### 5.3 迁移成本

| 迁移路径 | 成本 | 说明 |
|----------|------|------|
| CrewAI → LangGraph | 中 | 需重写工作流为图结构 |
| AutoGen → LangGraph | 高 | 对话模式→图模式，概念差异大 |
| LangChain → LangGraph | 低 | 天然兼容 |
| 任何 → Semantic Kernel | 高 | 语言和架构都不同 |

---

## 六、国内开发者视角

### 6.1 国内生态格局

**三梯队格局**：
1. **大厂平台**：字节扣子(Coze)、百度千帆、阿里通义、腾讯元器
2. **开源框架**：Dify(50k+⭐)、FastGPT、MaxKB
3. **垂直厂商**：各类行业解决方案

**流量排名**：扣子(Coze)断层式领先 > 文心智能体 > 通义 > Dify

### 6.2 推荐方案

| 场景 | 推荐方案 | 说明 |
|------|----------|------|
| 个人/小团队 | 扣子/Coze | 零门槛、免费起步 |
| 企业私有化 | Dify + Ollama + DeepSeek | 数据不出域 |
| 知识库场景 | FastGPT | 国产模型适配好 |
| 深度定制 | LangGraph / AutoGen | 技术团队首选 |

### 6.3 合规注意事项

1. **算法备案 + 大模型备案**是前置条件
2. 私有化 ≠ 合规"避风港"，仍需等保2.0、数据分类分级
3. **Dify社区版禁止直接构建商业SaaS**
4. 参考：信通院+腾讯云《AI Agent安全实践指引》

### 6.4 国内踩坑经验

- LangChain与Qwen兼容性问题频发（embedding参数冲突、思考模式截断）
- 国内团队正加速"去LangChain化"
- 32B模型需24GB+ GPU，硬件投入不菲
- 多Agent协作的token消耗是隐性成本

---

## 七、关键经验总结

### 7.1 生产环境必备

1. **容错是第一位**：建立"结构化校验 → 反馈修复重试 → 规则引擎降级 → 双模型交叉验证 → 转人工"五层防御
2. **上下文管理**：短期记忆（滑动窗口）+ 长期记忆（摘要压缩）+ 关键信息显式提取
3. **RAG不是万能**：混合检索（向量+关键词）远优于纯向量；表格和代码不能硬切块
4. **多Agent必须有人类出口**：所有自动化决策最终兜底永远是人
5. **Prompt纳入版本管理**：抽离为独立文件进Git，每次修改跑回归用例

### 7.2 成本控制

- 小模型Tool Call格式不稳定导致反复重试，实际成本可能更高
- 关键路径用强模型，简单分类用弱模型，分级使用最经济
- 先用免费额度跑通流程再定预算

### 7.3 失败案例共性

- 跳过评估体系直接上线
- 低估上下文窗口限制（第15-20轮后Agent质量断崖下跌）
- 未设计异步超时降级
- 日志只有自然语言原文不可排查

---

## 八、2025-2026趋势判断

### 8.1 框架层面

| 趋势 | 说明 |
|------|------|
| **1.0大版本潮** | LangChain/LangGraph、Semantic Kernel Agents均达到GA/1.0，Agent框架从实验走向生产就绪 |
| **大厂合并统一** | 微软合并AutoGen + Semantic Kernel → Microsoft Agent Framework |
| **开放标准互操作** | MCP（Model Context Protocol）、A2A（Agent-to-Agent）成为主流协议 |
| **持久化 + 人机协同** | LangGraph和OpenAI SDK都将持久化状态和Human-in-the-loop视为生产级必备 |
| **轻量 vs 重型两极分化** | OpenAI SDK（4个原语）走极简；LangGraph走全功能重型 |
| **TypeScript崛起** | OpenAI发布TS SDK、Mastra等TS优先框架出现 |

### 8.2 架构层面

- **记忆与状态**正成为差异化关键
- **可观测性**从"可有可无"变为"必备"
- **MCP协议**正成为工具集成的新标准

### 8.3 生态层面

- 2026年多Agent架构已成主流而非概念
- 框架将走向"分层融合"——上层用Dify/CrewAI快速构建，底层用LangGraph处理复杂状态逻辑
- Agent框架从"社区百花齐放"进入"平台标准化"阶段

---

## 九、给开发者的建议

### 9.1 如果你正在开发自己的Agent

1. **先明确场景**：单Agent还是多Agent？简单任务还是复杂工作流？
2. **先跑通再优化**：用CrewAI或OpenAI SDK快速验证想法
3. **生产化时考虑**：LangGraph（控制力）+ LangSmith（可观测性）
4. **国内部署**：Dify + 国产大模型（DeepSeek/Qwen/豆包）
5. **不要过早优化**：先评估体系，再迭代Prompt

### 9.2 技术栈建议

- **Python开发者**：LangGraph（复杂）/ CrewAI（简单）
- **.NET开发者**：Semantic Kernel / Microsoft Agent Framework
- **非技术团队**：Dify / Coze
- **知识库场景**：FastGPT

### 9.3 一句话选型

> 想写得快用CrewAI，想控得稳用LangGraph，想灵活探索用AutoGen，身在企业用Semantic Kernel，不想写代码用Dify。

---

## 附录：参考资源

### 官方文档
- LangChain: https://python.langchain.com/
- LangGraph: https://langchain-ai.github.io/langgraph/
- CrewAI: https://docs.crewai.com/
- AutoGen: https://microsoft.github.io/autogen/
- Semantic Kernel: https://learn.microsoft.com/semantic-kernel/
- Dify: https://docs.dify.ai/
- FastGPT: https://doc.tryfastgpt.ai/
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/

### 生产案例
- Klarna: https://www.langchain.com/case-studies/klarna
- C.H. Robinson: https://www.langchain.com/case-studies/chrobinson
- Rakuten: https://www.langchain.com/case-studies/rakuten

### 国内资源
- 信通院+腾讯云《AI Agent安全实践指引》
- 知乎/掘金/CSDN相关技术文章

---

*报告完成时间：2025年*
*调研方式：5个子Agent并行网络调研 + 汇总整理*
