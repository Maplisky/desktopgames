import {
  type ActionChoice,
  type GameDefinition,
  type GameEvent,
  type Reject,
  type Rng,
  type SeatInfo,
} from '@dg/games-core';
import { buildDeck, CARDS, HONOR_TOKEN_POOL } from './cards';
import type { Identity, NonPlayer, NonState, NonView, NonViewPlayer, RoundResult } from './types';

export const NON_MIN_PLAYERS = 3;
export const NON_MAX_PLAYERS = 11;

/* ================= 工具 ================= */

function rngStep(s: NonState): number {
  s.rngS = (s.rngS + 0x6d2b79f5) >>> 0;
  let t = s.rngS;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffled<T>(s: NonState, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rngStep(s) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const ev = (type: string, payload?: Record<string, unknown>, audience?: number[]): GameEvent =>
  audience ? { type, payload, audience } : payload ? { type, payload } : { type };

function aliveOthers(s: NonState, seat: number): number[] {
  return s.players.filter((p) => p.seat !== seat && p.alive).map((p) => p.seat);
}

function identityDeckFor(n: number): Identity[] {
  const even = n % 2 === 0 ? n : n - 1;
  const perHouse = even / 2;
  const deck: Identity[] = [];
  for (let r = 1; r <= perHouse; r++) deck.push({ house: 'crane', rank: r });
  for (let r = 1; r <= perHouse; r++) deck.push({ house: 'lotus', rank: r });
  if (n % 2 === 1) deck.push({ house: 'ronin', rank: 99 });
  return deck;
}

/* ================= 回合流程 ================= */

function startRound(s: NonState, events: GameEvent[]) {
  s.round += 1;
  s.phase = 'draft1';
  s.picked = [];
  s.night = null;
  s.roundResult = null;
  events.push(ev('non:roundStart', { round: s.round }));
  const identities = shuffled(s, identityDeckFor(s.players.length));
  const deck = shuffled(s, buildDeck(s.players.length));
  s.players.forEach((p, i) => {
    p.identity = identities[i];
    p.alive = true;
    p.resolvedCard = null;
    p.killedBy = null;
    p.exposed = false;
    p.monkUsed = false;
    p.hand = [];
    p.committed = null;
    p.draftPool = deck.slice(i * 3, i * 3 + 3);
    events.push(ev('non:identityDealt', { house: p.identity.house, rank: p.identity.rank }, [p.seat]));
    events.push(ev('non:dealt', { seat: p.seat, count: 3 }));
  });
}

function advanceNight(s: NonState, events: GameEvent[]) {
  const night = s.night!;
  while (night.idx < night.order.length) {
    const entry = night.order[night.idx];
    const p = s.players[entry.seat];
    const negated = night.negated.includes(entry.seat);
    if (!p.alive || negated) {
      events.push(ev('non:nightSkip', { seat: entry.seat, reason: !p.alive ? 'dead' : 'negated' }));
      night.idx += 1;
      continue;
    }
    const card = CARDS[entry.card];
    p.resolvedCard = entry.card;
    night.current = { seat: entry.seat, card: entry.card };
    events.push(ev('non:resolving', { seat: entry.seat, cardId: entry.card }));
    if (card.targetKind !== 'none') return; // 等待该玩家选择目标
    // 无需选择：立即结算（反应/被动/金蝉脱壳）
    applyEffect(s, entry.seat, entry.card, {}, events);
    night.current = null;
    night.idx += 1;
  }
}

function applyEffect(
  s: NonState,
  seat: number,
  cardId: string,
  args: { target?: number; target2?: number; choice?: string },
  events: GameEvent[],
) {
  const target = args.target !== undefined ? s.players[args.target] : null;
  switch (cardId) {
    case 'spy':
    case 'trick-peek': {
      events.push(
        ev('non:peek', { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank }, [seat]),
      );
      break;
    }
    case 'mystic': {
      const other = target!.hand.find((h) => h !== target!.committed);
      events.push(
        ev(
          'non:peek',
          { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank, otherCard: other ?? null },
          [seat],
        ),
      );
      break;
    }
    case 'trick-expose': {
      target!.exposed = true;
      events.push(
        ev('non:exposed', { seat: target!.seat, house: target!.identity.house, rank: target!.identity.rank }),
      );
      break;
    }
    case 'trick-swap': {
      const b = s.players[args.target2!];
      const ia = { ...s.players[seat].identity };
      s.players[seat].identity = { ...b.identity };
      b.identity = ia;
      events.push(ev('non:identitySwap', { a: seat, b: b.seat }));
      events.push(ev('non:peek', { self: true, house: s.players[seat].identity.house, rank: s.players[seat].identity.rank }, [seat]));
      events.push(ev('non:peek', { self: true, house: b.identity.house, rank: b.identity.rank }, [b.seat]));
      break;
    }
    case 'trick-exchange': {
      const me = s.players[seat];
      const otherCardMe = me.hand.find((h) => h !== me.committed);
      const otherCardT = target!.hand.find((h) => h !== target!.committed);
      if (otherCardMe && otherCardT) {
        me.hand = me.hand.map((h) => (h === otherCardMe ? otherCardT : h));
        target!.hand = target!.hand.map((h) => (h === otherCardT ? otherCardMe : h));
      }
      events.push(ev('non:cardSwap', { a: seat, b: target!.seat, aCard: otherCardMe ?? null, bCard: otherCardT ?? null }, [seat, target!.seat]));
      break;
    }
    case 'trick-disguise': {
      const deck = shuffled(s, identityDeckFor(s.players.length));
      const next = deck[0];
      s.players[seat].identity = next;
      events.push(ev('non:disguise', { seat }));
      events.push(ev('non:peek', { self: true, house: next.house, rank: next.rank }, [seat]));
      break;
    }
    case 'trick-silence': {
      s.night!.negated.push(target!.seat);
      events.push(ev('non:silenced', { seat: target!.seat }));
      break;
    }
    case 'blind-assassin': {
      attemptKill(s, events, seat, target!.seat);
      break;
    }
    case 'shinobi': {
      events.push(
        ev('non:peek', { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank }, [seat]),
      );
      if (args.choice === 'kill') attemptKill(s, events, seat, target!.seat);
      else events.push(ev('non:spared', { seat: target!.seat }));
      break;
    }
    case 'mirror-monk':
    case 'shadow-guard':
    case 'mastermind':
      // 被动：在 attemptKill / 回合结算中生效
      break;
    default:
      throw new Error(`unknown card ${cardId}`);
  }
}

function attemptKill(s: NonState, events: GameEvent[], attacker: number, targetSeat: number) {
  const t = s.players[targetSeat];
  if (!t.alive) return;
  events.push(ev('non:killAttempt', { attacker, target: targetSeat }));
  const tCard = t.committed ? CARDS[t.committed] : null;
  const tNegated = s.night?.negated.includes(targetSeat) ?? false;
  if (tCard?.id === 'mirror-monk' && !tNegated && !t.monkUsed) {
    t.monkUsed = true;
    const a = s.players[attacker];
    if (a.alive) {
      a.alive = false;
      a.killedBy = targetSeat;
      events.push(ev('non:reflected', { by: targetSeat, attacker }));
      events.push(ev('non:death', { seat: attacker }));
    }
    return;
  }
  if (tCard?.id === 'shadow-guard' && !tNegated) {
    events.push(ev('non:blocked', { seat: targetSeat }));
    return;
  }
  t.alive = false;
  t.killedBy = attacker;
  events.push(ev('non:death', { seat: targetSeat }));
}

/** 家系最佳排名序列比较（缺位视为 ∞；逐位比较，小者优先） */
function bestRanks(s: NonState, house: 'crane' | 'lotus'): number[] {
  return s.players
    .filter((p) => p.alive && p.identity.house === house)
    .map((p) => p.identity.rank)
    .sort((a, b) => a - b);
}

function computeRoundEnd(s: NonState, events: GameEvent[]) {
  s.phase = 'roundEnd';
  const survivors = s.players.filter((p) => p.alive);
  for (const p of survivors) {
    if (p.identity.house !== 'ronin') {
      events.push(ev('non:reveal', { seat: p.seat, house: p.identity.house, rank: p.identity.rank }));
    } else {
      events.push(ev('non:reveal', { seat: p.seat, house: 'ronin', rank: 99 }));
    }
  }

  // 主谋：唯一存活的主谋直接为其家系拿下回合（双方都有则回到排名比较）
  const livingMasterminds = s.players.filter(
    (p) => p.alive && p.committed === 'mastermind' && !(s.night?.negated.includes(p.seat) ?? false),
  );
  let winner: RoundResult['winner'];
  let mastermindSeat: number | null = null;
  const mmHouses = new Set(livingMasterminds.map((p) => p.identity.house));
  if (mmHouses.size === 1) {
    const h = [...mmHouses][0] as 'crane' | 'lotus';
    winner = h;
    mastermindSeat = livingMasterminds[0].seat;
  } else {
    const crane = bestRanks(s, 'crane');
    const lotus = bestRanks(s, 'lotus');
    const len = Math.max(crane.length, lotus.length);
    let cmp = 0;
    for (let i = 0; i < len; i++) {
      const a = crane[i] ?? Infinity;
      const b = lotus[i] ?? Infinity;
      if (a !== b) {
        cmp = a < b ? -1 : 1;
        break;
      }
    }
    winner = cmp === 0 ? 'none' : cmp < 0 ? 'crane' : 'lotus';
  }

  // 荣誉：获胜家系全员（死活皆可）各抽一枚；浪人存活也抽一枚
  const gained: number[] = [];
  const drawToken = (p: NonPlayer) => {
    if (s.tokenIdx >= s.tokenPool.length) {
      s.tokenPool = shuffled(s, [...HONOR_TOKEN_POOL]);
      s.tokenIdx = 0;
    }
    const v = s.tokenPool[s.tokenIdx++];
    p.honor += v;
    gained.push(p.seat);
    events.push(ev('non:honorDraw', { seat: p.seat }));
    events.push(ev('non:honor', { gained: v, total: p.honor }, [p.seat]));
  };
  if (winner !== 'none') {
    for (const p of s.players) if (p.identity.house === winner) drawToken(p);
  }
  for (const p of s.players) if (p.identity.house === 'ronin' && p.alive) drawToken(p);

  s.roundResult = {
    winner,
    mastermindSeat,
    survivors: survivors
      .filter((p) => p.identity.house !== 'ronin')
      .map((p) => ({ seat: p.seat, house: p.identity.house as 'crane' | 'lotus', rank: p.identity.rank })),
    gainedSeats: gained,
  };
  events.push(ev('non:roundEnd', { winner, gainedSeats: gained, mastermindSeat }));

  const reached = s.players.filter((p) => p.honor >= s.targetHonor);
  if (reached.length > 0) {
    const max = Math.max(...reached.map((p) => p.honor));
    s.winners = reached.filter((p) => p.honor === max).map((p) => p.seat);
    s.phase = 'gameEnd';
    events.push(
      ev('non:gameEnd', {
        winners: s.winners,
        standings: s.players.map((p) => ({ seat: p.seat, honor: p.honor, house: p.identity.house, rank: p.identity.rank })),
      }),
    );
  }
}

/* ================= 通用推进/选择 ================= */

function step(s: NonState, events: GameEvent[]) {
  // 单步自动推进（由 auto 调用）：处理当前无需输入的一切
  switch (s.phase) {
    case 'draft1': {
      if (s.picked.length < s.players.length) return false;
      const remaining = s.players.map((p) => p.draftPool);
      s.players.forEach((p, i) => {
        const from = (i - 1 + s.players.length) % s.players.length; // 从右家收到
        p.draftPool = remaining[from];
      });
      s.picked = [];
      s.phase = 'draft2';
      events.push(ev('non:poolPassed', { pickNumber: 2 }));
      return true;
    }
    case 'draft2': {
      if (s.picked.length < s.players.length) return false;
      s.players.forEach((p) => (p.draftPool = []));
      s.phase = 'commit';
      events.push(ev('non:draftDone', {}));
      return true;
    }
    case 'commit': {
      const waiting = s.players.filter((p) => p.alive && p.committed === null);
      if (waiting.length > 0) return false;
      const order = s.players
        .filter((p) => p.alive && p.committed !== null)
        .map((p) => ({ seat: p.seat, card: p.committed! }))
        .sort((a, b) => CARDS[a.card].phase - CARDS[b.card].phase || a.seat - b.seat);
      s.night = { order, idx: 0, negated: [], current: null };
      s.phase = 'night';
      events.push(ev('non:nightStart', { count: order.length }));
      advanceNight(s, events);
      return true;
    }
    case 'night': {
      const night = s.night!;
      if (night.current || night.idx < night.order.length) return false;
      computeRoundEnd(s, events);
      return true;
    }
    case 'roundEnd': {
      startRound(s, events);
      return true;
    }
    default:
      return false;
  }
}

function act(s: NonState, seat: number, action: { type: string } & Record<string, unknown>, events: GameEvent[]): Reject | null {
  const p = s.players[seat];
  if (!p) return { ok: false, reason: '座位不存在' };
  switch (action.type) {
    case 'non:draftPick': {
      if (s.phase !== 'draft1' && s.phase !== 'draft2') return { ok: false, reason: '不在轮抽阶段' };
      if (s.picked.includes(seat)) return { ok: false, reason: '你已完成本阶段选牌' };
      const cardId = String(action.cardId ?? '');
      const i = p.draftPool.indexOf(cardId);
      if (i < 0) return { ok: false, reason: '该牌不在你的候选牌中' };
      p.draftPool.splice(i, 1);
      p.hand.push(cardId);
      s.picked.push(seat);
      events.push(ev('non:draftPicked', { seat, pickNumber: s.phase === 'draft1' ? 1 : 2 }));
      return null;
    }
    case 'non:commit': {
      if (s.phase !== 'commit') return { ok: false, reason: '不在出牌阶段' };
      if (!p.alive) return { ok: false, reason: '你已出局' };
      if (p.committed !== null) return { ok: false, reason: '你已打出牌' };
      const cardId = String(action.cardId ?? '');
      if (!p.hand.includes(cardId)) return { ok: false, reason: '该牌不在你手中' };
      p.committed = cardId;
      events.push(ev('non:committed', { seat }));
      return null;
    }
    case 'non:resolve': {
      if (s.phase !== 'night' || !s.night?.current) return { ok: false, reason: '当前无需结算选择' };
      if (s.night.current.seat !== seat) return { ok: false, reason: '没轮到你结算' };
      const cardId = s.night.current.card;
      const card = CARDS[cardId];
      const target = action.target !== undefined ? Number(action.target) : undefined;
      const target2 = action.target2 !== undefined ? Number(action.target2) : undefined;
      if (card.targetKind !== 'none') {
        if (target === undefined || !Number.isInteger(target)) return { ok: false, reason: '缺少目标' };
        if (card.targetKind === 'anyAliveOther') {
          const t = s.players[target];
          if (!t || t.seat === seat || !t.alive) return { ok: false, reason: '目标无效' };
        }
        if (card.twoTargets) {
          if (target2 === undefined || !Number.isInteger(target2) || target2 === target)
            return { ok: false, reason: '需要两个不同目标' };
          if (!s.players[target2]?.alive || !s.players[target]?.alive) return { ok: false, reason: '目标无效' };
        }
      }
      if (card.shinobiStyle && action.choice !== 'kill' && action.choice !== 'spare')
        return { ok: false, reason: '需要选择杀或放' };
      applyEffect(s, seat, cardId, { target, target2, choice: action.choice as string | undefined }, events);
      s.night.current = null;
      s.night.idx += 1;
      advanceNight(s, events);
      return null;
    }
    default:
      return { ok: false, reason: `未知动作 ${action.type}` };
  }
}

/* ================= Definition ================= */

export const nightOfNinja: GameDefinition<NonState> = {
  id: 'night-of-ninja',
  displayName: '忍者之夜',
  minPlayers: NON_MIN_PLAYERS,
  maxPlayers: NON_MAX_PLAYERS,
  defaultOptions: { targetHonor: 10 },

  setup(seats: SeatInfo[], options: Record<string, unknown>, rng: Rng): NonState {
    const s: NonState = {
      gameId: 'night-of-ninja',
      phase: 'draft1',
      round: 0,
      targetHonor: Number(options.targetHonor ?? 10),
      players: seats.map((info) => ({
        seat: info.seat,
        sessionId: info.sessionId,
        nickname: info.nickname,
        isBot: info.isBot,
        identity: { house: 'crane', rank: 99 },
        draftPool: [],
        hand: [],
        committed: null,
        honor: 0,
        monkUsed: false,
        alive: true,
        resolvedCard: null,
        killedBy: null,
        exposed: false,
      })),
      picked: [],
      night: null,
      roundResult: null,
      winners: null,
      tokenPool: [],
      tokenIdx: 0,
      rngS: rng.int(2 ** 31),
    };
    const events: GameEvent[] = [];
    startRound(s, events);
    return s;
  },

  phaseInfo(state: NonState) {
    switch (state.phase) {
      case 'draft1':
      case 'draft2':
        return {
          id: state.phase,
          label: state.phase === 'draft1' ? '轮抽 · 第 1 抓' : '轮抽 · 第 2 抓',
          activeSeats: state.players.filter((p) => !state.picked.includes(p.seat)).map((p) => p.seat),
          timerMs: 45_000,
        };
      case 'commit':
        return {
          id: 'commit',
          label: '暗选出牌',
          activeSeats: state.players.filter((p) => p.alive && p.committed === null).map((p) => p.seat),
          timerMs: 30_000,
        };
      case 'night':
        return {
          id: 'night',
          label: '忍者之夜 · 结算',
          activeSeats: state.night?.current ? [state.night.current.seat] : [],
          timerMs: state.night?.current ? 30_000 : undefined,
        };
      case 'roundEnd':
        return { id: 'roundEnd', label: '回合结算', activeSeats: [], autoAfterMs: 6_000 };
      case 'gameEnd':
        return { id: 'gameEnd', label: '游戏结束', activeSeats: [] };
    }
  },

  applyAction(state: NonState, seat: number, action: { type: string } & Record<string, unknown>) {
    const s = structuredClone(state);
    const events: GameEvent[] = [];
    const reject = act(s, seat, action, events);
    if (reject) return reject;
    return { ok: true as const, state: s, events };
  },

  applyTimeout(state: NonState, seat: number) {
    const choices = this.legalActions(state, seat);
    if (choices.length === 0) return { ok: false as const, reason: '无可用垫步动作' };
    // 优先选非致命选项（忍者选择放过）
    const spare = choices.find((c) => c.action.choice === 'spare');
    return this.applyAction(state, seat, (spare ?? choices[0]).action);
  },

  auto(state: NonState) {
    if (this.isFinished(state)) return { ok: false as const, reason: '对局已结束' };
    const s = structuredClone(state);
    const events: GameEvent[] = [];
    if (!step(s, events)) return { ok: false as const, reason: '当前阶段需要玩家行动' };
    return { ok: true as const, state: s, events };
  },

  isFinished(state: NonState) {
    return state.phase === 'gameEnd';
  },

  legalActions(state: NonState, seat: number): ActionChoice[] {
    const p = state.players[seat];
    if (!p) return [];
    switch (state.phase) {
      case 'draft1':
      case 'draft2': {
        if (state.picked.includes(seat)) return [];
        return p.draftPool.map((cardId) => ({
          action: { type: 'non:draftPick', cardId },
          ui: { kind: 'card' as const, cardId },
        }));
      }
      case 'commit': {
        if (!p.alive || p.committed !== null) return [];
        return p.hand.map((cardId) => ({
          action: { type: 'non:commit', cardId },
          ui: { kind: 'card' as const, cardId, label: '打出' },
        }));
      }
      case 'night': {
        const cur = state.night?.current;
        if (!cur || cur.seat !== seat) return [];
        const others = aliveOthers(state, seat);
        const mk = (action: Record<string, unknown>, label: string, prompt: string): ActionChoice => ({
          action: { type: 'non:resolve', ...action } as ActionChoice['action'],
          ui: { kind: 'button' as const, label, targetSeats: action.target !== undefined ? [Number(action.target)] : undefined, prompt },
        });
        switch (cur.card) {
          case 'spy':
            return others.map((t) => mk({ target: t }, '间谍', `查看 ${state.players[t].nickname} 的身份`));
          case 'mystic':
          case 'trick-peek':
            return others.map((t) => mk({ target: t }, '通灵', `查看 ${state.players[t].nickname} 的身份与手牌`));
          case 'trick-expose':
            return others.map((t) => mk({ target: t }, '揭露', `公开 ${state.players[t].nickname} 的身份`));
          case 'trick-exchange':
            return others.map((t) => mk({ target: t }, '换牌', `与 ${state.players[t].nickname} 交换未打出的牌`));
          case 'trick-silence':
            return others.map((t) => mk({ target: t }, '封印', `封印 ${state.players[t].nickname} 的卡牌效果`));
          case 'blind-assassin':
            return others.map((t) => mk({ target: t }, '刺杀', `杀死 ${state.players[t].nickname}`));
          case 'shinobi':
            return others.flatMap((t) => [
              mk({ target: t, choice: 'kill' }, '忍者·杀', `查看并杀死 ${state.players[t].nickname}`),
              mk({ target: t, choice: 'spare' }, '忍者·放', `查看并放过 ${state.players[t].nickname}`),
            ]);
          case 'trick-swap': {
            const alive = state.players.filter((q) => q.alive);
            const out: ActionChoice[] = [];
            for (let i = 0; i < alive.length; i++)
              for (let j = i + 1; j < alive.length; j++) {
                const a = alive[i].seat;
                const b = alive[j].seat;
                out.push({
                  action: { type: 'non:resolve', target: a, target2: b },
                  ui: {
                    kind: 'button',
                    label: '调换',
                    targetSeats: [a, b],
                    prompt: `交换 ${state.players[a].nickname} 与 ${state.players[b].nickname} 的身份`,
                  },
                });
              }
            return out;
          }
          default:
            return [];
        }
      }
      default:
        return [];
    }
  },

  clientView(state: NonState, seat: number): NonView {
    const me = state.players[seat];
    const inReveal = state.phase === 'roundEnd' || state.phase === 'gameEnd';
    const players: NonViewPlayer[] = state.players.map((p) => ({
      seat: p.seat,
      nickname: p.nickname,
      isBot: p.isBot,
      alive: p.alive,
      hasCommitted: p.committed !== null,
      resolvedCard: p.resolvedCard,
      negated: state.night?.negated.includes(p.seat) ?? false,
      handCount: p.hand.length,
      exposedIdentity: p.exposed ? p.identity : null,
      revealedIdentity: inReveal && (p.alive || state.phase === 'gameEnd') ? p.identity : null,
    }));
    return {
      phase: state.phase,
      round: state.round,
      targetHonor: state.targetHonor,
      you: {
        seat,
        identity: me.identity,
        honor: me.honor,
        alive: me.alive,
        hand: [...me.hand],
        committed: me.committed,
        draftPool: [...me.draftPool],
        picked: state.picked.includes(seat),
      },
      players,
      draft:
        state.phase === 'draft1' || state.phase === 'draft2'
          ? {
              pickNumber: state.phase === 'draft1' ? 1 : 2,
              doneCount: state.picked.length,
              total: state.players.length,
            }
          : null,
      nightInfo: state.night
        ? {
            currentSeat: state.night.current?.seat ?? null,
            currentCardId: state.night.current?.card ?? null,
            resolvedCount: state.night.idx,
            total: state.night.order.length,
          }
        : null,
      roundResult: state.roundResult,
      winners: state.winners,
      standings:
        state.phase === 'gameEnd'
          ? state.players.map((p) => ({ seat: p.seat, nickname: p.nickname, honor: p.honor, identity: p.identity }))
          : null,
    };
  },
};
