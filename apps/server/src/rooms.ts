import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server, Socket } from 'socket.io';
import {
  C2S_SCHEMA,
  PROFILE_SCHEMA,
  SOCKET_EVENT,
  type C2S,
  type ChatMsg,
  type GameEvent,
  type RoomStateView,
} from '@dg/protocol';
import { mulberry32 } from '@dg/games-core';
import { GAMES, MAX_ROOM_PLAYERS } from './games';
import { BotBrain, chooseBotAction } from './bots';
import { logger } from './log';

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CHAT_TAIL = 60;
const CHAT_RATE = { max: 4, windowMs: 5000 };
const LOBBY_DISCONNECT_KICK_MS = 120_000;
const ROOM_IDLE_DESTROY_MS = 30 * 60_000;

interface PlayerConn {
  sessionId: string;
  seat: number;
  nickname: string;
  avatar: string;
  ready: boolean;
  isBot: boolean;
  connected: boolean;
  socketIds: Set<string>;
  lastSeq: number;
  chatTimes: number[];
}

interface RoomGame {
  gameId: string;
  state: any; // GameDefinition 泛型状态；registry 已约束
  rev: number;
  seed: number;
  phaseToken: string;
  deadline: number | null;
  autoTimer: NodeJS.Timeout | null;
  replayPath: string | null;
}

export class Room {
  code: string;
  hostSessionId: string;
  players: PlayerConn[] = [];
  chat: ChatMsg[] = [];
  phase: 'lobby' | 'playing' | 'result' = 'lobby';
  game: RoomGame | null = null;
  createdAt = Date.now();
  activityAt = Date.now();
  lastResult: RoomStateView['lastResult'] = null;
  botTimers = new Set<NodeJS.Timeout>();
  /** 机器人头脑（sessionId → 情报与策略） */
  readonly botBrains = new Map<string, BotBrain>();

  constructor(code: string, host: PlayerConn) {
    this.code = code;
    this.hostSessionId = host.sessionId;
    this.players.push(host);
  }

  player(sessionId: string) {
    return this.players.find((p) => p.sessionId === sessionId);
  }

  bySeat(seat: number) {
    return this.players.find((p) => p.seat === seat);
  }

  nextSeat(): number {
    const used = new Set(this.players.map((p) => p.seat));
    let s = 0;
    while (used.has(s)) s++;
    return s;
  }

  host(): PlayerConn | undefined {
    return this.player(this.hostSessionId) ?? this.players.find((p) => p.connected);
  }
}

export interface ManagerOptions {
  passcode?: string | null;
  replayDir?: string | null;
  botDelayMs?: number;
  /** autoAfterMs 缩放（测试用，如 0.05 = 结算演出 6s → 300ms） */
  autoDelayScale?: number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly sessionRoom = new Map<string, string>();
  private readonly io: Server;
  private readonly opts: Required<ManagerOptions>;
  private botCounter = 0;
  private sweep?: NodeJS.Timeout;

  constructor(io: Server, opts: ManagerOptions = {}) {
    this.io = io;
    this.opts = {
      passcode: opts.passcode ?? null,
      replayDir: opts.replayDir ?? null,
      botDelayMs: opts.botDelayMs ?? 900,
      autoDelayScale: opts.autoDelayScale ?? 1,
    };
    this.sweep = setInterval(() => this.tick(), 1000);
  }

  destroy() {
    if (this.sweep) clearInterval(this.sweep);
    for (const room of this.rooms.values()) this.teardownRoom(room);
    this.rooms.clear();
  }

  /* ================ socket 接入 ================ */

  attach(sock: Socket) {
    sock.on(SOCKET_EVENT, (raw: unknown) => {
      const parsed = C2S_SCHEMA.safeParse(raw);
      if (!parsed.success) {
        sock.emit(SOCKET_EVENT, { t: 'error', code: 'bad-message', message: '消息格式错误' });
        return;
      }
      // hello 之前到达的消息先排队（刷新时 joinRoom 可能抢跑），hello 完成后按序重放
      if (parsed.data.t !== 'hello' && !sock.data.sessionId) {
        sock.data.pending = [...((sock.data.pending as unknown[]) ?? []), parsed.data].slice(0, 20);
        return;
      }
      this.handle(sock, parsed.data).catch((e) => {
        logger.error({ err: String(e) }, 'handle failed');
        sock.emit(SOCKET_EVENT, { t: 'error', code: 'internal', message: '服务器内部错误' });
      });
    });
    sock.on('disconnect', () => this.onDisconnect(sock));
  }

  private roomOf(sock: Socket): Room | null {
    const sid = sock.data.sessionId as string | undefined;
    if (!sid) return null;
    const code = this.sessionRoom.get(sid);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  private async handle(sock: Socket, msg: any) {
    switch (msg.t) {
      case 'hello':
        return this.handleHello(sock, msg);
      case 'createRoom':
        return this.handleCreate(sock);
      case 'joinRoom':
        return this.handleJoin(sock, msg.code);
      case 'leaveRoom':
        return this.handleLeave(sock, '主动离开');
      case 'chat':
        return this.handleChat(sock, msg.text, 'chat');
      case 'react':
        return this.handleChat(sock, msg.emoji, 'react');
      case 'setReady':
        return this.handleSetReady(sock, msg.ready);
      case 'addBot':
        return this.handleAddBot(sock);
      case 'kick':
        return this.handleKick(sock, msg.sessionId);
      case 'startGame':
        return this.handleStartGame(sock, msg.gameId);
      case 'playAgain':
        return this.handlePlayAgain(sock);
      case 'gameAction':
        return this.handleGameAction(sock, msg.seq, msg.action);
    }
  }

  /* ================ 会话与重连 ================ */

  private handleHello(sock: Socket, msg: { profile: unknown; sessionToken?: string; passcode?: string }) {
    if (this.opts.passcode && msg.passcode !== this.opts.passcode) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'passcode', message: '需要正确的入口口令' });
      return;
    }
    const profile = PROFILE_SCHEMA.safeParse(msg.profile);
    if (!profile.success) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'bad-profile', message: '昵称或头像不合法' });
      return;
    }
    // 尝试凭 token 恢复会话
    let sessionId = msg.sessionToken;
    let restored = false;
    if (sessionId) {
      const code = this.sessionRoom.get(sessionId);
      const room = code ? this.rooms.get(code) : undefined;
      const player = room?.player(sessionId);
      if (room && player) {
        player.nickname = profile.data.nickname;
        player.avatar = profile.data.avatar;
        player.connected = true;
        player.socketIds.add(sock.id);
        sock.data.sessionId = sessionId;
        sock.join(this.roomKey(room.code));
        sock.emit(SOCKET_EVENT, { t: 'helloAck', sessionToken: sessionId });
        this.sendRoom(room);
        if (room.phase !== 'lobby' && room.game) {
          this.sendGameSync(room, player);
        }
        restored = true;
      }
    }
    if (!restored) {
      sessionId = randomUUID();
      sock.data.sessionId = sessionId;
      sock.data.profile = profile.data;
      sock.emit(SOCKET_EVENT, { t: 'helloAck', sessionToken: sessionId });
    }
    // 重放 hello 之前排队的消息（保持顺序）
    const pending = (sock.data.pending ?? []) as C2S[];
    sock.data.pending = [];
    if (pending.length > 0) {
      void (async () => {
        for (const m of pending) {
          await this.handle(sock, m).catch(() => {});
        }
      })();
    }
  }

  /* ================ 房间生命周期 ================ */

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  private ensurePlayer(sock: Socket): { room: Room; player: PlayerConn } | null {
    const room = this.roomOf(sock);
    if (!room || !sock.data.sessionId) return null;
    const player = room.player(sock.data.sessionId);
    if (!player) return null;
    room.activityAt = Date.now();
    return { room, player };
  }

  private handleCreate(sock: Socket) {
    if (!sock.data.sessionId || !sock.data.profile) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'no-hello', message: '请先发送 hello' });
      return;
    }
    this.autoLeave(sock);
    const player: PlayerConn = {
      sessionId: sock.data.sessionId,
      seat: 0,
      nickname: sock.data.profile.nickname,
      avatar: sock.data.profile.avatar,
      ready: true,
      isBot: false,
      connected: true,
      socketIds: new Set([sock.id]),
      lastSeq: -1,
      chatTimes: [],
    };
    const room = new Room(this.newCode(), player);
    this.rooms.set(room.code, room);
    this.sessionRoom.set(player.sessionId, room.code);
    sock.join(this.roomKey(room.code));
    this.systemChat(room, `${player.nickname} 开了一间新房间`);
    this.sendRoom(room);
    logger.info({ code: room.code }, 'room created');
  }

  private handleJoin(sock: Socket, code: string) {
    if (!sock.data.sessionId || !sock.data.profile) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'no-hello', message: '请先发送 hello' });
      return;
    }
    const room = this.rooms.get(code.toUpperCase());
    if (!room) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'room-not-found', message: '房间不存在' });
      return;
    }
    const existing = room.player(sock.data.sessionId);
    if (existing) {
      existing.socketIds.add(sock.id);
      sock.join(this.roomKey(room.code));
      this.sendRoom(room);
      if (room.phase !== 'lobby' && room.game) this.sendGameSync(room, existing);
      return;
    }
    if (room.phase !== 'lobby') {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'game-running', message: '对局已开始，等待本局结束' });
      return;
    }
    if (room.players.length >= MAX_ROOM_PLAYERS) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'room-full', message: '房间已满' });
      return;
    }
    this.autoLeave(sock);
    const player: PlayerConn = {
      sessionId: sock.data.sessionId,
      seat: room.nextSeat(),
      nickname: sock.data.profile.nickname,
      avatar: sock.data.profile.avatar,
      ready: true,
      isBot: false,
      connected: true,
      socketIds: new Set([sock.id]),
      lastSeq: -1,
      chatTimes: [],
    };
    room.players.push(player);
    room.players.sort((a, b) => a.seat - b.seat);
    this.sessionRoom.set(player.sessionId, room.code);
    sock.join(this.roomKey(room.code));
    this.systemChat(room, `${player.nickname} 加入了房间`);
    this.sendRoom(room);
  }

  private autoLeave(sock: Socket) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    this.removePlayer(ctx.room, ctx.player, '加入了其它房间');
  }

  private handleLeave(sock: Socket, reason: string) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) {
      sock.emit(SOCKET_EVENT, { t: 'left', reason: '不在房间中' });
      return;
    }
    this.removePlayer(ctx.room, ctx.player, reason);
    sock.leave(this.roomKey(ctx.room.code));
    sock.emit(SOCKET_EVENT, { t: 'left', reason });
  }

  private handleKick(sock: Socket, sessionId: string) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    if (ctx.room.hostSessionId !== ctx.player.sessionId) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'not-host', message: '只有房主可以移出玩家' });
      return;
    }
    const target = ctx.room.player(sessionId);
    if (!target || target.sessionId === ctx.player.sessionId) return;
    this.removePlayer(ctx.room, target, '被房主移出');
  }

  private removePlayer(room: Room, player: PlayerConn, reason: string) {
    const gameRunning = room.phase === 'playing';
    room.players = room.players.filter((p) => p.sessionId !== player.sessionId);
    this.sessionRoom.delete(player.sessionId);
    for (const sid of player.socketIds) {
      const s = this.io.sockets.sockets.get(sid);
      s?.leave(this.roomKey(room.code));
      s?.emit(SOCKET_EVENT, { t: 'left', reason });
    }
    room.botBrains.delete(player.sessionId);
    if (!gameRunning) {
      // 等待室阶段直接清理
    } else {
      // 对局中离开：座位保留（视图仍显示），由超时垫步推进；此处不可复活 —— 记为离线
    }
    this.systemChat(room, `${player.nickname} 离开了房间（${reason}）`);
    if (room.players.length === 0) {
      this.teardownRoom(room);
      this.rooms.delete(room.code);
      return;
    }
    if (room.hostSessionId === player.sessionId) {
      const next = room.players.find((p) => p.connected) ?? room.players[0];
      room.hostSessionId = next.sessionId;
      this.systemChat(room, `${next.nickname} 成为新房主`);
    }
    this.sendRoom(room);
  }

  /* ================ 聊天/准备/机器人 ================ */

  private handleChat(sock: Socket, text: string, kind: 'chat' | 'react') {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    const { room, player } = ctx;
    const now = Date.now();
    player.chatTimes = player.chatTimes.filter((t) => now - t < CHAT_RATE.windowMs);
    if (player.chatTimes.length >= CHAT_RATE.max) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'rate-limited', message: '说得太快啦，休息一下' });
      return;
    }
    player.chatTimes.push(now);
    room.chat.push({
      sessionId: player.sessionId,
      nickname: player.nickname,
      avatar: player.avatar,
      text,
      at: now,
      kind,
    });
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - CHAT_TAIL);
    this.sendRoom(room);
  }

  private systemChat(room: Room, text: string) {
    room.chat.push({ sessionId: '', nickname: '系统', avatar: '🏮', text, at: Date.now(), kind: 'system' });
  }

  private handleSetReady(sock: Socket, ready: boolean) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    ctx.player.ready = ready;
    this.sendRoom(ctx.room);
  }

  private handleAddBot(sock: Socket) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.hostSessionId !== player.sessionId) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'not-host', message: '只有房主可以添加机器人' });
      return;
    }
    if (room.phase !== 'lobby') return;
    if (room.players.length >= MAX_ROOM_PLAYERS) return;
    const names = ['玄', '岚', '枫', '铃', '霞', '刃', '影', '月'];
    const bot: PlayerConn = {
      sessionId: `bot-${++this.botCounter}-${randomUUID().slice(0, 8)}`,
      seat: room.nextSeat(),
      nickname: `忍者·${names[this.botCounter % names.length]}`,
      avatar: '🤖',
      ready: true,
      isBot: true,
      connected: true,
      socketIds: new Set(),
      lastSeq: -1,
      chatTimes: [],
    };
    room.players.push(bot);
    room.players.sort((a, b) => a.seat - b.seat);
    this.sessionRoom.set(bot.sessionId, room.code);
    this.systemChat(room, `${bot.nickname} 加入了房间`);
    this.sendRoom(room);
  }

  /* ================ 游戏调度 ================ */

  private handleStartGame(sock: Socket, gameId: string) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase !== 'lobby') return;
    if (room.hostSessionId !== player.sessionId) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'not-host', message: '只有房主可以开始游戏' });
      return;
    }
    const def = GAMES[gameId];
    if (!def) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'no-game', message: '未知游戏' });
      return;
    }
    const n = room.players.length;
    if (n < def.minPlayers || n > def.maxPlayers) {
      sock.emit(SOCKET_EVENT, {
        t: 'error',
        code: 'bad-player-count',
        message: `${def.displayName} 需要 ${def.minPlayers}-${def.maxPlayers} 名玩家（当前 ${n}）`,
      });
      return;
    }
    const seed = randomInt(1, 2 ** 31);
    const seats = room.players.map((p) => ({
      seat: p.seat,
      sessionId: p.sessionId,
      nickname: p.nickname,
      isBot: p.isBot,
    }));
    const state = def.setup(seats, def.defaultOptions, mulberry32(seed));
    room.game = { gameId, state, rev: 1, seed, phaseToken: '', deadline: null, autoTimer: null, replayPath: null };
    room.botBrains.clear();
    for (const s of seats) {
      if (s.isBot) room.botBrains.set(s.sessionId, new BotBrain(s.sessionId, s.seat));
    }
    if (this.opts.replayDir) {
      room.game.replayPath = this.replayPathFor(room);
      mkdir(this.opts.replayDir, { recursive: true }).catch(() => {});
      if (room.game.replayPath) {
        appendFile(
          room.game.replayPath,
          JSON.stringify({ t: 'start', gameId, seed, seats: seats.map((s) => ({ seat: s.seat, nickname: s.nickname })) }) + '\n',
        ).catch(() => {});
      }
    }
    room.phase = 'playing';
    room.lastResult = null;
    this.systemChat(room, `${def.displayName} 开始！`);
    this.broadcastEvents(room, [{ type: 'game:start', payload: { gameId, round: 1 } }]);
    this.sendRoom(room);
    this.pump(room, []);
  }

  private handlePlayAgain(sock: Socket) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase !== 'result') return;
    if (room.hostSessionId !== player.sessionId) return;
    room.phase = 'lobby';
    room.game = null;
    room.lastResult = null;
    room.botBrains.clear();
    for (const p of room.players) p.ready = true;
    this.sendRoom(room);
  }

  private handleGameAction(sock: Socket, seq: number, action: { type: string } & Record<string, unknown>) {
    const ctx = this.ensurePlayer(sock);
    if (!ctx) return;
    const { room, player } = ctx;
    if (room.phase !== 'playing' || !room.game) return;
    if (seq <= player.lastSeq) return; // 幂等：重试的旧动作直接忽略
    player.lastSeq = seq;
    const def = GAMES[room.game.gameId];
    const r = def.applyAction(room.game.state, player.seat, action);
    if (!r.ok) {
      sock.emit(SOCKET_EVENT, { t: 'error', code: 'illegal', message: r.reason });
      return;
    }
    room.game.state = r.state;
    this.pump(room, r.events);
  }

  /** 推进自动阶段 → 广播事件/视图 → 更新时钟 → 安排机器人 */
  private pump(room: Room, initialEvents: GameEvent[]) {
    if (!room.game) return;
    const def = GAMES[room.game.gameId];
    const events = [...initialEvents];
    let guard = 0;
    while (guard++ < 200) {
      if (def.isFinished(room.game.state)) break;
      const pi = def.phaseInfo(room.game.state);
      if (pi.activeSeats.length > 0) break;
      if (pi.autoAfterMs && pi.autoAfterMs > 0) {
        this.scheduleAuto(room, pi.id, pi.autoAfterMs);
        break;
      }
      const r = def.auto(room.game.state);
      if (!r.ok) {
        logger.warn({ code: room.code, reason: r.reason, phase: pi.id }, 'auto rejected');
        break;
      }
      room.game.state = r.state;
      events.push(...r.events);
    }
    if (events.length > 0) this.broadcastEvents(room, events);

    if (def.isFinished(room.game.state)) {
      this.sendAllGameSync(room); // 终局 standings 必须送达，客户端才渲染结算浮层
      this.finishGame(room);
      return;
    }
    const pi = def.phaseInfo(room.game.state);
    // 夜晚按状态子阶段独立计时（窗口/结算/待反应），断线玩家不再卡死整局
    const ng = room.game.state.night;
    const token =
      pi.id === 'night' && ng
        ? `${room.game.state.round}:night:${ng.phaseIdx}:${
            ng.pendingKill
              ? `k${ng.pendingKill.target}`
              : ng.current
                ? `r${ng.current.seat}:${ng.current.card}`
                : `w${ng.window?.phase}`
          }`
        : `${room.game.state.round}:${pi.id}`;
    this.updatePhaseTimer(room, token, pi.timerMs, pi.activeSeats.length > 0);
    this.sendAllGameSync(room);
    this.sendRoom(room); // 顶栏阶段标签/回合数实时更新
    this.scheduleBots(room);
  }

  private updatePhaseTimer(room: Room, token: string, timerMs: number | undefined, hasActive: boolean) {
    const g = room.game!;
    if (g.phaseToken !== token) {
      g.phaseToken = token;
      g.deadline = timerMs && hasActive ? Date.now() + timerMs : null;
    }
  }

  private scheduleAuto(room: Room, phaseId: string, delayMs: number) {
    const g = room.game!;
    const token = `${g.state.round}:${phaseId}`;
    if (g.phaseToken === token && g.autoTimer) return; // 已安排
    if (g.autoTimer) clearTimeout(g.autoTimer);
    g.phaseToken = token;
    g.deadline = null;
    g.autoTimer = setTimeout(() => {
      g.autoTimer = null;
      if (!room.game || room.phase !== 'playing') return;
      const def = GAMES[room.game.gameId];
      const r = def.auto(room.game.state);
      if (!r.ok) return;
      room.game.state = r.state;
      this.pump(room, r.events);
    }, Math.max(50, delayMs * this.opts.autoDelayScale));
  }

  private updateBotKnowledge(room: Room, events: GameEvent[]) {
    if (room.botBrains.size === 0) return;
    for (const brain of room.botBrains.values()) brain.observe(events);
  }

  private scheduleBots(room: Room) {
    if (!room.game || room.phase !== 'playing') return;
    const def = GAMES[room.game.gameId];
    const pi = def.phaseInfo(room.game.state);
    for (const seat of pi.activeSeats) {
      const player = room.bySeat(seat);
      if (!player?.isBot) continue;
      const t = setTimeout(
        () => {
          room.botTimers.delete(t);
          if (!room.game || room.phase !== 'playing') return;
          const cur = def.phaseInfo(room.game.state);
          if (!cur.activeSeats.includes(seat)) return;
          const choices = def.legalActions(room.game.state, seat);
          if (choices.length === 0) return;
          const brain = room.botBrains.get(player.sessionId);
          const pick = brain
            ? chooseBotAction(def, room.game.state, seat, brain, choices)
            : choices[randomInt(choices.length)];
          const r = def.applyAction(room.game.state, seat, pick.action);
          if (!r.ok) return;
          room.game.state = r.state;
          this.pump(room, r.events);
        },
        this.opts.botDelayMs + randomInt(500),
      );
      room.botTimers.add(t);
    }
  }

  private finishGame(room: Room) {
    const def = GAMES[room.game!.gameId];
    const state = room.game!.state;
    const standings = def.clientView(state, room.players[0]?.seat ?? 0) as any;
    room.phase = 'result';
    room.lastResult = (standings?.standings ?? []).map((s: any) => ({
      seat: s.seat,
      nickname: s.nickname,
      detail: `荣誉 ${s.honor}`,
    }));
    if (room.game!.replayPath) {
      appendFile(room.game!.replayPath, JSON.stringify({ t: 'end' }) + '\n').catch(() => {});
    }
    this.sendRoom(room);
    for (const t of room.botTimers) clearTimeout(t);
    room.botTimers.clear();
  }

  /* ================ 下发 ================ */

  private roomKey(code: string) {
    return `room:${code}`;
  }

  private broadcastEvents(room: Room, events: GameEvent[]) {
    const g = room.game!;
    g.rev += 1;
    this.updateBotKnowledge(room, events); // 机器人先从事件流学习，再做决定
    const publicEvents = events.filter((e) => !e.audience || e.audience.length === 0);
    if (publicEvents.length > 0) {
      this.io.to(this.roomKey(room.code)).emit(SOCKET_EVENT, { t: 'gameEvents', rev: g.rev, events: publicEvents });
    }
    const directed = events.filter((e) => e.audience && e.audience.length > 0);
    for (const e of directed) {
      for (const seat of e.audience!) {
        const player = room.bySeat(seat);
        if (!player) continue;
        for (const sid of player.socketIds) {
          this.io.to(sid).emit(SOCKET_EVENT, { t: 'gameEvents', rev: g.rev, events: [e] });
        }
      }
    }
    if (g.replayPath) {
      appendFile(g.replayPath, events.map((e) => JSON.stringify({ t: 'ev', rev: g.rev, ...e })).join('\n') + '\n').catch(
        () => {},
      );
    }
  }

  private sendRoom(room: Room) {
    const view = this.roomView(room);
    this.io.to(this.roomKey(room.code)).emit(SOCKET_EVENT, { t: 'room', room: view });
  }

  private sendAllGameSync(room: Room) {
    if (!room.game || room.phase === 'lobby') return;
    const def = GAMES[room.game.gameId];
    for (const p of room.players) {
      if (p.isBot || p.socketIds.size === 0) continue;
      const view = def.clientView(room.game.state, p.seat);
      for (const sid of p.socketIds) {
        this.io.to(sid).emit(SOCKET_EVENT, { t: 'gameSync', rev: room.game.rev, view, lastSeq: p.lastSeq });
      }
    }
  }

  private sendGameSync(room: Room, player: PlayerConn) {
    if (!room.game || player.isBot) return;
    const def = GAMES[room.game.gameId];
    const view = def.clientView(room.game.state, player.seat);
    for (const sid of player.socketIds) {
      this.io.to(sid).emit(SOCKET_EVENT, { t: 'gameSync', rev: room.game.rev, view, lastSeq: player.lastSeq });
    }
  }

  roomView(room: Room): RoomStateView {
    let phaseLabel = '';
    let round = 0;
    let displayName = '';
    if (room.game && room.phase !== 'lobby') {
      const def = GAMES[room.game.gameId];
      const pi = def.phaseInfo(room.game.state);
      phaseLabel = pi.label;
      round = room.game.state.round ?? 0;
      displayName = def.displayName;
    }
    return {
      code: room.code,
      hostSessionId: room.hostSessionId,
      phase: room.phase,
      players: room.players.map((p) => ({
        sessionId: p.sessionId,
        seat: p.seat,
        nickname: p.nickname,
        avatar: p.avatar,
        connected: p.connected,
        ready: p.ready,
        isBot: p.isBot,
      })),
      chat: room.chat.slice(-30),
      game: room.phase === 'lobby' ? null : { id: room.game!.gameId, displayName, phaseLabel, round },
      lastResult: room.lastResult,
    };
  }

  /* ================ 断线/清扫 ================ */

  private onDisconnect(sock: Socket) {
    const sid = sock.data.sessionId as string | undefined;
    if (!sid) return;
    const code = this.sessionRoom.get(sid);
    const room = code ? this.rooms.get(code) : undefined;
    const player = room?.player(sid);
    if (!room || !player) return;
    player.socketIds.delete(sock.id);
    if (player.socketIds.size === 0) {
      player.connected = false;
      this.systemChat(room, `${player.nickname} 掉线了`);
      this.sendRoom(room);
    }
  }

  private tick() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      // 对局内超时垫步
      if (room.phase === 'playing' && room.game && room.game.deadline && now > room.game.deadline) {
        room.game.deadline = null;
        const def = GAMES[room.game.gameId];
        const pi = def.phaseInfo(room.game.state);
        const events: GameEvent[] = [];
        let changed = false;
        for (const seat of pi.activeSeats) {
          const r = def.applyTimeout(room.game.state, seat);
          if (r.ok) {
            room.game.state = r.state;
            events.push(...r.events);
            changed = true;
          }
        }
        if (changed) this.pump(room, events);
        continue;
      }
      // 等待室：掉线玩家超时移除
      if (room.phase === 'lobby') {
        for (const p of [...room.players]) {
          if (!p.connected && !p.isBot && p.socketIds.size === 0 && now - room.activityAt > LOBBY_DISCONNECT_KICK_MS) {
            this.removePlayer(room, p, '长时间掉线');
          }
        }
      }
      // 空房/长期无活动销毁
      const noHumans = room.players.every((p) => p.isBot || (!p.connected && p.socketIds.size === 0));
      if (
        room.players.length === 0 ||
        (noHumans && now - room.activityAt > ROOM_IDLE_DESTROY_MS) ||
        now - room.activityAt > ROOM_IDLE_DESTROY_MS * 2
      ) {
        this.teardownRoom(room);
        this.rooms.delete(room.code);
      }
    }
  }

  private teardownRoom(room: Room) {
    if (room.game?.autoTimer) clearTimeout(room.game.autoTimer);
    for (const t of room.botTimers) clearTimeout(t);
    room.botTimers.clear();
    for (const p of room.players) this.sessionRoom.delete(p.sessionId);
  }

  /** 测试/运维用：初始化回放目录 */
  async initReplays(dir: string) {
    this.opts.replayDir = dir;
    await mkdir(dir, { recursive: true });
  }

  replayPathFor(room: Room): string | null {
    if (!this.opts.replayDir) return null;
    return path.join(this.opts.replayDir, `${room.code}-${Date.now()}.jsonl`);
  }
}
