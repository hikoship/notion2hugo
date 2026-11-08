import test from 'node:test';
import assert from 'node:assert/strict';
import { richTextToMarkdown, BlockParser } from '../lib/blocks-to-md.js';
import { extractProperties, renderYamlFrontmatter } from '../lib/frontmatter.js';

test('richTextToMarkdown formatting annotations', () => {
  const items = [
    { plain_text: 'Normal ' },
    { plain_text: 'bold', annotations: { bold: true } },
    { plain_text: ' and ' },
    { plain_text: 'italic', annotations: { italic: true } },
    { plain_text: ' and ' },
    { plain_text: 'code', annotations: { code: true } },
    { plain_text: ' link', href: 'https://hgao.net' },
  ];

  const md = richTextToMarkdown(items);
  assert.equal(md, 'Normal **bold** and *italic* and `code` [link](https://hgao.net)');
});

test('BlockParser headings and code blocks', async () => {
  const parser = new BlockParser({ postSlug: 'test-article' });
  const blocks = [
    {
      type: 'heading_1',
      heading_1: { rich_text: [{ plain_text: 'Top Level' }] },
    },
    {
      type: 'heading_2',
      heading_2: { rich_text: [{ plain_text: 'Second Level' }] },
    },
    {
      type: 'code',
      code: {
        language: 'javascript',
        rich_text: [{ plain_text: 'console.log("hello");' }],
      },
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.match(md, /## Top Level/);
  assert.match(md, /### Second Level/);
  assert.match(md, /```javascript\nconsole\.log\("hello"\);\n```/);
});

test('BlockParser nested lists without extra blank lines', async () => {
  const parser = new BlockParser();
  const blocks = [
    {
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ plain_text: 'Item 1' }] },
      children: [
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ plain_text: 'Subitem 1.1' }] },
        },
      ],
    },
    {
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: [{ plain_text: 'Item 2' }] },
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.ok(md.includes('- Item 1\n  - Subitem 1.1\n- Item 2'));
});

test('frontmatter extraction and user-defined date preservation', () => {
  const page = {
    id: 'page-123',
    properties: {
      Title: { title: [{ plain_text: 'My Great Post' }] },
      Slug: { rich_text: [{ plain_text: 'my-great-post' }] },
      Date: { date: { start: '2016-07-06' } },
      Category: { type: 'select', select: { name: 'Life' } },
      Summary: { rich_text: [{ plain_text: 'A post summary' }] },
      Status: { status: { name: 'Published' } },
    },
  };

  const props = extractProperties(page);
  assert.equal(props.title, 'My Great Post');
  assert.equal(props.slug, 'my-great-post');
  // Manual date preserved with timezone
  assert.equal(props.date, '2016-07-06T00:00:00-08:00');
  assert.equal(props.categories, 'Life');
  assert.equal(props.draft, false);

  const yamlOutput = renderYamlFrontmatter(props);
  assert.ok(yamlOutput.startsWith('---\n'));
  assert.ok(yamlOutput.endsWith('---\n\n'));
  assert.match(yamlOutput, /title: My Great Post/);
  assert.match(yamlOutput, /draft: false/);
});

