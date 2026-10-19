import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store';
import { send } from '../net/client';
import { audio } from '../audio';

const EMOJIS = ['🥷', '🗡️', '👀', '😱', '🤔', '😂', '🌸', '🐺'];
const UI_KEY = 'dg.chatui';
const PANEL_W = 268;

interface ChatUiState {
  x: number;
  y: number;
  collapsed: boolean;
}

function defaultUi(): ChatUiState {
  return { x: Math.max(8, window.innerWidth - PANEL_W - 16), y: 70, collapsed: false };
}

function loadUi(): ChatUiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const p = JSON.parse(raw) as ChatUiState;
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return {
          x: Math.max(4, Math.min(window.innerWidth - 80, p.x)),
          y: Math.max(4, Math.min(window.innerHeight - 60, p.y)),
          collapsed: !!p.collapsed,
        };
      }
    }
  } catch {
    /* 忽略损坏的本地状态 */
  }
  return defaultUi();
}

/** 可拖动、可收起的悬浮聊天窗（等待室与对局共用，位置记忆持久化） */
export default function ChatPanel() {
  const room = useGame((s) => s.room);
  const [text, setText] = useState('');
  const [ui, setUi] = useState<ChatUiState>(loadUi);
  const [unread, setUnread] = useState(0);
  const [dragging, setDragging] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const lastCount = useRef(0);

  const chat = room?.chat ?? [];
  useEffect(() => {
    if (chat.length > lastCount.current) {
      const delta = chat.length - lastCount.current;
      const lastMsg = chat[chat.length - 1];
      if (lastMsg && lastMsg.kind === 'chat' && lastMsg.sessionId) audio.sfx('chat');
      if (ui.collapsed) setUnread((u) => u + delta);
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    lastCount.current = chat.length;
  }, [chat.length, ui.collapsed]);

  // 视口变化时收进边界
  useEffect(() => {
    const clamp = () =>
      setUi((u) => ({
        ...u,
        x: Math.max(4, Math.min(window.innerWidth - 80, u.x)),
        y: Math.max(4, Math.min(window.innerHeight - 60, u.y)),
      }));
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  const persist = (s: ChatUiState) => {
    setUi(s);
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(s));
    } catch {
      /* 隐私模式下忽略 */
    }
  };

  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = panelRef.current!.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const x = Math.max(4, Math.min(window.innerWidth - 90, e.clientX - dragRef.current.dx));
    const y = Math.max(4, Math.min(window.innerHeight - 50, e.clientY - dragRef.current.dy));
    setUi((u) => ({ ...u, x, y }));
  };
  const onHeadUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    setUi((u) => {
      persist(u);
      return u;
    });
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ t: 'chat', text: t.slice(0, 200) });
    setText('');
  };

  if (ui.collapsed) {
    return (
      <button
        className="chat-pill"
        style={{ left: ui.x, top: ui.y }}
        title="打开聊天"
        onClick={() => {
          persist({ ...ui, collapsed: false });
          setUnread(0);
        }}
      >
        💬
        {unread > 0 && <span className="chat-unread">{unread > 9 ? '9+' : unread}</span>}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className={`chat-float ${dragging ? 'dragging' : ''}`}
      style={{ left: ui.x, top: ui.y, width: PANEL_W }}
    >
      <div
        className="chat-float-head"
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
      >
        <span>💬 房间闲聊</span>
        <button
          className="chat-collapse"
          title="收起聊天"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => persist({ ...ui, collapsed: true })}
        >
          −
        </button>
      </div>
      <div className="chat-panel">
        <div className="chat-list" ref={listRef}>
          {chat.map((m, i) => (
            <div key={i} className={`chat-msg ${m.kind}`}>
              <span className="who">{m.nickname}</span>
              {m.text}
            </div>
          ))}
        </div>
        <div className="emoji-row">
          {EMOJIS.map((e) => (
            <button key={e} onClick={() => send({ t: 'react', emoji: e })} title="发送表情">
              {e}
            </button>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            className="app-input"
            value={text}
            maxLength={200}
            placeholder="说点什么…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button className="app-btn" onClick={submit}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
