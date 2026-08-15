/**
 * A level probe, for diagnosing what the solver can and cannot reach.
 *
 * Prints the level as text with reachable stand spots marked, so an unreachable pickup can be
 * seen in context rather than inferred from a coordinate. This is the tool that turns "seven
 * pickups cannot be reached" into "the chain of platforms breaks here".
 *
 *   node Emberwake/tools/probe.mjs w1l2
 */

import { parseLevel, solve, audit, LEVELS, abilitiesAtLevel, TILE, MAX_JUMP_HEIGHT, MAX_JUMP_RUN }
  from '../build/test/core.mjs';

const id = process.argv[2] ?? 'w1l1';
const def = LEVELS.find((l) => l.id === id);
if (!def) {
  console.error(`no level "${id}". Known: ${LEVELS.map((l) => l.id).join(', ')}`);
  process.exit(1);
}

const level = parseLevel(def);
const abilities = abilitiesAtLevel(id);
const result = solve(level, abilities);

console.log(`\n${def.id} — ${def.name}`);
console.log(`  reach: a jump rises ${(MAX_JUMP_HEIGHT / TILE).toFixed(2)} tiles `
          + `and crosses ${(MAX_JUMP_RUN / TILE).toFixed(2)}`);
console.log(`  abilities: ${JSON.stringify(abilities)}`);
console.log(`  stand spots reached: ${result.reach.spots.size} / ${result.reach.total}`);
console.log(`  goal reachable: ${result.goalReachable}`);
for (const p of audit(level)) console.log(`  AUDIT: ${p}`);
for (const p of result.problems) console.log(`  PROBLEM: ${p}`);

const rows = def.rows.map((r) => r.padEnd(level.map.width, ' ').split(''));
// Mark reachable stand spots with a middle dot, so the shape of the reachable region is visible.
for (const key of result.reach.spots) {
  const [tx, ty] = key.split(',').map(Number);
  if (rows[ty] && rows[ty][tx] === ' ') rows[ty][tx] = '·';
}
// Mark stranded pickups with an X.
for (const p of result.unreachablePickups) {
  const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
  if (rows[ty]) rows[ty][tx] = 'X';
}
console.log();
for (const [i, row] of rows.entries()) {
  console.log(String(i).padStart(2) + ' ' + row.join(''));
}
console.log('   ' + Array.from({ length: level.map.width }, (_, i) => (i % 10 === 0 ? '|' : ' ')).join(''));
console.log();
