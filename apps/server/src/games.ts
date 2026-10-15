import type { GameDefinition } from '@dg/games-core';
import { nightOfNinja, type NonState } from '@dg/games-night-of-ninja';

/** 游戏注册表：新游戏在此登记即可被房间系统使用 */
export const GAMES: Record<string, GameDefinition<any>> = {
  'night-of-ninja': nightOfNinja as GameDefinition<NonState>,
};

export function gameMetaList() {
  return Object.values(GAMES).map((g) => ({
    id: g.id,
    displayName: g.displayName,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
  }));
}

export const MAX_ROOM_PLAYERS = Math.max(...Object.values(GAMES).map((g) => g.maxPlayers));
