import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { GameEvent } from '@dg/protocol';
import type { NonView } from '@dg/games-night-of-ninja';
import { CARDS } from '@dg/games-night-of-ninja';
import { useGame } from '../../store';
import { send } from '../../net/client';
import { audio } from '../../audio';
import { NinjaCard } from '../../components/NinjaCard';
import ChatPanel from '../../components/ChatPanel';

const HOUSE_LABEL: Record<string, string> = { crane: '鹤之家', lotus: '莲之家', ronin: '浪人' };
const HOUSE_SIGIL: Record<string, string> = { crane: '🕊️', lotus: '🪷', ronin: '⚔️' };

/** 全流程阶段轨道（模拟实体桌游的回合流程板） */
const PHASE_TRACK: Array<{ id: string; label: string }> = [
  { id: 'deal', label: '身份分发' },
  { id: 'draft1', label: '轮抽 · 壹' },
  { id: 'draft2', label: '轮抽 · 贰' },
  { id: 'commit', label: '暗选出牌' },
  { id: 'night', label: '忍者之夜' },
  { id: 'roundEnd', label: '回合结算' },
];

/** 变体类诡术师的操作方式（先选方式，再点目标座位） */
const VARIANTS: Record<string, Array<{ value: string; label: string; hint: string }>> = {
  'trick-troublemaker': [
    { value: 'peek', label: '只看', hint: '偷看身份，不公开' },
    { value: 'reveal', label: '公开', hint: '查看并公开身份' },
  ],
  'trick-spirit-merchant': [
    { value: 'house', label: '看身份', hint: '查看对方身份' },
    { value: 'token', label: '看代币', hint: '偷看一枚代币面值' },
    { value: 'swap', label: '换代币', hint: '与对方交换一枚代币' },
  ],
};

interface FxFlash {
  id: number;
  seat: number;
  color: string;
}
interface FxShuriken {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}
interface BannerState {
  kind: 'round';
  winner: string;
  sub: string;
  key: number;
}

let fxId = 0;

/** 带标题的一组卡（手牌区分区） */
function CardGroup({ label, dim, children }: { label: string; dim?: boolean; children: React.ReactNode }) {
  return (
    <div className={`card-group ${dim ? 'dim' : ''}`}>
      <div className="group-label">{label}</div>
      <div className="cards-row">{children}</div>
    </div>
  );
}

/** 卡 + 底部动作标签（明确的点击引导） */
function CardWithTag({ tag, children }: { tag: string; children: React.ReactNode }) {
  return (
    <div className="card-with-tag">
      {children}
      <span className="pick-tag">{tag}</span>
    </div>
  );
}

export default function NonTable() {
  const room = useGame((s) => s.room);
  const view = useGame((s) => s.gameView) as NonView | null;
  const lastEvents = useGame((s) => s.lastEvents);
  const token = useGame((s) => s.token);
  const pushToast = useGame((s) => s.pushToast);
  const seq = useRef(0);
  const lastRev = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [flashes, setFlashes] = useState<FxFlash[]>([]);
  const [shurikens, setShurikens] = useState<FxShuriken[]>([]);
  const [vignette, setVignette] = useState(0);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [targetMode, setTargetMode] = useState<{ card: string; first?: number } | null>(null);
  const [variantChoice, setVariantChoice] = useState<string | null>(null);

  const me = room?.players.find((p) => p.sessionId === token);

  // 换人结算（或夜晚结束）时清空目标/操作方式选择，避免跨结算误用
  const currentResolveSeat = view?.nightInfo?.currentSeat ?? null;
  useEffect(() => {
    setTargetMode(null);
    setVariantChoice(null);
  }, [currentResolveSeat, view?.nightInfo?.currentCardId]);

  /* ---------- 事件 → 动画/音效 ---------- */
  useEffect(() => {
    if (!lastEvents || lastEvents.rev <= lastRev.current) return;
    lastRev.current = lastEvents.rev;
    for (const e of lastEvents.events) {
      handleEvent(e);
    }
  }, [lastEvents]);

  const seatCenter = (seat: number): { x: number; y: number } => {
    const stage = stageRef.current;
    const node = document.querySelector(`[data-seat="${seat}"]`);
    if (!stage || !node) return { x: 0, y: 0 };
    const s = stage.getBoundingClientRect();
    const n = node.getBoundingClientRect();
    return { x: n.left + n.width / 2 - s.left, y: n.top + n.height / 2 - s.top };
  };

  const flash = (seat: number, color: string) => {
    const id = ++fxId;
    setFlashes((f) => [...f, { id, seat, color }]);
    setTimeout(() => setFlashes((f) => f.filter((x) => x.id !== id)), 700);
  };

  const fly = (fromSeat: number, toSeat: number) => {
    const id = ++fxId;
    setShurikens((s) => [...s, { id, from: seatCenter(fromSeat), to: seatCenter(toSeat) }]);
    setTimeout(() => setShurikens((s) => s.filter((x) => x.id !== id)), 900);
  };

  function handleEvent(e: GameEvent) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case 'game:start':
        audio.scene('night');
        audio.sfx('deal');
        break;
      case 'non:roundStart':
        setBanner(null);
        audio.sfx('deal');
        break;
      case 'non:draftPicked': {
        audio.sfx('card');
        const my = useGame.getState().gameView?.you.seat;
        if (Number(p.seat) === my) pushToast({ text: '已保留 1 张 ✓ 等待其他忍者选牌' });
        break;
      }
      case 'non:poolPassed':
        audio.sfx('deal');
        pushToast({ text: '余牌已左传 · 你收到了右家的新候选牌' });
        break;
      case 'non:committed': {
        audio.sfx('flip');
        const my = useGame.getState().gameView?.you.seat;
        if (Number(p.seat) === my) pushToast({ text: '已暗选打出 ✓ 夜晚即将降临' });
        break;
      }
      case 'non:resolving':
        audio.sfx('reveal');
        break;
      case 'non:killAttempt':
        fly(Number(p.attacker), Number(p.target));
        break;
      case 'non:death':
        flash(Number(p.seat), 'rgba(255,60,40,0.6)');
        setVignette((v) => v + 1);
        audio.sfx('death');
        break;
      case 'non:reflected':
        audio.sfx('reflect');
        break;
      case 'non:blocked':
        flash(Number(p.seat), 'rgba(90,167,214,0.6)');
        audio.sfx('shield');
        break;
      case 'non:spared':
        audio.sfx('spare');
        break;
      case 'non:peek': {
        audio.sfx('peek');
        if (p.peekToken !== undefined) {
          pushToast({ text: `偷看到一枚荣誉代币：${String(p.peekToken)} 点` });
          break;
        }
        pushToast({
          text: p.self ? '你的新身份：' : `窥见了 ${String(p.target ?? '')} 号位的身份：`,
          identity: { house: String(p.house), rank: Number(p.rank), otherCard: (p.otherCard as string) ?? null, self: !!p.self },
        });
        break;
      }
      case 'non:peek2': {
        audio.sfx('peek');
        pushToast({
          text: `窥见 ${String(p.a)} 号位与 ${String(p.b)} 号位的身份并已秘密交换（他们自己不知道）`,
          identity: { house: String(p.bHouse), rank: Number(p.bRank) },
        });
        break;
      }
      case 'non:martyred':
        flash(Number(p.seat), 'rgba(111,211,160,0.6)');
        audio.sfx('token');
        break;
      case 'non:tokenSteal':
        audio.sfx('token');
        pushToast({ text: `${String(p.to)} 号位从 ${String(p.from)} 号位拿走了一枚代币` });
        break;
      case 'non:tokenSwap':
        audio.sfx('flip');
        pushToast({ text: `${String(p.a)} 号位与 ${String(p.b)} 号位交换了一枚代币` });
        break;
      case 'non:graveTaken':
        audio.sfx('card');
        break;
      case 'non:exposed':
        pushToast({
          text: `${String(p.seat)} 号位的身份被公开了！`,
          identity: { house: String(p.house), rank: Number(p.rank) },
        });
        audio.sfx('reveal');
        break;
      case 'non:honor':
        audio.sfx('token');
        pushToast({ text: `获得 ${String(p.gained)} 点荣誉（共 ${String(p.total)}）` });
        break;
      case 'non:honorDraw':
        break;
      case 'non:roundEnd': {
        const winner = String(p.winner);
        setBanner({
          kind: 'round',
          winner,
          sub: winner === 'none' ? '平分秋色，双方各无所得' : `${HOUSE_LABEL[winner]} 赢得本回合`,
          key: ++fxId,
        });
        audio.scene('reveal');
        setTimeout(() => audio.scene('night'), 4000);
        break;
      }
      case 'non:gameEnd':
        setBanner(null);
        audio.sfx('win');
        break;
      case 'non:silenced':
        audio.sfx('shield');
        break;
      case 'non:identitySwap':
        audio.sfx('flip');
        break;
      default:
        break;
    }
  }

  /* ---------- 动作发送 ---------- */
  const act = (action: Record<string, unknown> & { type: string }) => {
    send({ t: 'gameAction', seq: ++seq.current, action });
    setTargetMode(null);
  };

  if (!room || !view) {
    return (
      <div className="table-page">
        <div className="game-topbar">
          <span className="phase">{room?.game?.displayName ?? '对局'}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
          正在进入对局…
        </div>
      </div>
    );
  }

  const n = view.players.length;
  const mySeat = view.you.seat;
  const seatPos = (seat: number) => {
    const a = ((seat - mySeat) / n) * Math.PI * 2 + Math.PI / 2; // 我在正下方
    return { left: `${50 + 41 * Math.cos(a)}%`, top: `${44 + 33 * Math.sin(a)}%` };
  };
  /** 公共区出牌位置：座位与桌面中心之间插值，形成中央卡环 */
  const centerCardPos = (seat: number) => {
    const a = ((seat - mySeat) / n) * Math.PI * 2 + Math.PI / 2;
    const t = 0.56;
    return { left: `${50 + 41 * t * Math.cos(a)}%`, top: `${44 + 33 * t * Math.sin(a)}%` };
  };
  const trackIdx =
    view.phase === 'draft1'
      ? 1
      : view.phase === 'draft2'
        ? 2
        : view.phase === 'commit'
          ? 3
          : view.phase === 'night'
            ? 4
            : view.phase === 'roundEnd'
              ? 5
              : 6;

  const locked = view.nightInfo?.lockedTarget ?? null;
  const myTurnToResolve = view.phase === 'night' && view.nightInfo?.currentSeat === mySeat;
  const currentCard = view.nightInfo?.currentCardId ? CARDS[view.nightInfo.currentCardId] : null;
  const currentCardId = view.nightInfo?.currentCardId ?? '';
  const needsTarget =
    myTurnToResolve &&
    !!currentCard &&
    currentCard.targetKind !== 'none' &&
    currentCard.targetKind !== 'graveyard' &&
    !(currentCard.shinobiStyle && locked !== null);

  const onSeatClick = (seat: number) => {
    if (!needsTarget || seat === mySeat) return;
    if (currentCardId === 'trick-shapeshifter') {
      if (targetMode?.first === undefined) {
        setTargetMode({ card: currentCardId, first: seat });
      } else if (targetMode.first !== seat) {
        act({ type: 'non:resolve', target: targetMode.first, target2: seat });
      }
      return;
    }
    if (VARIANTS[currentCardId]) {
      if (!variantChoice) return; // 先选操作方式
      act({ type: 'non:resolve', target: seat, choice: variantChoice });
      return;
    }
    // 含忍者：先发窥视（服务端随后弹出杀/放抉择）
    act({ type: 'non:resolve', target: seat });
  };

  const targetableSeats = (() => {
    if (!needsTarget) return [];
    const base = view.players.filter((p) => p.alive && p.seat !== mySeat);
    if (currentCardId === 'trick-thief') {
      const myCount = view.you.tokens.length;
      return base.filter((p) => p.tokenCount > myCount).map((p) => p.seat);
    }
    return base.map((p) => p.seat);
  })();

  const phaseHint = () => {
    switch (view.phase) {
      case 'draft1':
      case 'draft2':
        return view.you.picked ? '已选好，等其他忍者…' : `选 1 张保留（第 ${view.draft?.pickNumber} 抓）`;
      case 'commit':
        return view.you.committed ? '已暗选，等其他忍者…' : '从手中暗选 1 张打出';
      case 'night':
        if (view.nightInfo?.currentSeat === mySeat) {
          if (currentCard?.shinobiStyle && locked !== null)
            return `已窥视 ${view.players.find((p) => p.seat === locked)?.nickname ?? ''} 的身份 · 选择杀或放`;
          if (currentCardId === 'trick-gravedigger') return '掘墓人：从弃牌堆拿一张';
          if (VARIANTS[currentCardId] && !variantChoice) return `${currentCard?.name}：先选操作方式，再点目标`;
          return needsTarget ? `${currentCard?.name}：选择目标` : `${currentCard?.name} 生效中…`;
        }
        return view.nightInfo?.currentSeat !== null && view.nightInfo?.currentSeat !== undefined
          ? `${view.players.find((p) => p.seat === view.nightInfo!.currentSeat)?.nickname} 正在行动…`
          : '夜风掠过…';
      case 'roundEnd':
        return '回合结算中…';
      default:
        return '';
    }
  };

  return (
    <div className="table-page">
      <div className="game-topbar">
        <span className="phase">{room.game?.phaseLabel ?? ''}</span>
        <span>第 {view.round} 夜</span>
        {view.nightInfo && (
          <span>
            结算 {view.nightInfo.resolvedCount}/{view.nightInfo.total}
          </span>
        )}
        <div className="honor">
          <span className="honor-chip">🎯 目标 {view.targetHonor}</span>
          <span className="honor-chip">
            🏵️ 我的荣誉 {view.you.honor} · {view.you.tokens.length} 枚
          </span>
          {me && (
            <span className="identity-badge" style={{ marginLeft: 8, fontFamily: 'var(--font-body)' }}>
              {me.avatar} {me.nickname}
            </span>
          )}
        </div>
      </div>

      {/* 阶段轨道：全流程轮名称与当前位置（模拟实体流程板） */}
      <div className="phase-track">
        {PHASE_TRACK.map((p, i) => (
          <div key={p.id} className={`track-step ${i < trackIdx ? 'done' : ''} ${i === trackIdx ? 'active' : ''}`}>
            <span className="step-dot">{i < trackIdx ? '✓' : i + 1}</span>
            <span className="step-label">{p.label}</span>
            {i < PHASE_TRACK.length - 1 && <span className="step-arrow">›</span>}
          </div>
        ))}
      </div>

      <div
        className="table-stage"
        ref={stageRef}
        onTouchStart={() => audio.unlock()}
      >
        <div className="table-felt" />

        {/* 公共区：所有已打出的牌（暗置环绕中央，结算到谁则翻谁的） */}
        {view.players.map((p) =>
          p.hasCommitted || p.resolvedCard ? (
            <div key={`cc-${p.seat}`} className={`center-card ${!p.alive ? 'dead' : ''}`} style={centerCardPos(p.seat)}>
              <NinjaCard
                cardId={p.resolvedCard ?? 'spy'}
                faceDown={!p.resolvedCard}
                width={54}
                title={
                  p.resolvedCard
                    ? undefined
                    : `${p.seat === mySeat ? '你' : p.nickname} 打出的牌（结算到时翻开）`
                }
              />
              {p.negated && <span className="cc-negated">封</span>}
              <span className="cc-owner">{p.seat === mySeat ? '我' : p.nickname}</span>
            </div>
          ) : null,
        )}
        <div className="table-center">
          {view.phase === 'night' && currentCard && view.nightInfo?.currentSeat !== null && (
            <motion.div
              key={`${view.round}-${view.nightInfo?.currentSeat}-${view.nightInfo?.currentCardId}`}
              initial={{ scale: 0.5, opacity: 0, rotate: -8 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
            >
              <NinjaCard
                cardId={
                  view.players.find((p) => p.seat === view.nightInfo!.currentSeat)?.resolvedCard ??
                  view.nightInfo!.currentCardId!
                }
                width={118}
              />
              <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text-dim)', marginTop: 6 }}>
                {view.players.find((p) => p.seat === view.nightInfo!.currentSeat)?.nickname}
              </div>
            </motion.div>
          )}
          {view.phase === 'roundEnd' && view.roundResult && (
            <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 56 }}>{HOUSE_SIGIL[view.roundResult.winner] ?? '🌙'}</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--gold)' }}>
                {view.roundResult.winner === 'none' ? '无人得分' : `${HOUSE_LABEL[view.roundResult.winner]} 胜`}
              </div>
              {view.roundResult.mastermindSeat !== null && (
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>主谋翻盘！</div>
              )}
            </motion.div>
          )}
          {(view.phase === 'draft1' || view.phase === 'draft2' || view.phase === 'commit') && (
            <div style={{ fontSize: 54, opacity: 0.85 }}>🈶</div>
          )}
          <div className="phase-hint">{phaseHint()}</div>
        </div>

        {/* 座位环 */}
        {view.players.map((p) => {
          const seatPlayer = room.players.find((r) => r.seat === p.seat);
          const shownId = p.exposedIdentity ?? p.revealedIdentity;
          const isCurrent = view.nightInfo?.currentSeat === p.seat;
          return (
            <div
              key={p.seat}
              className={`seat ${p.seat === mySeat ? 'me' : ''} ${!p.alive ? 'dead' : ''} ${
                isCurrent ? 'active-turn' : ''
              } ${targetableSeats.includes(p.seat) ? 'targetable' : ''} ${
                targetMode?.first === p.seat ? 'target-picked' : ''
              }`}
              style={seatPos(p.seat)}
              data-seat={p.seat}
              onClick={() => onSeatClick(p.seat)}
            >
              <div className="avatar-orb">{seatPlayer?.avatar ?? '🥷'}</div>
              <div className="nick">
                {p.seat === mySeat ? '我' : p.nickname}
                {seatPlayer && !seatPlayer.connected && !p.isBot ? ' ·掉线' : ''}
              </div>
              <div className="tags">
                {p.negated && <span title="被封印">❌</span>}
                {p.tokenCount > 0 && (
                  <span title={`持有 ${p.tokenCount} 枚荣誉代币`}>🏵️{p.tokenCount}</span>
                )}
                {shownId && (
                  <span className={`identity-badge ${shownId.house}`}>
                    {shownId.house === 'ronin' ? '浪人' : `第${shownId.rank}席`}
                  </span>
                )}
              </div>
              <div className="mini-cards">
                {p.seat !== mySeat &&
                  Array.from({ length: Math.max(0, p.handCount - (p.hasCommitted ? 1 : 0)) }).map((_, i) => (
                    <div
                      key={i}
                      style={{
                        width: 14,
                        height: 20,
                        borderRadius: 3,
                        background: 'linear-gradient(150deg,#2b2058,#171035)',
                        border: '1px solid rgba(232,197,116,0.35)',
                      }}
                    />
                  ))}
              </div>
            </div>
          );
        })}

        {/* 特效层 */}
        <div className="fx-layer">
          <AnimatePresence>
            {shurikens.map((s) => (
              <motion.div
                key={s.id}
                className="shuriken"
                initial={{ left: s.from.x, top: s.from.y, opacity: 1, rotate: 0, scale: 1 }}
                animate={{ left: s.to.x, top: s.to.y, opacity: 0.9, rotate: 720, scale: 1.15 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.45, ease: 'easeIn' }}
                style={{ position: 'absolute' }}
              >
                🗡️
              </motion.div>
            ))}
          </AnimatePresence>
          {flashes.map((f) => {
            const c = seatCenter(f.seat);
            return (
              <motion.div
                key={f.id}
                className="seat-flash"
                style={{ left: c.x, top: c.y, background: `radial-gradient(circle, ${f.color}, transparent 70%)` }}
                initial={{ opacity: 1, scale: 0.6 }}
                animate={{ opacity: 0, scale: 1.8 }}
                transition={{ duration: 0.65 }}
              />
            );
          })}
        </div>

        {/* 回合横幅 */}
        <AnimatePresence>
          {banner && (
            <motion.div
              key={banner.key}
              className={`banner ${banner.winner}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setBanner(null)}
            >
              <div className="sigil">{HOUSE_SIGIL[banner.winner] ?? '🌙'}</div>
              <div className="big">{banner.winner === 'none' ? '平局' : `${HOUSE_LABEL[banner.winner]} 得势`}</div>
              <div className="sub">{banner.sub} · 点击关闭</div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 终局结算 */}
        {room.phase === 'result' && view.standings && (
          <div className="result-overlay">
            <div className="panel result-card">
              <h2>夜幕落下</h2>
              <div className="standings">
                {view.standings
                  .slice()
                  .sort((a, b) => b.honor - a.honor)
                  .map((s) => {
                    const winners = view.winners ?? [];
                    return (
                      <div key={s.seat} className={`standing-row ${winners.includes(s.seat) ? 'winner' : ''}`}>
                        <span>{room.players.find((r) => r.seat === s.seat)?.avatar ?? ''}</span>
                        <span style={{ flex: 1 }}>{s.nickname}</span>
                        <span className={`identity-badge ${s.identity.house}`}>
                          {s.identity.house === 'ronin' ? '浪人' : `${HOUSE_LABEL[s.identity.house]}·${s.identity.rank}`}
                        </span>
                        <b>🏵️ {s.honor}</b>
                      </div>
                    );
                  })}
              </div>
              {me?.sessionId === room.hostSessionId ? (
                <button className="app-btn primary" onClick={() => send({ t: 'playAgain' })}>
                  再来一局
                </button>
              ) : (
                <p style={{ color: 'var(--text-dim)' }}>等房主决定是否再来一局…</p>
              )}
              <button className="app-btn" style={{ marginTop: 10 }} onClick={() => send({ t: 'leaveRoom' })}>
                离开
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 我的手牌/候选区：分区标注，手牌状态一目了然 */}
      <div className="my-hand">
        <div className="hand-meta">
          {view.you.identityKnown && view.you.identity ? (
            <span className={`identity-badge ${view.you.identity.house}`}>
              我的身份 · {HOUSE_LABEL[view.you.identity.house]}
              {view.you.identity.house !== 'ronin' && ` 第${view.you.identity.rank}席`}
            </span>
          ) : (
            <span className="identity-badge ronin">🜲 身份不明（被易容师调换）</span>
          )}
          <span className="hand-pill">{phaseHint()}</span>
        </div>

        <div className="hand-groups">
          {/* 轮抽：已保留的牌常驻可见 */}
          {view.phase === 'draft1' || view.phase === 'draft2' ? (
            <>
              {view.you.hand.length > 0 && (
                <CardGroup label={`✋ 已保留 ${view.you.hand.length} 张`}>
                  {view.you.hand.map((c) => (
                    <NinjaCard key={c} cardId={c} width={64} />
                  ))}
                </CardGroup>
              )}
              {!view.you.picked ? (
                <CardGroup
                  label={`🎴 候选牌（第 ${view.draft?.pickNumber ?? 1} 抓）· 点击选 1 张 · 其他玩家 ${
                    view.draft?.doneCount ?? 0
                  }/${view.draft?.total ?? n} 已选`}
                >
                  {view.you.draftPool.map((c) => (
                    <CardWithTag key={c} tag="选这张">
                      <NinjaCard
                        cardId={c}
                        clickable
                        width={96}
                        onClick={() => act({ type: 'non:draftPick', cardId: c })}
                      />
                    </CardWithTag>
                  ))}
                </CardGroup>
              ) : (
                <CardGroup label="✓ 本轮已选好，等待其他忍者">
                  <span className="waiting-dots" />
                </CardGroup>
              )}
            </>
          ) : null}

          {/* 暗选：明确哪张打出、哪张留作暗牌 */}
          {view.phase === 'commit' && !view.you.committed && (
            <CardGroup label="🀄 手牌 · 点击打出 1 张（另一张留作暗牌）">
              {view.you.hand.map((c) => (
                <CardWithTag key={c} tag="打出">
                  <NinjaCard
                    cardId={c}
                    clickable
                    width={100}
                    onClick={() => act({ type: 'non:commit', cardId: c })}
                  />
                </CardWithTag>
              ))}
            </CardGroup>
          )}
          {view.phase === 'commit' && view.you.committed && (
            <>
              <CardGroup label="✅ 已打出（暗置）">
                <NinjaCard cardId={view.you.committed} width={72} />
              </CardGroup>
              <CardGroup label="🕶️ 暗牌（仍在你手中，会被通灵者看穿）" dim>
                {view.you.hand
                  .filter((c) => c !== view.you.committed)
                  .map((c) => (
                    <NinjaCard key={c} cardId={c} width={64} />
                  ))}
              </CardGroup>
            </>
          )}

          {/* 夜晚/结算：打出的牌与暗牌分开标注 */}
          {(view.phase === 'night' || view.phase === 'roundEnd' || view.phase === 'gameEnd') &&
            view.you.committed && (
              <>
                <CardGroup label={view.nightInfo?.currentSeat === mySeat ? '⚡ 正在结算你的牌' : '🗡️ 你打出的牌'}>
                  <NinjaCard
                    cardId={view.you.committed}
                    width={76}
                    selected={view.nightInfo?.currentSeat === mySeat}
                  />
                </CardGroup>
                <CardGroup label="🕶️ 暗牌（未打出）" dim>
                  {view.you.hand
                    .filter((c) => c !== view.you.committed)
                    .map((c) => (
                      <NinjaCard key={c} cardId={c} width={64} />
                    ))}
                </CardGroup>
              </>
            )}
        </div>

        {/* 变体诡术师：先选操作方式，再点目标座位 */}
        {myTurnToResolve && VARIANTS[currentCardId] && (
          <div className="hand-actions">
            <span className="hint">选择操作方式 →</span>
            {VARIANTS[currentCardId].map((v) => (
              <button
                key={v.value}
                className={`app-btn small ${variantChoice === v.value ? 'primary' : ''}`}
                title={v.hint}
                onClick={() => setVariantChoice(v.value)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}

        {/* 盗贼：点高亮座位偷代币，或跳过 */}
        {myTurnToResolve && currentCardId === 'trick-thief' && (
          <div className="hand-actions">
            <span className="hint">点一个高亮座位拿走一枚代币，或</span>
            <button className="app-btn small" onClick={() => act({ type: 'non:resolve', choice: 'skip' })}>
              跳过
            </button>
          </div>
        )}

        {/* 掘墓人：翻桌面中央的弃牌堆 */}
        {myTurnToResolve && currentCardId === 'trick-gravedigger' && (
          <div className="grave-panel">
            {view.discardPile.length === 0 ? (
              <span className="hint">弃牌堆是空的</span>
            ) : (
              view.discardPile.map((d) => (
                <div key={d} className="grave-item">
                  <NinjaCard cardId={d} width={72} />
                  <div className="grave-btns">
                    <button
                      className="app-btn small primary"
                      onClick={() => act({ type: 'non:resolve', pick: d, mode: 'play' })}
                    >
                      立即打出
                    </button>
                    <button className="app-btn small" onClick={() => act({ type: 'non:resolve', pick: d, mode: 'keep' })}>
                      收入手牌
                    </button>
                  </div>
                </div>
              ))
            )}
            <button className="app-btn small" onClick={() => act({ type: 'non:resolve', mode: 'skip' })}>
              跳过
            </button>
          </div>
        )}

        {/* 忍者两步结算：已窥视目标 → 杀/放抉择 */}
        {myTurnToResolve && currentCard?.shinobiStyle && locked !== null && (
          <div className="hand-actions">
            <span className="hint" style={{ color: 'var(--gold)' }}>
              已窥视 {view.players.find((p) => p.seat === locked)?.nickname} 的身份 →
            </span>
            <button className="app-btn danger" onClick={() => act({ type: 'non:choose', choice: 'kill' })}>
              杀
            </button>
            <button className="app-btn" onClick={() => act({ type: 'non:choose', choice: 'spare' })}>
              放
            </button>
          </div>
        )}
        {targetMode?.card === 'trick-shapeshifter' && targetMode.first !== undefined && (
          <span className="hint" style={{ color: 'var(--danger)' }}>
            再点一个座位完成调换（已选 {targetMode.first}）
          </span>
        )}
      </div>

      {/* 对局中迷你聊天 */}
      <div style={{ position: 'absolute', right: 12, top: 46, bottom: 160, width: 250, zIndex: 25 }}>
        <ChatPanel />
      </div>

      {vignette > 0 && (
        <motion.div
          key={vignette}
          className="vignette-kill"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.9 }}
        />
      )}
    </div>
  );
}
