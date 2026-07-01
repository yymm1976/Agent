# 多Agent协作流程框架调研报告

> 调研时间：2025年6月  
> 覆盖范围：主流多Agent协作开发框架

---

## 一、调研概述

本报告聚焦于**多Agent协作流程框架**，即支持多个AI Agent之间进行任务分配、通信协调、流程编排的软件开发框架。重点对比其架构设计、协作模式、通信机制、适用场景及生产就绪度。

---

## 二、主流框架概览

| 框架 | 开发者 | 语言支持 | 开源协议 | GitHub Stars |
|------|--------|----------|----------|-------------|
| **AutoGen** | Microsoft | Python, .NET | MIT | 45k+ |
| **CrewAI** | CrewAI | Python | MIT | 28k+ |
| **LangGraph** | LangChain | Python, JS/TS | MIT | 8k+ |
| **MetaGPT** | DeepWisdom | Python | MIT | 48k+ |
| **Camel-AI** | CAMEL-AI | Python | Apache 2.0 | 6k+ |
| **Autogen Studio** | Microsoft | Python (Web UI) | MIT | — |
| **Swarm** | OpenAI | Python | MIT | 20k+ |
| **AG2** | 社区 (AutoGen fork) | Python | MIT | 3k+ |

---

## 三、核心框架深度分析

### 3.1 AutoGen (Microsoft)

**架构模型：** 事件驱动的Actor模型

**核心概念：**
- **ConversableAgent**：基础Agent类，可发送/接收消息
- **AssistantAgent**：使用LLM生成回复
- **UserProxyAgent**：代表人类执行代码/操作
- **GroupChat**：多Agent群聊协作

**协作流程：**
```
用户请求 → UserProxyAgent 发起对话
         → AssistantAgent 生成方案
         → 可嵌套调用其他Agent
         → 循环对话直到终止条件满足
```

**通信机制：**
- 基于消息传递的异步通信
- 支持同步/异步两种模式
- 内置对话历史管理

**优势：** 灵活的对话拓扑、支持人机协作、代码执行沙箱  
**劣势：** 调试复杂、对话流难以精确控制

---

### 3.2 CrewAI

**架构模型：** 角色-任务-流程 三层架构

**核心概念：**
- **Agent**：具有特定角色(role)、目标(goal)、背景故事(backstory)
- **Task**：定义具体任务、期望输出、负责Agent
- **Crew**：Agent集合 + 流程定义
- **Process**：协作流程（顺序/层级/共识）

**协作流程：**
```
Crew 定义
  ├── Agent A (研究员)
  ├── Agent B (写手)
  └── Agent C (审核员)

Process.sequential:  A → B → C 顺序执行
Process.hierarchical: Manager → 分配任务 → 汇总结果
```

**通信机制：**
- 隐式通信（通过任务委托）
- Agent间通过delegation机制传递信息
- 内置记忆系统（短期/长期/实体记忆）

**优势：** 概念直观、上手快、角色定义清晰  
**劣势：** 流程控制粒度较粗、复杂分支场景支持有限

---

### 3.3 LangGraph

**架构模型：** 有向状态图（DAG / 循环图）

**核心概念：**
- **StateGraph**：定义状态流转图
- **Node**：执行单元（可以是Agent、函数、工具调用）
- **Edge**：状态转移条件
- **State**：全局共享状态对象
- **Checkpoint**：状态持久化/回溯

**协作流程：**
```
定义 State Schema
    ↓
构建 Graph:
  START → [Agent A] → 条件判断 → [Agent B] → END
                              ↘ [Agent C] ↗
    ↓
编译为可执行 App
    ↓
支持流式输出、中断恢复、人工介入
```

**通信机制：**
- 通过共享State进行数据传递
- 显式边条件控制流转
- 支持条件路由、并行分支、循环

**优势：** 
- 流程完全可控、可可视化
- 原生支持持久化和人工介入(human-in-the-loop)
- 生产就绪度最高（LangSmith集成）

**劣势：** 学习曲线较陡、需要手动设计状态Schema

---

### 3.4 MetaGPT

**架构模型：** 模拟软件公司的SOP流程

**核心概念：**
- **Role**：产品经理、架构师、工程师、QA等角色
- **Action**：每个角色执行的具体动作
- **Message**：角色间通信的结构化消息
- **Environment**：共享环境，消息发布/订阅

**协作流程：**
```
需求输入 → ProductManager(需求文档)
         → Architect(系统设计)
         → ProjectManager(任务拆分)
         → Engineer(代码实现)
         → QA(测试验证)
```

**通信机制：**
- 发布-订阅模式（Publish-Subscribe）
- 结构化消息（带sender、receiver、content、action类型）
- 全局共享环境

**优势：** 软件开发场景高度优化、SOP流程标准化  
**劣势：** 场景局限性强、非软件类任务适配困难

---

### 3.5 CAMEL-AI

**架构模型：** 角色扮演对话（Role-Playing）

**核心概念：**
- **AIUser / AIAssistant**：双Agent角色扮演
- **TaskSpecifiedAgent**：任务定义Agent
- **RolePlaying**：初始化对话框架

**协作流程：**
```
定义任务 → 分配User角色和Assistant角色
         → 自主对话协作
         → 直到任务完成或达到轮次上限
```

**通信机制：**
- 结构化提示词框架（Inception Prompt）
- 对话轮次控制
- 支持多轮自主协商

**优势：** 学术研究友好、理论框架清晰  
**劣势：** 主要支持双Agent、多Agent扩展性不足

---

### 3.6 OpenAI Swarm

**架构模型：** 轻量级Handoff模式

**核心概念：**
- **Agent**：轻量Agent定义（instructions + functions）
- **Handoff**：Agent间任务移交
- **Routine**：预定义的工作流模式

**协作流程：**
```
用户请求 → Triage Agent (路由)
         → Handoff → Specialist Agent A
         → 或 Handoff → Specialist Agent B
         → 返回结果
```

**通信机制：**
- Handoff函数实现Agent切换
- 上下文变量传递
- 无状态设计（每次调用独立）

**优势：** 极简设计、教学友好、易理解  
**劣势：** 功能过于简单、不适合生产环境、无持久化

---

## 四、关键维度对比

### 4.1 协作模式对比

| 框架 | 顺序流 | 并行流 | 条件路由 | 循环 | 层级管理 | 动态组队 |
|------|:------:|:------:|:--------:|:----:|:--------:|:--------:|
| AutoGen | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| CrewAI | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| LangGraph | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MetaGPT | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| CAMEL | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| Swarm | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |

### 4.2 通信机制对比

| 框架 | 消息传递 | 共享状态 | 发布订阅 | 委托机制 | 结构化消息 |
|------|:--------:|:--------:|:--------:|:--------:|:----------:|
| AutoGen | ✅ | ✅ | ❌ | ✅ | ❌ |
| CrewAI | ❌ | ❌ | ❌ | ✅ | ❌ |
| LangGraph | ❌ | ✅ | ❌ | ❌ | ❌ |
| MetaGPT | ✅ | ✅ | ✅ | ❌ | ✅ |
| CAMEL | ✅ | ❌ | ❌ | ❌ | ✅ |
| Swarm | ✅ | ✅ | ❌ | ✅ | ❌ |

### 4.3 生产就绪度对比

| 框架 | 持久化 | 可观测性 | 人工介入 | 流式输出 | 错误恢复 | 部署支持 |
|------|:------:|:--------:|:--------:|:--------:|:--------:|:--------:|
| AutoGen | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | Docker |
| CrewAI | ⚠️ | ⚠️ | ❌ | ✅ | ❌ | 有限 |
| LangGraph | ✅ | ✅ | ✅ | ✅ | ✅ | LangServe/Cloud |
| MetaGPT | ❌ | ❌ | ❌ | ❌ | ❌ | 有限 |
| CAMEL | ❌ | ❌ | ❌ | ❌ | ❌ | 无 |
| Swarm | ❌ | ❌ | ❌ | ❌ | ❌ | 无 |

---

## 五、选型建议

### 按场景推荐

| 场景 | 推荐框架 | 理由 |
|------|----------|------|
| **生产级复杂工作流** | LangGraph | 流程可控、持久化、可观测性完善 |
| **快速原型/概念验证** | CrewAI | 上手快、角色定义直观 |
| **人机协作场景** | AutoGen | 原生UserProxy支持、对话式协作 |
| **软件开发自动化** | MetaGPT | SOP流程高度匹配 |
| **教学/研究** | Swarm / CAMEL | 概念简洁、理论清晰 |
| **企业级多Agent系统** | LangGraph + AutoGen | 结合两者优势 |

### 按团队技术栈推荐

| 技术背景 | 推荐框架 |
|----------|----------|
| Python + 熟悉LangChain | LangGraph |
| Python + 快速交付 | CrewAI |
| .NET / 微软生态 | AutoGen (.NET版) |
| 学术研究 | CAMEL / MetaGPT |

---

## 六、趋势与展望

1. **标准化趋势**：Agent通信协议（如A2A、MCP）正在形成行业标准
2. **可视化编排**：低代码/可视化Agent编排成为主流需求
3. **可观测性**：Agent执行追踪、调试工具日趋成熟
4. **混合架构**：单一框架难以满足所有需求，组合使用成为常态
5. **Agent-as-a-Service**：Agent部署和服务化是下一阶段重点

---

## 七、参考资料

- AutoGen: https://github.com/microsoft/autogen
- CrewAI: https://github.com/crewAIInc/crewAI
- LangGraph: https://github.com/langchain-ai/langgraph
- MetaGPT: https://github.com/geekan/MetaGPT
- CAMEL-AI: https://github.com/camel-ai/camel
- Swarm: https://github.com/openai/swarm
- Google A2A Protocol: https://google.github.io/A2A/
- MCP Protocol: https://modelcontextprotocol.io/

---

*报告生成时间：2025年6月*
