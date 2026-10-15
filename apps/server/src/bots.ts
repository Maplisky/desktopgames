import type { ActionChoice, GameDefinition } from '@dg/games-core';
import type { GameEvent } from '@dg/protocol';

/**
 * 机器人头脑：从对局事件流中积累身份情报（只记自己看得到的 + 公开信息），
 * 并按局面（荣誉落后程度）决定选牌与目标策略。
 */

export interface BotMemory {
  house: string;
  rank: number;
}

/** 轮抽/暗选阶段的卡牌基础价值 */
const CARD_SCORE: Record<string, number> = {
  'blind-assassin': 5.0,
  shinobi: 4.2,
  mastermind: 3.6,
  'mirror-monk': 3.2,
  'shadow-guard': 2.8,
  'trick-silence': 2.2,
  'trick-expose': 2.0,
  mystic: 1.8,
  'trick-peek': 1.7,
  spy: 1.6,
  'trick-swap': 1.3,
  'trick-disguise': 1.1,
  'trick-exchange': 0.9,
};

export class BotBrain {
  readonly sessionId: string;
  readonly seat: number;
  /** 座位 → 已知身份 */
  memory = new Map<number, BotMemory>();

  constructor(sessionId: string, seat: number) {
    this.sessionId = sessionId;
    this.seat = seat;
  }

  resetRound() {
    this.memory.clear(); // 每轮身份重发，情报清零
  }

  observe(events: GameEvent[]) {
    for (const e of events) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      switch (e.type) {
        case 'non:peek': {
          // 只能记住自己看到的（定向事件）或自己换到的身份
          if (!e.audience?.includes(this.seat)) break;
          if (p.self) break; // 自己的身份自己本来就知道
          if (p.target !== undefined) {
            this.memory.set(Number(p.target), { house: String(p.house), rank: Number(p.rank) });
          }
          break;
        }
        case 'non:exposed':
        case 'non:reveal': {
          // 公开信息
          if (p.seat !== undefined && p.house) {
            this.memory.set(Number(p.seat), { house: String(p.house), rank: Number(p.rank ?? 99) });
          }
          break;
        }
        case 'non:identitySwap': {
          const a = Number(p.a);
          const b = Number(p.b);
          const ma = this.memory.get(a);
          const mb = this.memory.get(b);
          if (ma && mb) {
            this.memory.set(a, mb);
            this.memory.set(b, ma);
          } else {
            // 只知道换了，不知道换成什么 → 情报作废
            this.memory.delete(a);
            this.memory.delete(b);
          }
          break;
        }
        case 'non:disguise':
          this.memory.delete(Number(p.seat));
          break;
        case 'non:roundStart':
          this.resetRound();
          break;
      }
    }
  }
}

const rand = (n: number) => Math.floor(Math.random() * n);

/**
 * 机器人行动选择。信息来源 = 自己视角的视图 + 事件流积累的情报（不偷看服务器状态）。
 */
export function chooseBotAction(
  def: GameDefinition<any>,
  state: any,
  seat: number,
  brain: BotBrain,
  choices: ActionChoice[],
): ActionChoice {
  if (choices.length === 0) throw new Error('no choices');
  const view = def.clientView(state, seat) as Record<string, any>;
  const me = state.players[seat];
  const leaderHonor = Math.max(...(state.players as any[]).map((p) => p.honor));
  const behind = leaderHonor - me.honor >= 2;
  const myHouse = me.identity.house;

  /* ---- 轮抽 / 暗选：按卡牌价值 + 局面倾向 ---- */
  if (view.phase === 'draft1' || view.phase === 'draft2' || view.phase === 'commit') {
    let best = choices[0];
    let bestScore = -Infinity;
    for (const c of choices) {
      const id = String(c.action.cardId ?? '');
      let sc = (CARD_SCORE[id] ?? 1) + Math.random() * 0.8;
      if (behind && (id === 'blind-assassin' || id === 'shinobi')) sc += 1.2; // 落后 → 进攻
      if (!behind && (id === 'mastermind' || id === 'mirror-monk' || id === 'shadow-guard')) sc += 1.0; // 领先 → 防守/决胜
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    return best;
  }

  /* ---- 忍者杀/放（已窥视，情报刚入脑） ---- */
  if (choices[0]?.action.type === 'non:choose') {
    const t = brain.memory.get(Number(view.nightInfo?.lockedTarget));
    const kill = choices.find((c) => c.action.choice === 'kill') ?? choices[0];
    const spare = choices.find((c) => c.action.choice === 'spare') ?? choices[0];
    if (t) {
      if (t.house === myHouse || t.house === 'ronin') return spare; // 队友/浪人不杀
      return kill; // 已知敌人 → 杀
    }
    return Math.random() < (behind ? 0.6 : 0.35) ? kill : spare; // 未知 → 看局面赌
  }

  /* ---- 目标选择 ---- */
  const cardId = String(view.nightInfo?.currentCardId ?? '');
  const others = (state.players as any[]).filter((p) => p.alive && p.seat !== seat);
  const known = (p: any) => brain.memory.get(p.seat);
  const enemies = others
    .filter((p) => {
      const k = known(p);
      return k && k.house !== myHouse && k.house !== 'ronin';
    })
    .sort((a, b) => known(a)!.rank - known(b)!.rank); // 排名越靠前越是好目标
  const unknowns = others.filter((p) => !known(p));
  const byTarget = (seatNum: number) => choices.find((c) => Number(c.action.target) === seatNum);
  const randomChoice = () => choices[rand(choices.length)];

  switch (cardId) {
    case 'blind-assassin': {
      // 已知敌人（排名最优）优先；其次未知目标；实在不行宁杀浪人/队友也不浪费
      if (enemies.length > 0 && Math.random() < 0.9) return byTarget(enemies[0].seat) ?? randomChoice();
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      const ronin = others.find((p) => known(p)?.house === 'ronin');
      if (ronin) return byTarget(ronin.seat) ?? randomChoice();
      const worst = [...others].sort((a, b) => known(b)!.rank - known(a)!.rank)[0];
      return byTarget(worst.seat) ?? randomChoice();
    }
    case 'shinobi': {
      // 窥视优先选未知目标（情报收益）；都认识则看已知敌人
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      if (enemies.length > 0) return byTarget(enemies[0].seat) ?? randomChoice();
      return randomChoice();
    }
    case 'spy':
    case 'mystic':
    case 'trick-peek': {
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      return randomChoice();
    }
    case 'trick-expose': {
      if (enemies.length > 0) return byTarget(enemies[0].seat) ?? randomChoice(); // 公开敌方最优排名
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      return randomChoice();
    }
    case 'trick-silence': {
      if (enemies.length > 0) return byTarget(enemies[0].seat) ?? randomChoice();
      return randomChoice();
    }
    default:
      return randomChoice();
  }
}
