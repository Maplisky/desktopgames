import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGame } from '../store';
import { send } from '../net/client';
import { audio } from '../audio';

const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🦉', '🐺', '🦜', '🐙', '🦁', '🐯', '🦝'];
const ADJ = ['影', '月', '风', '雪', '焰', '雷', '霜', '夜'];

export default function Lobby() {
  const profile = useGame((s) => s.profile);
  const setProfile = useGame((s) => s.setProfile);
  const passcodeNeeded = useGame((s) => s.passcodeNeeded);
  const passcode = useGame((s) => s.passcode);
  const setPasscode = useGame((s) => s.setPasscode);
  const pushToast = useGame((s) => s.pushToast);
  const [joinCode, setJoinCode] = useState('');
  const [pc, setPc] = useState(passcode ?? '');
  const navigate = useNavigate();

  const randomName = () => {
    const nick = `无名${ADJ[Math.floor(Math.random() * ADJ.length)]}${Math.floor(Math.random() * 90 + 10)}`;
    setProfile({ ...profile, nickname: nick });
  };

  const saveProfile = () => {
    if (!profile.nickname.trim()) {
      pushToast({ text: '先给自己起个名字吧', err: true });
      return;
    }
    setProfile({ nickname: profile.nickname.trim().slice(0, 16), avatar: profile.avatar });
    audio.sfx('click');
  };

  const createRoom = () => {
    if (!profile.nickname.trim()) {
      pushToast({ text: '先起名再开房', err: true });
      return;
    }
    audio.sfx('click');
    const unwatch = useGame.subscribe((s) => {
      if (s.room && s.room.phase === 'lobby') {
        unwatch();
        clearTimeout(timer);
        navigate(`/room/${s.room.code}`);
      }
    });
    // 建房失败（口令错误等）时避免订阅泄漏
    const timer = setTimeout(unwatch, 5000);
    send({ t: 'createRoom' });
  };

  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return;
    audio.sfx('click');
    navigate(`/room/${code}`);
  };

  return (
    <div className="page">
      <div className="lobby-wrap">
        <div className="panel lobby-hero">
          <div className="lantern">🏮</div>
          <div>
            <h1>桌游馆</h1>
            <p>和朋友的夜里一局 · 开房发链接即玩 · 无需注册</p>
          </div>
        </div>

        {passcodeNeeded && (
          <div className="panel lobby-card">
            <h3>🔒 本馆需要口令</h3>
            <div className="join-row">
              <input
                className="app-input"
                value={pc}
                placeholder="输入入口口令"
                onChange={(e) => setPc(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setPasscode(pc);
                    location.reload();
                  }
                }}
              />
              <button
                className="app-btn primary"
                onClick={() => {
                  setPasscode(pc);
                  location.reload();
                }}
              >
                进门
              </button>
            </div>
          </div>
        )}

        <div className="lobby-grid">
          <div className="panel lobby-card">
            <h3>你的行头</h3>
            <div className="profile-row">
              <input
                className="app-input"
                style={{ flex: 1 }}
                placeholder="昵称（必填）"
                maxLength={16}
                value={profile.nickname}
                onChange={(e) => setProfile({ ...profile, nickname: e.target.value })}
                onBlur={saveProfile}
              />
              <button className="app-btn small" onClick={randomName}>
                随机
              </button>
            </div>
            <div className="avatar-pick">
              {AVATARS.map((a) => (
                <button key={a} className={profile.avatar === a ? 'sel' : ''} onClick={() => setProfile({ ...profile, avatar: a })}>
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div className="panel lobby-card">
            <h3>开一局 / 加入朋友</h3>
            <button className="app-btn primary" onClick={createRoom}>
              🎴 创建房间
            </button>
            <div className="join-row">
              <input
                className="app-input"
                placeholder="房间码"
                maxLength={5}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
              />
              <button className="app-btn" onClick={joinRoom}>
                加入
              </button>
            </div>
          </div>
        </div>

        <div className="panel lobby-card">
          <h3>游戏橱窗</h3>
          <div className="shelf">
            <div className="panel shelf-card" onClick={() => navigate('/help/night-of-ninja')}>
              <div className="shelf-art">
                <span>🥷</span>
                <div className="moon" />
              </div>
              <div className="shelf-body">
                <h4>忍者之夜</h4>
                <p>3–11 人 · 隐藏阵营 · 轮抽与暗杀 · 一局 15 分钟</p>
              </div>
            </div>
            <div className="panel shelf-card" style={{ opacity: 0.5, cursor: 'default' }}>
              <div className="shelf-art">
                <span>🀄</span>
              </div>
              <div className="shelf-body">
                <h4>更多游戏制作中…</h4>
                <p>下一款候选：情书 / 阿瓦隆</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
