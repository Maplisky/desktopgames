import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useGame } from './store';
import { getSocket, sendHello } from './net/client';
import { audio } from './audio';
import Lobby from './pages/Lobby';
import Room from './pages/Room';
import Help from './pages/Help';
import Settings from './pages/Settings';
import Toasts from './components/Toasts';
import Particles from './components/Particles';

export default function App() {
  const connected = useGame((s) => s.connected);
  const room = useGame((s) => s.room);
  const location = useLocation();

  // 建立 socket + 首次手势解锁音频
  useEffect(() => {
    getSocket();
    const unlock = () => {
      audio.unlock();
      sendHello();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // 起名后自动 hello；档案变化时重新打招呼
  const profile = useGame((s) => s.profile);
  useEffect(() => {
    if (profile.nickname && connected) sendHello();
  }, [profile.nickname, connected]);

  // 主题切换：对局中 = 游戏主题包
  useEffect(() => {
    const theme = room?.phase !== 'lobby' && room?.game ? room.game.id : 'default';
    document.documentElement.setAttribute('data-theme', theme);
  }, [room?.phase, room?.game?.id]);

  // 音量同步
  const prefs = useGame((s) => s.prefs);
  useEffect(() => {
    audio.setVolumes({ master: prefs.master, bgm: prefs.bgm, sfx: prefs.sfx });
  }, [prefs.master, prefs.bgm, prefs.sfx]);

  const inGame = location.pathname.startsWith('/room/') && room && room.phase !== 'lobby';

  return (
    <>
      {!inGame && (
        <header className="topbar">
          <Link to="/" className="brand">
            桌游馆
          </Link>
          <span className="spacer" />
          <Link to="/help/night-of-ninja" className="app-btn small" style={{ textDecoration: 'none' }}>
            玩法
          </Link>
          <Link to="/settings" className="app-btn small" style={{ textDecoration: 'none' }}>
            设置
          </Link>
          <span className={`status-dot ${connected ? 'on' : ''}`} title={connected ? '已连接' : '连接中…'} />
        </header>
      )}
      <Particles enabled={prefs.particles} />
      <Routes>
        <Route path="/" element={<Lobby />} />
        <Route path="/room/:code" element={<Room />} />
        <Route path="/help/:gameId" element={<Help />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
      <Toasts />
    </>
  );
}
