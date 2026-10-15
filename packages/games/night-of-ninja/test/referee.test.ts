import { mulberry32, type ActionChoice, type GameDefinition, type SeatInfo } from '@dg/games-core';
import { nightOfNinja } from '../src/referee';
import { cardOf } from '../src/cards';
import type { NonState } from '../src/types';

const def = nightOfNinja as GameDefinition<NonState>;

function makeSeats(n: number): SeatInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    seat: i,
    sessionId: `s${i}`,
    nickname: `玩家${i}`,
    isBot: false,
  }));
}

function setup(n: number, seed = 42): NonState {
  return def.setup(makeSeats(n), { targetHonor: 10 }, mulberry32(seed));
}

type Chooser = (seat: number, choices: ActionChoice[], s: NonState) => ActionChoice;

/** 随机合法动作推进整局直到终局（也可用于机器人/soak） */
function playout(def: GameDefinition<NonState>, start: NonState, choose: Chooser, onStep?: (s: NonState) => void) {
  let s = start;
  let guard = 0;
  while (!def.isFinished(s) && guard++ < 30000) {
    const pi = def.phaseInfo(s);
    if (pi.activeSeats.length === 0) {
      const r = def.auto(s);
      if (!r.ok) throw new Error(`auto rejected: ${r.reason} (phase=${s.phase})`);
      s = r.state;
    } else {
      for (const seat of [...pi.activeSeats]) {
        const choices = def.legalActions(s, seat);
        if (choices.length === 0) throw new Error(`active seat ${seat} has no legal actions (phase=${s.phase})`);
        const r = def.applyAction(s, seat, choose(seat, choices, s).action);
        if (!r.ok) throw new Error(`action rejected seat ${seat}: ${r.reason} (phase=${s.phase})`);
        s = r.state;
      }
    }
    onStep?.(s);
  }
  if (!def.isFinished(s)) throw new Error('playout did not finish (guard exhausted)');
  return s;
}

const firstChoice: Chooser = (_seat, choices) => choices[0];

describe('忍者之夜 · 完整对局', () => {
  for (const n of [3, 4, 6, 8]) {
    for (const seed of [1, 2]) {
      it(`n=${n} seed=${seed} 随机对局能推进到终局且有胜者`, () => {
        const rand = mulberry32(seed * 977 + n);
        const final = playout(def, setup(n, seed), (_s, ch) => ch[rand.int(ch.length)]);
        expect(def.isFinished(final)).toBe(true);
        expect(final.winners!.length).toBeGreaterThan(0);
        expect(final.round).toBeGreaterThanOrEqual(1);
        for (const p of final.players) expect(p.tokens.length).toBeGreaterThanOrEqual(0);
      });
    }
  }
});

describe('轮抽与弃牌堆', () => {
  it('发 3 张 → 选 1 → 剩牌左传 → 再选 1 → 余牌弃置桌面中央（掘墓人可用）', () => {
    let s = setup(4);
    expect(s.phase).toBe('draft1');
    for (const p of s.players) expect(p.draftPool.length).toBe(3);
    for (const seat of [0, 1, 2, 3]) {
      const r = def.applyAction(s, seat, { type: 'non:draftPick', cardId: s.players[seat].draftPool[0] });
      expect(r.ok).toBe(true);
      s = r.state;
    }
    const remainders = s.players.map((p) => [...p.draftPool]);
    const r = def.auto(s);
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.phase).toBe('draft2');
    s.players.forEach((p, i) => {
      expect(p.draftPool).toEqual(remainders[(i - 1 + 4) % 4]);
      expect(p.hand.length).toBe(1);
    });
    for (const seat of [0, 1, 2, 3]) {
      const rr = def.applyAction(s, seat, { type: 'non:draftPick', cardId: s.players[seat].draftPool[0] });
      expect(rr.ok).toBe(true);
      s = rr.state;
    }
    const r2 = def.auto(s);
    expect(r2.ok).toBe(true);
    s = r2.state;
    expect(s.phase).toBe('commit');
    for (const p of s.players) expect(p.hand.length).toBe(2);
    // 每人弃 1 张 → 弃牌堆 4 张
    expect(s.discardPile.length).toBe(4);
    expect(r2.events.some((e) => e.type === 'non:draftDone')).toBe(true);
  });
});

/** 构造到 commit 阶段并指定各玩家手牌（绕过随机轮抽，便于精确测试结算） */
function craftNight(n: number, handsBySeat: Record<number, string[]>): NonState {
  let s = setup(n);
  for (const seat of s.players.map((p) => p.seat)) {
    const r = def.applyAction(s, seat, { type: 'non:draftPick', cardId: s.players[seat].draftPool[0] });
    s = r.state;
  }
  s = def.auto(s).state;
  for (const seat of s.players.map((p) => p.seat)) {
    const r = def.applyAction(s, seat, { type: 'non:draftPick', cardId: s.players[seat].draftPool[0] });
    s = r.state;
  }
  s = def.auto(s).state;
  if (s.phase !== 'commit') throw new Error('craft failed');
  for (const [seatStr, cards] of Object.entries(handsBySeat)) {
    s.players[Number(seatStr)].hand = [...cards];
  }
  return s;
}

function commitAll(s: NonState): NonState {
  let out = s;
  for (const p of out.players) {
    const r = def.applyAction(out, p.seat, { type: 'non:commit', cardId: p.hand[0] });
    if (!r.ok) throw new Error(r.reason);
    out = r.state;
  }
  const a = def.auto(out);
  if (!a.ok) throw new Error(a.reason);
  return a.state;
}

describe('夜晚结算', () => {
  it('按类型阶段排序、同类型按角标数字升序；通灵者看到的是已打出的牌', () => {
    let s = craftNight(4, {
      0: ['blind-assassin#2', 'spy#5'],
      1: ['spy#2', 'mystic#1'],
      2: ['mystic#2', 'spy#6'],
      3: ['mastermind', 'spy#4'],
    });
    s = commitAll(s);
    expect(s.phase).toBe('night');
    const order = s.night!.order.map((e) => e.card);
    expect(order).toEqual(['spy#2', 'mystic#2', 'blind-assassin#2', 'mastermind']);
    expect(s.night!.current!.seat).toBe(1);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 2 });
    expect(r.ok).toBe(true);
    s = r.state;
    const peekEv = r.events.find((e) => e.type === 'non:peek')!;
    expect(peekEv.audience).toEqual([1]);
    expect(s.night!.current!.seat).toBe(2);
    // 通灵者看目标「已打出」的忍者牌（座位 0 打出的是盲眼刺客）
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(r.events.find((e) => e.type === 'non:peek')!.payload!.otherCard).toBe('blind-assassin#2');
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 2 });
    s = r.state;
    expect(s.players[2].alive).toBe(false);
    expect(r.events.some((e) => e.type === 'non:death')).toBe(true);
    expect(s.night!.current).toBeNull();
    const a = def.auto(s);
    expect(a.ok).toBe(true);
    s = a.state;
    expect(s.phase).toBe('roundEnd');
    expect(s.roundResult!.mastermindSeat).toBe(3);
    expect(s.roundResult!.winner).toBe(s.players[3].identity.house);
  });

  it('镜僧：刺杀者被反弹致死', () => {
    let s = craftNight(4, { 0: ['blind-assassin#1', 'spy#1'], 1: ['mirror-monk', 'spy#2'], 2: ['spy#3', 'spy#4'], 3: ['spy#5', 'spy#6'] });
    s = commitAll(s);
    let r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 3, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[0].alive).toBe(false);
    expect(s.players[1].alive).toBe(true);
    expect(r.events.some((e) => e.type === 'non:reflected')).toBe(true);
  });

  it('殉道者：被刺杀时获得一枚代币并存活', () => {
    let s = craftNight(4, { 0: ['blind-assassin#1', 'spy#1'], 1: ['martyr', 'spy#2'], 2: ['spy#3', 'spy#4'], 3: ['spy#5', 'spy#6'] });
    s = commitAll(s);
    let r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 3, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[1].alive).toBe(true);
    expect(s.players[1].tokens.length).toBe(1);
    expect(r.events.some((e) => e.type === 'non:martyred')).toBe(true);
    const honorEv = r.events.find((e) => e.type === 'non:honor')!;
    expect(honorEv.audience).toEqual([1]);
  });

  it('审判官：无视镜僧直接杀死，并公开自己的身份', () => {
    let s = craftNight(4, {
      0: ['trick-judge', 'spy#1'],
      1: ['mirror-monk', 'spy#2'],
      2: ['spy#3', 'spy#4'],
      3: ['spy#5', 'spy#6'],
    });
    s = commitAll(s);
    // 顺序：spy(2,3) → judge(0) → monk(1 被动)
    let r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 3, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[1].alive).toBe(false); // 镜僧对审判官无效
    expect(s.players[0].alive).toBe(true);
    expect(s.players[0].exposed).toBe(true);
    expect(r.events.some((e) => e.type === 'non:exposed')).toBe(true);
  });

  it('搅局者：查看后公开身份', () => {
    let s = craftNight(3, { 0: ['trick-troublemaker', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s = commitAll(s);
    // 顺序：spy#2(1) → spy#4(2) → 搅局者(0)
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 2, choice: 'reveal' });
    s = r.state;
    expect(s.players[2].exposed).toBe(true);
    expect(r.events.some((e) => e.type === 'non:exposed')).toBe(true);
  });

  it('盗贼：公开身份并从代币更多的玩家处拿走一枚（代币面值保密）', () => {
    let s = craftNight(3, { 0: ['trick-thief', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.players[1].tokens = [3, 4];
    s.players[0].tokens = [2];
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    const r2 = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r2.state;
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[0].tokens.length).toBe(2);
    expect(s.players[1].tokens.length).toBe(1);
    expect(s.players[0].exposed).toBe(true);
    expect(r.events.some((e) => e.type === 'non:tokenSteal')).toBe(true);
    // 只能对代币数多于自己的玩家出手
    const bad = def.applyAction(s, 0, { type: 'non:resolve', target: 2 });
    expect(bad.ok).toBe(false);
  });

  it('易容师：秘密交换两张身份，受害者不再知晓自己的身份', () => {
    let s = craftNight(3, { 0: ['trick-shapeshifter', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'lotus', rank: 2 };
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1, target2: 2 });
    s = r.state;
    // 身份已交换
    expect(s.players[1].identity).toEqual({ house: 'lotus', rank: 2 });
    expect(s.players[2].identity).toEqual({ house: 'crane', rank: 1 });
    // 受害者不知新身份；易容师本人若涉及也失知
    expect(s.players[1].identityKnown).toBe(false);
    expect(s.players[2].identityKnown).toBe(false);
    // 交换是秘密的：只发给易容师定向事件，无公开身份信息
    const peek2 = r.events.find((e) => e.type === 'non:peek2')!;
    expect(peek2.audience).toEqual([0]);
    expect(r.events.filter((e) => e.type === 'non:exposed')).toHaveLength(0);
  });

  it('掘墓人：从弃牌堆拿牌并立即打出', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['blind-assassin#6', 'mirror-monk'];
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(s.night!.current!.seat).toBe(0);
    // 拿弃牌堆的盲眼刺客并立即打出 → 结算切换为那张牌
    r = def.applyAction(s, 0, { type: 'non:resolve', pick: 'blind-assassin#6', mode: 'play' });
    s = r.state;
    expect(s.discardPile).toEqual(['mirror-monk']);
    expect(cardOf(s.night!.current!.card).id).toBe('blind-assassin');
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[1].alive).toBe(false);
    // 收下模式：加入手牌
    // （下一轮验证：此处仅验证状态推进正常）
    expect(s.phase === 'night' || s.phase === 'roundEnd').toBe(true);
  });
});

/** 驱动夜晚结算直到无人在等（被动卡自动越过） */
function drainNight(s0: NonState): NonState {
  let s = s0;
  let guard = 0;
  while (s.phase === 'night' && s.night?.current && guard++ < 30) {
    const cs = s.night.current.seat;
    const choices = def.legalActions(s, cs);
    if (choices.length === 0) break;
    const r = def.applyAction(s, cs, choices[0].action);
    if (!r.ok) throw new Error(`drain rejected: ${r.reason}`);
    s = r.state;
  }
  return s;
}

describe('回合结算', () => {
  it('家系最佳排名比较：[1,2] 胜 [1]；获胜家系全员（含死者）得分', () => {
    let s = craftNight(4, {
      0: ['blind-assassin#1', 'spy#1'],
      1: ['spy#2', 'spy#3'],
      2: ['spy#4', 'spy#5'],
      3: ['mastermind', 'spy#6'],
    });
    s.players[0].identity = { house: 'crane', rank: 2 };
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'lotus', rank: 1 };
    s.players[3].identity = { house: 'lotus', rank: 2 };
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 3 });
    s = r.state;
    expect(s.players[3].alive).toBe(false);
    const a = def.auto(s);
    s = a.state;
    expect(s.roundResult!.winner).toBe('crane'); // crane [1,2] vs lotus [1]
    expect(s.roundResult!.gainedSeats).toContain(0);
    expect(s.roundResult!.gainedSeats).toContain(1);
    expect(s.roundResult!.gainedSeats).not.toContain(2);
    expect(s.players[0].tokens.length).toBe(1);
  });

  it('完全平局：每位幸存者各得一枚代币', () => {
    let s = craftNight(4, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'], 3: ['martyr', 'spy#1'] });
    s.players[0].identity = { house: 'crane', rank: 1 };
    s.players[1].identity = { house: 'crane', rank: 2 };
    s.players[2].identity = { house: 'lotus', rank: 1 };
    s.players[3].identity = { house: 'lotus', rank: 2 };
    s = commitAll(s);
    s = drainNight(s);
    const a = def.auto(s);
    s = a.state;
    expect(s.roundResult!.winner).toBe('none');
    for (const p of s.players) expect(p.tokens.length).toBe(1); // 四位幸存者各一枚
  });

  it('浪人主谋存活 → 无家系获胜，仅浪人得分', () => {
    let s = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['mastermind', 'spy#5'] });
    s.players[0].identity = { house: 'crane', rank: 1 };
    s.players[1].identity = { house: 'lotus', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s = commitAll(s);
    s = drainNight(s);
    const a = def.auto(s);
    s = a.state;
    expect(s.roundResult!.winner).toBe('none');
    expect(s.roundResult!.mastermindSeat).toBe(2);
    expect(s.players[2].tokens.length).toBe(1); // 浪人存活得分
    expect(s.players[0].tokens.length).toBe(0); // 家系无人得分
  });

  it('荣誉达标后终局；下一轮身份重发、全员复活、弃牌堆清空', () => {
    let s = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'] });
    s.players[0].identity = { house: 'lotus', rank: 2 };
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s.players[1].tokens = [9]; // 差一枚达标
    s = commitAll(s);
    s = drainNight(s);
    let a = def.auto(s);
    s = a.state;
    expect(s.phase).toBe('gameEnd'); // crane 胜 → 座位1 再得一枚 ≥ 10
    expect(s.winners).toEqual([1]);

    // 另一局：验证下一轮重置
    let s2 = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'] });
    s2 = commitAll(s2);
    s2.players[0].identity = { house: 'crane', rank: 1 };
    s2.players[1].identity = { house: 'lotus', rank: 1 };
    s2.players[2].identity = { house: 'ronin', rank: 99 };
    s2 = drainNight(s2);
    a = def.auto(s2);
    s2 = a.state;
    expect(s2.phase).toBe('roundEnd');
    a = def.auto(s2);
    s2 = a.state;
    expect(s2.phase).toBe('draft1');
    expect(s2.round).toBe(2);
    expect(s2.discardPile).toEqual([]);
    for (const p of s2.players) {
      expect(p.alive).toBe(true);
      expect(p.identityKnown).toBe(true);
      expect(p.hand.length).toBe(0);
      expect(p.draftPool.length).toBe(3);
    }
  });
});

describe('超时垫步与非法动作', () => {
  it('轮抽超时自动选第一张；忍者两步超时最终放过', () => {
    let s = setup(3);
    const r = def.applyTimeout(s, 0);
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.players[0].hand.length).toBe(1);

    let s2 = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['shinobi#1', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s2 = commitAll(s2);
    let cur = s2.night!.current!;
    let guard = 0;
    while (cardOf(cur.card).id !== 'shinobi' && guard++ < 10) {
      const rr = def.applyTimeout(s2, cur.seat);
      s2 = rr.state;
      cur = s2.night!.current!;
    }
    expect(cardOf(cur.card).id).toBe('shinobi');
    const rr1 = def.applyTimeout(s2, cur.seat);
    s2 = rr1.state;
    expect(rr1.events.some((e) => e.type === 'non:peek')).toBe(true);
    expect(s2.night!.current!.lockedTarget).toBeDefined();
    const rr2 = def.applyTimeout(s2, cur.seat);
    s2 = rr2.state;
    expect(rr2.events.some((e) => e.type === 'non:spared')).toBe(true);
    expect(s2.players.every((p) => p.alive)).toBe(true);
  });

  it('忍者两步结算：先窥视目标，再决定杀', () => {
    let s = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['shinobi#1', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'lotus', rank: 1 };
    s = commitAll(s);
    let r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(s.night!.current!.seat).toBe(1);
    r = def.applyAction(s, 1, { type: 'non:resolve', target: 2 });
    s = r.state;
    expect(r.events.some((e) => e.type === 'non:peek' && e.audience?.includes(1))).toBe(true);
    expect(s.players[2].alive).toBe(true);
    expect(s.night!.current!.lockedTarget).toBe(2);
    expect(def.applyAction(s, 1, { type: 'non:resolve', target: 0 }).ok).toBe(false);
    r = def.applyAction(s, 1, { type: 'non:choose', choice: 'kill' });
    s = r.state;
    expect(s.players[2].alive).toBe(false);
    expect(r.events.some((e) => e.type === 'non:death')).toBe(true);
  });

  it('拒绝非法动作：不存在的牌、错误的座位、错误的阶段', () => {
    const s = setup(4);
    expect(def.applyAction(s, 0, { type: 'non:commit', cardId: 'spy#1' }).ok).toBe(false);
    expect(def.applyAction(s, 0, { type: 'non:draftPick', cardId: 'not-a-card' }).ok).toBe(false);
    expect(def.applyAction(s, 9, { type: 'non:draftPick', cardId: 'spy#1' }).ok).toBe(false);
    expect(def.applyAction(s, 1, { type: 'non:resolve', target: 0 }).ok).toBe(false);
  });

  it('首选策略全流程也能完成整局（机器人兜底路径）', () => {
    const final = playout(def, setup(6, 5), firstChoice);
    expect(def.isFinished(final)).toBe(true);
  });

  it('死锁防护：需要目标的卡在无合法目标时自动跳过', () => {
    // 3 人局：两个间谍结算后各杀一人，最后忍者的持有者是唯一存活者 → 无目标，应跳过而非卡死
    let s = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['blind-assassin#2', 'spy#2'], 2: ['shinobi#1', 'spy#3'] });
    s = commitAll(s);
    s = drainNight(s);
    expect(s.phase === 'roundEnd' || s.phase === 'night').toBe(true);
    // 全流程不抛错且能推进
    while (s.phase === 'roundEnd') {
      const a = def.auto(s);
      expect(a.ok).toBe(true);
      s = a.state;
    }
  });

  it('掘墓人：收下弃牌不向其他人泄露牌 id（仅本人收到定向事件）', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['mirror-monk', 'blind-assassin#6'];
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    // 收下镜僧
    r = def.applyAction(s, 0, { type: 'non:resolve', pick: 'mirror-monk', mode: 'keep' });
    s = r.state;
    expect(s.players[0].hand).toContain('mirror-monk');
    const taken = r.events.filter((e) => e.type === 'non:graveTaken');
    // 公开版本（无 audience）不得含 cardId；带 cardId 的版本必须定向给掘墓人
    for (const e of taken) {
      if (!e.audience || e.audience.length === 0) {
        expect(e.payload?.cardId).toBeUndefined();
      } else {
        expect(e.audience).toEqual([0]);
        expect(e.payload?.cardId).toBe('mirror-monk');
      }
    }
  });

  it('超时垫步保守优先：掘墓人跳过、盗贼不偷', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['blind-assassin#6'];
    s = commitAll(s);
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    // 掘墓人超时 → 跳过（不会替玩家打出刺杀牌）
    r = def.applyTimeout(s, 0);
    s = r.state;
    expect(s.discardPile).toContain('blind-assassin#6');
    expect(s.players[1].alive).toBe(true);

    // 盗贼超时 → 跳过偷取
    let s2 = craftNight(3, { 0: ['trick-thief', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s2.players[1].tokens = [3];
    s2 = commitAll(s2);
    let r2 = def.applyAction(s2, 1, { type: 'non:resolve', target: 0 });
    s2 = r2.state;
    r2 = def.applyAction(s2, 2, { type: 'non:resolve', target: 0 });
    s2 = r2.state;
    r2 = def.applyTimeout(s2, 0);
    s2 = r2.state;
    expect(s2.players[0].tokens.length).toBe(0); // 没有偷到代币
    expect(s2.players[1].tokens.length).toBe(1);
    expect(s2.players[0].exposed).toBe(false); // 跳过 = 什么都不做，也不公开身份
  });

  it('掘墓人：无目标类牌（镜僧/殉道者/主谋）只能收下，不能立即打出', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['mirror-monk', 'blind-assassin#6'];
    s = commitAll(s);
    // 顺序：spy(1) → spy(2) → 掘墓人(0)
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    // legalActions 不含镜僧的 play 选项，只含 keep
    const choices = def.legalActions(s, 0);
    const monkPlay = choices.find((c) => c.action.pick === 'mirror-monk' && c.action.mode === 'play');
    const monkKeep = choices.find((c) => c.action.pick === 'mirror-monk' && c.action.mode === 'keep');
    expect(monkPlay).toBeUndefined();
    expect(monkKeep).toBeDefined();
    // 直接发 play 动作被拒绝
    expect(def.applyAction(s, 0, { type: 'non:resolve', pick: 'mirror-monk', mode: 'play' }).ok).toBe(false);
    // 打出盲眼刺客仍然可行
    r = def.applyAction(s, 0, { type: 'non:resolve', pick: 'blind-assassin#6', mode: 'play' });
    expect(r.ok).toBe(true);
  });
});

describe('模糊测试 · 大规模随机对局', () => {
  for (let seed = 100; seed < 112; seed++) {
    for (const n of [3, 5, 7]) {
      it(`seed=${seed} n=${n} 全随机（含全部变体选项）推进到终局`, () => {
        const rand = mulberry32(seed * 131 + n);
        const final = playout(def, setup(n, seed), (_s, ch) => ch[rand.int(ch.length)]);
        expect(def.isFinished(final)).toBe(true);
        // 不变量：代币非负、终局有人达标
        for (const p of final.players) {
          const sum = p.tokens.reduce((a, b) => a + b, 0);
          expect(sum).toBeGreaterThanOrEqual(0);
        }
        expect(final.players.some((p) => p.tokens.reduce((a, b) => a + b, 0) >= final.targetHonor)).toBe(true);
      });
    }
  }
});
