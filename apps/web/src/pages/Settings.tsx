import { useNavigate } from 'react-router-dom';
import { useGame } from '../store';
import { audio } from '../audio';

export default function Settings() {
  const navigate = useNavigate();
  const prefs = useGame((s) => s.prefs);
  const setPrefs = useGame((s) => s.setPrefs);

  return (
    <div className="page">
      <div className="settings-wrap">
        <button
          className="app-btn"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
        >
          ← 返回
        </button>
        <div className="panel">
          <h3 style={{ marginTop: 0, color: 'var(--gold)', fontFamily: 'var(--font-display)' }}>声音与画面</h3>
          <div className="setting-row">
            <label>总音量</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.master}
              onChange={(e) => setPrefs({ master: Number(e.target.value) })}
            />
          </div>
          <div className="setting-row">
            <label>氛围音乐</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.bgm}
              onChange={(e) => setPrefs({ bgm: Number(e.target.value) })}
            />
          </div>
          <div className="setting-row">
            <label>音效</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.sfx}
              onChange={(e) => {
                setPrefs({ sfx: Number(e.target.value) });
                audio.sfx('token');
              }}
            />
          </div>
          <div className="setting-row">
            <label>萤火虫粒子</label>
            <button className="app-btn small" onClick={() => setPrefs({ particles: !prefs.particles })}>
              {prefs.particles ? '🟢 开启' : '⚪ 关闭（低配设备）'}
            </button>
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            浏览器要求用户先点击页面后才能播放声音——如果听不到音乐，点一下页面任意位置即可。
          </p>
        </div>
      </div>
    </div>
  );
}
