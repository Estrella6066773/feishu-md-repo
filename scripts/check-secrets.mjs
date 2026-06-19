#!/usr/bin/env node
/**
 * 提交前扫描：检测工作区/暂存区中是否含常见密钥或本地数据库。
 * 用法：node scripts/check-secrets.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';

const IGNORE_PATH_RE =
  /(?:^|\/)(node_modules|dist|\.turbo|\.git|apps\/desktop\/src-tauri\/target)(?:\/|$)/;

const BLOCKED_FILE_RE =
  /(?:^|\/)\.env(?!\.example)|\.db(?:-journal|-wal|-shm)?$|\.sqlite3?$|credentials\.json$|secrets\.json$/i;

const SECRET_PATTERNS = [
  { name: '飞书 app_secret 字段', re: /"app_secret"\s*:\s*"(?!xxx|your_|placeholder)[^"]{8,}"/i },
  { name: '飞书 App Secret 明文', re: /\bapp_secret\s*=\s*[^\s#]{8,}/i },
  { name: 'tenant_access_token', re: /\bt-[a-zA-Z0-9_-]{20,}\b/ },
  { name: 'user_access_token', re: /\bu-[a-zA-Z0-9_-]{20,}\b/ },
];

function listCandidateFiles() {
  const files = new Set();
  try {
    const tracked = execSync('git ls-files -z', { encoding: 'buffer' })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    for (const f of tracked) files.add(f);
  } catch {
    // 未初始化 git 时扫描常见源码目录
  }

  try {
    const unstaged = execSync('git diff --name-only -z HEAD 2>nul || git diff --name-only -z', {
      encoding: 'buffer',
      shell: true,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    for (const f of unstaged) files.add(f);
  } catch {
    // ignore
  }

  if (files.size === 0) {
    return ['apps', 'packages', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example'];
  }
  return [...files];
}

const findings = [];

for (const file of listCandidateFiles()) {
  if (IGNORE_PATH_RE.test(file)) continue;
  if (BLOCKED_FILE_RE.test(file)) {
    findings.push({ file, reason: '禁止纳入版本库的文件类型' });
    continue;
  }
  if (!existsSync(file)) continue;

  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  if (content.includes('\0')) continue;

  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      findings.push({ file, reason: `疑似 ${name}` });
      break;
    }
  }
}

if (findings.length === 0) {
  console.log('check-secrets: 未发现明显敏感内容。');
  process.exit(0);
}

console.error('check-secrets: 发现潜在敏感内容，请移除后再提交：\n');
for (const item of findings) {
  console.error(`  - ${relative(process.cwd(), item.file)} (${item.reason})`);
}
console.error('\n详见 SECURITY.md');
process.exit(1);
