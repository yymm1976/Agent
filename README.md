# RouteDev

按任务复杂度自动路由模型的 CLI 开发助手。

## 快速开始

```powershell
pnpm install
cp config.example.yaml %APPDATA%\RouteDev\config.yaml
# 编辑 config.yaml 填入你的 API Key
pnpm build
pnpm start
```

## 开发

```powershell
pnpm dev      # 监听模式
pnpm test     # 运行测试
pnpm typecheck # 类型检查
```

## 项目结构

```
routedev/
├── src/
│   ├── config/        # 配置管理（schema + loader + defaults）
│   ├── utils/         # 工具函数（paths + logger）
│   └── index.ts       # CLI 入口
├── tests/             # 单元测试
├── config.example.yaml # 配置模板
└── ...
```

## 当前进度

- **Phase 1（已完成）**：项目骨架 + 配置系统
- **Phase 2+**：分类器、Agent Loop、工具系统等

## 许可证

AGPL-3.0
