/**
 * 不连飞书，检查语义流程图的解析与画板逆向是否还按同一套规则。
 * 跑法：pnpm dlx tsx scripts/check-flowchart-roundtrip.ts
 */
import { readFileSync } from 'node:fs';
import { parseEdgesFromLine, parseMermaidFlowchart } from '../packages/shared/src/diagram/parse-mermaid.ts';
import { parseMermaidClassStyles as parseClassStyles } from '../packages/shared/src/diagram/class-style.ts';
import { exportBoardNodesToMermaid } from '../packages/feishu/src/export/board-export.ts';
import { parseMermaidGraph } from '../packages/feishu/src/mermaid-subgraph.ts';
import { previewMermaidFlowchartBoard } from '../packages/feishu/src/board-subgraph-sections.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const sample = `
flowchart LR
subgraph gCamp ["战役系统"]
cQFuel{"燃料是否还够支付这一步"}
cSStuck["被困"]
cAWrite["写入进节点检查点"]
cQFuel -->|0| cSStuck
cQFuel -->|1| cAWrite
end
classDef cond fill:#2f7c8a,stroke:#1f5a64,color:#ffffff
classDef state fill:#e4d4f2,stroke:#8e6aad,color:#2a2038
classDef act fill:#7ebf8a,stroke:#4e8f5c,color:#102018
class cQFuel cond
class cSStuck state
class cAWrite act
`;

const edges = parseMermaidFlowchart(sample).edges;
assert(
  edges.some((edge) => edge.from === 'cQFuel' && edge.to === 'cSStuck' && edge.label === '0'),
  `条件 0 边丢失: ${JSON.stringify(edges)}`,
);
assert(
  edges.some((edge) => edge.from === 'cQFuel' && edge.to === 'cAWrite' && edge.label === '1'),
  `条件 1 边丢失: ${JSON.stringify(edges)}`,
);

const chain = parseEdgesFromLine('A -->|1| B --> C');
assert(chain.length === 2 && chain[0]?.label === '1' && !chain[1]?.label, `链式边解析错误: ${JSON.stringify(chain)}`);

const graph = parseMermaidGraph(sample);
assert(graph.nodeLabels.get('cQFuel') === '燃料是否还够支付这一步', '菱形标签不应带上语法引号');
assert(graph.nodeShapes.get('cQFuel') === 'diamond', 'cQFuel 应为菱形');
assert(graph.nodeShapes.get('cSStuck') === 'rect', 'cSStuck 应为矩形');

const preview = previewMermaidFlowchartBoard(sample);
assert(preview.diamondCount === 1, `样例菱形数量不对: ${JSON.stringify(preview)}`);
assert(preview.captionCount === 2, `样例条件标签数量不对: ${JSON.stringify(preview)}`);
assert(preview.styledCount === 3, `样例上色节点数量不对: ${JSON.stringify(preview)}`);
assert(preview.connectorCount === 2, `样例连线数量不对: ${JSON.stringify(preview)}`);
assert(preview.autoPolylineCount === preview.connectorCount, `样例连线没有在创建时写好拐点: ${JSON.stringify(preview)}`);
assert(preview.rightToLeftCount === preview.connectorCount, `样例应从右边出去、从左边进来: ${JSON.stringify(preview)}`);
assert(preview.shapeCount === 3, `样例形状数量不对: ${JSON.stringify(preview)}`);
assert(preview.overlapCount === 0, `样例节点重叠: ${preview.overlapCount}`);
assert(preview.elbowXs.length === 2, `样例两条条件线都应有竖段: ${JSON.stringify(preview.elbowXs)}`);
assert(preview.elbowXs[0] === preview.elbowXs[1], `样例两条条件线应共用一条竖线: ${JSON.stringify(preview.elbowXs)}`);
const fuelBox = preview.boxes.find((box) => box.id === 'cQFuel');
assert(Boolean(fuelBox), '样例缺少燃料判断');
assert(
  Math.abs((preview.elbowXs[0] ?? 0) - ((fuelBox?.x ?? 0) + (fuelBox?.width ?? 0) + 24)) < 0.6,
  `样例竖线应离起点右缘 24: ${JSON.stringify(preview.elbowXs)} / ${JSON.stringify(fuelBox)}`,
);

const styles = parseClassStyles(sample);
assert(styles.classByNodeId.get('cQFuel') === 'cond', 'cQFuel 应属于 cond');
assert(styles.styleByClass.get('cond')?.fill === '#2f7c8a', 'cond 填充色不对');

const sourcePath = 'D:/Unity/CoreJack/Docs/系统设计/core-systems.md';
try {
  const source = readFileSync(sourcePath, 'utf8');
  const fences = source.split('```mermaid').slice(1).map((part) => part.split('```')[0] ?? '');
  assert(fences.length >= 6, `core-systems 流程图数量不对: ${fences.length}`);
  fences.forEach((fence, index) => {
    const parsed = parseMermaidGraph(fence);
    const drawn = previewMermaidFlowchartBoard(fence);
    const classStyles = parseClassStyles(fence);
    const diamondExpected = [...parsed.nodeShapes.values()].filter((shape) => shape === 'diamond').length;
    const captionExpected = parsed.edges.filter((edge) => edge.label).length;
    let styledExpected = 0;
    for (const nodeId of parsed.nodeLabels.keys()) {
      const className = classStyles.classByNodeId.get(nodeId);
      if (className && classStyles.styleByClass.has(className)) styledExpected += 1;
    }
    assert(drawn.shapeCount === parsed.nodeLabels.size, `第 ${index + 1} 图节点没画全: ${JSON.stringify(drawn)} / ${parsed.nodeLabels.size}`);
    assert(drawn.diamondCount === diamondExpected, `第 ${index + 1} 图菱形不对: ${drawn.diamondCount} != ${diamondExpected}`);
    assert(drawn.connectorCount === parsed.edges.length, `第 ${index + 1} 图连线不对: ${drawn.connectorCount} != ${parsed.edges.length}`);
    assert(drawn.autoPolylineCount === drawn.connectorCount, `第 ${index + 1} 图连线没有在创建时写好拐点`);
    assert(drawn.rightToLeftCount === drawn.connectorCount, `第 ${index + 1} 图不是左进右出`);
    assert(drawn.captionCount === captionExpected, `第 ${index + 1} 图条件标签不对: ${drawn.captionCount} != ${captionExpected}`);
    assert(drawn.styledCount === styledExpected, `第 ${index + 1} 图上色不对: ${drawn.styledCount} != ${styledExpected}`);
    assert(drawn.overlapCount === 0, `第 ${index + 1} 图节点重叠: ${drawn.overlapCount} ${drawn.overlapSample.join(' | ')}`);
  });
  const joinDrawn = previewMermaidFlowchartBoard(fences[1] ?? '');
  const joinAt = (id: string) => {
    const box = joinDrawn.boxes.find((item) => item.id === id);
    assert(Boolean(box), `咬合图缺少 ${id}`);
    return box!;
  };
  const joinRoot = joinAt('oRRoot');
  const joinCamp = joinAt('oYCamp');
  const joinTask = joinAt('oYTask');
  const joinShipSys = joinAt('oYShip');
  const joinShip = joinAt('oOShip');
  const joinNotifyHit = joinAt('oNHit');
  const joinHit = joinAt('oVHit');
  assert(joinShipSys.y < joinTask.y && joinTask.y < joinCamp.y, '咬合图纵向顺序应与 GitHub 的分层结果一致');
  assert(
    joinRoot.x < joinTask.x && joinTask.x < joinShip.x && joinShip.x < joinNotifyHit.x && joinNotifyHit.x < joinHit.x,
    '咬合图应按 Dagre 从左到右分层，而不是贴着父节点往右堆',
  );
  assert(joinCamp.x > joinTask.x, '战役系统应落到更靠右的层，避免和任务系统挤在同一列');
  const camp = fences[2] ?? '';
  const campGraph = parseMermaidGraph(camp);
  const fuelEdges = campGraph.edges.filter((edge) => edge.from === 'cQFuel');
  assert(
    fuelEdges.some((edge) => edge.to === 'cSStuck' && edge.label === '0') &&
      fuelEdges.some((edge) => edge.to === 'cAWriteFuel' && edge.label === '1'),
    `战役图条件边丢失: ${JSON.stringify(fuelEdges)}`,
  );
  const campStyles = parseClassStyles(camp);
  assert(campStyles.classByNodeId.get('cQFuel') === 'cond', '战役图 cQFuel 应是 cond');
  assert(campStyles.styleByClass.get('obj')?.fill === '#3b7fc4', 'obj 配色未读到');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    console.log(`跳过外部文稿：${sourcePath}`);
  } else {
    throw error;
  }
}

const exported = exportBoardNodesToMermaid([
  { id: 'sec1', type: 'section', x: 0, y: 0, width: 800, height: 240, section: { title: '战役系统' } },
  {
    id: 'cQFuel',
    type: 'composite_shape',
    parent_id: 'sec1',
    x: 0,
    y: 40,
    width: 160,
    height: 80,
    text: { text: '燃料是否还够支付这一步', text_color: '#ffffff', text_color_type: 1 },
    composite_shape: { type: 'flow_chart_diamond' },
    style: { fill_color: '#2F7C8A', fill_color_type: 1, border_color: '#1f5a64', border_color_type: 1 },
  },
  {
    id: 'cSStuck',
    type: 'composite_shape',
    parent_id: 'sec1',
    x: 400,
    y: 0,
    width: 120,
    height: 56,
    text: { text: '被困', text_color: '#2a2038', text_color_type: 1 },
    composite_shape: { type: 'round_rect' },
    style: { fill_color: '#e4d4f2', fill_color_type: 1, border_color: '#8e6aad', border_color_type: 1 },
  },
  {
    id: 'cAWrite',
    type: 'composite_shape',
    parent_id: 'sec1',
    x: 400,
    y: 120,
    width: 180,
    height: 56,
    text: { text: '写入进节点检查点', text_color: '#102018', text_color_type: 1 },
    composite_shape: { type: 'round_rect' },
    style: { fill_color: '#7ebf8a', fill_color_type: 1, border_color: '#4e8f5c', border_color_type: 1 },
  },
  {
    id: 'c1',
    type: 'connector',
    connector: {
      start_object: { id: 'cQFuel' },
      end_object: { id: 'cSStuck' },
      captions: { data: [{ text: '0' }] },
    },
  },
  {
    id: 'c2',
    type: 'connector',
    connector: {
      start_object: { id: 'cQFuel' },
      end_object: { id: 'cAWrite' },
      captions: { data: [{ text: '1' }] },
    },
  },
]);

assert(Boolean(exported), '逆向结果为空');
const pieces = [
  'flowchart LR',
  'subgraph g1 ["战役系统"]',
  'cQFuel{"燃料是否还够支付这一步"}',
  'cSStuck["被困"]',
  'cQFuel -->|0| cSStuck',
  'cQFuel -->|1| cAWrite',
  'classDef cond fill:#2f7c8a,stroke:#1f5a64,color:#ffffff',
  'classDef state fill:#e4d4f2,stroke:#8e6aad,color:#2a2038',
  'classDef act fill:#7ebf8a,stroke:#4e8f5c,color:#102018',
  'class cQFuel cond',
  'class cSStuck state',
  'class cAWrite act',
];
for (const piece of pieces) {
  assert(exported!.includes(piece), `逆向缺少「${piece}」\n${exported}`);
}

const plain = exportBoardNodesToMermaid([
  {
    id: 'o1:1',
    type: 'composite_shape',
    x: 0,
    y: 0,
    width: 80,
    height: 40,
    text: { text: '甲' },
    composite_shape: { type: 'round_rect' },
    style: { fill_color: '#ffffff', fill_color_type: 0 },
  },
  {
    id: 'o1:2',
    type: 'composite_shape',
    x: 0,
    y: 200,
    width: 80,
    height: 40,
    text: { text: '乙' },
    composite_shape: { type: 'round_rect' },
  },
  {
    id: 'c',
    type: 'connector',
    connector: { start_object: { id: 'o1:1' }, end_object: { id: 'o1:2' } },
  },
]);
assert(plain?.startsWith('flowchart TD') === true, `未着色竖图应是 TD:\n${plain}`);
assert(!plain?.includes('classDef'), `未着色图不应生成 classDef:\n${plain}`);
assert(plain?.includes('["甲"]') === true && plain.includes('-->'), `普通节点或连线丢失:\n${plain}`);

console.log('flowchart roundtrip ok');
