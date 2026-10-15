import { mulberry32, type GameDefinition, type GameEvent } from '@dg/games-core';
import { nightOfNinja } from '../src/referee';
import type { NonState, NonView, NonViewPlayer } from '../src/types';

const def = nightOfNinja as GameDefinition<NonState>;

/**
 * 视图泄露测试（DESIGN §5.4 / §9.2）：
 * 1. 任何座位的视图中，其他玩家的序列化结果不得包含隐藏字段；
 * 2. 携带身份信息的事件必须有 audience 定向，或在公开白名单内。
 */

/** 其他玩家视图允许出现的键（不含任何隐藏信息） */
const ALLOWED_PLAYER_KEYS: (keyof NonViewPlayer)[] = [
  'seat',
  'nickname',
  'isBot',
  'alive',
  'hasCommitted',
  'resolvedCard',
  'negated',
  'handCount',
  'exposedIdentity',
  'revealedIdentity',
];

/** 允许在 payload 中携带 house/rank 的公开事件类型 */
const PUBLIC_IDENTITY_EVENTS = new Set([
  'non:exposed', // 诡术师主动公开
  'non:reveal', // 回合结束幸存者揭示
  'non:gameEnd', // 终局摊牌
]);

const HIDDEN_KEYS = ['identity', 'hand', 'committed', 'honor', 'draftPool', 'monkUsed', 'sessionId'];

function makeSeats(n: number) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, sessionId: `s${i}`, nickname: `P${i}`, isBot: false }));
}

describe('视图泄露防护', () => {
  for (const n of [3, 4, 6]) {
    it(`n=${n} 全流程任意视角不泄露隐藏信息`, () => {
      const rand = mulberry32(n * 31 + 7);
      let s = def.setup(makeSeats(n), { targetHonor: 10 }, mulberry32(n));
      const allEvents: GameEvent[] = [];
      const collect = (evs: GameEvent[]) => {
        for (const e of evs) allEvents.push(e);
      };
      let guard = 0;
      while (!def.isFinished(s) && guard++ < 30000) {
        const pi = def.phaseInfo(s);
        if (pi.activeSeats.length === 0) {
          const r = def.auto(s);
          if (!r.ok) throw new Error(r.reason);
          s = r.state;
          collect(r.events);
        } else {
          for (const seat of [...pi.activeSeats]) {
            const choices = def.legalActions(s, seat);
            const r = def.applyAction(s, seat, choices[rand.int(choices.length)].action);
            if (!r.ok) throw new Error(r.reason);
            s = r.state;
            collect(r.events);
          }
        }
        // 每步都检查所有座位视角
        for (const seat of s.players.map((p) => p.seat)) {
          const view = def.clientView(s, seat) as NonView;
          expect(view.you.seat).toBe(seat);
          for (const p of view.players) {
            if (p.seat === seat) continue;
            const keys = Object.keys(p);
            for (const k of keys) expect(ALLOWED_PLAYER_KEYS).toContain(k);
            const raw = JSON.stringify(p);
            for (const hk of HIDDEN_KEYS) expect(raw).not.toContain(`"${hk}"`);
            // 未揭示/未被公开的身份必须为 null
            if (view.phase !== 'roundEnd' && view.phase !== 'gameEnd') {
              expect(p.revealedIdentity).toBeNull();
            }
          }
        }
      }
      // 事件定向检查：携带身份的事件要么有 audience，要么在白名单
      for (const e of allEvents) {
        if (e.payload && ('house' in e.payload || 'rank' in e.payload)) {
          const directed = e.audience && e.audience.length > 0;
          expect(directed || PUBLIC_IDENTITY_EVENTS.has(e.type)).toBe(true);
        }
      }
    });
  }
});
