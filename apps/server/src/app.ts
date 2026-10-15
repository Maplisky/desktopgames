import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import { Server } from 'socket.io';
import { RoomManager } from './rooms';
import { logger } from './log';

export interface GameServerOptions {
  cors?: boolean;
  passcode?: string | null;
  replayDir?: string | null;
  botDelayMs?: number;
}

export function createGameServer(httpServer: HttpServer, opts: GameServerOptions = {}) {
  const io = new Server(httpServer, {
    cors: opts.cors ? { origin: true } : undefined,
    maxHttpBufferSize: 1e6,
  });
  const manager = new RoomManager(io, opts);
  io.on('connection', (sock) => {
    logger.debug({ id: sock.id }, 'socket connected');
    manager.attach(sock);
  });
  return { io, manager };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** 健康检查 + 前端静态托管（含 SPA 回退），生产单容器部署用 */
export function createHttpHandler(staticDir: string | null) {
  const root = staticDir ? path.resolve(staticDir) : null;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!root || req.method !== 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    let urlPath = decodeURIComponent(url.split('?')[0]);
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const send = (data: Buffer, type: string) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' });
      res.end(data);
    };
    try {
      const data = await readFile(file);
      send(data, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      try {
        const index = await readFile(path.join(root, 'index.html'));
        send(index, MIME['.html']);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    }
  };
}
