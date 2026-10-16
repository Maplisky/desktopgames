# DesktopGames 桌游馆

面向朋友局的线上桌游平台：一人开房、发链接即玩，重美术动画与氛围音乐，无语音通话（游戏内文字聊天 + 表情）。

**当前状态**：MVP 可玩 —— 忍者之夜（Night of the Ninja）3–11 人完整实现（裁判/房间/重连/机器人/动画/音频）。

- 设计文档：[docs/DESIGN.md](docs/DESIGN.md)
- 开发计划：[docs/ROADMAP.md](docs/ROADMAP.md)
- 忍者之夜规则核对：[docs/rules-night-of-ninja.md](docs/rules-night-of-ninja.md)

## 技术栈

React 18 + Vite + TS + Framer Motion ｜ Node + Socket.IO（服务端权威，隐藏信息按座位过滤）｜ 纯逻辑游戏插件（可单测/可回放，种子随机）｜ pnpm monorepo

```
apps/web                    前端（大厅/房间/对局桌面/帮助/设置）
apps/server                 服务端（房间/会话/聊天/超时/机器人/回放日志/静态托管）
packages/protocol           zod 通信协议（前后端共享）
packages/games/core         游戏插件框架接口
packages/games/night-of-ninja  忍者之夜裁判（纯逻辑 + 22 项单测）
```

## 快速开始

```bash
corepack enable pnpm && corepack prepare pnpm@10 --activate   # 首次
pnpm install

pnpm dev        # 同时起前端(5173, 热更)和服务端(8787)
# 或分开：pnpm dev:web / pnpm dev:server
```

打开 http://localhost:5173 ，起个昵称 → 创建房间 → 加机器人 → 开始。

## 生产部署（单进程：API + 静态托管）

```bash
pnpm build
DG_STATIC_DIR=apps/web/dist node apps/server/dist/server.cjs   # 默认 8787
```

服务器一键部署（Docker Compose + Caddy 自动 HTTPS）：见 [DEPLOY.md](DEPLOY.md)。

环境变量：`DG_PORT`（端口）、`DG_PASSCODE`（站点入口口令）、`DG_REPLAY_DIR`（对局回放 JSONL 目录）、`DG_BOT_DELAY`（机器人思考毫秒）、`DG_CORS=1`（开发跨域）。

## 测试

```bash
pnpm test        # 裁判 22 项 + 服务端集成 6 项（含隐藏信息泄露扫描）
pnpm typecheck
pnpm lint
```

## 已知事项

- 卡牌效果表按公开资料重建，数值待对照实体规则书核对（见 docs/rules-night-of-ninja.md 清单）。
- 音频为 WebAudio 合成的氛围垫乐与音效（零素材可用）；接入真实 BGM/SFX 时替换 `apps/web/src/audio.ts` 的 scene/sfx 实现即可。
- 服务器重启会丢失进行中的房间（内存态，设计如此）；浏览器刷新凭 sessionToken 自动回到原座位。
