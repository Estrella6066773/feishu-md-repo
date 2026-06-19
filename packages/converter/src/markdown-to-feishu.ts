import { remark } from 'remark';
import remarkParse from 'remark-parse';
import type { Root, Content } from 'mdast';
import type { FeishuBlock } from './types.js';

export async function markdownToFeishuBlocks(markdown: string): Promise<FeishuBlock[]> {
  const tree = remark().use(remarkParse).parse(markdown) as Root;
  return tree.children.flatMap(convertNode);
}

function convertNode(node: Content): FeishuBlock[] {
  switch (node.type) {
    case 'heading':
      return [
        {
          blockType: 'heading',
          content: {
            level: node.depth,
            text: extractText(node),
          },
        },
      ];
    case 'paragraph':
      return [
        {
          blockType: 'paragraph',
          content: {
            text: extractText(node),
          },
        },
      ];
    case 'code':
      return [
        {
          blockType: 'code',
          content: {
            language: node.lang ?? 'text',
            text: node.value,
          },
        },
      ];
    default:
      return [
        {
          blockType: 'paragraph',
          content: {
            text: extractText(node),
          },
        },
      ];
  }
}

function extractText(node: Content): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.value;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((child) => extractText(child as Content)).join('');
  }
  return '';
}
