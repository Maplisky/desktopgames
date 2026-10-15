export type NonPhase = 'draft1' | 'draft2' | 'commit' | 'night' | 'roundEnd' | 'gameEnd';
export type House = 'crane' | 'lotus' | 'ronin';

export interface Identity {
  house: House;
  /** 1 最优；浪人无排名（用 99 表示） */
  rank: number;
}

export interface NonPlayer {
  seat: number;
  sessionId: string;
  nickname: string;
  isBot: boolean;
  /* ---- 服务端私有（绝不出现在他人视图） ---- */
  identity: Identity;
  draftPool: string[];
  hand: string[];
  committed: string | null;
  honor: number;
  monkUsed: boolean;
  /* ---- 公开进度 ---- */
  alive: boolean;
  resolvedCard: string | null;
  killedBy: number | null;
  exposed: boolean;
}

export interface RoundResult {
  winner: 'crane' | 'lotus' | 'none';
  mastermindSeat: number | null;
  survivors: Array<{ seat: number; house: 'crane' | 'lotus'; rank: number }>;
  /** 本回合获得代币的座位（面值保密） */
  gainedSeats: number[];
}

export interface NightState {
  order: Array<{ seat: number; card: string }>;
  idx: number;
  negated: number[];
  /** 正在结算的牌；忍者的 lockedTarget = 已窥视并锁定的目标（等待杀/放抉择） */
  current: { seat: number; card: string; lockedTarget?: number } | null;
}

export interface NonState {
  gameId: 'night-of-ninja';
  phase: NonPhase;
  round: number;
  targetHonor: number;
  players: NonPlayer[];
  /** 当前轮抽阶段已选完的座位 */
  picked: number[];
  night: NightState | null;
  roundResult: RoundResult | null;
  winners: number[] | null;
  tokenPool: number[];
  tokenIdx: number;
  /** 可复现随机状态（mulberry32 内部字） */
  rngS: number;
}

/* ---------- 客户端视图类型（clientView 的返回形状，前端直接使用） ---------- */

export interface NonViewPlayer {
  seat: number;
  nickname: string;
  isBot: boolean;
  alive: boolean;
  hasCommitted: boolean;
  resolvedCard: string | null;
  negated: boolean;
  handCount: number;
  /** 被诡术师公开 / 回合结束揭示的身份 */
  exposedIdentity: Identity | null;
  revealedIdentity: Identity | null;
}

export interface NonView {
  phase: NonPhase;
  round: number;
  targetHonor: number;
  you: {
    seat: number;
    identity: Identity;
    honor: number;
    alive: boolean;
    hand: string[];
    committed: string | null;
    draftPool: string[];
    picked: boolean;
  };
  players: NonViewPlayer[];
  draft: { pickNumber: 1 | 2; doneCount: number; total: number } | null;
  nightInfo: {
    currentSeat: number | null;
    currentCardId: string | null;
    /** 忍者已锁定的窥视目标（等待杀/放） */
    lockedTarget: number | null;
    resolvedCount: number;
    total: number;
  } | null;
  roundResult: RoundResult | null;
  winners: number[] | null;
  /** gameEnd 时公开全部荣誉 */
  standings: Array<{ seat: number; nickname: string; honor: number; identity: Identity }> | null;
}
