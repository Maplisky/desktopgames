import { io, type Socket } from 'socket.io-client';
import { SOCKET_EVENT, type C2S, type S2C } from '@dg/protocol';
import { useGame } from '../store';
import { audio } from '../audio';

let sock: Socket | null = null;

export function getSocket(): Socket {
  if (sock) return sock;
  sock = io({ transports: ['websocket'] });
  const st = useGame.getState;

  sock.on('connect', () => {
    st().setConnected(true);
    sendHello();
  });
  sock.on('disconnect', () => st().setConnected(false));
  sock.on(SOCKET_EVENT, (raw: unknown) => {
    const m = raw as S2C;
    switch (m.t) {
      case 'helloAck':
        st().setToken(m.sessionToken);
        st().setPasscodeNeeded(false);
        break;
      case 'room':
        st().setRoom(m.room);
        st().setLastErrorCode(null); // 成功收到房间视图 → 清除导航类错误码
        if (m.room.phase === 'lobby') audio.scene('lobby');
        else if (m.room.game?.id === 'night-of-ninja') audio.scene('night');
        break;
      case 'gameSync':
        st().setGameView(m.view as never);
        if (typeof m.lastSeq === 'number') st().noteLastSeq(m.lastSeq);
        break;
      case 'gameEvents':
        st().pushEvents(m.rev, m.events);
        break;
      case 'error':
        st().setLastErrorCode(m.code);
        if (m.code === 'passcode') st().setPasscodeNeeded(true);
        else st().pushToast({ text: m.message, err: true });
        break;
      case 'left':
        st().setRoom(null);
        audio.scene('lobby');
        break;
    }
  });
  return sock;
}

export function send(msg: C2S) {
  const s = sock ?? getSocket();
  s.emit(SOCKET_EVENT, msg);
}

export function sendHello() {
  const st = useGame.getState();
  if (!st.profile.nickname) return; // 大厅里先起名
  send({
    t: 'hello',
    profile: st.profile,
    sessionToken: st.token ?? undefined,
    passcode: st.passcode ?? undefined,
  });
}
