import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as clientIo, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGameServer } from '../src/app';
import type { RoomManager } from '../src/rooms';
import { SOCKET_EVENT, type S2C } from '@dg/protocol';

let httpServer: http.Server;
let manager: RoomManager;
let port: number;
const clients: Socket[] = [];

beforeEach(async () => {
  httpServer = http.createServer();
  const gs = createGameServer(httpServer, { botDelayMs: 40, autoDelayScale: 0.05 });
  manager = gs.manager;
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  clients.length = 0;
  manager.destroy();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

function connect() {
  const sock = clientIo(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  clients.push(sock);
  return sock;
}

function send(sock: Socket, msg: unknown) {
  sock.emit(SOCKET_EVENT, msg);
}

function waitUntil(sock: Socket, pred: (m: S2C) => boolean, timeout = 8000): Promise<S2C> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`waitUntil timeout (${timeout}ms)`)), timeout);
    const on = (raw: unknown) => {
      if (pred(raw as S2C)) {
        clearTimeout(timer);
        sock.off(SOCKET_EVENT, on);
        resolve(raw as S2C);
      }
    };
    sock.on(SOCKET_EVENT, on);
  });
}

async function hello(sock: Socket, nickname: string, token?: string): Promise<string> {
  const p = waitUntil(sock, (m) => m.t === 'helloAck');
  send(sock, { t: 'hello', profile: { nickname, avatar: '🐱' }, sessionToken: token });
  const ack = (await p) as Extract<S2C, { t: 'helloAck' }>;
  return ack.sessionToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('房间与聊天', () => {
  it('创建房间 → 好友加入 → 聊天互见', async () => {
    const c1 = connect();
    await hello(c1, '阿一');
    const roomP = waitUntil(c1, (m) => m.t === 'room');
    send(c1, { t: 'createRoom' });
    const room1 = ((await roomP) as Extract<S2C, { t: 'room' }>).room;
    expect(room1.code).toHaveLength(5);
    expect(room1.players).toHaveLength(1);
    expect(room1.phase).toBe('lobby');

    const c2 = connect();
    await hello(c2, '阿二');
    const joined = waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 2);
    send(c2, { t: 'joinRoom', code: room1.code });
    const rj = (await joined) as Extract<S2C, { t: 'room' }>;
    expect(rj.room.players.map((p) => p.nickname)).toEqual(['阿一', '阿二']);

    const chatSeen = waitUntil(c2, (m) => m.t === 'room' && m.room.chat.some((c) => c.text === '晚上好'));
    send(c1, { t: 'chat', text: '晚上好' });
    const rc = (await chatSeen) as Extract<S2C, { t: 'room' }>;
    expect(rc.room.chat.some((c) => c.text === '晚上好' && c.nickname === '阿一')).toBe(true);
  });

  it('断线重连：凭 sessionToken 回到原座位', async () => {
    const c1 = connect();
    await hello(c1, '房主');
    const roomP = waitUntil(c1, (m) => m.t === 'room');
    send(c1, { t: 'createRoom' });
    const code = ((await roomP) as Extract<S2C, { t: 'room' }>).room.code;

    const c2 = connect();
    const t2 = await hello(c2, '浪客');
    const joined = waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 2);
    send(c2, { t: 'joinRoom', code });
    const before = (await joined) as Extract<S2C, { t: 'room' }>;
    const seatBefore = before.room.players.find((p) => p.nickname === '浪客')!.seat;

    c2.disconnect();
    await sleep(200);

    const c3 = connect();
    const back = waitUntil(c1, (m) => m.t === 'room' && !!m.room.players.find((p) => p.nickname === '浪客')?.connected);
    const afterP = waitUntil(c3, (m) => m.t === 'room');
    await hello(c3, '浪客', t2);
    await back;
    const after = ((await afterP) as Extract<S2C, { t: 'room' }>).room;
    expect(after.players.find((p) => p.nickname === '浪客')!.seat).toBe(seatBefore);
    expect(after.players.find((p) => p.nickname === '浪客')!.connected).toBe(true);
  });

  it('非房主不能开始游戏；人数不足给出提示', async () => {
    const c1 = connect();
    await hello(c1, '房主');
    const roomP = waitUntil(c1, (m) => m.t === 'room');
    send(c1, { t: 'createRoom' });
    const code = ((await roomP) as Extract<S2C, { t: 'room' }>).room.code;

    const c2 = connect();
    await hello(c2, '路人');
    send(c2, { t: 'joinRoom', code });
    await sleep(150);

    const errP = waitUntil(c2, (m) => m.t === 'error' && m.code === 'not-host');
    send(c2, { t: 'startGame', gameId: 'night-of-ninja' });
    await errP;

    const err2P = waitUntil(c1, (m) => m.t === 'error' && m.code === 'bad-player-count');
    send(c1, { t: 'startGame', gameId: 'night-of-ninja' });
    await err2P;
  });
});

describe('对局（人类 + 机器人）', () => {
  /** 简单驱动器：让 c1 跟上回合节奏 */
  function installDriver(c1: Socket) {
    let seq = 0;
    return (view: any) => {
      if (view.phase === 'draft1' || view.phase === 'draft2') {
        if (!view.you.picked && view.you.draftPool.length > 0) {
          send(c1, { t: 'gameAction', seq: ++seq, action: { type: 'non:draftPick', cardId: view.you.draftPool[0] } });
        }
      } else if (view.phase === 'commit' && !view.you.committed) {
        send(c1, { t: 'gameAction', seq: ++seq, action: { type: 'non:commit', cardId: view.you.hand[0] } });
      } else if (view.phase === 'night' && view.nightInfo?.currentSeat === view.you.seat) {
        // 忍者已锁定目标 → 抉择；否则按卡型选目标/选项
        if (view.nightInfo.lockedTarget !== null && view.nightInfo.lockedTarget !== undefined) {
          send(c1, { t: 'gameAction', seq: ++seq, action: { type: 'non:choose', choice: 'spare' } });
          return;
        }
        const others = view.players.filter((p: any) => p.alive && p.seat !== view.you.seat).map((p: any) => p.seat);
        if (others.length === 0) return;
        const cardId = String(view.nightInfo.currentCardId ?? '');
        const action: any = { type: 'non:resolve' };
        if (cardId === 'trick-shapeshifter') {
          if (others.length < 2) return; // 双目标不足，交给超时垫步
          action.target = others[0];
          action.target2 = others[1];
        } else if (cardId === 'trick-troublemaker') {
          action.target = others[0];
          action.choice = 'peek';
        } else if (cardId === 'trick-spirit-merchant') {
          action.target = others[0];
          action.choice = 'house';
        } else if (cardId === 'trick-thief') {
          action.choice = 'skip';
        } else if (cardId === 'trick-gravedigger') {
          action.mode = 'skip';
        } else {
          action.target = others[0];
        }
        send(c1, { t: 'gameAction', seq: ++seq, action });
      }
    };
  }

  it('完整对局推进到 result，事件流完整，视图不泄露隐藏信息，可再来一局', async () => {
    const c1 = connect();
    await hello(c1, '玩家甲');
    const roomP = waitUntil(c1, (m) => m.t === 'room');
    send(c1, { t: 'createRoom' });
    await roomP;
    send(c1, { t: 'addBot' });
    await waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 2);
    send(c1, { t: 'addBot' });
    await waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 3);

    const events: any[] = [];
    const views: any[] = [];
    const driver = installDriver(c1); // seq 计数器必须跨消息复用，否则会被服务端幂等去重丢弃
    c1.on(SOCKET_EVENT, (raw: any) => {
      if (raw.t === 'gameEvents') events.push(...raw.events);
      if (raw.t === 'gameSync') {
        views.push(raw.view);
        driver(raw.view);
      }
    });

    send(c1, { t: 'startGame', gameId: 'night-of-ninja' });
    const done = (await waitUntil(c1, (m) => m.t === 'room' && m.room.phase === 'result', 30000)) as Extract<
      S2C,
      { t: 'room' }
    >;
    expect(done.room.lastResult).toHaveLength(3);
    expect(events.some((e) => e.type === 'non:roundEnd')).toBe(true);
    expect(events.some((e) => e.type === 'non:gameEnd')).toBe(true);
    expect(events.some((e) => e.type === 'game:start')).toBe(true);
    // 视图泄露：他人条目不含 identity/hand 等隐藏键
    expect(views.length).toBeGreaterThan(5);
    for (const v of views) {
      expect(v.you.identity).toBeTruthy();
      for (const p of v.players) {
        expect(Object.keys(p)).not.toContain('identity');
        expect(Object.keys(p)).not.toContain('hand');
      }
    }
    // 定向事件（窥视/身份变化）只发给本人
    const peeks = events.filter((e) => e.type === 'non:peek');
    for (const p of peeks)
      expect(p.payload?.target !== undefined || p.payload?.self === true).toBe(true);

    send(c1, { t: 'playAgain' });
    const lobby = await waitUntil(c1, (m) => m.t === 'room' && m.room.phase === 'lobby');
    expect(lobby).toBeTruthy();
  }, 45000);

  it('非法动作被拒绝并收到 illegal 错误', async () => {
    const c1 = connect();
    await hello(c1, '独狼');
    send(c1, { t: 'createRoom' });
    send(c1, { t: 'addBot' });
    send(c1, { t: 'addBot' });
    await waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 3);
    send(c1, { t: 'startGame', gameId: 'night-of-ninja' });
    await waitUntil(c1, (m) => m.t === 'gameSync');
    const errP = waitUntil(c1, (m) => m.t === 'error' && m.code === 'illegal');
    send(c1, { t: 'gameAction', seq: 1, action: { type: 'non:resolve', target: 1 } });
    await errP;
  });

  it('seq 幂等：同一动作重发只生效一次', async () => {
    const c1 = connect();
    await hello(c1, '重发侠');
    send(c1, { t: 'createRoom' });
    send(c1, { t: 'addBot' });
    send(c1, { t: 'addBot' });
    await waitUntil(c1, (m) => m.t === 'room' && m.room.players.length === 3);
    const syncs: any[] = [];
    c1.on(SOCKET_EVENT, (raw: any) => {
      if (raw.t === 'gameSync') syncs.push(raw.view);
    });
    send(c1, { t: 'startGame', gameId: 'night-of-ninja' });
    const first = (await waitUntil(c1, (m) => m.t === 'gameSync')) as Extract<S2C, { t: 'gameSync' }>;
    const view = first.view as any;
    expect(view.phase).toBe('draft1');
    // 同一 seq 发两次相同的选牌：第二次必须被静默忽略（手牌只加一张）
    const cardId = view.you.draftPool[0];
    send(c1, { t: 'gameAction', seq: 7, action: { type: 'non:draftPick', cardId } });
    await waitUntil(c1, (m) => m.t === 'gameSync' && (m.view as any).you.picked);
    send(c1, { t: 'gameAction', seq: 7, action: { type: 'non:draftPick', cardId } });
    await sleep(1200); // 等机器人推进，期间收集所有 sync
    // 选牌生效之后的每个视图里，我的手牌中该牌始终只有一张（重发未产生第二张）
    const from = syncs.findIndex((s) => s.you.picked);
    expect(from).toBeGreaterThanOrEqual(0);
    for (const s of syncs.slice(from)) {
      expect(s.you.hand.filter((c: string) => c === cardId).length).toBe(1);
    }
    expect(syncs.length).toBeGreaterThan(1);
  }, 20000);
});

describe('站点口令', () => {
  it('未带/错口令被拒，正确口令放行', async () => {
    const srv = http.createServer();
    const gs = createGameServer(srv, { passcode: 'pw123' });
    await new Promise<void>((r) => srv.listen(0, () => r()));
    const p2 = (srv.address() as AddressInfo).port;
    const c = clientIo(`http://127.0.0.1:${p2}`, { transports: ['websocket'] });
    clients.push(c);
    await new Promise<void>((r) => setTimeout(r, 100));

    const errP = waitUntil(c, (m) => m.t === 'error' && m.code === 'passcode');
    c.emit(SOCKET_EVENT, { t: 'hello', profile: { nickname: 'x', avatar: '🐱' } });
    await errP;

    const okP = waitUntil(c, (m) => m.t === 'helloAck');
    c.emit(SOCKET_EVENT, { t: 'hello', profile: { nickname: 'x', avatar: '🐱' }, passcode: 'pw123' });
    await okP;

    c.disconnect();
    gs.manager.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  });
});
