/**
 * 不连飞书，检查语义流程图的解析与画板逆向是否还按同一套规则。
 * 跑法：pnpm dlx tsx scripts/check-flowchart-roundtrip.ts
 */
import { readFileSync } from 'node:fs';
import { parseEdgesFromLine, parseMermaidFlowchart } from '../packages/shared/src/diagram/parse-mermaid.ts';
import { parseMermaidClassStyles as parseClassStyles } from '../packages/shared/src/diagram/class-style.ts';
import { exportBoardNodesToMermaid } from '../packages/feishu/src/export/board-export.ts';
import { parseMermaidGraph } from '../packages/feishu/src/mermaid-subgraph.ts';

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

const styles = parseClassStyles(sample);
assert(styles.classByNodeId.get('cQFuel') === 'cond', 'cQFuel 应属于 cond');
assert(styles.styleByClass.get('cond')?.fill === '#2f7c8a', 'cond 填充色不对');

const sourcePath = 'D:/Unity/CoreJack/Docs/系统设计/core-systems.md';
try {
  const source = readFileSync(sourcePath, 'utf8');
  const camp = source.split('```mermaid')[3] ?? '';
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
