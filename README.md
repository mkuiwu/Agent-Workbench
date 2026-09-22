# Agent Workbench

[English](#english) | [中文](#中文)

## English

Agent Workbench is a local coding-agent runtime with Telegram, Web, and terminal interfaces. It can use Claude through the Claude Agent SDK or Kimi through the Kimi Agent SDK, while keeping conversations isolated by channel and project directory.

### Features

- Run the same agent runtime through Telegram, a local Web UI, or a terminal session.
- Use Claude or Kimi as the agent provider.
- Isolate session state by channel and project directory.
- Queue work within a project while allowing unrelated projects to run independently.
- Show task progress, tool activity, and token usage in supported interfaces.
- Load reusable skills and manually run unchecked project tasks from `HEARTBEAT.md`.
- Use `/team <task>` to let a manager route a task to analysis, implementation, review, or a sequential implementation-and-review flow.

### Requirements

- Node.js 22.23 or later (Node.js 24 is the server build target)
- pnpm 10
- PM2 for `pnpm dev` and production lifecycle commands
- A provider setup:
  - Claude: one of `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `API_KEY`
  - Kimi: a locally installed and authenticated [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)

### Quick Start

Install dependencies, then create a local `.env` file in the project root. `.env` is ignored by Git and must never be committed.

```bash
pnpm install
```

Use the terminal interface with Kimi:

```env
APP_CHANNELS=terminal
AGENT_PROVIDER=kimi
```

```bash
pnpm dev:run
```

Use Claude instead:

```env
APP_CHANNELS=terminal
AGENT_PROVIDER=claude
API_KEY=<your-claude-api-key>
```

For a Telegram bot, add `telegram` to `APP_CHANNELS` and set `BOT_TOKEN`. For the Web UI, use `web` and optionally set `WEB_PORT`; it binds to `127.0.0.1` by default.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_CHANNELS` | Comma-separated interfaces: `telegram`, `web`, `terminal` | `telegram` |
| `AGENT_PROVIDER` | Agent backend: `claude` or `kimi` | `claude` |
| `BOT_TOKEN` | Telegram bot token; required for Telegram | - |
| `API_KEY` | Claude API credential; required for Claude | - |
| `WEB_HOST` / `WEB_PORT` | Local Web UI bind address and port | `127.0.0.1` / `3000` |
| `ADMIN_LIST` | Comma-separated Telegram user IDs allowed to use the bot | empty: allow all |
| `PROJECT_ROOTS` | Comma-separated directories available to the project selector | auto-discover |
| `DB_PATH` | SQLite file for persistent session state | `runtime_tasks.db` |
| `SKILLS_ROOT` | Directory containing `SKILL.md` folders | `~/.claude/skills` |

See [QUICKSTART.md](./QUICKSTART.md) for the full configuration reference and more channel examples.

### Commands

| Command | Description |
| --- | --- |
| `pnpm dev:run` | Run the TypeScript entry point directly |
| `pnpm dev` | Start the development process with PM2 watch mode |
| `pnpm build` | Build the server and Web UI |
| `pnpm check` | Run TypeScript and Vue type checks |
| `pnpm prod` | Start the production process through PM2 |

Inside a supported interface, `/cd` selects a project, `/skills` lists skills, and `/use <skill>` selects one for the next request. `/team <task>` asks a manager to choose the appropriate role flow; `/heartbeat` shows the selected project's manual task status, while `/heartbeat run` runs its unchecked tasks once.

### Team Mode

`/team <task>` is available in Telegram and the terminal. The manager first decides whether a request needs analysis, implementation, review, or both implementation and review. Role sessions run sequentially; Team mode is not a parallel multi-agent executor.

The Web UI also includes a Team Workspace for named teams and project directories. One directory is the primary working directory; additional directories are provided as context and are not executed as separate workspaces.

### Manual Heartbeat Tasks

Automatic heartbeat scheduling is disabled. To run a project-local checklist manually, create `HEARTBEAT.md` in the selected project:

```markdown
- [ ] Review open pull requests
- [ ] Check CI failures
```

Run `/heartbeat` to inspect the file and `/heartbeat run` to submit its unchecked items for one execution.

### Security

- Keep credentials only in local `.env` or `.env.*` files. They are ignored by Git.
- Restrict Telegram access with `ADMIN_LIST` before exposing a bot to other users.
- The Web UI has no built-in authentication. Keep `WEB_HOST=127.0.0.1`; do not expose its port through a public address, port forward, or reverse proxy.
- Agent tasks run with broad tool approval in the selected project. Use only trusted projects and review skills and `HEARTBEAT.md` before execution.

### License

This project is licensed under the [MIT License](./LICENSE).

See [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md) before making the repository public.

## 中文

Agent Workbench 是一个本地编程 Agent 运行时，支持 Telegram、Web 和终端入口。它可通过 Claude Agent SDK 使用 Claude，也可通过 Kimi Agent SDK 使用 Kimi，并按渠道和项目目录隔离会话。

### 功能

- 通过 Telegram、本地 Web UI 或终端使用同一套 Agent 运行时。
- 支持 Claude 和 Kimi 两种 Agent 提供者。
- 按渠道和项目目录隔离会话状态。
- 同一项目内任务顺序排队，不同项目可以独立执行。
- 在支持的入口中展示任务进度、工具调用和 Token 用量。
- 加载可复用技能，并手动执行项目 `HEARTBEAT.md` 中未完成的任务。
- 使用 `/team <任务>` 由 manager 路由到分析、实现、审查，或顺序的实现加审查流程。

### 环境要求

- Node.js 22.23 或更高版本（服务端构建目标为 Node.js 24）
- pnpm 10
- 使用 `pnpm dev` 和生产生命周期命令时需要 PM2
- 配置一种 Agent 提供者：
  - Claude：设置 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `API_KEY` 之一
  - Kimi：本机安装并登录 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)

### 快速开始

安装依赖后，在项目根目录创建本地 `.env` 文件。`.env` 已被 Git 忽略，不能提交到仓库。

```bash
pnpm install
```

使用 Kimi 的终端模式：

```env
APP_CHANNELS=terminal
AGENT_PROVIDER=kimi
```

```bash
pnpm dev:run
```

使用 Claude：

```env
APP_CHANNELS=terminal
AGENT_PROVIDER=claude
API_KEY=<你的-Claude-API-Key>
```

使用 Telegram 时，将 `telegram` 加入 `APP_CHANNELS` 并设置 `BOT_TOKEN`。使用 Web UI 时，加入 `web`，也可以设置 `WEB_PORT`；默认只绑定在 `127.0.0.1`。

### 配置说明

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `APP_CHANNELS` | 逗号分隔的入口：`telegram`、`web`、`terminal` | `telegram` |
| `AGENT_PROVIDER` | Agent 后端：`claude` 或 `kimi` | `claude` |
| `BOT_TOKEN` | Telegram Bot Token；启用 Telegram 时必填 | - |
| `API_KEY` | Claude API 凭据；使用 Claude 时必填 | - |
| `WEB_HOST` / `WEB_PORT` | 本地 Web UI 的绑定地址和端口 | `127.0.0.1` / `3000` |
| `ADMIN_LIST` | 允许使用 Telegram Bot 的 Telegram 用户 ID，逗号分隔 | 空：允许所有人 |
| `PROJECT_ROOTS` | 项目选择器可见的根目录，逗号分隔 | 自动发现 |
| `DB_PATH` | 持久化会话状态的 SQLite 文件 | `runtime_tasks.db` |
| `SKILLS_ROOT` | 包含 `SKILL.md` 目录的技能根目录 | `~/.claude/skills` |

完整配置和更多渠道示例见 [QUICKSTART.md](./QUICKSTART.md)。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev:run` | 直接运行 TypeScript 入口 |
| `pnpm dev` | 通过 PM2 watch 模式启动开发进程 |
| `pnpm build` | 构建服务端和 Web UI |
| `pnpm check` | 执行 TypeScript 和 Vue 类型检查 |
| `pnpm prod` | 通过 PM2 启动生产进程 |

在支持的交互入口中，`/cd` 用于选择项目，`/skills` 列出技能，`/use <skill>` 为下一条请求选择技能。`/team <任务>` 会由 manager 选择合适的角色流程；`/heartbeat` 查看当前项目的手动任务状态，`/heartbeat run` 执行一次未完成任务。

### Team 模式

Telegram 和终端都支持直接输入 `/team <任务>`。manager 会先判断任务需要分析、实现、审查，还是实现加审查；各角色会话顺序执行，Team 模式不是并行多 Agent 执行器。

Web UI 还提供 Team Workspace，可保存 team 名称和项目目录。其中一个目录是主工作目录；其他目录只作为任务上下文，不会作为独立工作区自动执行。

### 手动 Heartbeat 任务

自动 Heartbeat 调度已禁用。要手动执行项目内的待办清单，请在当前项目创建 `HEARTBEAT.md`：

```markdown
- [ ] 审查待处理的 Pull Request
- [ ] 检查 CI 失败
```

使用 `/heartbeat` 查看文件状态，使用 `/heartbeat run` 提交其中未完成的任务执行一次。

### 安全边界

- 凭据只放在本地 `.env` 或 `.env.*` 文件中；这些文件已被 Git 忽略。
- Telegram Bot 面向其他人使用前，应通过 `ADMIN_LIST` 限制可访问的用户。
- Web UI 没有内建鉴权。应保持 `WEB_HOST=127.0.0.1`，不要通过公网地址、端口转发或反向代理暴露端口。
- Agent 会在当前项目中以较高的工具权限执行任务。只在可信项目中使用，并在执行前审查技能和 `HEARTBEAT.md`。

### 许可证

本项目采用 [MIT License](./LICENSE)。

公开仓库前，请先完成 [RELEASE_CHECKLIST.md](./RELEASE_CHECKLIST.md)。
