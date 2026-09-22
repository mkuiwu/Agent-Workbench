# 快速启动指南

## 1. 安装依赖

```bash
pnpm install
```

## 2. 配置环境变量

在项目根目录创建 `.env` 文件，根据需要配置：

### 按模式配置

| 变量 | 说明 | 示例 |
|------|------|------|
| `APP_CHANNELS` | 选择入口：`telegram`、`web`、`terminal` | `terminal` |
| `BOT_TOKEN` | 仅启用 Telegram 时必填 | `123456:ABC-DEF...` |
| `API_KEY` | 仅使用 Claude 时必填 | `sk-ant-...` |
| `ADMIN_LIST` | 可选；Telegram 对外使用前应设置允许的用户 ID | `12345678` |

### 渠道配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_CHANNELS` | 启用的渠道：`telegram`、`web`、`terminal`，可多选 | `telegram` |
| `WEB_HOST` | Web 绑定地址 | `127.0.0.1` |
| `WEB_PORT` | Web 端口 | `3000` |

### AI 提供者

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AGENT_PROVIDER` | `claude` 或 `kimi` | `claude` |

**Claude 提供者**（默认）：
```env
API_KEY=your-anthropic-api-key
# ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
# ANTHROPIC_MODEL=claude-sonnet-4-20250514      # 可选
```

**Kimi 提供者**：
```env
AGENT_PROVIDER=kimi
# KIMI_MODEL=kimi-latest     # 可选
# KIMI_THINKING=true         # 可选
```

> **注意**：Kimi 提供者需要先安装并登录 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)。

### 其他常用配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PROJECT_ROOTS` | 代码仓库根目录 | 自动发现 |
| `DB_PATH` | SQLite 数据库路径 | `runtime_tasks.db` |
| `HTTP_PROXY` | HTTP 代理地址 | - |

## 3. 启动服务

### 生产模式（推荐）

```bash
pnpm prod        # 启动
pnpm logs        # 查看日志
pnpm restart     # 重启
pnpm stop        # 停止
```

### 开发模式

```bash
pnpm dev         # PM2 watch 模式
pnpm dev:logs    # 查看日志
pnpm dev:restart # 重启
pnpm dev:stop    # 停止
```

### 临时调试

```bash
pnpm dev:run     # 直接运行 TypeScript 入口
```

`pnpm dev:run` 读取项目根目录的 `.env`。`pnpm dev` 由 PM2 启动，并读取 `.env.dev`；使用前请分别创建对应的本地配置文件。

## 4. 开发环境隔离

推荐为开发环境创建独立配置：

在项目根目录创建 `.env.dev`，并填写：
```env
AGENT_PROVIDER=kimi
DB_PATH=runtime_tasks_dev.db
WEB_PORT=3001
```

隔离启动命令：
```bash
pnpm dev:isolate:kimi      # Kimi + 开发配置
pnpm dev:isolate:claude    # Claude + 开发配置
```

## 5. 使用 Web UI

如果配置了 `APP_CHANNELS=web` 或 `APP_CHANNELS=telegram,web`，启动后访问：

- 开发环境：http://127.0.0.1:3001（或配置的端口）
- 生产环境：http://127.0.0.1:3000

Web UI 提供：
- 实时对话界面
- 项目切换
- 技能选择
- 状态监控

Web UI 没有内建鉴权，只能保持在 `127.0.0.1`。不要通过公网地址、端口转发或反向代理暴露它。

## 6. 使用终端渠道

如果你只想在本机终端里使用：

```env
APP_CHANNELS=terminal
```

然后运行：

```bash
pnpm dev:run
```

启动后直接在当前终端输入消息即可。普通消息走单 Agent；`/team <任务>` 会由 manager 判断是否需要分析、实现、审查或顺序的实现加审查。

## 常用命令

| 命令 | 说明 |
|------|------|
| `/start` | 启动欢迎信息 |
| `/cd` | 切换项目目录 |
| `/info` | 查看会话状态 |
| `/skills` | 列出可用技能 |
| `/use <skill>` | 使用技能 |
| `/team <task>` | 由 manager 路由到合适的角色流程 |
| `/heartbeat` | 查看当前项目的手动 Heartbeat 状态 |
| `/heartbeat run` | 手动执行一次未完成 Heartbeat 任务 |
| `/reset` | 重置当前项目的会话记忆 |
| `/compress` | 压缩当前会话上下文 |
| `/stop` | 停止当前任务 |
| `/restart` | 重启服务 |

## Team 与 Heartbeat

`/team <任务>` 的角色会话顺序执行，不会并行运行多个 Agent。Web UI 的 Team Workspace 需要一个主工作目录；其他目录仅作为任务上下文。

自动 Heartbeat 调度已禁用。要使用手动任务，在当前项目创建 `HEARTBEAT.md`：

```markdown
- [ ] 检查 CI 状态
- [ ] 审查待处理的 Pull Request
```

使用 `/heartbeat` 查看任务，使用 `/heartbeat run` 手动执行一次。执行前应先审查任务内容。

## 示例配置

### 仅 Telegram

```env
APP_CHANNELS=telegram
BOT_TOKEN=123456:ABC-DEF...
API_KEY=sk-ant-...
ADMIN_LIST=12345678
```

### 仅 Web

```env
APP_CHANNELS=web
API_KEY=sk-ant-...
WEB_HOST=127.0.0.1
WEB_PORT=3000
```

### 仅终端

```env
APP_CHANNELS=terminal
API_KEY=sk-ant-...
```

### Telegram + Web

```env
APP_CHANNELS=telegram,web
BOT_TOKEN=123456:ABC-DEF...
API_KEY=sk-ant-...
ADMIN_LIST=12345678,web
WEB_HOST=127.0.0.1
WEB_PORT=3000
```

### Kimi 提供者

```env
APP_CHANNELS=telegram,web
BOT_TOKEN=123456:ABC-DEF...
AGENT_PROVIDER=kimi
ADMIN_LIST=12345678
```

## 开发命令

```bash
pnpm build       # 构建服务端 + Web UI
pnpm check       # TypeScript 类型检查
pnpm web:dev     # Web UI 开发服务器
```
