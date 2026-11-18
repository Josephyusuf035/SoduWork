'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const markedSource = fs.readFileSync(path.join(root, 'vendor/markdown/marked.umd.js'), 'utf8');
const dialectSource = fs.readFileSync(path.join(root, 'core/markdown.js'), 'utf8');

// Renderer path: desk.html loads the vendored bundle, then core/markdown.js.
function rendererMarked({ dialect = true } = {}) {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.runInNewContext(markedSource + (dialect ? '\n' + dialectSource : ''), sandbox);
  return sandbox.marked;
}

const html = (marked, source) => marked.parse(source, { gfm: true, breaks: false }).trim();
const plain = rendererMarked({ dialect: false });
const renderer = rendererMarked();
// Main-process path used by the task attachment preview (main/attachment-files.js).
const main = require('../core/markdown.js').marked;

const fixed = [
  ['**注意：**这里需要先登录', '<p><strong>注意：</strong>这里需要先登录</p>'],
  ['这是**重点（必读）**内容', '<p>这是<strong>重点（必读）</strong>内容</p>'],
  ['**（注）**以下为草稿', '<p><strong>（注）</strong>以下为草稿</p>'],
  ['1. **准备：**安装 Node', '<ol>\n<li><strong>准备：</strong>安装 Node</li>\n</ol>'],
  ['**注意：**先登录，**步骤一：**打开设置', '<p><strong>注意：</strong>先登录，<strong>步骤一：</strong>打开设置</p>'],
  ['**用 `**` 包裹：**后文', '<p><strong>用 <code>**</code> 包裹：</strong>后文</p>'],
  ['**见 [a**b](https://example.com)：**后文',
    '<p><strong>见 <a href="https://example.com">a**b</a>：</strong>后文</p>'],
  ['[**注意：**这里](https://example.com)', '<p><a href="https://example.com"><strong>注意：</strong>这里</a></p>'],
];

const unchanged = [
  '`**注意：**不是加粗`', '`a**b` 和 **c**', '[a**b](https://example.com) 与 **结论**：x',
  '**结论**：营收增长', '**Note:** read this', 'a **b** c **d**', '```\n**注意：**代码块\n```',
  '***全部***', '** 不是加粗 **', '**注意 **后文', '*斜体* 和 _下划线_', '[**链接**](https://example.com)',
  '**未闭合：', '\\*\\*注意：\\*\\*转义', '工期 3~5 天，~~原价~~',
];

test('bold whose inner edge is CJK punctuation is closed in the renderer', () => {
  assert.equal(html(plain, '**注意：**这里需要先登录'), '<p>**注意：**这里需要先登录</p>', 'baseline');
  for (const [source, expected] of fixed) assert.equal(html(renderer, source), expected, source);
});

test('the main-process attachment preview uses the same dialect', () => {
  assert.match(fs.readFileSync(path.join(root, 'main/attachment-files.js'), 'utf8'),
    /require\('\.\.\/core\/markdown\.js'\)/);
  for (const [source, expected] of fixed) assert.equal(html(main, source), expected, source);
});

test('asterisks inside code spans and link text are never taken as delimiters', () => {
  for (const source of unchanged) {
    assert.equal(html(renderer, source), html(plain, source).replace('3<del>5 天，</del>', '3~5 天，'), source);
  }
});
