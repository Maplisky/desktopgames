import { create } from 'zustand';
import type { GameEvent, Profile, RoomStateView } from '@dg/protocol';
import type { NonView } from '@dg/games-night-of-ninja';

export interface Toast {
  id: number;
  text: string;
  err?: boolean;
  identity?: { house: string; rank: number; otherCard?: string | null; self?: boolean };
}

export interface Prefs {
  master: number;
  bgm: number;
  sfx: number;
  particles: boolean;
}

const DEFAULT_PREFS: Prefs = { master: 0.7, bgm: 0.5, sfx: 0.8, particles: true };
const DEFAULT_PROFILE: Profile = { nickname: '', avatar: '🐱' };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface DGStore {
  profile: Profile;
  token: string | null;
  passcode: string | null;
  connected: boolean;
  passcodeNeeded: boolean;
  room: RoomStateView | null;
  gameView: NonView | null;
  /** 最近一批游戏事件（FX 层按 rev 消费） */
  lastEvents: { rev: number; events: GameEvent[] } | null;
  toasts: Toast[];
  prefs: Prefs;
  /** 最近一次服务端错误码（用于页面导航类处理） */
  lastErrorCode: string | null;
  /** 服务端已接受的最大动作 seq（断线重连后客户端据此对齐计数器） */
  lastServerSeq: number;

  setProfile: (p: Profile) => void;
  setToken: (t: string) => void;
  setPasscode: (p: string | null) => void;
  setConnected: (c: boolean) => void;
  setPasscodeNeeded: (n: boolean) => void;
  setRoom: (r: RoomStateView | null) => void;
  setGameView: (v: NonView | null) => void;
  pushEvents: (rev: number, events: GameEvent[]) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  setPrefs: (p: Partial<Prefs>) => void;
  setLastErrorCode: (c: string | null) => void;
  noteLastSeq: (n: number) => void;
}

let toastId = 0;

export const useGame = create<DGStore>((set, get) => ({
  profile: load('dg.profile', DEFAULT_PROFILE),
  token: load<string | null>('dg.token', null),
  passcode: load<string | null>('dg.passcode', null),
  connected: false,
  passcodeNeeded: false,
  room: null,
  gameView: null,
  lastEvents: null,
  toasts: [],
  prefs: load('dg.prefs', DEFAULT_PREFS),
  lastErrorCode: null,
  lastServerSeq: -1,

  setProfile: (p) => {
    localStorage.setItem('dg.profile', JSON.stringify(p));
    set({ profile: p });
  },
  setToken: (t) => {
    localStorage.setItem('dg.token', JSON.stringify(t));
    set({ token: t });
  },
  setPasscode: (p) => {
    localStorage.setItem('dg.passcode', JSON.stringify(p));
    set({ passcode: p });
  },
  setConnected: (c) => set({ connected: c }),
  setPasscodeNeeded: (n) => set({ passcodeNeeded: n }),
  setRoom: (r) =>
    set((s) => ({
      room: r,
      gameView: r && r.phase !== 'lobby' ? s.gameView : null,
      lastEvents: r && r.phase === 'lobby' ? null : s.lastEvents,
    })),
  setGameView: (v) => set({ gameView: v }),
  pushEvents: (rev, events) => set({ lastEvents: { rev, events } }),
  pushToast: (t) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.identity ? 8000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  setLastErrorCode: (c) => set({ lastErrorCode: c }),
  noteLastSeq: (n) => set((s) => (n > s.lastServerSeq ? { lastServerSeq: n } : {})),
  setPrefs: (p) => {
    const next = { ...get().prefs, ...p };
    localStorage.setItem('dg.prefs', JSON.stringify(next));
    set({ prefs: next });
  },
}));
