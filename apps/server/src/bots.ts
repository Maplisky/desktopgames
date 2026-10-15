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
  'trick-judge': 4.6,
  shinobi: 4.2,
  mastermind: 3.6,
  'mirror-monk': 3.2,
  martyr: 2.6,
  'trick-thief': 2.4,
  'trick-spirit-merchant': 2.2,
  'trick-gravedigger': 2.0,
  'trick-troublemaker': 1.8,
  mystic: 1.7,
  spy: 1.6,
  'trick-shapeshifter': 1.4,
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
          // 只能记住自己看到的（定向事件）
          if (!e.audience?.includes(this.seat)) break;
          if (p.self) break;
          if (p.target !== undefined && p.house) {
            this.memory.set(Number(p.target), { house: String(p.house), rank: Number(p.rank ?? 99) });
          }
          break;
        }
        case 'non:peek2': {
          // 易容师视角：事件携带的是交换前双方身份，交换后正好对调
          if (!e.audience?.includes(this.seat)) break;
          const a = Number(p.a);
          const b = Number(p.b);
          this.memory.set(a, { house: String(p.bHouse), rank: Number(p.bRank ?? 99) });
          this.memory.set(b, { house: String(p.aHouse), rank: Number(p.aRank ?? 99) });
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
  const tokenSum = (q: any) => (q.tokens as number[]).reduce((a, b) => a + b, 0);
  const leaderHonor = Math.max(...state.players.map(tokenSum));
  const behind = leaderHonor - tokenSum(me) >= 2;
  // 身份不明（被易容过）时不能信任旧认知 → 不做阵营判断
  const myHouse: string | null = me.identityKnown ? me.identity.house : null;

  /* ---- 轮抽 / 暗选：按卡牌价值 + 局面倾向 ---- */
  if (view.phase === 'draft1' || view.phase === 'draft2' || view.phase === 'commit') {
    let best = choices[0];
    let bestScore = -Infinity;
    for (const c of choices) {
      const id = String(c.action.cardId ?? '').split('#')[0];
      let sc = (CARD_SCORE[id] ?? 1) + Math.random() * 0.8;
      if (behind && (id === 'blind-assassin' || id === 'shinobi' || id === 'trick-judge')) sc += 1.2; // 落后 → 进攻
      if (!behind && (id === 'mastermind' || id === 'mirror-monk' || id === 'martyr')) sc += 1.0; // 领先 → 防守/决胜
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
  const isEnemy = (p: any) => {
    const k = known(p);
    return !!k && k.house !== 'ronin' && (myHouse === null || k.house !== myHouse);
  };
  const enemies = others.filter(isEnemy).sort((a, b) => known(a)!.rank - known(b)!.rank);
  const unknowns = others.filter((p) => !known(p));
  const byTarget = (seatNum: number) => choices.find((c) => Number(c.action.target) === seatNum);
  const byChoice = (ch: string) => choices.find((c) => String(c.action.choice) === ch);
  const randomChoice = () => choices[rand(choices.length)];

  switch (cardId) {
    case 'blind-assassin':
    case 'trick-judge': {
      // 审判官/刺客：已知敌人（排名最优）优先；其次未知；实在不行宁杀浪人也不浪费
      if (enemies.length > 0 && Math.random() < 0.9) return byTarget(enemies[0].seat) ?? randomChoice();
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      const ronin = others.find((p) => known(p)?.house === 'ronin');
      if (ronin) return byTarget(ronin.seat) ?? randomChoice();
      const worst = [...others].sort((a, b) => known(b)!.rank - known(a)!.rank)[0];
      return byTarget(worst.seat) ?? randomChoice();
    }
    case 'shinobi':
    case 'spy':
    case 'mystic': {
      // 窥视优先选未知目标（情报收益）；都认识则看已知敌人
      if (unknowns.length > 0) return byTarget(unknowns[rand(unknowns.length)].seat) ?? randomChoice();
      if (enemies.length > 0) return byTarget(enemies[0].seat) ?? randomChoice();
      return randomChoice();
    }
    case 'trick-troublemaker': {
      // 公开已知敌人最优排名；否则只看未知
      if (enemies.length > 0) return choices.find((c) => Number(c.action.target) === enemies[0].seat && c.action.choice === 'reveal') ?? randomChoice();
      if (unknowns.length > 0) return choices.find((c) => Number(c.action.target) === unknowns[0].seat && c.action.choice === 'peek') ?? randomChoice();
      return randomChoice();
    }
    case 'trick-spirit-merchant': {
      // 落后换代币搏一把；领先看身份攒情报
      return byChoice(behind ? 'swap' : 'house') ?? randomChoice();
    }
    case 'trick-thief': {
      // 候选已按规则过滤（代币更多者），落后必偷
      if (behind) {
        const steal = choices.find((c) => c.action.choice !== 'skip');
        if (steal) return steal;
      }
      return byChoice('skip') ?? randomChoice();
    }
    case 'trick-gravedigger': {
      // 弃牌堆里能立即打出的杀招优先，否则收着或跳过
      const playable = choices.filter((c) => c.action.mode === 'play');
      const killer = playable.find((c) => {
        const id = String(c.action.pick ?? '').split('#')[0];
        return id === 'blind-assassin' || id === 'shinobi' || id === 'trick-judge';
      });
      if (killer) return killer;
      const keeper = choices.find((c) => {
        const id = String(c.action.pick ?? '').split('#')[0];
        return c.action.mode === 'keep' && (id === 'blind-assassin' || id === 'shinobi' || id === 'mastermind');
      });
      if (keeper) return keeper;
      return byChoice('skip') ?? choices.find((c) => c.action.mode === 'skip') ?? randomChoice();
    }
    default:
      return randomChoice();
  }
}
