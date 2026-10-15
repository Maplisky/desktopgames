/**
 * 忍者之夜（Night of the Ninja, Brotherwise Games）卡牌数据表。
 *
 * 结构（阶段顺序、类型划分、确认出现的卡名）来自官方规则书与多篇评测的交叉确认：
 *   1 间谍 → 2 通灵者 → 3 诡术师 → 4 盲眼刺客 → 5 忍者 → 6 特殊（反应/决胜）
 * 标记 provisional: true 的条目为「效果已按公开资料合理重建，数值/措辞待对照实体规则书微调」，
 * 见 docs/rules-night-of-ninja.md 的核对清单。
 */

export type TargetKind = 'none' | 'anyAliveOther' | 'anyTwoAlive';

export interface CardDef {
  id: string;
  /** 结算阶段 1-6 */
  phase: number;
  name: string;
  nameEn: string;
  /** 卡面汉字，灰盒/主题共用 */
  glyph: string;
  desc: string;
  /** 结算时是否需要玩家选择目标/执行方式 */
  targetKind: TargetKind;
  /** 双目标（家牌调换） */
  twoTargets?: boolean;
  /** 忍者（先看后选杀/放） */
  shinobiStyle?: boolean;
  tag: 'info' | 'trickster' | 'kill' | 'reaction' | 'kicker';
  provisional?: boolean;
}

const c = (d: CardDef) => d;

export const CARDS: Record<string, CardDef> = {
  spy: c({
    id: 'spy', phase: 1, name: '间谍', nameEn: 'Spy', glyph: '谍',
    desc: '查看任意一名玩家的身份牌（家系与排名）。',
    targetKind: 'anyAliveOther', tag: 'info',
  }),
  mystic: c({
    id: 'mystic', phase: 2, name: '通灵者', nameEn: 'Mystic', glyph: '灵',
    desc: '查看任意一名玩家的身份牌与其未打出的忍者牌。',
    targetKind: 'anyAliveOther', tag: 'info',
  }),
  'trick-swap': c({
    id: 'trick-swap', phase: 3, name: '家牌调换', nameEn: 'Trickster: Swap', glyph: '换',
    desc: '交换任意两名玩家的身份牌。',
    targetKind: 'anyTwoAlive', twoTargets: true, tag: 'trickster', provisional: true,
  }),
  'trick-expose': c({
    id: 'trick-expose', phase: 3, name: '真相揭露', nameEn: 'Trickster: Expose', glyph: '曝',
    desc: '公开任意一名玩家的身份牌。',
    targetKind: 'anyAliveOther', tag: 'trickster', provisional: true,
  }),
  'trick-exchange': c({
    id: 'trick-exchange', phase: 3, name: '偷天换日', nameEn: 'Trickster: Exchange', glyph: '夺',
    desc: '与任意一名玩家交换手中未打出的忍者牌。',
    targetKind: 'anyAliveOther', tag: 'trickster', provisional: true,
  }),
  'trick-peek': c({
    id: 'trick-peek', phase: 3, name: '窥魂之瞳', nameEn: 'Trickster: Peek', glyph: '瞳',
    desc: '查看任意一名玩家的身份牌与其未打出的忍者牌。',
    targetKind: 'anyAliveOther', tag: 'trickster', provisional: true,
  }),
  'trick-disguise': c({
    id: 'trick-disguise', phase: 3, name: '金蝉脱壳', nameEn: 'Trickster: Disguise', glyph: '蝉',
    desc: '弃置当前身份，从身份牌堆随机获得一张新身份。',
    targetKind: 'none', tag: 'trickster', provisional: true,
  }),
  'trick-silence': c({
    id: 'trick-silence', phase: 3, name: '封印之印', nameEn: 'Trickster: Silence', glyph: '封',
    desc: '使任意一名玩家本回合的卡牌效果无效（包括反应与被动）。',
    targetKind: 'anyAliveOther', tag: 'trickster', provisional: true,
  }),
  'blind-assassin': c({
    id: 'blind-assassin', phase: 4, name: '盲眼刺客', nameEn: 'Blind Assassin', glyph: '杀',
    desc: '杀死任意一名玩家。',
    targetKind: 'anyAliveOther', tag: 'kill', provisional: true,
  }),
  shinobi: c({
    id: 'shinobi', phase: 5, name: '忍者', nameEn: 'Shinobi', glyph: '忍',
    desc: '查看任意一名玩家的身份牌，然后选择杀死或放过对方。',
    targetKind: 'anyAliveOther', shinobiStyle: true, tag: 'kill', provisional: true,
  }),
  'mirror-monk': c({
    id: 'mirror-monk', phase: 6, name: '镜僧', nameEn: 'Mirror Monk', glyph: '僧',
    desc: '反应：试图杀死你的玩家反而立刻死亡，你存活。',
    targetKind: 'none', tag: 'reaction',
  }),
  'shadow-guard': c({
    id: 'shadow-guard', phase: 6, name: '影卫', nameEn: 'Shadow Guard', glyph: '卫',
    desc: '反应：本回合你不会被打死。',
    targetKind: 'none', tag: 'reaction', provisional: true,
  }),
  mastermind: c({
    id: 'mastermind', phase: 6, name: '主谋', nameEn: 'Mastermind', glyph: '谋',
    desc: '若你存活到回合结束，你的家系直接赢得本回合。',
    targetKind: 'none', tag: 'kicker',
  }),
};

/** 按人数组建忍者牌堆（每人发 3 张，牌堆略厚以增加变化）。provisional：数量待核对。 */
export function buildDeck(playerCount: number): string[] {
  const n = playerCount;
  const deck: string[] = [];
  const push = (id: string, count: number) => {
    for (let i = 0; i < count; i++) deck.push(id);
  };
  push('spy', Math.ceil(n / 2));
  push('mystic', Math.floor(n / 2));
  for (const id of Object.keys(CARDS).filter((k) => CARDS[k].tag === 'trickster')) deck.push(id);
  push('blind-assassin', Math.ceil(n / 2));
  push('shinobi', Math.floor(n / 2));
  push('mirror-monk', 1);
  push('shadow-guard', 1);
  push('mastermind', 1);
  while (deck.length < 3 * n) deck.push('spy');
  return deck;
}

/** 荣誉代币面值池（provisional：官方为暗置随机代币，面值分布待核对）。 */
export const HONOR_TOKEN_POOL: number[] = [1, 1, 1, 1, 2, 2, 2, 3, 3, 4];
