import { Game, group, neighbors } from '../build/test/core.mjs';

const angles = Array.from({ length: 201 }, (_, i) => (i - 100) * .75 * Math.PI / 180);

function paths(game) {
  const unique = new Map();
  for (const angle of angles) {
    const path = game.trace(angle);
    if (path.slot >= 0 && !unique.has(path.slot)) unique.set(path.slot, path);
  }
  return [...unique.values()];
}

function rate(game, result) {
  const setup = result.removed.length ? 0 : group(game.board, result.hit).length;
  const edges = neighbors[result.hit].filter(cell => game.board[cell] === game.current).length;
  return -game.left * 6 - game.deepest * 2 - game.drop * 1.8 - game.pressure * 1.25 + setup * 2.7 + edges;
}

export function solve(index, width = 5) {
  const start = new Game(index);
  let frontier = [start];
  for (let step = 0; step < 140 && frontier.length; step++) {
    const candidates = new Map();
    for (const game of frontier) {
      const moves = paths(game);
      const picks = [0];
      if (game.next !== game.current) picks.push(1);
      if (game.reserve !== game.current && game.reserve !== game.next) picks.push(2);
      for (const path of moves) for (const swap of picks) {
        const next = game.clone();
        if (swap) next.swap(swap);
        const result = next.resolve(path);
        if (next.status === 'won') return next;
        if (next.status !== 'playing') continue;
        const key = `${next.current}/${next.next}/${next.reserve}/${next.drop}/${next.pressure}/${next.board.join('')}`;
        const value = rate(next, result);
        if (!candidates.has(key) || value > candidates.get(key).value) candidates.set(key, { next, value });
      }
    }
    frontier = [...candidates.values()].sort((a, b) => b.value - a.value).slice(0, width).map(entry => entry.next);
  }
}
