import type { LegendEntry } from './types.js';

/** 交互链默认图例（与策划图例一致） */
export const INTERACTION_CHAIN_LEGEND: LegendEntry[] = [
  {
    type: 'goal',
    label: '目标',
    labelPrefixes: ['目标：', '目标:'],
    idPrefixes: ['G_'],
    style: { fill: '#1e40af', text: '#ffffff', border: '#1e3a8a' },
  },
  {
    type: 'action',
    label: '行为',
    labelPrefixes: ['行为：', '行为:'],
    idPrefixes: ['A_'],
    style: { fill: '#facc15', text: '#000000', border: '#ca8a04' },
  },
  {
    type: 'obstacle',
    label: '障碍',
    labelPrefixes: ['障碍：', '障碍:'],
    idPrefixes: ['O_'],
    style: { fill: '#000000', text: '#ffffff', border: '#374151' },
  },
  {
    type: 'reward',
    label: '奖励',
    labelPrefixes: ['奖励：', '奖励:'],
    idPrefixes: ['R_'],
    style: { fill: '#86efac', text: '#000000', border: '#4ade80' },
  },
  {
    type: 'decision',
    label: '决策信息',
    labelPrefixes: ['决策信息：', '决策信息:'],
    idPrefixes: ['D_'],
    style: { fill: '#ffffff', text: '#000000', border: '#93c5fd' },
  },
  {
    type: 'feedback',
    label: '反馈',
    labelPrefixes: ['反馈：', '反馈:'],
    idPrefixes: ['F_'],
    style: { fill: '#e5e7eb', text: '#000000', border: '#9ca3af' },
  },
  {
    type: 'topic',
    label: '主题',
    labelPrefixes: [],
    idPrefixes: ['T_', 'T'],
    style: { fill: '#1e40af', text: '#ffffff', border: '#1e3a8a' },
  },
];

export const DIAGRAM_PRESETS = {
  'interaction-chain': {
    id: 'interaction-chain',
    name: '交互链',
    legend: INTERACTION_CHAIN_LEGEND,
  },
} as const;

export type DiagramPresetId = keyof typeof DIAGRAM_PRESETS;
