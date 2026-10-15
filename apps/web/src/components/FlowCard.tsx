/**
 * 官方风格「回合流程卡」（玩家辅助卡）：
 * 展示一回合的完整流程（回合开始 → 忍者轮抽 → 忍者之夜 → 身份揭示 → 回合结束），
 * 内容依据官方规则书原文整理；currentStep/currentNightPhase 用于高亮当前位置。
 */

const HOUSE_STEPS: Array<{ id: string; num: string; label: string; desc: string }> = [
  {
    id: 'deal',
    num: '1',
    label: '回合开始',
    desc: '洗混身份牌，每人暗发一张（只可自己查看）。鹤之家对莲之家，排名 1 最优；奇数人数加入中立的浪人。每轮身份重新分发！',
  },
  {
    id: 'draft',
    num: '2',
    label: '忍者轮抽',
    desc: '每人摸 3 张忍者牌：选 1 张保留，余下 2 张传给左家；再从收到的 2 张里选 1 张，最后 1 张弃至桌面中央。',
  },
  {
    id: 'night',
    num: '3',
    label: '忍者之夜',
    desc: '五个阶段依次叫名。每阶段持有者决定是否打出——打出立即面朝上公开；全员决定后按卡面角标 1→6 依次结算；不打出则该牌本轮作废（虚张声势也是战术）。',
  },
  {
    id: 'reveal',
    num: '4',
    label: '身份揭示',
    desc: '幸存者公开身份！幸存者排名最优的家系获胜（1 最优，平局比下一位；完全平局则无人获胜）。',
  },
  {
    id: 'score',
    num: '5',
    label: '回合结束',
    desc: '获胜家系全员（含死者）各抽一枚暗置荣誉代币（2/3/4 分）；浪人存活也抽一枚。有玩家凑满 10 分即获胜！',
  },
];

const NIGHT_PHASES: Array<{ id: number; label: string }> = [
  { id: 1, label: '① 间谍' },
  { id: 2, label: '② 通灵者' },
  { id: 3, label: '③ 诡术师' },
  { id: 4, label: '④ 盲眼刺客' },
  { id: 5, label: '⑤ 忍者' },
];

const OUT_OF_SEQUENCE = [
  { name: '镜僧', desc: '反应牌：被刺杀时打出，刺杀者反死' },
  { name: '殉道者', desc: '反应牌：被刺杀时打出，得一枚代币并存活' },
  { name: '主谋', desc: '揭示牌：计分时若你存活，你的家系直接获胜' },
];

export default function FlowCard({
  currentStep,
  currentNightPhase,
}: {
  /** 当前大步骤下标（0-4），-1 表示不在对局中不高亮 */
  currentStep?: number;
  /** 当前夜晚阶段 1-5 */
  currentNightPhase?: number | null;
}) {
  return (
    <div className="flow-card">
      <div className="flow-title">回合流程</div>
      {HOUSE_STEPS.map((s, i) => {
        const isNow = currentStep === i;
        const isNight = s.id === 'night';
        return (
          <div key={s.id} className={`flow-step ${isNow ? 'now' : ''}`}>
            <div className="flow-step-head">
              <span className="flow-num">{s.num}</span>
              <span className="flow-label">{s.label}</span>
              {isNow && <span className="flow-now-tag">当前</span>}
            </div>
            <div className="flow-desc">{s.desc}</div>
            {isNight && (
              <div className="flow-subphases">
                {NIGHT_PHASES.map((p) => {
                  const done = currentNightPhase !== null && currentNightPhase !== undefined && p.id < currentNightPhase;
                  const now = currentNightPhase === p.id;
                  return (
                    <span key={p.id} className={`flow-sub ${done ? 'done' : ''} ${now ? 'now' : ''}`}>
                      {p.label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      <div className="flow-extra">
        <div className="flow-extra-title">序外特殊牌</div>
        {OUT_OF_SEQUENCE.map((o) => (
          <div key={o.name} className="flow-extra-row">
            <b>{o.name}</b>
            <span>{o.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
