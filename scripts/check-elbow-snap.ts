import assert from 'node:assert/strict';
import { planSharedVerticalBuses, routeBlockHitCount, separateBlocksFromRoutes } from '../packages/feishu/src/board-connector-elbows.ts';

const shared = planSharedVerticalBuses([
  {
    payloadIndex: 0,
    groupKey: 'parent',
    boxX: 100,
    boxY: 0,
    boxWidth: 200,
    boxHeight: 80,
    turningPoints: [{ x: 40, y: 80 }, { x: 40, y: 0 }],
  },
  {
    payloadIndex: 1,
    groupKey: 'parent',
    boxX: 100,
    boxY: 100,
    boxWidth: 300,
    boxHeight: 60,
    turningPoints: [{ x: 80, y: 0 }, { x: 80, y: 60 }],
  },
  {
    payloadIndex: 2,
    groupKey: 'parent',
    boxX: 100,
    boxY: 40,
    boxWidth: 280,
    boxHeight: 0,
    turningPoints: [],
  },
]);

assert.equal(shared.get(0)?.turningPoints[0]?.x, 24);
assert.equal(shared.get(1)?.turningPoints[0]?.x, 24);
assert.equal(shared.has(2), false);

const separated = planSharedVerticalBuses([
  {
    payloadIndex: 0,
    groupKey: 'parent-a',
    boxX: 100,
    boxY: 0,
    boxWidth: 200,
    boxHeight: 160,
    turningPoints: [{ x: 40, y: 0 }, { x: 40, y: 160 }],
  },
  {
    payloadIndex: 1,
    groupKey: 'parent-b',
    boxX: 100,
    boxY: 20,
    boxWidth: 180,
    boxHeight: 40,
    turningPoints: [{ x: 30, y: 0 }, { x: 30, y: 40 }],
  },
  {
    payloadIndex: 2,
    groupKey: 'parent-c',
    boxX: 100,
    boxY: 400,
    boxWidth: 200,
    boxHeight: 40,
    turningPoints: [{ x: 50, y: 0 }, { x: 50, y: 40 }],
  },
]);

assert.equal(separated.get(0)?.turningPoints[0]?.x, 24);
assert.equal(separated.get(1)?.turningPoints[0]?.x, 40);
assert.equal(separated.get(2)?.turningPoints[0]?.x, 24);

const expanded = planSharedVerticalBuses([
  {
    payloadIndex: 0,
    groupKey: 'parent',
    boxX: 0,
    boxY: 0,
    boxWidth: 4,
    boxHeight: 40,
    turningPoints: [{ x: 2, y: 0 }, { x: 2, y: 40 }],
  },
  {
    payloadIndex: 1,
    groupKey: 'parent',
    boxX: 0,
    boxY: 50,
    boxWidth: 200,
    boxHeight: 80,
    turningPoints: [{ x: 10, y: 0 }, { x: 10, y: 80 }],
  },
]);

assert.equal(expanded.get(0)?.boxWidth, 24);
assert.equal(expanded.get(0)?.turningPoints[0]?.x, 24);
assert.equal(expanded.get(1)?.turningPoints[0]?.x, 24);

const blocks = [
  { id: 'source', x: 0, y: 0, width: 100, height: 40 },
  { id: 'near', x: 110, y: 80, width: 80, height: 40 },
  { id: 'far', x: 360, y: 200, width: 80, height: 40 },
  { id: 'wide', x: 0, y: 140, width: 160, height: 40 },
  { id: 'blocker', x: 200, y: 0, width: 80, height: 40 },
];
const edges = [
  { from: 'source', to: 'near' },
  { from: 'source', to: 'far' },
  { from: 'source', to: 'blocker' },
];
separateBlocksFromRoutes(blocks, edges);
assert.equal(routeBlockHitCount(blocks, edges), 0, `线仍然穿过块: ${JSON.stringify(blocks)}`);
for (let left = 0; left < blocks.length; left += 1) {
  for (let right = left + 1; right < blocks.length; right += 1) {
    const a = blocks[left]!;
    const b = blocks[right]!;
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    assert.ok(overlapX <= 0.5 || overlapY <= 0.5, `块叠在一起: ${a.id} ${b.id}`);
  }
}
const byId = new Map(blocks.map((block) => [block.id, block]));
assert.ok((byId.get('near')?.x ?? 0) >= 100 + 24 + 8, '近处目标应让开竖线');
assert.ok((byId.get('wide')?.x ?? 0) + (byId.get('wide')?.width ?? 0) <= 100 + 24 - 8
  || (byId.get('wide')?.x ?? 0) >= 100 + 24 + 8, '宽块不应盖住竖线');

console.log('shared vertical bus checks passed');
