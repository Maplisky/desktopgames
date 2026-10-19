/**
 * AudioDirector（DESIGN §4.4）
 * MVP 阶段无音频素材文件：BGM 用 WebAudio 合成的氛围垫乐（按场景换和弦），
 * SFX 用短促合成音。将来接入真实素材时只需替换 scene()/sfx() 的实现。
 * 首次用户手势解锁；音量三通道持久化（store.prefs）。
 */

type Scene = 'lobby' | 'draft' | 'night' | 'reveal' | 'off';

const SCENE_CHORDS: Record<Exclude<Scene, 'off'>, number[]> = {
  // 频率（Hz）— 小调开放五度，暗夜氛围
  lobby: [110, 164.81, 220, 329.63], // A 小调
  draft: [98, 146.83, 196, 293.66], // G 悬浮
  night: [87.31, 130.81, 174.61, 261.63], // F 更暗
  reveal: [130.81, 196, 261.63, 392], // C 上行
};

class AudioDirector {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private unlocked = false;
  private currentScene: Scene = 'off';
  private sceneNodes: { osc: OscillatorNode; gain: GainNode }[] = [];
  private lfoTimer: number | null = null;
  private vols = { master: 0.7, bgm: 0.5, sfx: 0.8 };

  unlock() {
    if (this.unlocked) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.bgmGain.connect(this.master);
      this.sfxGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.applyVolumes();
      this.unlocked = true;
      if (this.currentScene !== 'off') {
        const s = this.currentScene;
        this.currentScene = 'off';
        this.scene(s);
      }
    } catch {
      /* 无音频环境 */
    }
  }

  setVolumes(v: { master?: number; bgm?: number; sfx?: number }) {
    Object.assign(this.vols, v);
    this.applyVolumes();
  }

  private applyVolumes() {
    if (!this.ctx || !this.master) return;
    this.master.gain.value = this.vols.master;
    this.bgmGain!.gain.value = this.vols.bgm * 0.12;
    this.sfxGain!.gain.value = this.vols.sfx * 0.5;
  }

  /** 切换场景垫乐（交叉淡化重建，简实现） */
  scene(name: Scene) {
    if (name === this.currentScene) return;
    this.currentScene = name;
    if (!this.unlocked || !this.ctx) return;
    // 淡出旧节点
    const old = this.sceneNodes;
    for (const { osc, gain } of old) {
      gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
      setTimeout(() => osc.stop(), 1800);
    }
    this.sceneNodes = [];
    if (this.lfoTimer) {
      clearInterval(this.lfoTimer);
      this.lfoTimer = null;
    }
    if (name === 'off' || !this.bgmGain) return;
    const chord = SCENE_CHORDS[name];
    const now = this.ctx.currentTime;
    chord.forEach((freq, i) => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = freq * (i % 2 === 0 ? 1 : 1.002);
      gain.gain.value = 0;
      gain.gain.setTargetAtTime(i === 0 ? 0.5 : 0.22, now, 1.2); // 淡入
      osc.connect(gain);
      gain.connect(this.bgmGain!);
      osc.start();
      this.sceneNodes.push({ osc, gain });
    });
    // 呼吸 LFO：整体轻微起伏
    this.lfoTimer = window.setInterval(() => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (const { gain } of this.sceneNodes) {
        const base = gain.gain.value;
        gain.gain.setTargetAtTime(base * (0.9 + Math.random() * 0.2), t, 2);
      }
    }, 4000);
  }

  /** 一次性音效 */
  sfx(name: string) {
    if (!this.unlocked || !this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const tone = (
      freq: number,
      dur: number,
      type: OscillatorType = 'sine',
      vol = 0.5,
      slideTo?: number,
      delay = 0,
    ) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t + delay);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + delay + dur);
      g.gain.setValueAtTime(0, t + delay);
      g.gain.linearRampToValueAtTime(vol, t + delay + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      osc.connect(g);
      g.connect(this.sfxGain!);
      osc.start(t + delay);
      osc.stop(t + delay + dur + 0.05);
    };
    const noise = (dur: number, vol = 0.3, hp = 1200) => {
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = hp;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(filter);
      filter.connect(g);
      g.connect(this.sfxGain!);
      src.start(t);
    };
    switch (name) {
      case 'card': noise(0.12, 0.25, 900); break;
      case 'flip': noise(0.09, 0.3, 1600); tone(520, 0.1, 'triangle', 0.2, 720); break;
      case 'deal': for (let i = 0; i < 3; i++) { noise(0.08, 0.2, 1100); tone(300 + i * 60, 0.08, 'sine', 0.15, undefined, i * 0.09); } break;
      case 'reveal': tone(392, 0.35, 'triangle', 0.35, 523); noise(0.15, 0.2, 2000); break;
      case 'kill': tone(160, 0.4, 'sawtooth', 0.4, 60); noise(0.25, 0.35, 300); break; // 闷响
      case 'death': tone(220, 0.6, 'sine', 0.4, 80); break;
      case 'shield': tone(523, 0.3, 'square', 0.15, 659); tone(659, 0.3, 'square', 0.12, 784, 0.1); break;
      case 'reflect': tone(660, 0.18, 'sawtooth', 0.3, 220); break;
      case 'token': tone(880, 0.12, 'sine', 0.3, 988); tone(1318, 0.2, 'sine', 0.25, undefined, 0.1); break; // 代币
      case 'click': tone(600, 0.05, 'sine', 0.2); break;
      case 'chat': tone(740, 0.07, 'sine', 0.18, 880); break;
      case 'win': [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.5, 'triangle', 0.3, undefined, i * 0.13)); break;
      case 'spare': tone(440, 0.2, 'sine', 0.25, 330); break;
      case 'peek': tone(988, 0.1, 'sine', 0.2, 1175); break;
      /* ---- 每种牌的专属音效 ---- */
      case 'spy': tone(880, 0.1, 'sine', 0.22, 1320); tone(1320, 0.1, 'sine', 0.18, 1760, 0.1); break;
      case 'mystic': tone(523, 0.28, 'sine', 0.24, 659); tone(784, 0.34, 'sine', 0.2, undefined, 0.12); break;
      case 'trickster': tone(600, 0.09, 'square', 0.18, 900); tone(900, 0.12, 'square', 0.15, 450, 0.1); break;
      case 'grave': tone(180, 0.4, 'sine', 0.32, 90); noise(0.3, 0.22, 200); break;
      case 'coin': tone(988, 0.09, 'sine', 0.28); tone(1319, 0.16, 'sine', 0.24, undefined, 0.08); break;
      case 'steal': tone(300, 0.22, 'sawtooth', 0.22, 900); break;
      case 'judge': tone(120, 0.45, 'sawtooth', 0.4, 50); noise(0.32, 0.35, 150); break;
      case 'dark': tone(90, 0.5, 'sine', 0.38, 45); break;
      case 'stealth': tone(440, 0.18, 'sine', 0.18, 880); tone(880, 0.14, 'sine', 0.14, 440, 0.18); break;
      case 'monk': tone(1046, 0.28, 'triangle', 0.28); tone(1568, 0.4, 'triangle', 0.22, undefined, 0.1); break;
      case 'martyr': [659, 784, 988].forEach((f, i) => tone(f, 0.4, 'sine', 0.24, undefined, i * 0.1)); break;
      case 'mastermind': [220, 277, 330, 440].forEach((f, i) => tone(f, 0.5, 'triangle', 0.28, undefined, i * 0.12)); break;
      default: tone(440, 0.08, 'sine', 0.15);
    }
  }
}

export const audio = new AudioDirector();
