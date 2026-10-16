import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { NON_MAX_PLAYERS } from '@dg/games-night-of-ninja';
import { useGame } from '../store';
import { send } from '../net/client';
import { audio } from '../audio';
import ChatPanel from '../components/ChatPanel';
import NonTable from '../game/non/NonTable';

export default function Room() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const room = useGame((s) => s.room);
  const token = useGame((s) => s.token);
  const connected = useGame((s) => s.connected);
  const profile = useGame((s) => s.profile);
  const lastErrorCode = useGame((s) => s.lastErrorCode);
  const lastJoinCode = useRef<string | null>(null);

  // 房间不存在/已开局/已满（服务器重启、码错误、迟到）→ 回大厅
  useEffect(() => {
    if (!room && ['room-not-found', 'game-running', 'room-full'].includes(lastErrorCode ?? '')) {
      navigate('/', { replace: true });
    }
  }, [room, lastErrorCode, navigate]);

  // 进页面自动加入该房间（每个房间码只尝试一次）；必须等 hello 完成之后再 join
  useEffect(() => {
    if (!code) return;
    if (lastJoinCode.current === code.toUpperCase()) return;
    if (room && room.code === code.toUpperCase()) return;
    if (!connected || !profile.nickname || !token) return;
    lastJoinCode.current = code.toUpperCase();
    send({ t: 'joinRoom', code: code.toUpperCase() });
  }, [code, room, token, connected, profile.nickname]);

  if (!room || (code && room.code !== code.toUpperCase())) {
    return (
      <div className="page">
        <div className="panel lobby-card" style={{ maxWidth: 420, margin: '60px auto', textAlign: 'center' }}>
          <h3>正在进入房间 {code?.toUpperCase()} …</h3>
          <p style={{ color: 'var(--text-dim)' }}>若一直没有反应，请检查房间码是否正确。</p>
          <a className="app-btn" href="/" style={{ textDecoration: 'none', display: 'inline-block' }}>
            回大厅
          </a>
        </div>
      </div>
    );
  }

  if (room.phase !== 'lobby') {
    return <NonTable />;
  }

  const me = room.players.find((p) => p.sessionId === token);
  const isHost = me?.sessionId === room.hostSessionId;

  return (
    <div className="page" style={{ overflow: 'hidden' }}>
      <div className="room-wrap">
        <div className="room-left">
          <div className="panel room-code-panel">
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>房间码 · 发给朋友</div>
              <div className="code">{room.code}</div>
            </div>
            <div style={{ flex: 1 }} />
            <button
              className="app-btn small"
              onClick={() => {
                const url = `${location.origin}/room/${room.code}`;
                navigator.clipboard?.writeText(url).then(
                  () => useGame.getState().pushToast({ text: '邀请链接已复制' }),
                  () => useGame.getState().pushToast({ text: url, err: false }),
                );
                audio.sfx('click');
              }}
            >
              📋 复制邀请链接
            </button>
          </div>

          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '14px 18px 0', display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>等待室</h3>
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                {room.players.length} 人在座 · 还可加入 {Math.max(0, NON_MAX_PLAYERS - room.players.length)} 人
              </span>
            </div>
            <div className="players-grid">
              {room.players.map((p) => (
                <div key={p.sessionId} className={`player-chip ${p.connected ? '' : 'disconnected'}`}>
                  <span className="avatar">{p.avatar}</span>
                  <span className="info">
                    <div className="nick">
                      {p.sessionId === room.hostSessionId && <span className="crown">👑 </span>}
                      {p.nickname}
                    </div>
                    <div className="sub">
                      {p.isBot ? '机器人' : p.connected ? (p.ready ? '✓ 准备好了' : '未准备') : '掉线'}
                    </div>
                  </span>
                  {isHost && p.sessionId !== me?.sessionId && (
                    <button className="kick" title="移出房间" onClick={() => send({ t: 'kick', sessionId: p.sessionId })}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div style={{ padding: 14, display: 'flex', gap: 10, flexWrap: 'wrap', borderTop: '1px solid var(--panel-border)' }}>
              {isHost ? (
                <>
                  <button className="app-btn" onClick={() => send({ t: 'addBot' })}>
                    🤖 加一个机器人
                  </button>
                  <button
                    className="app-btn primary"
                    onClick={() => {
                      audio.sfx('click');
                      send({ t: 'startGame', gameId: 'night-of-ninja' });
                    }}
                  >
                    开始 · 忍者之夜（≥3 人）
                  </button>
                </>
              ) : (
                <span style={{ color: 'var(--text-dim)', alignSelf: 'center' }}>等房主开始…</span>
              )}
              <div style={{ flex: 1 }} />
              <button className="app-btn danger" onClick={() => send({ t: 'leaveRoom' })}>
                离开房间
              </button>
            </div>
          </div>
        </div>

        <ChatPanel />
      </div>
    </div>
  );
}
