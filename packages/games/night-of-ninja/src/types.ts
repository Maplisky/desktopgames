export type NonPhase = 'draft1' | 'draft2' | 'night' | 'roundEnd' | 'gameEnd';
export type House = 'crane' | 'lotus' | 'ronin';

export interface Identity {
  house: House;
  /** 1 最优；浪人无排名（99） */
  rank: number;
}

export interface NonPlayer {
  seat: number;
  sessionId: string;
  nickname: string;
  isBot: boolean;
  /* ---- 服务端私有（绝不出现在他人视图） ---- */
  identity: Identity;
  /** 是否知晓自己的身份（被易容师秘密交换后为 false） */
  identityKnown: boolean;
  draftPool: string[];
  hand: string[];
  /** 荣誉代币（面值仅本人视角可见） */
  tokens: number[];
  /* ---- 公开进度 ---- */
  /** 本夜已亮出的牌（打出即公开，按打出顺序） */
  played: string[];
  alive: boolean;
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

/**
 * 夜晚状态机（还原实体规则：逐阶段叫名，从手牌决定是否亮牌）：
 * - window：某类型阶段开放中，持有者各自选择打出（立即公开）或保留；
 * - queue/window 关闭后按角标数字升序排列的结算队列；
 * - current：正在结算的牌（等待目标选择/杀放抉择）；
 *   gravedigger 结算时预抽取的至多两张弃牌（graveLook，官方：只看两张）；
 * - pendingKill：刺杀已宣告，等待目标从手牌打出反应牌（镜僧/殉道者）或承受。
 */
export interface NightState {
  /** 0..4 → 间谍/通灵/诡术/盲眼刺客/忍者 */
  phaseIdx: number;
  window: { phase: number; holders: number[]; played: Array<{ seat: number; card: string }>; passed: number[] } | null;
  queue: Array<{ seat: number; card: string }>;
  qIdx: number;
  current: { seat: number; card: string; lockedTarget?: number; graveLook?: string[] } | null;
  pendingKill: { attacker: number; target: number } | null;
}

export interface NonState {
  gameId: 'night-of-ninja';
  phase: NonPhase;
  round: number;
  targetHonor: number;
  players: NonPlayer[];
  /** 当前轮抽阶段已选完的座位 */
  picked: number[];
  /** 本回合轮抽弃置的忍者牌（桌面中央，掘墓人可用） */
  discardPile: string[];
  night: NightState | null;
  roundResult: RoundResult | null;
  winners: number[] | null;
  /** 代币抽取袋（面值 2/3/4 混洗） */
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
  /** 本夜已亮出的牌（公开） */
  played: string[];
  handCount: number;
  /** 公开的荣誉代币枚数（面值保密） */
  tokenCount: number;
  /** 被公开/回合结束揭示的身份 */
  exposedIdentity: Identity | null;
  revealedIdentity: Identity | null;
}

export interface NonView {
  phase: NonPhase;
  round: number;
  targetHonor: number;
  you: {
    seat: number;
    /** 自己的身份；被易容师换过后为 null（身份不明） */
    identity: Identity | null;
    identityKnown: boolean;
    honor: number;
    /** 自己各代币的面值 */
    tokens: number[];
    alive: boolean;
    hand: string[];
    played: string[];
    draftPool: string[];
    picked: boolean;
  };
  players: NonViewPlayer[];
  draft: { pickNumber: 1 | 2; doneCount: number; total: number } | null;
  nightInfo: {
    phaseId: number;
    phaseLabel: string;
    /** 我持有本阶段牌且尚未决定（打出/保留） */
    myWindowPending: boolean;
    holdersTotal: number;
    chosenCount: number;
    /** 本阶段已亮出的牌 */
    windowPlayed: Array<{ seat: number; cardId: string }>;
    currentSeat: number | null;
    currentCardId: string | null;
    lockedTarget: number | null;
    /** 刺杀待反应（target 需要决定是否打出镜僧/殉道者） */
    killPending: { target: number; attacker: number } | null;
    resolvedCount: number;
    total: number;
  } | null;
  /** 本回合弃置的忍者牌（掘墓人视角下非空） */
  discardPile: string[];
  discardVisible: boolean;
  roundResult: RoundResult | null;
  winners: number[] | null;
  /** gameEnd 时公开全部荣誉 */
  standings: Array<{ seat: number; nickname: string; honor: number; identity: Identity }> | null;
}
