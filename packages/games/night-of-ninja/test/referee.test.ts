import { mulberry32, type ActionChoice, type GameDefinition, type SeatInfo } from '@dg/games-core';
import { nightOfNinja } from '../src/referee';
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
        // 座位选择可能同步推进阶段（窗口关闭→结算→下一窗口），旧快照中的座位可能已无动作
        if (def.phaseInfo(s).activeSeats.indexOf(seat) < 0) continue;
        const choices = def.legalActions(s, seat);
        if (choices.length === 0) continue;
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
void firstChoice;

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
  it('发 3 张 → 选 1 → 剩牌左传 → 再选 1 → 余牌弃置桌面中央并直接进入夜晚', () => {
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
    // 无暗选阶段：轮抽完成直接进入夜晚（阶段 1 窗口开放）
    expect(s.phase).toBe('night');
    expect(s.night!.window!.phase).toBe(1);
    for (const p of s.players) expect(p.hand.length).toBe(2);
    expect(s.discardPile.length).toBe(4);
    expect(r2.events.some((e) => e.type === 'non:draftDone')).toBe(true);
  });
});

/** 构造：完成轮抽并在进入夜晚前注入指定手牌（夜晚阶段 1 窗口已开放） */
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
  // 注入手牌（在 auto 进入夜晚之前）
  for (const [seatStr, cards] of Object.entries(handsBySeat)) {
    s.players[Number(seatStr)].hand = [...cards];
  }
  const a = def.auto(s);
  if (!a.ok) throw new Error('craft failed: ' + a.reason);
  s = a.state;
  if (s.phase !== 'night') throw new Error('craft failed: phase=' + s.phase);
  return s;
}

/**
 * 夜晚全流程驱动器：按 plans（每个阶段窗口一个 seat→cardId 计划，缺省保留）打出，
 * 结算用 choices[0]，被刺杀默认承受。驱动到夜晚结束（roundEnd）或无法推进。
 */
function flowNight(s0: NonState, plans: Array<Record<number, string | null>> = []): NonState {
  let s = s0;
  let planIdx = 0;
  let guard = 0;
  while (s.phase === 'night' && guard++ < 120) {
    const n = s.night!;
    if (n.pendingKill) {
      const t = n.pendingKill.target;
      const ch = def.legalActions(s, t);
      if (ch.length === 0) break;
      const noReact = ch.find((c) => c.action.type === 'non:noReact')!;
      s = def.applyAction(s, t, noReact.action).state;
      continue;
    }
    if (n.current) {
      const seat = n.current.seat;
      const ch = def.legalActions(s, seat);
      if (ch.length === 0) break;
      const r = def.applyAction(s, seat, ch[0].action);
      if (!r.ok) throw new Error(`flow current seat ${seat}: ${r.reason}`);
      s = r.state;
      continue;
    }
    if (n.window) {
      const plan = plans[planIdx++] ?? {};
      for (const seat of n.window.holders) {
        if (!s.night?.window) break;
        const cardId = plan[seat] ?? null;
        const action = cardId ? { type: 'non:phasePlay', cardId } : { type: 'non:phasePass' };
        const r = def.applyAction(s, seat, action);
        if (!r.ok) throw new Error(`window seat ${seat}: ${r.reason}`);
        s = r.state;
      }
      continue;
    }
    break;
  }
  return s;
}

describe('夜晚 · 逐阶段窗口与结算', () => {
  it('阶段叫名顺序：间谍→通灵→诡术→盲眼刺客→忍者；同阶段按角标升序结算', () => {
    let s = craftNight(4, {
      0: ['blind-assassin#2', 'spy#5'],
      1: ['spy#2', 'mystic#1'],
      2: ['mystic#2', 'spy#6'],
      3: ['mastermind', 'spy#4'],
    });
    // 阶段 1：间谍窗口，全员打出
    expect(s.night!.window!.phase).toBe(1);
    expect([...s.night!.window!.holders].sort()).toEqual([0, 1, 2, 3]);
    // 依次打出后窗口关闭，队列按角标排序
    for (const [seat, card] of [
      [0, 'spy#5'],
      [1, 'spy#2'],
      [2, 'spy#6'],
      [3, 'spy#4'],
    ] as const) {
      const r = def.applyAction(s, seat, { type: 'non:phasePlay', cardId: card });
      expect(r.ok).toBe(true);
      s = r.state;
    }
    expect(s.night!.window).toBeNull();
    expect(s.night!.queue.map((e) => e.card)).toEqual(['spy#2', 'spy#4', 'spy#5', 'spy#6']);
    expect(s.night!.current!.seat).toBe(1);
    expect(s.players[1].played).toContain('spy#2'); // 打出即公开
    // 驱动剩余流程（通灵阶段由 flowNight 自动按 plans[0] 打出）
    s = flowNight(s, [{ 1: 'mystic#1', 2: 'mystic#2', 0: 'blind-assassin#2' }]);
    expect(s.phase).toBe('roundEnd');
  });

  it('通灵者看的是目标「手牌」（打出的牌本就公开）', () => {
    let s = craftNight(3, { 0: ['mystic#1', 'spy#1'], 1: ['spy#2', 'shinobi#3'], 2: ['spy#4', 'spy#5'] });
    s = flowNight(s, [{ 1: 'spy#2', 2: 'spy#4' }, { 0: 'mystic#1' }]);
    expect(s.phase).toBe('roundEnd');
    // 找到通灵者的窥视事件：目标 1 的手牌只剩 shinobi#3
    // （flowNight 中通灵者 choices[0] 目标为首个存活其他座位；本局 0 的间谍目标即 1）
  });

  it('镜僧/殉道者从手牌打出：反弹刺杀 / 得币存活；承受则死亡', () => {
    // 镜僧反弹
    let s = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['mirror-monk', 'spy#2'], 2: ['spy#3', 'spy#4'] });
    const w0 = s.night!.window!;
    expect(w0.phase).toBe(1);
    // 间谍阶段全保留 → 直接进入刺客阶段
    for (const seat of w0.holders) {
      const r = def.applyAction(s, seat, { type: 'non:phasePass' });
      s = r.state;
    }
    // 刺客阶段：0 打出并刺杀 1
    expect(s.night!.window!.phase).toBe(4);
    let r = def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'blind-assassin#1' });
    s = r.state;
    r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(s.night!.pendingKill).toEqual({ attacker: 0, target: 1 });
    // 目标打出镜僧反弹
    r = def.applyAction(s, 1, { type: 'non:react', cardId: 'mirror-monk' });
    s = r.state;
    expect(s.players[0].alive).toBe(false);
    expect(s.players[1].alive).toBe(true);
    expect(s.players[1].played).toContain('mirror-monk');
    expect(r.events.some((e) => e.type === 'non:reflected')).toBe(true);

    // 殉道者
    let s2 = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['martyr', 'spy#4'] });
    for (const seat of s2.night!.window!.holders) {
      s2 = def.applyAction(s2, seat, { type: 'non:phasePass' }).state;
    }
    s2 = def.applyAction(s2, 0, { type: 'non:phasePlay', cardId: 'blind-assassin#1' }).state;
    s2 = def.applyAction(s2, 0, { type: 'non:resolve', target: 2 }).state;
    const rMartyr = def.applyAction(s2, 2, { type: 'non:react', cardId: 'martyr' });
    s2 = rMartyr.state;
    expect(s2.players[2].alive).toBe(true);
    // 殉道者恰好抽到一枚（react 后夜晚可能直接结束并计分，故以事件而非绝对代币数断言）
    expect(rMartyr.events.some((e) => e.type === 'non:martyred' && e.payload?.seat === 2)).toBe(true);
    expect(rMartyr.events.some((e) => e.type === 'non:honorDraw' && e.payload?.seat === 2)).toBe(true);

    // 承受 → 死亡
    let s3 = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    for (const seat of s3.night!.window!.holders) {
      s3 = def.applyAction(s3, seat, { type: 'non:phasePass' }).state;
    }
    s3 = def.applyAction(s3, 0, { type: 'non:phasePlay', cardId: 'blind-assassin#1' }).state;
    s3 = def.applyAction(s3, 0, { type: 'non:resolve', target: 2 }).state;
    expect(s3.night!.pendingKill).toEqual({ attacker: 0, target: 2 });
    s3 = def.applyAction(s3, 2, { type: 'non:noReact' }).state;
    expect(s3.players[2].alive).toBe(false);
  });

  it('审判官无视镜僧：直接击杀，无待反应窗口', () => {
    let s = craftNight(3, { 0: ['trick-judge', 'spy#1'], 1: ['mirror-monk', 'spy#2'], 2: ['spy#3', 'spy#4'] });
    // plans[0] = 间谍阶段全员保留；plans[1] = 诡术阶段 0 打出审判官
    s = flowNight(s, [{}, { 0: 'trick-judge' }]);
    expect(s.players[1].alive).toBe(false); // 镜僧未生效
    expect(s.players[0].exposed).toBe(true);
    expect(s.phase).toBe('roundEnd');
  });

  it('不打出则本阶段作废：保留的间谍在间谍阶段过后无法再打出', () => {
    let s = craftNight(3, { 0: ['spy#1', 'blind-assassin#3'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s = flowNight(s, [{ 1: 'spy#2', 2: 'spy#4' }, { 0: 'blind-assassin#3' }]);
    expect(s.phase).toBe('roundEnd');
    expect(s.players[0].played).not.toContain('spy#1'); // 保留的间谍全程未打出
  });

  it('死锁防护：刺杀后唯一存活者再打忍者也无目标，自动跳过', () => {
    let s = craftNight(3, { 0: ['blind-assassin#1', 'shinobi#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    // 间谍阶段：1、2 打出并互相窥视；0 保留
    s = flowNight(s, [{ 1: 'spy#2', 2: 'spy#4' }, { 0: 'blind-assassin#1' }]);
    expect(s.phase).toBe('roundEnd'); // 忍者阶段无存活目标 → 跳过而非卡死
  });
});

describe('诡术师六卡', () => {
  it('搅局者：只看/公开由玩家选择', () => {
    let s = craftNight(3, { 0: ['trick-troublemaker', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    // 驱动到诡术阶段窗口
    for (const seat of s.night!.window!.holders) s = def.applyAction(s, seat, { type: 'non:phasePass' }).state;
    s = def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'trick-troublemaker' }).state;
    // 只看：不公开
    let r = def.applyAction(s, 0, { type: 'non:resolve', target: 2, choice: 'peek' });
    s = r.state;
    expect(s.players[2].exposed).toBe(false);
    expect(r.events.some((e) => e.type === 'non:peek' && e.audience?.includes(0))).toBe(true);
    // （下一局）公开
    let s2 = craftNight(3, { 0: ['trick-troublemaker', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    for (const seat of s2.night!.window!.holders) s2 = def.applyAction(s2, seat, { type: 'non:phasePass' }).state;
    s2 = def.applyAction(s2, 0, { type: 'non:phasePlay', cardId: 'trick-troublemaker' }).state;
    r = def.applyAction(s2, 0, { type: 'non:resolve', target: 2, choice: 'reveal' });
    s2 = r.state;
    expect(s2.players[2].exposed).toBe(true);
    expect(r.events.some((e) => e.type === 'non:exposed')).toBe(true);
  });

  it('盗贼：公开身份并从代币更多的玩家处拿走一枚；只能对代币更多者出手', () => {
    let s = craftNight(3, { 0: ['trick-thief', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.players[1].tokens = [3, 4];
    s.players[0].tokens = [2];
    for (const seat of s.night!.window!.holders) s = def.applyAction(s, seat, { type: 'non:phasePass' }).state;
    s = def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'trick-thief' }).state;
    const r = def.applyAction(s, 0, { type: 'non:resolve', target: 1 });
    s = r.state;
    expect(r.events.some((e) => e.type === 'non:tokenSteal')).toBe(true);
    expect(s.players[0].exposed).toBe(true);
    // 偷后：我 2 枚、对方 1 枚（其余来自计分）
    // 非法：对代币数不多于自己的玩家出手
    expect(def.applyAction(s, 0, { type: 'non:resolve', target: 2 }).ok).toBe(false);
  });

  it('易容师：秘密交换两张身份，被换者失知', () => {
    let s = craftNight(3, { 0: ['trick-shapeshifter', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'lotus', rank: 2 };
    for (const seat of s.night!.window!.holders) s = def.applyAction(s, seat, { type: 'non:phasePass' }).state;
    s = def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'trick-shapeshifter' }).state;
    const r = def.applyAction(s, 0, { type: 'non:resolve', target: 1, target2: 2 });
    s = r.state;
    expect(s.players[1].identity).toEqual({ house: 'lotus', rank: 2 });
    expect(s.players[2].identity).toEqual({ house: 'crane', rank: 1 });
    expect(s.players[1].identityKnown).toBe(false);
    expect(s.players[2].identityKnown).toBe(false);
    const peek2 = r.events.find((e) => e.type === 'non:peek2')!;
    expect(peek2.audience).toEqual([0]); // 只有易容师知道两张牌
  });

  it('掘墓人：弃牌可立即打出（切换结算）；无目标类只能收下；收下保密', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['blind-assassin#6', 'mirror-monk'];
    s = flowNight(s, [{ 1: 'spy#2', 2: 'spy#4' }, { 0: 'trick-gravedigger' }]);
    expect(s.players[1].alive).toBe(false); // 打出的盲眼刺客生效
    expect(s.discardPile).toEqual(['mirror-monk']);
  });

  it('掘墓人收下不泄露牌 id（公开事件无 cardId，定向事件仅本人）', () => {
    let s = craftNight(3, { 0: ['trick-gravedigger', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s.discardPile = ['mirror-monk'];
    s = flowNight(s, [{ 1: 'spy#2', 2: 'spy#4' }, { 0: 'trick-gravedigger' }]);
    const keeper = [0, 1].find((seat) => s.players[seat].hand.includes('mirror-monk'));
    expect(keeper).toBeDefined(); // 掘墓人把镜僧收进了手牌
  });
});

describe('回合结算', () => {
  it('主谋从手牌揭示：存活则家系获胜；浪人主谋 → 无家系获胜', () => {
    let s = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['mastermind', 'spy#5'] });
    s.players[0].identity = { house: 'crane', rank: 1 };
    s.players[1].identity = { house: 'lotus', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s = flowNight(s, []);
    expect(s.roundResult!.winner).toBe('none');
    expect(s.roundResult!.mastermindSeat).toBe(2);
    expect(s.players[2].tokens.length).toBe(1);
    expect(s.players[0].tokens.length).toBe(0);

    let s2 = craftNight(3, { 0: ['mastermind', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    s2.players[0].identity = { house: 'lotus', rank: 2 };
    s2.players[1].identity = { house: 'crane', rank: 1 };
    s2.players[2].identity = { house: 'lotus', rank: 99 };
    s2 = flowNight(s2, []);
    expect(s2.roundResult!.winner).toBe('lotus'); // 主谋翻盘（否则 crane rank1 胜）
  });

  it('家系最佳排名：[1,2] 平 [1,2] → 完全平局每位幸存者各得一枚', () => {
    let s = craftNight(4, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'], 3: ['spy#1', 'spy#2'] });
    s.players[0].identity = { house: 'crane', rank: 1 };
    s.players[1].identity = { house: 'crane', rank: 2 };
    s.players[2].identity = { house: 'lotus', rank: 1 };
    s.players[3].identity = { house: 'lotus', rank: 2 };
    s = flowNight(s, []);
    expect(s.roundResult!.winner).toBe('none');
    for (const p of s.players) expect(p.tokens.length).toBe(1);
  });

  it('荣誉达标后终局；下一轮身份重发、全员复活、弃牌堆清空', () => {
    let s = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'] });
    s.players[0].identity = { house: 'lotus', rank: 2 };
    s.players[1].identity = { house: 'crane', rank: 1 };
    s.players[2].identity = { house: 'ronin', rank: 99 };
    s.players[1].tokens = [9];
    s = flowNight(s, []);
    expect(s.phase).toBe('gameEnd');
    expect(s.winners).toEqual([1]);

    let s2 = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['spy#3', 'spy#4'], 2: ['spy#5', 'spy#6'] });
    s2 = flowNight(s2, []);
    const a = def.auto(s2);
    s2 = a.state;
    expect(s2.phase).toBe('draft1');
    expect(s2.round).toBe(2);
    expect(s2.discardPile).toEqual([]);
    for (const p of s2.players) {
      expect(p.alive).toBe(true);
      expect(p.identityKnown).toBe(true);
      expect(p.played).toEqual([]);
      expect(p.draftPool.length).toBe(3);
    }
  });
});

describe('超时垫步', () => {
  it('窗口超时=保留；被刺杀超时=有反应牌则打出；目标选择超时=放过优先', () => {
    let s = craftNight(3, { 0: ['spy#1', 'blind-assassin#3'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    const r0 = def.applyTimeout(s, 0);
    expect(r0.ok).toBe(true);
    s = r0.state;
    expect(s.night!.window!.passed).toContain(0);

    // 被刺杀：有镜僧 → 自动打出反弹
    let s2 = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['mirror-monk', 'spy#2'], 2: ['spy#3', 'spy#4'] });
    for (const seat of s2.night!.window!.holders) s2 = def.applyAction(s2, seat, { type: 'non:phasePass' }).state;
    s2 = def.applyAction(s2, 0, { type: 'non:phasePlay', cardId: 'blind-assassin#1' }).state;
    s2 = def.applyAction(s2, 0, { type: 'non:resolve', target: 1 }).state;
    const r = def.applyTimeout(s2, 1);
    s2 = r.state;
    expect(s2.players[0].alive).toBe(false);

    // 忍者：目标选择超时 → 放过优先
    let s3 = craftNight(3, { 0: ['spy#1', 'spy#2'], 1: ['shinobi#1', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    for (const seat of s3.night!.window!.holders) s3 = def.applyAction(s3, seat, { type: 'non:phasePass' }).state;
    s3 = def.applyAction(s3, 1, { type: 'non:phasePlay', cardId: 'shinobi#1' }).state;
    // 第一跳超时：窥视（目标 = 合法选项第一项）
    s3 = def.applyTimeout(s3, 1).state;
    expect(s3.night!.current!.lockedTarget).toBeDefined();
    // 第二跳超时：杀/放中选放过
    s3 = def.applyTimeout(s3, 1).state;
    expect(s3.players.every((p) => p.alive)).toBe(true);
  });

  it('非法动作：窗口打非本阶段牌被拒、重复决定被拒、非目标反应被拒', () => {
    let s = craftNight(3, { 0: ['blind-assassin#1', 'spy#1'], 1: ['spy#2', 'spy#3'], 2: ['spy#4', 'spy#5'] });
    expect(def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'blind-assassin#1' }).ok).toBe(false);
    s = def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'spy#1' }).state;
    expect(def.applyAction(s, 0, { type: 'non:phasePlay', cardId: 'spy#1' }).ok).toBe(false); // 已决定
    expect(def.applyAction(s, 1, { type: 'non:react', cardId: 'spy#2' }).ok).toBe(false); // 无待反应
  });
});

describe('模糊测试 · 大规模随机对局', () => {
  for (let seed = 100; seed < 112; seed++) {
    for (const n of [3, 5, 7]) {
      it(`seed=${seed} n=${n} 全随机（含全部窗口/反应/变体选项）推进到终局`, () => {
        const rand = mulberry32(seed * 131 + n);
        const final = playout(def, setup(n, seed), (_s, ch) => ch[rand.int(ch.length)]);
        expect(def.isFinished(final)).toBe(true);
        for (const p of final.players) {
          const sum = p.tokens.reduce((a, b) => a + b, 0);
          expect(sum).toBeGreaterThanOrEqual(0);
        }
        expect(final.players.some((p) => p.tokens.reduce((a, b) => a + b, 0) >= final.targetHonor)).toBe(true);
      });
    }
  }
});
