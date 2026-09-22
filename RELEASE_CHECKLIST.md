# Public Release Checklist / 公开发布检查清单

Complete this checklist before changing repository visibility. The repository is intended for source publication, not npm package publication; keep `package.json` with `"private": true` unless that intent changes.

在修改仓库可见性前完成此清单。当前仓库用于公开源码，不用于发布 npm 包；除非发布目标改变，否则保留 `package.json` 中的 `"private": true`。

## Source and History / 源码与历史

- [ ] Confirm the directory has no inherited `.git` history, branches, tags, or remotes.
- [ ] Initialize a fresh repository and verify `git log --oneline` contains only the intended initial commit.
- [ ] Configure a Git author name and email that are acceptable to disclose publicly before committing.
- [ ] Check `git status --ignored` and confirm no `.env`, database, log, `HEARTBEAT.md`, or local `agents/` files are staged.

## Security / 安全

- [ ] Keep `WEB_HOST=127.0.0.1`. The Web UI has no built-in authentication and must not be published through a public address, port forward, or reverse proxy.
- [ ] Set `ADMIN_LIST` before making a Telegram bot accessible to other users.
- [ ] Review installed skills and project-local `HEARTBEAT.md` tasks before execution. Agent runtimes use broad tool approval in the selected project.
- [ ] Run a secret scan that does not print credential values, then inspect any matches manually.

## Verification / 验证

- [ ] Use Node.js 22.23 or later and pnpm 10. The server build target is Node.js 24.
- [ ] Run `pnpm install --frozen-lockfile`.
- [ ] Run `pnpm check`.
- [ ] Run `pnpm audit --prod --registry=https://registry.npmjs.org` and decide how to address reported dependency vulnerabilities. Some mirrors do not provide the audit endpoint.
- [ ] Start a terminal-only session and verify the selected provider can complete a harmless request.
- [ ] If using Telegram or Web, verify each enabled channel with a local test account or local browser.

## Documentation and Licensing / 文档与许可证

- [ ] Confirm [README.md](./README.md) and [QUICKSTART.md](./QUICKSTART.md) match the enabled channels and provider.
- [ ] Confirm Team mode is described as sequential manager routing, and Heartbeat as manual-only execution.
- [x] MIT License added for reuse and external contributions.
- [ ] Review [CHANGELOG.md](./CHANGELOG.md) and keep it limited to changes made after the public source release.
