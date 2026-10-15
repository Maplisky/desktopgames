import { useParams } from 'react-router-dom';
import { CARDS } from '@dg/games-night-of-ninja';

const FLOW = [
  [
    '1 · 分发身份',
    '每轮开始，所有人秘密获得一张身份牌：鹤之家或莲之家（排名 1 最优，人多时使用更高排名），奇数人数时加入一名中立浪人。每轮身份重新分发——上一轮的队友这一轮可能就是对手。',
  ],
  [
    '2 · 轮抽手牌',
    '从 33 张忍者牌堆中每人摸 3 张：选 1 张留下，余下 2 张传给左家；再从收到的 2 张里选 1 张，最后 1 张弃到桌面中央（当心掘墓人）。',
  ],
  [
    '3 · 暗选出牌',
    '所有人从手中暗选 1 张打出，扣置在自己面前；另一张留在手里——它会被「通灵者」看穿。',
  ],
  [
    '4 · 忍者之夜',
    '按类型阶段结算：间谍 → 通灵者 → 诡术师 → 盲眼刺客 → 忍者；同类型内按卡面角标数字从小到大。被杀的玩家若还没轮到结算，其打出的牌作废（保持暗置）。死者不亮身份，但可以继续说话、误导、嘴炮。',
  ],
  [
    '5 · 身份揭示与得分',
    '幸存者公开身份。家系按「幸存者最佳排名」逐位比较（1 最优），完全平局则每位幸存者各得一枚代币。获胜家系全员（死活皆算）各抽一枚暗置荣誉代币（面值 2/3/4）；浪人只要活着也抽一枚。任一玩家凑满 10 分即获胜——同分更高者胜，完全同分则共享胜利。',
  ],
  [
    '6 · 序外特殊牌',
    '镜僧与殉道者是反应牌（在别人杀你时生效）；主谋在身份揭示时生效。它们不在正常结算顺序内。',
  ],
];

export default function Help() {
  const { gameId } = useParams();
  if (gameId !== 'night-of-ninja') {
    return (
      <div className="page">
        <div className="help-wrap">
          <div className="panel">暂无该游戏的说明。</div>
        </div>
      </div>
    );
  }
  const cards = Object.values(CARDS).sort(
    (a, b) => a.phase - b.phase || (a.number ?? 0) - (b.number ?? 0) || a.name.localeCompare(b.name),
  );
  return (
    <div className="page">
      <div className="help-wrap">
        <div className="panel" style={{ padding: '26px 30px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginTop: 0 }}>🥷 忍者之夜</h2>
          <p style={{ color: 'var(--text-dim)' }}>
            两大家族在同一个夜晚短兵相接——问题是，你不知道谁是队友。3–11 人 · 每轮约 5 分钟 · 设计：Justin
            Gary（Brotherwise Games）。
          </p>
          {FLOW.map(([t, d]) => (
            <div key={t} style={{ margin: '14px 0' }}>
              <b style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>{t}</b>
              <p style={{ margin: '4px 0 0', lineHeight: 1.7 }}>{d}</p>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>卡牌一览（按结算顺序排列；角标数字 = 同类型内的先后）</h3>
          <div className="card-grid">
            {cards.map((c) => (
              <div key={c.id} className="help-card">
                <b>
                  {c.phase === 6 ? '序外' : c.phase} · {c.glyph} {c.name}
                  {c.number ? `（角标 ${c.number}）` : ''}
                </b>
                <div style={{ marginTop: 4 }}>{c.desc}</div>
              </div>
            ))}
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            间谍/通灵者/盲眼刺客/忍者各有 6 张（角标 1-6），六张诡术师各 1 张，另有镜僧、殉道者、主谋 —— 全盒共 33
            张忍者牌。
          </p>
        </div>
      </div>
    </div>
  );
}
