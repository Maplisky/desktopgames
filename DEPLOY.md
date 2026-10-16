# 部署指南

一条命令即可在任何有 Docker 的机器上部署（设计目标：单台 Linux VPS）。

## 服务器部署（推荐：Debian 12 / Ubuntu 24.04）

### 1. 准备服务器（一次性）

```bash
# 安装 Docker（官方脚本）
curl -fsSL https://get.docker.com | sh

# 获取代码
git clone <你的仓库地址> desktopgames && cd desktopgames
```

### 2. 配置

```bash
cp .env.example .env
nano .env        # 设置 DG_PASSCODE（入口口令，强烈建议）
```

有域名时（可选）：把域名的 DNS A 记录指向服务器 IP，然后
`nano deploy/Caddyfile.tls` 把 `example.com` 改成你的域名，并在 `.env` 设 `CADDY_MODE=tls`。

### 3. 启动

```bash
docker compose up -d --build
```

完成。浏览器访问 `http://服务器IP`（或你的域名），输入口令即可开局。

### 4. 更新版本

```bash
git pull
docker compose up -d --build
```

### 5. 日常运维

```bash
docker compose logs -f app     # 看日志
docker compose restart app     # 重启
docker compose down            # 停止（数据卷保留）
```

数据（对局回放 JSONL）在 `app-data` 卷中；如需备份：`docker run --rm -v desktopgames_app-data:/data -v $PWD:/bak alpine cp -r /data /bak/`。

## 本机运行（开发/试玩）

```bash
pnpm install
pnpm dev            # 前端 5173 + 服务端 8787，浏览器开 http://localhost:5173
```

或生产模式单进程：`pnpm build && DG_STATIC_DIR=apps/web/dist node apps/server/dist/server.cjs`。

## 部署到免费托管（备选）

不想维护 VPS 的话，也可以用支持 Docker 的免费托管（如 Render / Fly.io / Koyeb）：
新建服务 → 连接 GitHub 仓库 → 选择 Docker 部署即可。注意免费实例会有休眠与流量限制；
`DG_PASSCODE` 在托管平台的环境变量里设置。

## 安全建议

- 务必设置 `DG_PASSCODE`，把访问范围固定在朋友圈；
- 服务器开启防火墙，仅放行 80/443（和 SSH）；
- 服务器重启后 compose 会自动拉起（`restart: unless-stopped`）。
