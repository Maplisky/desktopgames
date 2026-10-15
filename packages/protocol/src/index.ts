import { z } from 'zod';

/** 玩家档案（MVP 无账号，客户端本地保存） */
export const PROFILE_SCHEMA = z.object({
  nickname: z.string().trim().min(1).max(16),
  avatar: z.string().trim().min(1).max(8),
});
export type Profile = z.infer<typeof PROFILE_SCHEMA>;

/** 游戏动作：由具体游戏插件定义语义，协议层只保证是带 type 的 JSON */
export const GAME_ACTION_SCHEMA = z.object({ type: z.string().min(1) }).passthrough();
export type GameAction = z.infer<typeof GAME_ACTION_SCHEMA>;

/** 游戏事件：裁判产出，用于客户端动画/音效；audience 为空表示广播全体 */
export interface GameEvent {
  type: string;
  payload?: Record<string, unknown>;
  /** 目标座位号；缺省 = 全员可见 */
  audience?: number[];
}

export const CHAT_MSG_SCHEMA = z.object({
  sessionId: z.string(),
  nickname: z.string(),
  avatar: z.string(),
  text: z.string(),
  at: z.number(),
  kind: z.enum(['chat', 'react', 'system']).default('chat'),
});
export type ChatMsg = z.infer<typeof CHAT_MSG_SCHEMA>;

export const ROOM_PLAYER_SCHEMA = z.object({
  sessionId: z.string(),
  seat: z.number().int().nonnegative(),
  nickname: z.string(),
  avatar: z.string(),
  connected: z.boolean(),
  ready: z.boolean(),
  isBot: z.boolean(),
});
export type RoomPlayerView = z.infer<typeof ROOM_PLAYER_SCHEMA>;

export const ROOM_STATE_SCHEMA = z.object({
  code: z.string(),
  hostSessionId: z.string(),
  phase: z.enum(['lobby', 'playing', 'result']),
  players: z.array(ROOM_PLAYER_SCHEMA),
  chat: z.array(CHAT_MSG_SCHEMA),
  game: z
    .object({ id: z.string(), displayName: z.string(), phaseLabel: z.string(), round: z.number().int() })
    .nullable(),
  lastResult: z.array(z.object({ seat: z.number().int(), nickname: z.string(), detail: z.string() })).nullable(),
});
export type RoomStateView = z.infer<typeof ROOM_STATE_SCHEMA>;

/* ---------------- Client → Server ---------------- */
export const C2S_SCHEMA = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    profile: PROFILE_SCHEMA,
    sessionToken: z.string().optional(),
    passcode: z.string().optional(),
  }),
  z.object({ t: z.literal('createRoom') }),
  z.object({ t: z.literal('joinRoom'), code: z.string().trim().min(4).max(5) }),
  z.object({ t: z.literal('leaveRoom') }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(200) }),
  z.object({ t: z.literal('react'), emoji: z.string().min(1).max(4) }),
  z.object({ t: z.literal('setReady'), ready: z.boolean() }),
  z.object({ t: z.literal('startGame'), gameId: z.string() }),
  z.object({ t: z.literal('addBot') }),
  z.object({ t: z.literal('kick'), sessionId: z.string() }),
  z.object({ t: z.literal('playAgain') }),
  z.object({
    t: z.literal('gameAction'),
    seq: z.number().int().nonnegative(),
    action: GAME_ACTION_SCHEMA,
  }),
]);
export type C2S = z.infer<typeof C2S_SCHEMA>;

/* ---------------- Server → Client ---------------- */
export const S2C_SCHEMA = z.discriminatedUnion('t', [
  z.object({ t: z.literal('helloAck'), sessionToken: z.string() }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ t: z.literal('room'), room: ROOM_STATE_SCHEMA }),
  z.object({ t: z.literal('left'), reason: z.string() }),
  z.object({ t: z.literal('gameEvents'), rev: z.number().int(), events: z.array(z.custom<GameEvent>()) }),
  z.object({ t: z.literal('gameSync'), rev: z.number().int(), view: z.unknown() }),
]);
export type S2C = z.infer<typeof S2C_SCHEMA>;

/** 单一 socket 事件名，消息体为上述判别联合 */
export const SOCKET_EVENT = 'dg';
