import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Binding, FeishuTargetType, NodeMapping, SyncMode } from '@feishu-md/shared';
import {
  SYNC_OVERVIEW_GIT_PATH,
  SYNC_OVERVIEW_TITLE,
  isReservedSyncGitPath,
} from '@feishu-md/shared';
import type { DbClient } from '@feishu-md/db';
import {
  getNodeMappingByGitPath,
  listNodeMappings,
  upsertNodeMapping,
} from '@feishu-md/db';
import type { FeishuClient, FeishuTargetAdapter, NodeRef } from '@feishu-md/feishu';
import {
  ensureWhiteboardInDocument,
  replaceBoardLinkMindMap,
  toFeishuDocumentUrl,
  type BoardMindMapLinkNode,
} from '@feishu-md/feishu';

interface StructureTreeNode {
  label: string;
  gitPath: string;
  url: string;
  children: StructureTreeNode[];
}

const OVERVIEW_NATIVE_BOARD_VERSION = 2;

export async function syncOverviewWhiteboard(options: {
  binding: Binding;
  db: DbClient;
  client: FeishuClient;
  adapter: FeishuTargetAdapter;
  targetType: FeishuTargetType;
  syncMode: SyncMode;
}): Promise<boolean> {
  const { binding, db, client, adapter, targetType, syncMode } = options;
  const mappings = await listNodeMappings(db, binding.id);
  const tree = buildStructureTree(mappings, binding.name, syncMode);
  if (!tree) return false;

  const linkNodes = flattenStructureTree(tree);
  const mindMapHash = hashContent(
    `${OVERVIEW_NATIVE_BOARD_VERSION}:${JSON.stringify(linkNodes)}`,
  );

  const existing = await getNodeMappingByGitPath(db, binding.id, SYNC_OVERVIEW_GIT_PATH);
  if (existing?.contentSha === mindMapHash) {
    return false;
  }

  const parentToken = adapter.getRootParentToken();
  const existingRef = existing ? mappingToNodeRef(existing) : undefined;
  const doc = await adapter.ensureDocument(
    SYNC_OVERVIEW_GIT_PATH,
    parentToken,
    SYNC_OVERVIEW_TITLE,
    existingRef,
  );

  const docToken = doc.docToken ?? doc.token;
  const whiteboardId = await ensureWhiteboardInDocument(client, docToken);
  await replaceBoardLinkMindMap(client, whiteboardId, linkNodes);

  await upsertNodeMapping(db, {
    id: existing?.id ?? randomUUID(),
    bindingId: binding.id,
    gitPath: SYNC_OVERVIEW_GIT_PATH,
    feishuTargetType: targetType,
    feishuNodeToken: doc.nodeToken ?? doc.token,
    feishuDocToken: docToken,
    feishuNodeType: 'docx',
    feishuParentToken: parentToken,
    contentSha: mindMapHash,
  });

  return true;
}

function buildStructureTree(
  mappings: NodeMapping[],
  bindingName: string,
  syncMode: SyncMode,
): StructureTreeNode | null {
  const relevant = mappings.filter(
    (mapping) =>
      !isReservedSyncGitPath(mapping.gitPath) &&
      (mapping.feishuNodeType === 'docx' || mapping.feishuNodeType === 'folder'),
  );
  if (relevant.length === 0) return null;

  const rootTitle = bindingName.trim() || '项目';
  const rootMapping = relevant.find((mapping) => mapping.gitPath.replace(/\\/g, '/') === '');
  const root: StructureTreeNode = {
    gitPath: '',
    label: rootMapping ? mappingLabel(rootMapping, rootTitle, syncMode) : rootTitle,
    url: rootMapping ? toFeishuDocumentUrl(rootMapping) : toFeishuDocumentUrl(relevant[0]!),
    children: [],
  };
  const nodeByPath = new Map<string, StructureTreeNode>([['', root]]);

  const sorted = [...relevant].sort((left, right) =>
    compareGitPaths(left.gitPath, right.gitPath),
  );

  for (const mapping of sorted) {
    const gitPath = mapping.gitPath.replace(/\\/g, '/');
    if (gitPath === '') continue;

    const node: StructureTreeNode = {
      gitPath,
      label: mappingLabel(mapping, rootTitle, syncMode),
      url: toFeishuDocumentUrl(mapping),
      children: [],
    };
    nodeByPath.set(gitPath, node);

    const parentPath = gitPath.includes('/') ? gitPath.slice(0, gitPath.lastIndexOf('/')) : '';
    const parent = nodeByPath.get(parentPath) ?? root;
    parent.children.push(node);
  }

  sortStructureTree(root);
  return root;
}

function compareGitPaths(left: string, right: string): number {
  const leftNorm = left.replace(/\\/g, '/');
  const rightNorm = right.replace(/\\/g, '/');
  const leftParts = leftNorm ? leftNorm.split('/') : [];
  const rightParts = rightNorm ? rightNorm.split('/') : [];
  const depth = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < depth; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const partOrder = comparePathSegment(leftPart, rightPart);
    if (partOrder !== 0) return partOrder;
  }

  return leftNorm.localeCompare(rightNorm, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function comparePathSegment(left: string, right: string): number {
  const leftIsFolder = !posix.extname(left);
  const rightIsFolder = !posix.extname(right);
  if (leftIsFolder !== rightIsFolder) {
    return leftIsFolder ? -1 : 1;
  }
  return left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function mappingLabel(mapping: NodeMapping, bindingName: string, syncMode: SyncMode): string {
  const gitPath = mapping.gitPath.replace(/\\/g, '/');
  if (!gitPath) return bindingName.trim() || '根目录';

  if (syncMode === 'repository') {
    const parts = gitPath.split('/');
    return parts[parts.length - 1] || bindingName;
  }

  if (mapping.feishuNodeType === 'folder') {
    return posix.basename(gitPath) || gitPath;
  }

  return posix.basename(gitPath) || gitPath;
}

function sortStructureTree(node: StructureTreeNode): void {
  node.children.sort((left, right) => compareGitPaths(left.gitPath, right.gitPath));
  for (const child of node.children) {
    sortStructureTree(child);
  }
}

function flattenStructureTree(root: StructureTreeNode): BoardMindMapLinkNode[] {
  const nodes: BoardMindMapLinkNode[] = [];
  let idCounter = 0;

  function nextNodeId(): string {
    idCounter += 1;
    return `m${idCounter}:1`;
  }

  function walk(
    node: StructureTreeNode,
    parentId: string | undefined,
    zIndex: number,
    depth: number,
  ): void {
    const id = nextNodeId();
    nodes.push({
      id,
      label: node.label,
      url: node.url,
      parentId,
      zIndex,
      isRoot: parentId == null,
      layoutPosition: depth === 1 ? 'right' : undefined,
    });
    node.children.forEach((child, index) => {
      walk(child, id, index, depth + 1);
    });
  }

  walk(root, undefined, 0, 0);
  return nodes;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function mappingToNodeRef(mapping: NodeMapping): NodeRef {
  return {
    token: mapping.feishuNodeToken,
    nodeToken: mapping.feishuNodeToken,
    docToken: mapping.feishuDocToken ?? (mapping.feishuNodeType === 'docx' ? mapping.feishuNodeToken : undefined),
    nodeType: mapping.feishuNodeType,
  };
}

export { buildStructureTree, flattenStructureTree, mappingLabel, compareGitPaths };
