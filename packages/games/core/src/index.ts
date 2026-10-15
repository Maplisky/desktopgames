/**
 * 游戏插件框架核心：所有游戏以纯逻辑 reducer 实现，服务端负责调度与分发。
 * 见 docs/DESIGN.md §6。
 */

/* ---------- 可复现随机数（对局可回放） ---------- */
export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  shuffle<T>(arr: T[]): T[];
}

/** mulberry32：小、快、可由单一 32 位种子重建 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    shuffle: <T,>(arr: T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/* ---------- 事件 ---------- */
export interface GameEvent {
  type: string;
  payload?: Record<string, unknown>;
  /** 目标座位；缺省 = 广播全体 */
  audience?: number[];
}

/* ---------- 阶段元信息 ---------- */
export interface PhaseInfo {
  id: string;
  label: string;
  /** 当前可行动的座位（空 = 无人在等，服务端可 auto 推进） */
  activeSeats: number[];
  /** 建议时限（毫秒）；超时由服务端调用 applyTimeout */
  timerMs?: number;
  /** activeSeats 为空时，延迟多少毫秒再调用 auto（默认 0 立即；用于结算演出） */
  autoAfterMs?: number;
}

/* ---------- 合法动作描述（驱动客户端 UI） ---------- */
export interface ActionChoice {
  action: { type: string } & Record<string, unknown>;
  ui: {
    kind: 'card' | 'button';
    /** kind=card 时：卡牌 id（客户端据此渲染卡面） */
    cardId?: string;
    label?: string;
    /** 可选目标座位（单选） */
    targetSeats?: number[];
    /** 双目标（如交换两张身份牌） */
    secondTargetSeats?: number[];
    /** 目标提示文案 */
    prompt?: string;
  };
}

export interface SeatInfo {
  seat: number;
  sessionId: string;
  nickname: string;
  isBot: boolean;
}

export interface ApplyResult<S> {
  ok: true;
  state: S;
  events: GameEvent[];
}

export interface Reject {
  ok: false;
  reason: string;
}

/**
 * 游戏定义。实现方保证：
 * 1. applyAction/applyTimeout/auto 为纯函数（不触碰网络/时间/随机源以外的全局状态）；
 * 2. clientView 之外的任何隐藏字段不会出现在事件 payload 中（除非 audience 定向）；
 * 3. 所有随机性经由 state 携带的种子推导，保证同种子同演化（可回放）。
 */
export interface GameDefinition<S> {
  id: string;
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  /** 房主可调选项的默认值 */
  defaultOptions: Record<string, unknown>;

  setup(seats: SeatInfo[], options: Record<string, unknown>, rng: Rng): S;

  phaseInfo(state: S): PhaseInfo;
  /** 玩家主动动作（服务端已做 seq 幂等去重） */
  applyAction(state: S, seat: number, action: { type: string } & Record<string, unknown>): ApplyResult<S> | Reject;
  /** 超时垫步（为当前唯一/每个 active 座位） */
  applyTimeout(state: S, seat: number): ApplyResult<S> | Reject;
  /** 无人在等时的服务端自动推进（阶段切换/结算/下一轮） */
  auto(state: S): ApplyResult<S> | Reject;
  /** 以某座位视角序列化状态（隐藏信息在此过滤） */
  clientView(state: S, seat: number): unknown;
  /** 某座位当前可执行动作（驱动 UI 与机器人） */
  legalActions(state: S, seat: number): ActionChoice[];

  /** 对局是否已终局（auto 推进到头） */
  isFinished(state: S): boolean;
}
