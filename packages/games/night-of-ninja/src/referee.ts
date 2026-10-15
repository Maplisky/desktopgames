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

/** 夜晚五个类型阶段（角标 1-6 为同阶段内的结算顺序） */
const NIGHT_PHASES = [1, 2, 3, 4, 5] as const;
const PHASE_LABEL: Record<number, string> = {
  1: '间谍阶段',
  2: '通灵阶段',
  3: '诡术阶段',
  4: '盲眼刺客阶段',
  5: '忍者阶段',
};

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
    p.killedBy = null;
    p.exposed = false;
    p.hand = [];
    p.played = [];
    p.draftPool = deck.slice(i * 3, i * 3 + 3);
    events.push(ev('non:identityDealt', { house: p.identity.house, rank: p.identity.rank }, [p.seat]));
    events.push(ev('non:dealt', { seat: p.seat, count: 3 }));
  });
}

/* ================= 夜晚状态机（逐阶段叫名，从手牌决定亮牌） ================= */

function enterNight(s: NonState, events: GameEvent[]) {
  s.phase = 'night';
  s.night = { phaseIdx: 0, window: null, queue: [], qIdx: 0, current: null, pendingKill: null };
  events.push(ev('non:nightStart', {}));
  openWindow(s, events);
}

function openWindow(s: NonState, events: GameEvent[]) {
  const night = s.night!;
  if (night.phaseIdx >= NIGHT_PHASES.length) {
    computeRoundEnd(s, events);
    return;
  }
  const phase = NIGHT_PHASES[night.phaseIdx];
  events.push(ev('non:phaseCall', { phase, label: PHASE_LABEL[phase] }));
  const holders = s.players.filter((p) => p.alive && p.hand.some((c) => cardOf(c).phase === phase)).map((p) => p.seat);
  if (holders.length === 0) {
    events.push(ev('non:phaseSkip', { phase, reason: 'no-holders' }));
    night.phaseIdx += 1;
    openWindow(s, events);
    return;
  }
  night.window = { phase, holders, played: [], passed: [] };
}

/** 窗口关闭：把已亮出的牌按角标升序（同角标按座位）排成结算队列 */
function closeWindow(s: NonState, events: GameEvent[]) {
  const night = s.night!;
  const w = night.window!;
  night.queue = [...w.played].sort(
    (a, b) => parseInst(a.card).number - parseInst(b.card).number || a.seat - b.seat,
  );
  night.window = null;
  night.qIdx = 0;
  resolveNext(s, events);
}

/** 推进结算队列；牌主已死则作废；需要选择但无合法选择则跳过（防死锁） */
function resolveNext(s: NonState, events: GameEvent[]) {
  const night = s.night!;
  while (night.qIdx < night.queue.length) {
    const entry = night.queue[night.qIdx];
    const p = s.players[entry.seat];
    if (!p.alive) {
      events.push(ev('non:nightSkip', { seat: entry.seat, reason: 'dead' }));
      night.qIdx += 1;
      continue;
    }
    night.current = { seat: entry.seat, card: entry.card };
    // 掘墓人：官方规则「查看两张弃置的忍者牌」——结算开始时预抽至多两张
    if (cardOf(entry.card).id === 'trick-gravedigger' && s.discardPile.length > 0) {
      const pool = shuffled(s, s.discardPile);
      night.current.graveLook = pool.slice(0, 2);
    }
    events.push(ev('non:resolving', { seat: entry.seat, cardId: parseInst(entry.card).id }));
    if (nightChoices(s, entry.seat).length === 0) {
      night.current = null;
      night.qIdx += 1;
      events.push(ev('non:nightSkip', { seat: entry.seat, reason: 'no-targets' }));
      continue;
    }
    return; // 等待该玩家选择
  }
  // 队列结算完毕 → 下一阶段
  night.phaseIdx += 1;
  openWindow(s, events);
}

function applyEffect(
  s: NonState,
  seat: number,
  cardId: string,
  args: { target?: number; target2?: number; choice?: string; pick?: string; mode?: string; giveIdx?: number },
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
      // 打出的牌本就公开，通灵者看的是目标「手中」的一张忍者牌（随机抽看）
      const hand = target!.hand;
      const other = hand.length > 0 ? hand[Math.floor(rngStep(s) * hand.length)] : null;
      events.push(
        ev(
          'non:peek',
          { target: target!.seat, house: target!.identity.house, rank: target!.identity.rank, otherCard: other },
          [seat],
        ),
      );
      break;
    }
    case 'trick-shapeshifter': {
      // 交换两个目标之间的身份（可包含易容师本人）；秘密交换，被换者不知新身份
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
      if (a.seat !== seat) a.identityKnown = false;
      if (b.seat !== seat) b.identityKnown = false;
      break;
    }
    case 'trick-gravedigger':
      // 在 act 的 non:resolve 分支处理（选择弃牌 + 打出/保留）
      break;
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
          // 官方 FAQ：任选自己一枚给出（面值仅自己可见，可挑着给），换对方随机一枚
          const gi = Math.min(Math.max(0, args.giveIdx ?? 0), me.tokens.length - 1);
          const mv = me.tokens.splice(gi, 1)[0];
          const ti = Math.floor(rngStep(s) * target!.tokens.length);
          const tv = target!.tokens.splice(ti, 1)[0];
          me.tokens.push(tv);
          target!.tokens.push(mv);
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
      if (target) killNow(s, events, seat, target.seat, true); // 审判官无视镜僧/殉道者
      break;
    }
    case 'blind-assassin':
      announceKill(s, events, seat, target!.seat);
      break;
    default:
      throw new Error(`unknown card ${id}`);
  }
}

/** 宣告刺杀：进入待反应状态，目标可从手牌打出镜僧/殉道者 */
function announceKill(s: NonState, events: GameEvent[], attacker: number, targetSeat: number) {
  const t = s.players[targetSeat];
  if (!t.alive) return;
  events.push(ev('non:killPending', { attacker, target: targetSeat }));
  s.night!.pendingKill = { attacker, target: targetSeat };
}

/** 无视反应的直接击杀（审判官） */
function killNow(s: NonState, events: GameEvent[], attacker: number, targetSeat: number, _bypass: boolean) {
  const t = s.players[targetSeat];
  if (!t.alive) return;
  events.push(ev('non:judged', { target: targetSeat }));
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
  s.night = null;
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

  // 主谋：计分时从手牌揭示——存活者持主谋则其家系获胜；浪人主谋 → 无家系获胜
  const livingMasterminds = s.players.filter((p) => p.alive && p.hand.includes('mastermind'));
  let winner: RoundResult['winner'];
  let mastermindSeat: number | null = null;
  let roninMastermindOnly = false;
  const mmHouses = new Set(livingMasterminds.map((p) => p.identity.house).filter((h) => h !== 'ronin'));
  const roninMM = livingMasterminds.some((p) => p.identity.house === 'ronin');
  if (mmHouses.size === 1) {
    winner = [...mmHouses][0] as 'crane' | 'lotus';
    mastermindSeat = livingMasterminds.find((p) => p.identity.house === winner)?.seat ?? null;
  } else if (mmHouses.size === 0 && roninMM) {
    winner = 'none';
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
  for (const p of livingMasterminds) {
    events.push(ev('non:mastermindRevealed', { seat: p.seat }));
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
      for (const p of s.players) {
        for (const c of p.draftPool) s.discardPile.push(c);
        p.draftPool = [];
      }
      events.push(ev('non:draftDone', { discards: s.discardPile.length }));
      enterNight(s, events);
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

/** 夜晚结算者的目标选择等（供 legalActions 与死锁检测共用） */
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
      return others.map((t) => mk({ target: t }, '通灵', `查看 ${state.players[t].nickname} 的身份与手中一张牌`));
    case 'trick-troublemaker':
      return others.flatMap((t) => [
        mk({ target: t, choice: 'peek' }, '只看', `偷看 ${state.players[t].nickname} 的身份`),
        mk({ target: t, choice: 'reveal' }, '公开', `查看并公开 ${state.players[t].nickname} 的身份`),
      ]);
    case 'trick-spirit-merchant': {
      const me2 = state.players[seat];
      return others.flatMap((t) => {
        const tp = state.players[t];
        const opts = [mk({ target: t, choice: 'house' }, '看身份', `查看 ${tp.nickname} 的身份`)];
        if (tp.tokens.length > 0)
          opts.push(mk({ target: t, choice: 'token' }, '看代币', `偷看 ${tp.nickname} 的一枚代币面值`));
        // 官方 FAQ：任选自己一枚给出（面值仅自己可见）
        if (tp.tokens.length > 0 && me2.tokens.length > 0)
          for (let i = 0; i < me2.tokens.length; i++)
            opts.push(
              mk({ target: t, choice: 'swap', giveIdx: i }, `换·给第 ${i + 1} 枚`, `把自己第 ${i + 1} 枚代币与 ${tp.nickname} 随机一枚交换`),
            );
        return opts;
      });
    }
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
      // 官方：只看两张（结算开始时已抽定 graveLook）
      const look = cur.graveLook ?? [];
      const out: ActionChoice[] = look
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
      for (const d of look.filter((d) => cardOf(d).targetKind === 'none')) {
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

/** 待反应目标的选择：从手牌打出镜僧/殉道者，或承受 */
function reactChoices(state: NonState, seat: number): ActionChoice[] {
  const pk = state.night?.pendingKill;
  if (!pk || pk.target !== seat) return [];
  const out: ActionChoice[] = [];
  for (const c of state.players[seat].hand) {
    const id = parseInst(c).id;
    if (id === 'mirror-monk') {
      out.push({
        action: { type: 'non:react', cardId: c },
        ui: { kind: 'card', cardId: c, label: '镜僧·反弹', prompt: '打出镜僧：刺杀者反而立刻死亡' },
      });
    } else if (id === 'martyr') {
      out.push({
        action: { type: 'non:react', cardId: c },
        ui: { kind: 'card', cardId: c, label: '殉道者·得币', prompt: '打出殉道者：获得一枚荣誉代币并存活' },
      });
    }
  }
  out.push({
    action: { type: 'non:noReact' },
    ui: { kind: 'button', label: '承受', prompt: '不打出反应牌，接受死亡' },
  });
  return out;
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
    case 'non:phasePlay': {
      // 夜晚阶段窗口：从手牌亮出一张本阶段牌（打出即公开）
      const night = s.night;
      const w = night?.window;
      if (s.phase !== 'night' || !w) return { ok: false, reason: '不在阶段抉择窗口' };
      if (!w.holders.includes(seat)) return { ok: false, reason: '你没有本阶段的牌' };
      if (w.played.some((e) => e.seat === seat) || w.passed.includes(seat))
        return { ok: false, reason: '你已做出本阶段决定' };
      const cardId = String(action.cardId ?? '');
      if (!p.hand.includes(cardId)) return { ok: false, reason: '该牌不在你手中' };
      if (cardOf(cardId).phase !== w.phase) return { ok: false, reason: '该牌不属于当前阶段' };
      p.hand.splice(p.hand.indexOf(cardId), 1);
      p.played.push(cardId);
      w.played.push({ seat, card: cardId });
      events.push(ev('non:played', { seat, cardId: parseInst(cardId).id, number: parseInst(cardId).number }));
      if (w.played.length + w.passed.length >= w.holders.length) closeWindow(s, events);
      return null;
    }
    case 'non:phasePass': {
      const night = s.night;
      const w = night?.window;
      if (s.phase !== 'night' || !w) return { ok: false, reason: '不在阶段抉择窗口' };
      if (!w.holders.includes(seat)) return { ok: false, reason: '你没有本阶段的牌' };
      if (w.played.some((e) => e.seat === seat) || w.passed.includes(seat))
        return { ok: false, reason: '你已做出本阶段决定' };
      w.passed.push(seat);
      events.push(ev('non:passed', { seat }));
      if (w.played.length + w.passed.length >= w.holders.length) closeWindow(s, events);
      return null;
    }
    case 'non:react': {
      const pk = s.night?.pendingKill;
      if (!pk) return { ok: false, reason: '当前没有待反应的刺杀' };
      if (pk.target !== seat) return { ok: false, reason: '你不是被刺杀的目标' };
      const cardId = String(action.cardId ?? '');
      if (!p.hand.includes(cardId)) return { ok: false, reason: '该牌不在你手中' };
      const id = parseInst(cardId).id;
      if (id !== 'mirror-monk' && id !== 'martyr') return { ok: false, reason: '只能打出镜僧或殉道者' };
      p.hand.splice(p.hand.indexOf(cardId), 1);
      p.played.push(cardId);
      events.push(ev('non:played', { seat, cardId: id, number: 0 }));
      if (id === 'mirror-monk') {
        const a = s.players[pk.attacker];
        if (a.alive) {
          a.alive = false;
          a.killedBy = seat;
          events.push(ev('non:reflected', { by: seat, attacker: pk.attacker }));
          events.push(ev('non:death', { seat: pk.attacker }));
        }
      } else {
        drawToken(s, p, events);
        events.push(ev('non:martyred', { seat }));
      }
      s.night!.pendingKill = null;
      s.night!.qIdx += 1;
      resolveNext(s, events);
      return null;
    }
    case 'non:noReact': {
      const pk = s.night?.pendingKill;
      if (!pk) return { ok: false, reason: '当前没有待反应的刺杀' };
      if (pk.target !== seat) return { ok: false, reason: '你不是被刺杀的目标' };
      const t = s.players[pk.target];
      t.alive = false;
      t.killedBy = pk.attacker;
      events.push(ev('non:death', { seat: pk.target }));
      s.night!.pendingKill = null;
      s.night!.qIdx += 1;
      resolveNext(s, events);
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
      if (action.choice === 'kill') {
        announceKill(s, events, seat, locked);
        if (s.night!.pendingKill) return null; // 等待目标反应
      } else {
        events.push(ev('non:spared', { seat: locked }));
      }
      s.night.current = null;
      s.night.qIdx += 1;
      resolveNext(s, events);
      return null;
    }
    case 'non:resolve': {
      if (s.phase !== 'night' || !s.night?.current) return { ok: false, reason: '当前无需结算选择' };
      if (s.night.current.seat !== seat) return { ok: false, reason: '没轮到你结算' };
      const cardId = s.night.current.card;
      const card = cardOf(cardId);
      const target = action.target !== undefined ? Number(action.target) : undefined;
      const target2 = action.target2 !== undefined ? Number(action.target2) : undefined;

      if (card.id === 'trick-gravedigger') {
        const mode = String(action.mode ?? 'skip');
        if (mode === 'skip') {
          s.night.current = null;
          s.night.qIdx += 1;
          resolveNext(s, events);
          return null;
        }
        const pick = String(action.pick ?? '');
        const look = s.night.current.graveLook ?? [];
        if (!look.includes(pick) || !s.discardPile.includes(pick))
          return { ok: false, reason: '只能拿取你查看过的两张弃牌' };
        s.discardPile.splice(s.discardPile.indexOf(pick), 1);
        if (mode === 'keep') {
          events.push(ev('non:graveTaken', { seat, mode }));
          events.push(ev('non:graveTaken', { seat, mode, cardId: parseInst(pick).id }, [seat]));
          p.hand.push(pick);
          s.night.current = null;
          s.night.qIdx += 1;
          resolveNext(s, events);
          return null;
        }
        if (mode === 'play') {
          const taken = cardOf(pick);
          if (taken.targetKind === 'none') return { ok: false, reason: '该牌无法立即打出，只能收下' };
          events.push(ev('non:graveTaken', { seat, mode, cardId: parseInst(pick).id }));
          p.played.push(pick);
          s.night.current = { seat, card: pick };
          events.push(ev('non:resolving', { seat, cardId: parseInst(pick).id }));
          return null;
        }
        return { ok: false, reason: '未知的掘墓人选项' };
      }

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
      if (card.id === 'trick-thief' && choice === 'skip') {
        events.push(ev('non:thiefSkip', { seat }));
        s.night.current = null;
        s.night.qIdx += 1;
        resolveNext(s, events);
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
        if (card.id === 'trick-spirit-merchant' && choice === 'swap' && (p.tokens.length === 0 || t.tokens.length === 0))
          return { ok: false, reason: '双方都需持有代币才能交换' };
        if (card.id === 'trick-troublemaker' && !['peek', 'reveal'].includes(choice ?? ''))
          return { ok: false, reason: '需要选择只看或公开' };
      }
      if (card.targetKind === 'anyTwoAlive') {
        if (target === undefined || !Number.isInteger(target)) return { ok: false, reason: '缺少目标' };
        if (target2 === undefined || !Number.isInteger(target2) || target2 === target)
          return { ok: false, reason: '需要两个不同目标' };
        if (!s.players[target2]?.alive || !s.players[target]?.alive) return { ok: false, reason: '目标无效' };
      }
      applyEffect(s, seat, cardId, { target, target2, choice, giveIdx: action.giveIdx !== undefined ? Number(action.giveIdx) : undefined }, events);
      if (s.night.pendingKill) return null; // 刺杀宣告，等待目标反应
      s.night.current = null;
      s.night.qIdx += 1;
      resolveNext(s, events);
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
        identityKnown: true,
        draftPool: [],
        hand: [],
        tokens: [],
        played: [],
        alive: true,
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
      case 'night': {
        const n = state.night!;
        let active: number[] = [];
        if (n.pendingKill) {
          // 待反应优先：此刻只有被刺杀者需要决定（current 尚未清除）
          active = [n.pendingKill.target];
        } else if (n.window) {
          const chosen = new Set([...n.window.played.map((e) => e.seat), ...n.window.passed]);
          active = n.window.holders.filter((seat) => !chosen.has(seat));
        } else if (n.current) {
          active = [n.current.seat];
        }
        const label = n.window
          ? `忍者之夜 · ${PHASE_LABEL[NIGHT_PHASES[n.phaseIdx]]}`
          : n.pendingKill
            ? '忍者之夜 · 生死抉择'
            : '忍者之夜 · 结算';
        return {
          id: 'night',
          label,
          activeSeats: active,
          timerMs: active.length > 0 ? (n.pendingKill ? 20_000 : 30_000) : undefined,
        };
      }
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
    // 垫步优先：被刺杀时有反应牌则打出（几乎总是更优）；窗口保留；可跳过则跳过；可放过则放过
    const react = choices.find((c) => c.action.type === 'non:react');
    const pass = choices.find((c) => c.action.type === 'non:phasePass');
    const skip = choices.find((c) => c.action.choice === 'skip' || c.action.mode === 'skip');
    const spare = choices.find((c) => c.action.choice === 'spare');
    return this.applyAction(state, seat, (react ?? pass ?? skip ?? spare ?? choices[0]).action);
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
      case 'night': {
        const n = state.night!;
        if (n.pendingKill) return reactChoices(state, seat);
        if (n.window) {
          if (!n.window.holders.includes(seat)) return [];
          const chosen = n.window.played.some((e) => e.seat === seat) || n.window.passed.includes(seat);
          if (chosen) return [];
          const out: ActionChoice[] = p.hand
            .filter((c) => cardOf(c).phase === n.window!.phase)
            .map((cardId) => ({
              action: { type: 'non:phasePlay', cardId },
              ui: { kind: 'card' as const, cardId, label: '打出' },
            }));
          out.push({
            action: { type: 'non:phasePass' },
            ui: { kind: 'button', label: '保留', prompt: '本阶段不打出（此牌本夜不再有机会）' },
          });
          return out;
        }
        return nightChoices(state, seat);
      }
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
      played: [...p.played],
      handCount: p.hand.length,
      tokenCount: p.tokens.length,
      exposedIdentity: p.exposed ? p.identity : null,
      revealedIdentity: inReveal && (p.alive || state.phase === 'gameEnd') ? p.identity : null,
    }));
    const n = state.night;
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
        played: [...me.played],
        draftPool: [...me.draftPool],
        picked: state.picked.includes(seat),
      },
      players,
      draft:
        state.phase === 'draft1' || state.phase === 'draft2'
          ? { pickNumber: state.phase === 'draft1' ? 1 : 2, doneCount: state.picked.length, total: state.players.length }
          : null,
      nightInfo: n
        ? {
            phaseId: NIGHT_PHASES[n.phaseIdx] ?? 5,
            phaseLabel: PHASE_LABEL[NIGHT_PHASES[n.phaseIdx] ?? 5] ?? '',
            myWindowPending:
              !!n.window && n.window.holders.includes(seat) && !n.window.played.some((e) => e.seat === seat) && !n.window.passed.includes(seat),
            holdersTotal: n.window?.holders.length ?? 0,
            chosenCount: (n.window?.played.length ?? 0) + (n.window?.passed.length ?? 0),
            windowPlayed: (n.window?.played ?? []).map((e) => ({ seat: e.seat, cardId: parseInst(e.card).id })),
            currentSeat: n.current?.seat ?? null,
            currentCardId: n.current ? parseInst(n.current.card).id : null,
            lockedTarget: n.current?.lockedTarget ?? null,
            killPending: n.pendingKill ? { ...n.pendingKill } : null,
            resolvedCount: n.qIdx,
            total: n.queue.length,
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
