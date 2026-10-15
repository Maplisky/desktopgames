import {
  type ActionChoice,
  type GameDefinition,
  type GameEvent,
  type Reject,
  type Rng,
  type SeatInfo,
} from '@dg/games-core';
import { buildDeck, CARDS, cardOf, HONOR_TOKEN_POOL, parseInst } from './cards';
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

const sumTokens = (p: NonPlayer) => p.tokens.reduce((a, b) => a + b, 0);

function identityDeckFor(n: number): Identity[] {
  const even = n % 2 === 0 ? n : n - 1;
  const perHouse = even / 2;
  const deck: Identity[] = [];
  for (let r = 1; r <= perHouse; r++) deck.push({ house: 'crane', rank: r });
  for (let r = 1; r <= perHouse; r++) deck.push({ house: 'lotus', rank: r });
  if (n % 2 === 1) deck.push({ house: 'ronin', rank: 99 });
  return deck;
}

/** 从代币袋抽一枚（耗尽后重洗） */
function drawToken(s: NonState, p: NonPlayer, events: GameEvent[]) {
  if (s.tokenIdx >= s.tokenPool.length) {
    s.tokenPool = shuffled(s, [...HONOR_TOKEN_POOL]);
    s.tokenIdx = 0;
  }
  const v = s.tokenPool[s.tokenIdx++];
  p.tokens.push(v);
  events.push(ev('non:honorDraw', { seat: p.seat }));
  events.push(ev('non:honor', { gained: v, total: sumTokens(p) }, [p.seat]));
}

/* ================= 回合流程 ================= */

function startRound(s: NonState, events: GameEvent[]) {
  s.round += 1;
  s.phase = 'draft1';
  s.picked = [];
  s.night = null;
  s.roundResult = null;
  s.discardPile = [];
  events.push(ev('non:roundStart', { round: s.round }));
  const identities = shuffled(s, identityDeckFor(s.players.length));
  const deck = shuffled(s, buildDeck()); // 全盒 33 张洗混，发 3N，余牌旁置
  s.players.forEach((p, i) => {
    p.identity = identities[i];
    p.identityKnown = true;
    p.alive = true;
    p.resolvedCard = null;
    p.killedBy = null;
    p.exposed = false;
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
    const card = cardOf(entry.card);
    p.resolvedCard = entry.card;
    night.current = { seat: entry.seat, card: entry.card };
    events.push(ev('non:resolving', { seat: entry.seat, cardId: parseInst(entry.card).id }));
    if (card.targetKind !== 'none') {
      // 需要选择但没有任何合法选择（如已无存活目标）→ 跳过，防止死锁
      if (nightChoices(s, entry.seat).length === 0) {
        night.current = null;
        night.idx += 1;
        events.push(ev('non:nightSkip', { seat: entry.seat, reason: 'no-targets' }));
        continue;
      }
      return; // 等待该玩家选择
    }
    // 无需选择：立即结算（反应/被动）
    applyEffect(s, entry.seat, entry.card, {}, events);
    night.current = null;
    night.idx += 1;
  }
}

function applyEffect(
  s: NonState,
  seat: number,
  cardId: string,
  args: { target?: number; target2?: number; choice?: string; pick?: string; mode?: string },
  events: GameEvent[],
) {
  const id = parseInst(cardId).id;
  const me = s.players[seat];
  const target = args.target !== undefined ? s.players[args.target] : null;
  switch (id) {
    case 'spy':
      events.push(
        ev('non:peek', { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank }, [seat]),
      );
      break;
    case 'mystic': {
      // 通灵者看的是目标「已打出」的那张忍者牌
      events.push(
        ev(
          'non:peek',
          { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank, otherCard: target!.committed ?? null },
          [seat],
        ),
      );
      break;
    }
    case 'trick-shapeshifter': {
      // 交换的是两个目标之间（易容师本人不动）；官方：秘密交换，受害者不知新身份
      const a = s.players[args.target!];
      const b = s.players[args.target2!];
      events.push(
        ev(
          'non:peek2',
          {
            a: a.seat,
            b: b.seat,
            aHouse: a.identity.house,
            aRank: a.identity.rank,
            bHouse: b.identity.house,
            bRank: b.identity.rank,
            swapped: true,
          },
          [seat],
        ),
      );
      const ia = { ...a.identity };
      a.identity = { ...b.identity };
      b.identity = ia;
      a.identityKnown = false;
      b.identityKnown = false;
      break;
    }
    case 'trick-gravedigger': {
      // 变体动作在 act 中处理（选择弃牌 + 打出/保留），这里不直接调用
      break;
    }
    case 'trick-troublemaker': {
      events.push(
        ev('non:peek', { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank }, [seat]),
      );
      if (args.choice === 'reveal') {
        target!.exposed = true;
        events.push(ev('non:exposed', { seat: target!.seat, house: target!.identity.house, rank: target!.identity.rank }));
      }
      break;
    }
    case 'trick-spirit-merchant': {
      if (args.choice === 'house') {
        events.push(
          ev('non:peek', { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank }, [seat]),
        );
      } else if (args.choice === 'token') {
        const v = target!.tokens.length > 0 ? target!.tokens[Math.floor(rngStep(s) * target!.tokens.length)] : null;
        events.push(ev('non:peek', { target: target!.seat, peekToken: v }, [seat]));
      } else if (args.choice === 'swap') {
        if (me.tokens.length > 0 && target!.tokens.length > 0) {
          const mi = Math.floor(rngStep(s) * me.tokens.length);
          const ti = Math.floor(rngStep(s) * target!.tokens.length);
          const mv = me.tokens[mi];
          me.tokens[mi] = target!.tokens[ti];
          target!.tokens[ti] = mv;
          events.push(ev('non:tokenSwap', { a: me.seat, b: target!.seat }));
          events.push(ev('non:honor', { gained: 0, note: 'swap', total: sumTokens(me) }, [me.seat]));
          events.push(ev('non:honor', { gained: 0, note: 'swap', total: sumTokens(target!) }, [target!.seat]));
        }
      }
      break;
    }
    case 'trick-thief': {
      me.exposed = true;
      events.push(ev('non:exposed', { seat: me.seat, house: me.identity.house, rank: me.identity.rank }));
      if (target && target.tokens.length > 0) {
        const ti = Math.floor(rngStep(s) * target.tokens.length);
        const v = target.tokens.splice(ti, 1)[0];
        me.tokens.push(v);
        events.push(ev('non:tokenSteal', { from: target.seat, to: me.seat }));
        events.push(ev('non:honor', { gained: v, note: 'steal', total: sumTokens(me) }, [me.seat]));
      }
      break;
    }
    case 'trick-judge': {
      me.exposed = true;
      events.push(ev('non:exposed', { seat: me.seat, house: me.identity.house, rank: me.identity.rank }));
      if (target) attemptKill(s, events, seat, target.seat, { bypassReactions: true });
      break;
    }
    case 'blind-assassin':
      attemptKill(s, events, seat, target!.seat);
      break;
    case 'mirror-monk':
    case 'martyr':
    case 'mastermind':
      // 被动：在 attemptKill / 回合结算中生效
      break;
    default:
      throw new Error(`unknown card ${id}`);
  }
}

function attemptKill(
  s: NonState,
  events: GameEvent[],
  attacker: number,
  targetSeat: number,
  opts: { bypassReactions?: boolean } = {},
) {
  const t = s.players[targetSeat];
  if (!t.alive) return;
  events.push(ev('non:killAttempt', { attacker, target: targetSeat }));
  const tId = t.committed ? parseInst(t.committed).id : null;
  const tNegated = s.night?.negated.includes(targetSeat) ?? false;
  if (!opts.bypassReactions && !tNegated) {
    if (tId === 'mirror-monk') {
      const a = s.players[attacker];
      if (a.alive) {
        a.alive = false;
        a.killedBy = targetSeat;
        events.push(ev('non:reflected', { by: targetSeat, attacker }));
        events.push(ev('non:death', { seat: attacker }));
      }
      return;
    }
    if (tId === 'martyr') {
      drawToken(s, t, events);
      events.push(ev('non:martyred', { seat: targetSeat }));
      return;
    }
  }
  if (opts.bypassReactions) {
    events.push(ev('non:judged', { target: targetSeat }));
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
    events.push(
      ev('non:reveal', {
        seat: p.seat,
        house: p.identity.house,
        rank: p.identity.house === 'ronin' ? 99 : p.identity.rank,
      }),
    );
  }

  // 主谋：存活主谋直接为其家系拿下回合；浪人主谋 → 无家系获胜；双方家系都有 → 回到排名比较
  const livingMasterminds = s.players.filter(
    (p) => p.alive && p.committed !== null && parseInst(p.committed).id === 'mastermind' && !(s.night?.negated.includes(p.seat) ?? false),
  );
  let winner: RoundResult['winner'];
  let mastermindSeat: number | null = null;
  let roninMastermindOnly = false;
  const mmHouses = new Set(livingMasterminds.map((p) => p.identity.house).filter((h) => h !== 'ronin'));
  const roninMM = livingMasterminds.some((p) => p.identity.house === 'ronin');
  if (mmHouses.size === 1) {
    winner = [...mmHouses][0] as 'crane' | 'lotus';
    mastermindSeat = livingMasterminds.find((p) => p.identity.house === winner)?.seat ?? null;
  } else if (mmHouses.size === 0 && roninMM) {
    winner = 'none'; // 浪人主谋：无家系获胜
    mastermindSeat = livingMasterminds.find((p) => p.identity.house === 'ronin')!.seat;
    roninMastermindOnly = true;
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

  const gained: number[] = [];
  const gain = (p: NonPlayer) => {
    drawToken(s, p, events);
    gained.push(p.seat);
  };
  if (winner !== 'none') {
    for (const p of s.players) if (p.identity.house === winner) gain(p);
    for (const p of s.players) if (p.identity.house === 'ronin' && p.alive) gain(p);
  } else if (roninMastermindOnly) {
    // 浪人主谋：仅浪人按存活规则得分
    for (const p of s.players) if (p.identity.house === 'ronin' && p.alive) gain(p);
  } else {
    // 完全平局：每位幸存者各得一枚
    for (const p of s.players) if (p.alive) gain(p);
  }

  s.roundResult = {
    winner,
    mastermindSeat,
    survivors: survivors
      .filter((p) => p.identity.house !== 'ronin')
      .map((p) => ({ seat: p.seat, house: p.identity.house as 'crane' | 'lotus', rank: p.identity.rank })),
    gainedSeats: gained,
  };
  events.push(ev('non:roundEnd', { winner, gainedSeats: gained, mastermindSeat }));

  const reached = s.players.filter((p) => sumTokens(p) >= s.targetHonor);
  if (reached.length > 0) {
    const max = Math.max(...reached.map((p) => sumTokens(p)));
    s.winners = reached.filter((p) => sumTokens(p) === max).map((p) => p.seat);
    s.phase = 'gameEnd';
    events.push(
      ev('non:gameEnd', {
        winners: s.winners,
        standings: s.players.map((p) => ({ seat: p.seat, honor: sumTokens(p), house: p.identity.house, rank: p.identity.rank })),
      }),
    );
  }
}

/* ================= 阶段推进 ================= */

function step(s: NonState, events: GameEvent[]) {
  switch (s.phase) {
    case 'draft1': {
      if (s.picked.length < s.players.length) return false;
      const remaining = s.players.map((p) => p.draftPool);
      s.players.forEach((p, i) => {
        p.draftPool = remaining[(i - 1 + s.players.length) % s.players.length]; // 从右家收到
      });
      s.picked = [];
      s.phase = 'draft2';
      events.push(ev('non:poolPassed', { pickNumber: 2 }));
      return true;
    }
    case 'draft2': {
      if (s.picked.length < s.players.length) return false;
      // 余牌弃置桌面中央（掘墓人可用）
      for (const p of s.players) {
        for (const c of p.draftPool) s.discardPile.push(c);
        p.draftPool = [];
      }
      s.phase = 'commit';
      events.push(ev('non:draftDone', { discards: s.discardPile.length }));
      return true;
    }
    case 'commit': {
      const waiting = s.players.filter((p) => p.alive && p.committed === null);
      if (waiting.length > 0) return false;
      // 同类型内按角标数字升序，再按座位
      const order = s.players
        .filter((p) => p.alive && p.committed !== null)
        .map((p) => ({ seat: p.seat, card: p.committed! }))
        .sort((a, b) => {
          const ca = cardOf(a.card);
          const cb = cardOf(b.card);
          return ca.phase - cb.phase || parseInst(a.card).number - parseInst(b.card).number || a.seat - b.seat;
        });
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

function act(
  s: NonState,
  seat: number,
  action: { type: string } & Record<string, unknown>,
  events: GameEvent[],
): Reject | null {
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
    case 'non:choose': {
      if (s.phase !== 'night' || !s.night?.current) return { ok: false, reason: '当前无需抉择' };
      if (s.night.current.seat !== seat) return { ok: false, reason: '没轮到你结算' };
      const card = cardOf(s.night.current.card);
      const locked = s.night.current.lockedTarget;
      if (!card.shinobiStyle || locked === undefined) return { ok: false, reason: '当前无需抉择' };
      if (action.choice !== 'kill' && action.choice !== 'spare') return { ok: false, reason: '需要选择杀或放' };
      if (!s.players[locked]?.alive) return { ok: false, reason: '目标已死亡' };
      if (action.choice === 'kill') attemptKill(s, events, seat, locked);
      else events.push(ev('non:spared', { seat: locked }));
      s.night.current = null;
      s.night.idx += 1;
      advanceNight(s, events);
      return null;
    }
    case 'non:resolve': {
      if (s.phase !== 'night' || !s.night?.current) return { ok: false, reason: '当前无需结算选择' };
      if (s.night.current.seat !== seat) return { ok: false, reason: '没轮到你结算' };
      const cardId = s.night.current.card;
      const card = cardOf(cardId);
      const target = action.target !== undefined ? Number(action.target) : undefined;
      const target2 = action.target2 !== undefined ? Number(action.target2) : undefined;

      // 掘墓人：从弃牌堆拿牌（打出/保留/跳过）
      if (card.id === 'trick-gravedigger') {
        const mode = String(action.mode ?? 'skip');
        if (mode === 'skip') {
          s.night.current = null;
          s.night.idx += 1;
          advanceNight(s, events);
          return null;
        }
        const pick = String(action.pick ?? '');
        const i = s.discardPile.indexOf(pick);
        if (i < 0) return { ok: false, reason: '该牌不在弃牌堆中' };
        s.discardPile.splice(i, 1);
        events.push(ev('non:graveTaken', { seat, cardId: parseInst(pick).id, mode }));
        if (mode === 'keep') {
          p.hand.push(pick);
          s.night.current = null;
          s.night.idx += 1;
          advanceNight(s, events);
          return null;
        }
        if (mode === 'play') {
          const taken = cardOf(pick);
          if (taken.targetKind === 'none') return { ok: false, reason: '该牌无法立即打出，只能收下' };
          // 立即打出需要选择的牌：当前结算切换为那张牌
          p.resolvedCard = pick;
          s.night.current = { seat, card: pick };
          events.push(ev('non:resolving', { seat, cardId: parseInst(pick).id }));
          return null;
        }
        return { ok: false, reason: '未知的掘墓人选项' };
      }

      // 忍者：先选窥视目标，杀/放由 non:choose 决定（实体规则「先看后选」）
      if (card.shinobiStyle) {
        if (s.night.current.lockedTarget !== undefined) return { ok: false, reason: '已看过目标，请选择杀或放' };
        if (target === undefined || !Number.isInteger(target)) return { ok: false, reason: '缺少目标' };
        const t = s.players[target];
        if (!t || t.seat === seat || !t.alive) return { ok: false, reason: '目标无效' };
        events.push(ev('non:peek', { target: t.seat, house: t.identity.house, rank: t.identity.rank }, [seat]));
        s.night.current.lockedTarget = target;
        return null;
      }

      const choice = action.choice !== undefined ? String(action.choice) : undefined;
      // 盗贼：可跳过
      if (card.id === 'trick-thief' && choice === 'skip') {
        events.push(ev('non:thiefSkip', { seat }));
        s.night.current = null;
        s.night.idx += 1;
        advanceNight(s, events);
        return null;
      }
      if (card.targetKind === 'anyAliveOther' || card.targetKind === 'variants') {
        if (target === undefined || !Number.isInteger(target)) return { ok: false, reason: '缺少目标' };
        const t = s.players[target];
        if (!t || t.seat === seat || !t.alive) return { ok: false, reason: '目标无效' };
        if (card.id === 'trick-thief' && t.tokens.length <= p.tokens.length)
          return { ok: false, reason: '只能对代币数多于你的玩家出手' };
        if (card.id === 'trick-spirit-merchant' && !['house', 'token', 'swap'].includes(choice ?? ''))
          return { ok: false, reason: '需要选择查看身份/看代币/交换' };
        if (card.id === 'trick-troublemaker' && !['peek', 'reveal'].includes(choice ?? ''))
          return { ok: false, reason: '需要选择只看或公开' };
      }
      if (card.targetKind === 'anyTwoAlive') {
        if (target === undefined || !Number.isInteger(target)) return { ok: false, reason: '缺少目标' };
        if (target2 === undefined || !Number.isInteger(target2) || target2 === target)
          return { ok: false, reason: '需要两个不同目标' };
        if (!s.players[target2]?.alive || !s.players[target]?.alive) return { ok: false, reason: '目标无效' };
      }
      applyEffect(s, seat, cardId, { target, target2, choice }, events);
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

/** 夜晚当前结算者的全部合法选择（供 legalActions 与 advanceNight 死锁检测共用） */
function nightChoices(state: NonState, seat: number): ActionChoice[] {
  const cur = state.night?.current;
  if (!cur || cur.seat !== seat) return [];
  const card = cardOf(cur.card);
  const others = aliveOthers(state, seat);
  const mk = (action: Record<string, unknown>, label: string, prompt: string): ActionChoice => ({
    action: { type: 'non:resolve', ...action } as ActionChoice['action'],
    ui: {
      kind: 'button' as const,
      label,
      targetSeats: action.target !== undefined ? [Number(action.target)] : undefined,
      prompt,
    },
  });
  if (card.shinobiStyle) {
    const locked = cur.lockedTarget;
    if (locked !== undefined) {
      const name = state.players[locked]?.nickname ?? String(locked);
      return [
        { action: { type: 'non:choose', choice: 'kill' }, ui: { kind: 'button', label: '忍者·杀', prompt: `杀死 ${name}` } },
        { action: { type: 'non:choose', choice: 'spare' }, ui: { kind: 'button', label: '忍者·放', prompt: `放过 ${name}` } },
      ];
    }
    return others.map((t) => mk({ target: t }, '窥视', `查看 ${state.players[t].nickname} 的身份，再决定杀或放`));
  }
  switch (card.id) {
    case 'spy':
      return others.map((t) => mk({ target: t }, '间谍', `查看 ${state.players[t].nickname} 的身份`));
    case 'mystic':
      return others.map((t) => mk({ target: t }, '通灵', `查看 ${state.players[t].nickname} 的身份与打出的牌`));
    case 'trick-troublemaker':
      return others.flatMap((t) => [
        mk({ target: t, choice: 'peek' }, '只看', `偷看 ${state.players[t].nickname} 的身份`),
        mk({ target: t, choice: 'reveal' }, '公开', `查看并公开 ${state.players[t].nickname} 的身份`),
      ]);
    case 'trick-spirit-merchant':
      return others.flatMap((t) => [
        mk({ target: t, choice: 'house' }, '看身份', `查看 ${state.players[t].nickname} 的身份`),
        mk({ target: t, choice: 'token' }, '看代币', `偷看 ${state.players[t].nickname} 的一枚代币面值`),
        mk({ target: t, choice: 'swap' }, '换代币', `与 ${state.players[t].nickname} 交换一枚代币`),
      ]);
    case 'trick-thief': {
      const rich = state.players.filter((q) => q.alive && q.seat !== seat && q.tokens.length > state.players[seat].tokens.length);
      const out = rich.map((q) => mk({ target: q.seat }, '偷', `从代币更多的 ${q.nickname} 处拿一枚`));
      out.push({
        action: { type: 'non:resolve', choice: 'skip' },
        ui: { kind: 'button', label: '跳过', prompt: '不偷任何人' },
      });
      return out;
    }
    case 'trick-judge':
      return others.map((t) => mk({ target: t }, '审判', `杀死 ${state.players[t].nickname}（无视镜僧/殉道者）`));
    case 'blind-assassin':
      return others.map((t) => mk({ target: t }, '刺杀', `杀死 ${state.players[t].nickname}`));
    case 'trick-shapeshifter': {
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
              label: '易容',
              targetSeats: [a, b],
              prompt: `查看并秘密交换 ${state.players[a].nickname} 与 ${state.players[b].nickname} 的身份`,
            },
          });
        }
      return out;
    }
    case 'trick-gravedigger': {
      // 无目标类牌（反应/被动）只能收下，不能「立即打出」
      const out: ActionChoice[] = state.discardPile
        .filter((d) => cardOf(d).targetKind !== 'none')
        .map((d): ActionChoice[] => [
          {
            action: { type: 'non:resolve', pick: d, mode: 'play' },
            ui: { kind: 'button', label: `打出·${CARDS[parseInst(d).id].name}`, prompt: `立即打出弃牌 ${CARDS[parseInst(d).id].name}` },
          },
          {
            action: { type: 'non:resolve', pick: d, mode: 'keep' },
            ui: { kind: 'button', label: `收下·${CARDS[parseInst(d).id].name}`, prompt: `将 ${CARDS[parseInst(d).id].name} 收入手牌` },
          },
        ])
        .flat();
      const keepOnly = state.discardPile.filter((d) => cardOf(d).targetKind === 'none');
      for (const d of keepOnly) {
        out.push({
          action: { type: 'non:resolve', pick: d, mode: 'keep' },
          ui: { kind: 'button', label: `收下·${CARDS[parseInst(d).id].name}`, prompt: `将 ${CARDS[parseInst(d).id].name} 收入手牌` },
        });
      }
      out.push({
        action: { type: 'non:resolve', mode: 'skip' },
        ui: { kind: 'button', label: '跳过', prompt: '不拿弃牌' },
      });
      return out;
    }
    default:
      return [];
  }
}

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
        identityKnown: true,
        draftPool: [],
        hand: [],
        committed: null,
        tokens: [],
        alive: true,
        resolvedCard: null,
        killedBy: null,
        exposed: false,
      })),
      picked: [],
      discardPile: [],
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
      case 'night':
        return nightChoices(state, seat);
      default:
        return [];
    }
  },

  clientView(state: NonState, seat: number): NonView {
    const me = state.players[seat];
    const inReveal = state.phase === 'roundEnd' || state.phase === 'gameEnd';
    const isGravedigger =
      state.phase === 'night' &&
      state.night?.current?.seat === seat &&
      cardOf(state.night.current.card).id === 'trick-gravedigger';
    const players: NonViewPlayer[] = state.players.map((p) => ({
      seat: p.seat,
      nickname: p.nickname,
      isBot: p.isBot,
      alive: p.alive,
      hasCommitted: p.committed !== null,
      resolvedCard: p.resolvedCard,
      negated: state.night?.negated.includes(p.seat) ?? false,
      handCount: p.hand.length,
      tokenCount: p.tokens.length,
      exposedIdentity: p.exposed ? p.identity : null,
      revealedIdentity: inReveal && (p.alive || state.phase === 'gameEnd') ? p.identity : null,
    }));
    return {
      phase: state.phase,
      round: state.round,
      targetHonor: state.targetHonor,
      you: {
        seat,
        identity: me.identityKnown ? me.identity : null,
        identityKnown: me.identityKnown,
        honor: sumTokens(me),
        tokens: [...me.tokens],
        alive: me.alive,
        hand: [...me.hand],
        committed: me.committed,
        draftPool: [...me.draftPool],
        picked: state.picked.includes(seat),
      },
      players,
      draft:
        state.phase === 'draft1' || state.phase === 'draft2'
          ? { pickNumber: state.phase === 'draft1' ? 1 : 2, doneCount: state.picked.length, total: state.players.length }
          : null,
      nightInfo: state.night
        ? {
            currentSeat: state.night.current?.seat ?? null,
            currentCardId: state.night.current ? parseInst(state.night.current.card).id : null,
            lockedTarget: state.night.current?.lockedTarget ?? null,
            resolvedCount: state.night.idx,
            total: state.night.order.length,
          }
        : null,
      discardPile: isGravedigger ? [...state.discardPile] : [],
      discardVisible: isGravedigger,
      roundResult: state.roundResult,
      winners: state.winners,
      standings:
        state.phase === 'gameEnd'
          ? state.players.map((p) => ({ seat: p.seat, nickname: p.nickname, honor: sumTokens(p), identity: p.identity }))
          : null,
    };
  },
};
