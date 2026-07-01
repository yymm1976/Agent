# 多 Agent 协作流程框架调研报告

> 生成日期：2025-07-14  
> 调研范围：主流多 Agent 协作框架  
> 关键词：Multi-Agent Collaboration, Workflow Orchestration, Agent Framework

---

## 一、概述

随着 LLM Agent 从单轮对话走向复杂任务编排，多 Agent 协作框架成为 2024-2025 年最活跃的 AI 基础设施赛道。本报告聚焦 **以代码编程或工作流编排方式实现多 Agent 协作** 的框架，从架构模式、协作机制、部署方式、适用场景等维度进行横向对比。

---

## 二、框架全景总览

| 框架 | 开发商 | 开源 | 语言 | 首次发布 | GitHub Stars | 核心定位 |
|------|--------|------|------|----------|-------------|---------|
| **LangGraph** | LangChain | ✅ MIT | Python/JS | 2024.01 | ~10k+ | 低层级有状态 Agent 工作流图 |
| **AutoGen** | Microsoft | ✅ MIT | Python | 2023.10 | ~35k+ | 对话驱动多 Agent 协作 |
| **CrewAI** | CrewAI Inc | ✅ MIT | Python | 2024.03 | ~25k+ | 角色扮演式多 Agent 团队 |
| **Semantic Kernel → Microsoft Agent Framework** | Microsoft | ✅ MIT | C#/Python | 2023.05 | ~22k+ | 企业级 Agent 编排 |
| **OpenAI Agents SDK** | OpenAI | ✅ MIT | Python | 2025.03 | ~20k+ | 轻量级多 Agent 工作流 |
| **MetaGPT** | 社区 | ✅ MIT | Python | 2023.08 | ~30k+ | 软件公司角色模拟 |
| **Smolagents** | Hugging Face | ✅ Apache | Python | 2024.12 | ~15k+ | 极简 Code Agent |
| **Dify** | Dify.AI | ✅ Apache | Python/TS | 2023.05 | ~60k+ | 可视化 Agent 工作流编排 |
| **Letta (MemGPT)** | Letta | ✅ Apache | Python | 2024.06 | ~12k+ | 长期记忆管理 Agent |
| **Agno (原 Phidata)** | Agno | ✅ MIT | Python | 2024.01 | ~18k+ | 多模态 Agent 框架 |

---

## 三、核心框架深度分析

### 3.1 LangGraph（LangChain）

| 维度 | 说明 |
|------|------|
| **架构模式** | 有向图（DAG） + 状态机，节点=Agent/函数，边=条件路由 |
| **协作机制** | 节点间通过共享 State 通信，支持条件分支、循环、并行执行 |
| **状态管理** | 内置 StateGraph，支持持久化（PostgreSQL/Redis），可恢复中断 |
| **人机交互** | 内置 Human-in-the-loop，可在任意节点中断并等待人工输入 |
| **部署方式** | LangGraph Platform（托管）+ 自部署 |
| **优势** | 细粒度控制、持久化执行、生态兼容 LangChain 全家桶 |
| **不足** | 学习曲线陡峭，概念多（StateGraph/Checkpoint/Node/Edge） |
| **适用场景** | 复杂有状态工作流、需要精确编排的流水线 |

**协作流程示例：**
```
[User Input] → [Supervisor Agent (路由)] 
                ├→ [Researcher Agent] → [Search Tools]
                ├→ [Coder Agent] → [Code Executor]
                └→ [Reviewer Agent] → [Quality Check]
              → [Aggregator Node] → [Final Output]
```

---

### 3.2 AutoGen（Microsoft）

| 维度 | 说明 |
|------|------|
| **架构模式** | 对话驱动，Agent 之间通过异步消息通信 |
| **协作机制** | GroupChat + Round-Robin/Speaker 选择，Agent 可动态加入/退出 |
| **代码执行** | 跨语言代码执行沙箱（Docker），支持 Python/JS/C# |
| **协议支持** | 原生支持 MCP Server 集成，支持 A2A 互操作 |
| **部署方式** | Python SDK + AutoGen Studio（可视化） |
| **优势** | 动态对话流、代码执行能力强、微软生态支持 |
| **不足** | 调试困难，对话流不可直观查看 |
| **适用场景** | 开放式讨论、代码生成与执行、需要动态角色的场景 |

**协作流程示例：**
```
[User] ↔ [Assistant Agent]
          ↔ [Code Writer Agent] → [Code Executor Agent]
          ↔ [Critic Agent] → [Human Feedback]
        → [Final Answer]
```

---

### 3.3 CrewAI

| 维度 | 说明 |
|------|------|
| **架构模式** | 角色扮演式（Role-Playing），每个 Agent 有明确角色/目标/技能 |
| **协作机制** | Crew（团队）→ Task（任务）→ Process（顺序/层级/协商） |
| **任务编排** | 支持顺序执行、层级管理（Manager Agent 协调）、自主协商 |
| **工具集成** | 内置工具 + 自定义工具 + LangChain 工具集成 |
| **部署方式** | Python SDK + 独立运行 |
| **优势** | 概念直观（团队/角色/任务），上手快，适合业务场景建模 |
| **不足** | 复杂工作流控制力不如 LangGraph，状态管理弱 |
| **适用场景** | 内容生成、数据分析、报告撰写、自动化工作流 |

**协作流程示例：**
```python
# CrewAI 概念模型
crew = Crew(
    agents=[Researcher(), Writer(), Reviewer()],
    tasks=[research_task, write_task, review_task],
    process=Process.sequential  # 或 Process.hierarchical
)
```

---

### 3.4 Microsoft Agent Framework（原 Semantic Kernel）

| 维度 | 说明 |
|------|------|
| **架构模式** | Agent 作为一等公民，通过 AgentGroupChat 协作 |
| **协作机制** | 支持自动选择发言者、顺序、自定义策略 |
| **协议互操** | 原生支持 MCP（Model Context Protocol）+ A2A（Agent-to-Agent） |
| **企业特性** | Azure OpenAI 集成、企业级安全策略、Telemetry |
| **部署方式** | NuGet/PyPI SDK + Azure AI Foundry |
| **优势** | 企业级就绪、多语言（C#/Python）、A2A 互操作 |
| **不足** | 社区相对 LangChain 小，文档仍有缺口 |
| **适用场景** | 企业级应用、.NET 生态、Azure 集成场景 |

---

### 3.5 OpenAI Agents SDK

| 维度 | 说明 |
|------|------|
| **架构模式** | Agent 即工具（Agent as Tool），通过 Handoff 实现多 Agent |
| **协作机制** | Agent 可注册为另一个 Agent 的工具，形成层级链 |
| **沙箱执行** | Sandbox Agent 预配置 Docker 容器，支持长时间运行 |
| **安全机制** | Guardrail（护栏），输入/输出双端过滤 |
| **部署方式** | 轻量 Python SDK，支持 OpenAI 与 100+ 第三方模型 |
| **优势** | 设计极简、与 GPT 系列原生配合、Guardrail 安全 |
| **不足** | 复杂编排能力有限，生态未成熟 |
| **适用场景** | 快速原型、轻度多 Agent 场景、OpenAI 生态用户 |

---

### 3.6 MetaGPT

| 维度 | 说明 |
|------|------|
| **架构模式** | 软件公司角色模拟（产品经理/架构师/工程师/QA） |
| **协作机制** | SOP（标准作业程序）驱动，角色间通过结构化文档流通 |
| **输出质量** | 角色分工产生交叉验证，输出产品需求/设计文档/代码/测试 |
| **部署方式** | Python CLI + SaaS（mgx.dev） |
| **优势** | 角色分工成熟、代码生成质量高、学术影响力强 |
| **不足** | 领域局限在软件开发，不适合通用任务 |
| **适用场景** | 软件项目需求→设计→编码→测试全流程自动化 |

---

### 3.7 Smolagents（Hugging Face）

| 维度 | 说明 |
|------|------|
| **架构模式** | Code Agent——Agent 以 Python 代码形式思考和行动 |
| **协作机制** | 支持 Multi-Agent 模式，Agent 可调用其他 Agent |
| **安全沙箱** | 原生支持 E2B / Modal / Docker 沙箱执行 |
| **Hub 生态** | Hugging Face Hub 分享工具与 Agent |
| **部署方式** | pip 安装，轻量 Python 库 |
| **优势** | 极简（~1000 行核心）、模型无关、安全沙箱 |
| **不足** | 多 Agent 协作支持较基础，功能不如 LangGraph 丰富 |
| **适用场景** | 轻量 Agent 原型、Hugging Face 生态用户、安全敏感场景 |

---

### 3.8 Dify

| 维度 | 说明 |
|------|------|
| **架构模式** | 可视化工作流（DAG） + LLM 节点编排 |
| **协作机制** | 拖拽式编排 Agent 节点，支持条件/循环/并行/子工作流 |
| **知识管理** | 内置 RAG 知识库、文档解析 |
| **部署方式** | Docker 自部署 + Dify Cloud |
| **优势** | 可视化/低代码、开源 62k+ Stars、中文支持好 |
| **不足** | 编程灵活性不如代码框架、复杂逻辑受限 |
| **适用场景** | 非技术人员搭建 Agent 工作流、快速原型验证 |

---

## 四、横向对比：关键维度

### 4.1 协作模式

| 框架 | 协作模式 | 通信机制 | 动态性 |
|------|---------|---------|--------|
| LangGraph | 图状态机 | 共享 State | 静态图（编译时确定） |
| AutoGen | 对话驱动 | 异步消息 | 动态加入/退出 |
| CrewAI | 角色任务派发 | 任务队列 | 半动态（Process 决定） |
| MAF (SK) | 对话/策略 | 消息传递 | 可定制策略 |
| OpenAI SDK | 层级 Handoff | 工具调用 | 静态层级 |
| MetaGPT | SOP 流水线 | 文档传递 | 静态角色 |
| Smolagents | Code Agent 互调 | 函数调用 | 动态 |
| Dify | 可视化 DAG | 数据流管道 | 静态图（运行时可配置） |

### 4.2 状态管理与持久化

| 框架 | 状态管理 | 持久化 | 断点恢复 |
|------|---------|--------|---------|
| LangGraph | StateGraph | ✅ PostgreSQL/Redis | ✅ |
| AutoGen | 对话历史 | ❌ 需自行实现 | ❌ |
| CrewAI | 任务上下文 | ❌ 需自行实现 | ❌ |
| MAF (SK) | 对话历史 | ✅ 可扩展 | ❌ |
| OpenAI SDK | Session | ✅ 自动管理 | ❌ |
| MetaGPT | 文档流转 | ❌ | ❌ |
| Smolagents | 上下文变量 | ❌ | ❌ |
| Dify | 工作流变量 | ✅ DB 持久化 | ✅ |

### 4.3 人机交互（Human-in-the-Loop）

| 框架 | 内置支持 | 粒度 |
|------|---------|------|
| LangGraph | ✅ 完善 | 节点级中断 |
| AutoGen | ✅ | 对话级反馈 |
| CrewAI | ⚠️ 有限 | 任务级人工审核 |
| MAF (SK) | ✅ | 可配置 |
| OpenAI SDK | ✅ | 运行级中断 |
| MetaGPT | ❌ | 无 |
| Smolagents | ❌ | 无 |
| Dify | ✅ | 节点级审批 |

### 4.4 学习曲线与上手成本

| 框架 | 学习成本 | 最小代码量 | 文档质量 |
|------|---------|-----------|---------|
| LangGraph | 🔴 高 | ~50 行 | ⭐⭐⭐⭐⭐ |
| AutoGen | 🟡 中 | ~30 行 | ⭐⭐⭐⭐ |
| CrewAI | 🟢 低 | ~20 行 | ⭐⭐⭐⭐ |
| MAF (SK) | 🟡 中 | ~30 行 | ⭐⭐⭐⭐ |
| OpenAI SDK | 🟢 低 | ~15 行 | ⭐⭐⭐⭐ |
| MetaGPT | 🟡 中 | ~10 行（CLI） | ⭐⭐⭐ |
| Smolagents | 🟢 低 | ~10 行 | ⭐⭐⭐ |
| Dify | 🟢 极低 | 无需代码 | ⭐⭐⭐⭐⭐ |

---

## 五、选型建议

### 按场景推荐

| 场景 | 首选 | 备选 |
|------|------|------|
| **复杂有状态工作流** | LangGraph | Dify（可视化） |
| **多 Agent 讨论/代码生成** | AutoGen | OpenAI SDK |
| **业务角色自动化** | CrewAI | MetaGPT（软件领域） |
| **企业级 .NET/Azure 集成** | Microsoft Agent Framework | LangGraph |
| **快速原型/低代码** | Dify | CrewAI |
| **轻量/安全优先** | Smolagents | OpenAI SDK |
| **软件全流程自动化** | MetaGPT | CrewAI + 自定义 |

### 按团队技术栈推荐

| 团队背景 | 推荐框架 | 理由 |
|---------|---------|------|
| Python 全栈 | LangGraph + CrewAI | 互补：一个控制力强，一个上手快 |
| .NET / C# | Microsoft Agent Framework | 原生支持，企业级 |
| 前端/全栈 JS | LangGraph.js | JS 生态最成熟的多 Agent 框架 |
| 非技术/产品 | Dify | 无需编码，可视化编排 |
| AI 研究 | AutoGen + Smolagents | 灵活，适合实验性探索 |

---

## 六、技术趋势总结

1. **A2A 与 MCP 互操作协议**：2025 年各框架纷纷支持 Agent-to-Agent 通信标准，将来可跨框架协作
2. **持久化 Agent 成为标配**：LangGraph、Dify 已支持，其他框架正在跟进
3. **安全与可控性**：Guardrail（OpenAI）、Human-in-the-loop（LangGraph）成为差异化竞争点
4. **低代码化**：Dify 代表的可视化工作流正在挤压纯代码框架的简单场景市场
5. **企业级需求驱动**：Microsoft 将 Semantic Kernel 升级为 Microsoft Agent Framework，提供企业级 SLA

---

## 七、结论

当前多 Agent 协作框架处于**百花齐放但未统一**的阶段：
- **需要精细控制** → LangGraph（最成熟的有状态图编排）
- **需要快速交付** → CrewAI 或 Dify（低代码）
- **需要微软生态** → Microsoft Agent Framework
- **需要最新实验性功能** → AutoGen / OpenAI SDK

推荐组合策略：**LangGraph 做核心编排 + CrewAI 做业务角色封装**，在控制力与开发效率之间取得平衡。

---

*本报告基于各项目 GitHub 页面、官方文档及社区信息整理，部分数据截至 2025 年 7 月。*
