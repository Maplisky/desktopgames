/**
 * 忍者之夜（Night of the Ninja, Brotherwise Games / 设计：Justin Gary）卡牌数据表。
 *
 * 依据 RulesPal 完整规则书文本 + 官方/评测多源交叉确认（见 docs/rules-night-of-ninja.md）：
 * - 结算顺序：类型阶段（间谍→通灵→诡术→盲眼刺客→忍者），同类型内按卡面角标数字升序；
 * - 反应/被动卡在序外生效；
 * - 全盒 33 张忍者牌，每轮洗混后每人发 3 张，余牌旁置；
 * - 荣誉代币 35 枚、面值 2/3/4、暗置抽取（枚数公开、数值保密）。
 *
 * 仍标记 provisional 的：每种类型的张数分布与角标数字分配（规则书未公开逐张清单）。
 */

export type TargetKind = 'none' | 'anyAliveOther' | 'anyTwoAlive' | 'variants' | 'graveyard';

export interface CardDef {
  id: string;
  /** 结算阶段：1 间谍 → 2 通灵 → 3 诡术 → 4 盲眼刺客 → 5 忍者；6 = 序外反应/被动 */
  phase: number;
  /** 单张卡的固定角标（多副本卡由实例 id#N 携带） */
  number?: number;
  name: string;
  nameEn: string;
  glyph: string;
  desc: string;
  /** 结算时是否需要玩家选择 */
  targetKind: TargetKind;
  /** 忍者（先看后选，两步结算） */
  shinobiStyle?: boolean;
  tag: 'info' | 'trickster' | 'kill' | 'reaction' | 'kicker';
  provisional?: boolean;
}

const c = (d: CardDef) => d;

export const CARDS: Record<string, CardDef> = {
  spy: c({
    id: 'spy', phase: 1, name: '间谍', nameEn: 'Spy', glyph: '谍',
    desc: '查看另一名玩家的身份牌。',
    targetKind: 'anyAliveOther', tag: 'info',
  }),
  mystic: c({
    id: 'mystic', phase: 2, name: '通灵者', nameEn: 'Mystic', glyph: '灵',
    desc: '查看另一名玩家的身份牌与其已打出的忍者牌。',
    targetKind: 'anyAliveOther', tag: 'info',
  }),
  /* ---- 六张诡术师（各不相同，角标 1-6） ---- */
  'trick-shapeshifter': c({
    id: 'trick-shapeshifter', phase: 3, number: 1, name: '易容师', nameEn: 'Shapeshifter', glyph: '变',
    desc: '查看两名玩家的身份牌，并秘密交换它们（受害者不知道自己的新身份）。',
    targetKind: 'anyTwoAlive', tag: 'trickster',
  }),
  'trick-gravedigger': c({
    id: 'trick-gravedigger', phase: 3, number: 2, name: '掘墓人', nameEn: 'Grave Digger', glyph: '掘',
    desc: '查看本回合弃置的忍者牌，拿取一张：立即打出，或收入手牌。',
    targetKind: 'graveyard', tag: 'trickster',
  }),
  'trick-troublemaker': c({
    id: 'trick-troublemaker', phase: 3, number: 3, name: '搅局者', nameEn: 'Troublemaker', glyph: '搅',
    desc: '查看一名玩家的身份牌，可选择将其公开。',
    targetKind: 'variants', tag: 'trickster',
  }),
  'trick-spirit-merchant': c({
    id: 'trick-spirit-merchant', phase: 3, number: 4, name: '灵商', nameEn: 'Spirit Merchant', glyph: '商',
    desc: '查看一名玩家的一枚荣誉代币或其身份牌；或与其交换一枚荣誉代币。',
    targetKind: 'variants', tag: 'trickster',
  }),
  'trick-thief': c({
    id: 'trick-thief', phase: 3, number: 5, name: '盗贼', nameEn: 'Thief', glyph: '盗',
    desc: '公开你的身份牌，从荣誉代币数多于你的一名玩家处拿取一枚代币。',
    targetKind: 'variants', tag: 'trickster',
  }),
  'trick-judge': c({
    id: 'trick-judge', phase: 3, number: 6, name: '审判官', nameEn: 'Judge', glyph: '判',
    desc: '公开你的身份牌，并选择一名玩家将其杀死（镜僧与殉道者对审判官无效）。',
    targetKind: 'anyAliveOther', tag: 'kill',
  }),
  /* ---- 击杀 ---- */
  'blind-assassin': c({
    id: 'blind-assassin', phase: 4, name: '盲眼刺客', nameEn: 'Blind Assassin', glyph: '杀',
    desc: '选择一名玩家，将其杀死。',
    targetKind: 'anyAliveOther', tag: 'kill',
  }),
  shinobi: c({
    id: 'shinobi', phase: 5, name: '忍者', nameEn: 'Shinobi', glyph: '忍',
    desc: '选择一名玩家，查看其身份牌，然后可将其杀死。',
    targetKind: 'anyAliveOther', shinobiStyle: true, tag: 'kill',
  }),
  /* ---- 序外反应/被动 ---- */
  'mirror-monk': c({
    id: 'mirror-monk', phase: 6, name: '镜僧', nameEn: 'Mirror Monk', glyph: '僧',
    desc: '反应：当忍者或盲眼刺客以你为目标时，改为杀死对方。',
    targetKind: 'none', tag: 'reaction',
  }),
  martyr: c({
    id: 'martyr', phase: 6, name: '殉道者', nameEn: 'Martyr', glyph: '殉',
    desc: '反应：当忍者或盲眼刺客以你为目标时，你获得一枚荣誉代币并存活。',
    targetKind: 'none', tag: 'reaction',
  }),
  mastermind: c({
    id: 'mastermind', phase: 6, name: '主谋', nameEn: 'Mastermind', glyph: '谋',
    desc: '被动：若你在身份揭示时存活，你的家系赢得本回合（浪人则无家系获胜）。',
    targetKind: 'none', tag: 'kicker',
  }),
};

/* ---------- 卡牌实例：id#角标数字（同类型内按角标升序结算） ---------- */

export interface CardInstance {
  /** 基础卡 id */
  id: string;
  /** 卡面角标数字 */
  number: number;
}

export function inst(id: string, number: number): string {
  return `${id}#${number}`;
}

export function parseInst(s: string): CardInstance {
  const i = s.indexOf('#');
  if (i < 0) return { id: s, number: CARDS[s]?.number ?? 0 };
  return { id: s.slice(0, i), number: Number(s.slice(i + 1)) };
}

export function cardOf(s: string): CardDef {
  return CARDS[parseInst(s).id];
}

/** 全盒固定 33 张：间谍/通灵/盲眼刺客/忍者 各 6 张（角标 1-6）+ 六张诡术师 + 三张特殊 */
export function buildDeck(): string[] {
  const deck: string[] = [];
  for (let n = 1; n <= 6; n++) deck.push(inst('spy', n));
  for (let n = 1; n <= 6; n++) deck.push(inst('mystic', n));
  deck.push('trick-shapeshifter', 'trick-gravedigger', 'trick-troublemaker', 'trick-spirit-merchant', 'trick-thief', 'trick-judge');
  for (let n = 1; n <= 6; n++) deck.push(inst('blind-assassin', n));
  for (let n = 1; n <= 6; n++) deck.push(inst('shinobi', n));
  deck.push('mirror-monk', 'martyr', 'mastermind');
  return deck; // 6+6+6+6+6+3 = 33
}

/** 荣誉代币面值池：35 枚、面值 2/3/4（provisional：精确比例未公开） */
export const HONOR_TOKEN_POOL: number[] = [
  ...Array(12).fill(2),
  ...Array(12).fill(3),
  ...Array(11).fill(4),
];
