import { useEffect, useRef, useState } from 'react';
import { useGame } from '../store';
import { send } from '../net/client';
import { audio } from '../audio';

const EMOJIS = ['🥷', '🗡️', '👀', '😱', '🤔', '😂', '🌸', '🐺'];

export default function ChatPanel() {
  const room = useGame((s) => s.room);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const chat = room?.chat ?? [];
  useEffect(() => {
    if (chat.length > lastCount.current && listRef.current) {
      const lastMsg = chat[chat.length - 1];
      if (lastMsg && lastMsg.kind === 'chat' && lastMsg.sessionId) audio.sfx('chat');
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
    lastCount.current = chat.length;
  }, [chat.length]);

  if (!room) return null;
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ t: 'chat', text: t.slice(0, 200) });
    setText('');
  };

  return (
    <div className="panel chat-panel">
      <h4>房间闲聊</h4>
      <div className="chat-list" ref={listRef}>
        {chat.map((m, i) => (
          <div key={i} className={`chat-msg ${m.kind}`}>
            {m.kind !== 'react' && <span className="who">{m.nickname}</span>}
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
  );
}
