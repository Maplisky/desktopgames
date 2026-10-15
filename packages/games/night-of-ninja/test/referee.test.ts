import { mulberry32, type ActionChoice, type GameDefinition, type SeatInfo } from '@dg/games-core';
import { nightOfNinja } from '../src/referee';
import { CARDS } from '../src/cards';
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
        for (const p of final.players) expect(p.honor).toBeGreaterThanOrEqual(0);
      });
    }
  }
});

describe('轮抽', () => {
  it('发 3 张 → 选 1 → 剩牌左传 → 再选 1 → 保留 2 张', () => {
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
    // 左传：座位 i 收到右家 (i-1) 的余牌
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
    const seat = Number(seatStr);
    s.players[seat].hand = [...cards];
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
  it('按阶段 1→6 顺序结算，选择类卡暂停等待目标', () => {
    let s = craftNight(4, {
      0: ['blind-assassin', 'spy'],
      1: ['spy', 'mystic'],
      2: ['mystic', 'spy'],
      3: ['mastermind', 'spy'],
    });
    s = commitAll(s);
    expect(s.phase).toBe('night');
    const order = s.night!.order.map((e) => e.card);
    expect(order).toEqual(['spy', 'mystic', 'blind-assassin', 'mastermind']);
    expect(s.night!.current!.seat).toBe(1);
    // 间谍 1 → 看座位 2（事件只发给自己）
    let r = def.applyAction(s, 1, { type: 'non:resolve', target: 2 });
    expect(r.ok).toBe(true);
    s = r.state;
    const peekEv = r.events.find((e) => e.type === 'non:peek')!;
    expect(peekEv.audience).toEqual([1]);
    expect(s.night!.current!.seat).toBe(2);
    // 通灵 2 → 看座位 0（含未打出牌）
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    expect(r.events.find((e) => e.type === 'non:peek')!.payload!.otherCard).toBe('spy');
    // 盲眼刺客 4 → 杀座位 2
    expect(s.night!.current!.seat).toBe(0);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 2 });
    s = r.state;
    expect(s.players[2].alive).toBe(false);
    expect(r.events.some((e) => e.type === 'non:death')).toBe(true);
    // 主谋 6（被动）→ 夜晚结束进入结算
    expect(s.night!.current).toBeNull();
    const a = def.auto(s);
    expect(a.ok).toBe(true);
    s = a.state;
    expect(s.phase).toBe('roundEnd');
    expect(s.roundResult!.mastermindSeat).toBe(3);
    expect(s.roundResult!.winner).toBe(s.players[3].identity.house);
  });

  it('镜僧：刺杀者被反弹致死', () => {
    let s = craftNight(4, { 0: ['blind-assassin', 'spy'], 1: ['mirror-monk', 'spy'], 2: ['spy', 'spy'], 3: ['spy', 'spy'] });
    s = commitAll(s);
    // 先结算两张间谍（阶段 1，座位 2、3）
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

  it('影卫：本回合免死', () => {
    let s = craftNight(4, { 0: ['blind-assassin', 'spy'], 1: ['shadow-guard', 'spy'], 2: ['spy', 'spy'], 3: ['spy', 'spy'] });
    s = commitAll(s);
    let r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 3, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[1].alive).toBe(true);
    expect(s.players[0].alive).toBe(true);
    expect(r.events.some((e) => e.type === 'non:blocked')).toBe(true);
  });

  it('封印之印使镜僧失效，刺杀成功', () => {
    // 座位 2 持封印(阶段3)先于盲眼刺客(4)结算，封印座位 1 的镜僧
    let s = craftNight(4, {
      0: ['blind-assassin', 'spy'],
      1: ['mirror-monk', 'spy'],
      2: ['trick-silence', 'spy'],
      3: ['spy', 'spy'],
    });
    s = commitAll(s);
    // 顺序：spy(3) → silence(2) → assassin(0) → monk(1)
    expect(s.night!.order.map((e) => e.card)).toEqual(['spy', 'trick-silence', 'blind-assassin', 'mirror-monk']);
    let r = def.applyAction(s, 3, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(r.events.some((e) => e.type === 'non:silenced')).toBe(true);
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.players[1].alive).toBe(false);
    expect(s.players[0].alive).toBe(true);
  });
});

describe('回合结算', () => {
  it('家系最佳排名比较：[1,2] 胜 [1]', () => {
    let s = craftNight(4, {
      0: ['blind-assassin', 'spy'],
      1: ['spy', 'spy'],
      2: ['spy', 'spy'],
      3: ['mastermind', 'spy'],
    });
    s.players[0].identity = { house: 'crane', rank: 2 };
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'lotus', rank: 1 };
    s.players[3].identity = { house: 'lotus', rank: 2 };
    s = commitAll(s);
    // 顺序：spy(1),spy(2) → assassin(3) 杀 4 → mastermind(4) 已死无效
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
    // crane 全员（含活的和死的）得分
    expect(s.roundResult!.gainedSeats).toContain(0);
    expect(s.roundResult!.gainedSeats).toContain(1);
    expect(s.roundResult!.gainedSeats).not.toContain(2);
    expect(s.players[0].honor).toBeGreaterThanOrEqual(1);
  });

  it('浪人存活即得分，即使无人获胜', () => {
    let s = craftNight(3, { 0: ['spy', 'spy'], 1: ['spy', 'spy'], 2: ['spy', 'spy'] });
    s.players[0].identity = { house: 'crane', rank: 1 };
    s.players[1].identity = { house: 'lotus', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s = commitAll(s);
    let r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    r = def.applyAction(s, 1, { type: 'non:resolve', target: 0 });
    s = r.state;
    r = def.applyAction(s, 2, { type: 'non:resolve', target: 0 });
    s = r.state;
    const a = def.auto(s);
    s = a.state;
    expect(s.roundResult!.winner).toBe('none');
    expect(s.players[2].honor).toBeGreaterThanOrEqual(1);
    expect(s.players[0].honor).toBe(0);
  });

  it('荣誉达到目标值后终局，进入下一轮则身份重发、全员复活', () => {
    let s = craftNight(3, { 0: ['spy', 'spy'], 1: ['spy', 'spy'], 2: ['spy', 'spy'] });
    s.players[0].identity = { house: 'lotus', rank: 2 };
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s.players[1].honor = 9;
    s = commitAll(s);
    for (const seat of [0, 1, 2]) {
      const r = def.applyAction(s, seat, { type: 'non:resolve', target: (seat + 1) % 3 });
      s = r.state;
    }
    let a = def.auto(s);
    s = a.state;
    expect(s.phase).toBe('gameEnd'); // crane 胜 → 座位1 荣誉 +token ≥ 10
    expect(s.winners).toEqual([1]);

    // 另一局：验证下一轮重置
    let s2 = craftNight(3, { 0: ['spy', 'spy'], 1: ['spy', 'spy'], 2: ['spy', 'spy'] });
    s2 = commitAll(s2);
    s2.players[0].identity = { house: 'crane', rank: 1 };
    s2.players[1].identity = { house: 'lotus', rank: 1 };
    s2.players[2].identity = { house: 'ronin', rank: 99 };
    for (const seat of [0, 1, 2]) {
      const r = def.applyAction(s2, seat, { type: 'non:resolve', target: (seat + 1) % 3 });
      s2 = r.state;
    }
    a = def.auto(s2);
    s2 = a.state; // roundEnd
    expect(s2.phase).toBe('roundEnd');
    a = def.auto(s2);
    s2 = a.state; // 下一轮
    expect(s2.phase).toBe('draft1');
    expect(s2.round).toBe(2);
    for (const p of s2.players) {
      expect(p.alive).toBe(true);
      expect(p.hand.length).toBe(0);
      expect(p.draftPool.length).toBe(3);
    }
    const houses = s2.players.map((p) => p.identity.house);
    expect(houses.filter((h) => h === 'crane').length).toBe(1);
    expect(houses.filter((h) => h === 'lotus').length).toBe(1);
    expect(houses.filter((h) => h === 'ronin').length).toBe(1);
  });
});

describe('超时垫步与非法动作', () => {
  it('轮抽超时自动选第一张；忍者超时选择放过', () => {
    let s = setup(3);
    const r = def.applyTimeout(s, 0);
    expect(r.ok).toBe(true);
    s = r.state;
    expect(s.players[0].hand.length).toBe(1);

    let s2 = craftNight(3, { 0: ['spy', 'spy'], 1: ['shinobi', 'spy'], 2: ['spy', 'spy'] });
    s2 = commitAll(s2);
    let cur = s2.night!.current!;
    let guard = 0;
    while (CARDS[cur.card].id !== 'shinobi' && guard++ < 10) {
      const rr = def.applyTimeout(s2, cur.seat);
      s2 = rr.state;
      cur = s2.night!.current!;
    }
    expect(cur.card).toBe('shinobi');
    const rr = def.applyTimeout(s2, cur.seat);
    s2 = rr.state;
    expect(rr.events.some((e) => e.type === 'non:spared' || e.type === 'non:peek')).toBe(true);
    expect(s2.players.every((p) => p.alive)).toBe(true);
  });

  it('拒绝非法动作：不存在的牌、错误的座位、错误的阶段', () => {
    const s = setup(4);
    expect(def.applyAction(s, 0, { type: 'non:commit', cardId: 'spy' }).ok).toBe(false);
    expect(def.applyAction(s, 0, { type: 'non:draftPick', cardId: 'not-a-card' }).ok).toBe(false);
    expect(def.applyAction(s, 9, { type: 'non:draftPick', cardId: 'spy' }).ok).toBe(false);
    expect(def.applyAction(s, 1, { type: 'non:resolve', target: 0 }).ok).toBe(false);
  });

  it('首选策略全流程也能完成整局（机器人兜底路径）', () => {
    const final = playout(def, setup(6, 5), firstChoice);
    expect(def.isFinished(final)).toBe(true);
  });
});
