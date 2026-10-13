import assert from 'node:assert/strict';
import { planSharedVerticalBuses } from '../packages/feishu/src/board-connector-elbows.ts';

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

console.log('shared vertical bus checks passed');
