import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createGameServer, createHttpHandler } from './app';
import { logger } from './log';

const PORT = Number(process.env.DG_PORT ?? process.env.PORT ?? 8787);

function findStaticDir(): string | null {
  if (process.env.DG_STATIC_DIR) return process.env.DG_STATIC_DIR;
  const candidates = [
    path.resolve(process.cwd(), '../web/dist'), // 从 apps/server 启动
    path.resolve(process.cwd(), 'apps/web/dist'), // 从仓库根启动
    path.resolve(process.cwd(), 'web/dist'), // 容器内 /app
  ];
  return candidates.find((p) => existsSync(path.join(p, 'index.html'))) ?? null;
}
const staticDir = findStaticDir();

const httpServer = http.createServer(createHttpHandler(staticDir));
const { io, manager } = createGameServer(httpServer, {
  cors: process.env.DG_CORS === '1' || process.env.NODE_ENV !== 'production',
  passcode: process.env.DG_PASSCODE ?? null,
  replayDir: process.env.DG_REPLAY_DIR ?? null,
  botDelayMs: Number(process.env.DG_BOT_DELAY ?? 900),
});

httpServer.listen(PORT, () => {
  logger.info({ port: PORT, static: staticDir, passcode: !!process.env.DG_PASSCODE }, '桌游馆服务端已启动');
});

// 进程级守卫：任何未捕获异常/拒绝都必须留下痕迹（曾出现进程静默死亡且无日志）
process.on('uncaughtException', (err) => {
  logger.error({ err: String(err?.stack ?? err) }, 'uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ err: String(reason) }, 'unhandledRejection');
});
const heartbeat = setInterval(() => {
  logger.debug({ rooms: io?.of('/').adapter?.rooms?.size ?? 0 }, 'heartbeat');
}, 60_000);
heartbeat.unref();

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutting down');
  manager.destroy();
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
