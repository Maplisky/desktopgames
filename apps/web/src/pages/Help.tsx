import { useParams } from 'react-router-dom';
import { CARDS } from '@dg/games-night-of-ninja';

const FLOW = [
  ['1 · 分发身份', '每轮开始，所有人秘密获得一张身份牌：鹤之家或莲之家（排名 1 最优），人数为奇数时会有一名中立的浪人。每轮身份重新分发——上一轮的队友这一轮可能是对手。'],
  ['2 · 轮抽手牌', '每人摸 3 张忍者牌，选 1 张留下，余牌传给左家；再从收到的 2 张里选 1 张，最后 1 张弃置。你最终保留 2 张。'],
  ['3 · 暗选出牌', '所有人从手中暗选 1 张打出（扣置）。另一张留在手里——它会被「通灵者」类卡看穿。'],
  ['4 · 忍者之夜', '打出的牌按编号 1→6 依次结算：间谍 → 通灵者 → 诡术师 → 盲眼刺客 → 忍者 → 特殊。编号小先行动。被杀的玩家若还没轮到结算，其卡牌作废。'],
  ['5 · 回合结算', '幸存者公开身份。幸存者中排名最优的家系赢得回合，该家系全员（死活皆算）各抽一枚暗置荣誉代币；浪人只要活着也能抽。有人凑满 10 荣誉即获胜。'],
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
  const cards = Object.values(CARDS).sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));
  return (
    <div className="page">
      <div className="help-wrap">
        <div className="panel" style={{ padding: '26px 30px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginTop: 0 }}>🥷 忍者之夜</h2>
          <p style={{ color: 'var(--text-dim)' }}>
            两大家族在同一个夜晚短兵相接——问题是，你不知道谁是队友。3–11 人 · 每轮约 5 分钟。
          </p>
          {FLOW.map(([t, d]) => (
            <div key={t} style={{ margin: '14px 0' }}>
              <b style={{ color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>{t}</b>
              <p style={{ margin: '4px 0 0', lineHeight: 1.7 }}>{d}</p>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>卡牌一览（结算顺序即排列顺序）</h3>
          <div className="card-grid">
            {cards.map((c) => (
              <div key={c.id} className="help-card">
                <b>
                  {c.phase} · {c.glyph} {c.name}
                </b>
                {c.provisional && <span style={{ color: 'var(--text-dim)' }}>（效果待核对实体规则书）</span>}
                <div style={{ marginTop: 4 }}>{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
