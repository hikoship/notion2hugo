import test from 'node:test';
import assert from 'node:assert/strict';
import { richTextToMarkdown, BlockParser } from '../lib/blocks-to-md.js';
import { extractProperties, renderYamlFrontmatter } from '../lib/frontmatter.js';
import { NotionService } from '../lib/notion.js';

test('richTextToMarkdown formatting annotations and equations', () => {
  const items = [
    { plain_text: 'Normal ' },
    { plain_text: 'bold', annotations: { bold: true } },
    { plain_text: ' ' },
    { plain_text: 'italic', annotations: { italic: true } },
    { plain_text: ' ' },
    { plain_text: 'strike', annotations: { strikethrough: true } },
    { plain_text: ' ' },
    { plain_text: 'under', annotations: { underline: true } },
    { plain_text: ' ' },
    { plain_text: 'code', annotations: { code: true } },
    { plain_text: ' ' },
    { type: 'equation', equation: { expression: 'E=mc^2' } },
    { plain_text: ' ' },
    { plain_text: 'link', href: 'https://hgao.net' },
  ];

  const md = richTextToMarkdown(items);
  assert.equal(
    md,
    'Normal **bold** *italic* ~~strike~~ <u>under</u> `code` $E=mc^2$ [link](https://hgao.net)'
  );
});

test('BlockParser headings (shifted H1->H2, H2->H3, H3->H4) and code blocks', async () => {
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
      type: 'heading_3',
      heading_3: { rich_text: [{ plain_text: 'Third Level' }] },
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
  assert.match(md, /^## Top Level$/m);
  assert.match(md, /^### Second Level$/m);
  assert.match(md, /^#### Third Level$/m);
  assert.match(md, /```javascript\nconsole\.log\("hello"\);\n```/);
});

test('BlockParser nested lists and checklists without extra blank lines', async () => {
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
    {
      type: 'to_do',
      to_do: { checked: true, rich_text: [{ plain_text: 'Done task' }] },
    },
    {
      type: 'to_do',
      to_do: { checked: false, rich_text: [{ plain_text: 'Pending task' }] },
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.ok(md.includes('- Item 1\n  - Subitem 1.1\n- Item 2'));
  assert.ok(md.includes('- [x] Done task\n- [ ] Pending task'));
});

test('BlockParser images preserve Notion captions as alt text and default to IMAGE when empty', async () => {
  const parser = new BlockParser({ postSlug: '2006-world-cup-memory' });
  const blocks = [
    {
      type: 'image',
      image: {
        type: 'external',
        external: { url: 'https://ik.imagekit.io/hikoship/blog/2006-world-cup-memory/wc2006-logo.jpg' },
        caption: [{ plain_text: '二〇〇六世界杯会徽' }],
      },
    },
    {
      type: 'image',
      image: {
        type: 'external',
        external: { url: 'https://ik.imagekit.io/hikoship/blog/2006-world-cup-memory/wc2006-cards.jpg' },
        caption: [],
      },
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.equal(
    md.trim(),
    '![二〇〇六世界杯会徽](https://ik.imagekit.io/hikoship/blog/2006-world-cup-memory/wc2006-logo.jpg)\n\n![IMAGE](https://ik.imagekit.io/hikoship/blog/2006-world-cup-memory/wc2006-cards.jpg)'
  );
});

test('BlockParser converts YouTube video blocks to responsive iframe and falls back for other URLs', async () => {
  const parser = new BlockParser();
  const blocks = [
    {
      type: 'video',
      video: {
        type: 'external',
        external: { url: 'https://www.youtube.com/watch?v=4aOxDHqWyK0' },
      },
    },
    {
      type: 'video',
      video: {
        type: 'external',
        external: { url: 'https://youtu.be/dQw4w9WgXcQ?si=123' },
      },
    },
    {
      type: 'video',
      video: {
        type: 'external',
        external: { url: 'https://example.com/video.mp4' },
      },
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.match(md, /<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/4aOxDHqWyK0"[^>]*><\/iframe>/);
  assert.match(md, /<iframe[^>]+src="https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ"[^>]*><\/iframe>/);
  assert.match(md, /\[Video\/Embed\]\(https:\/\/example\.com\/video\.mp4\)/);
});

test('BlockParser quotes, callouts, tables, dividers, and equations', async () => {
  const parser = new BlockParser();
  const blocks = [
    {
      type: 'quote',
      quote: { rich_text: [{ plain_text: 'Line 1\nLine 2' }] },
      children: [
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ plain_text: 'Child quote para 1' }] },
        },
        {
          type: 'paragraph',
          paragraph: { rich_text: [{ plain_text: 'Child quote para 2' }] },
        },
      ],
    },
    {
      type: 'callout',
      callout: {
        icon: { type: 'emoji', emoji: '💡' },
        rich_text: [{ plain_text: 'Note text' }],
      },
    },
    {
      type: 'divider',
      divider: {},
    },
    {
      type: 'equation',
      equation: { expression: '\\int_0^1 x^2 dx' },
    },
    {
      type: 'table',
      table: {},
      children: [
        {
          type: 'table_row',
          table_row: {
            cells: [[{ plain_text: 'Col A' }], [{ plain_text: 'Col B' }]],
          },
        },
        {
          type: 'table_row',
          table_row: {
            cells: [[{ plain_text: 'Val 1' }], [{ plain_text: 'Val 2' }]],
          },
        },
      ],
    },
  ];

  const md = await parser.parseBlocks(blocks);
  assert.ok(md.includes('> Line 1\n> Line 2\n>\n> Child quote para 1\n>\n> Child quote para 2'));
  assert.ok(md.includes('> 💡 Note text'));
  assert.ok(md.includes('---'));
  assert.ok(md.includes('$$\n\\int_0^1 x^2 dx\n$$'));
  assert.ok(md.includes('| Col A | Col B |\n| --- | --- |\n| Val 1 | Val 2 |'));
});

test('frontmatter extraction preserves manual Date and strips WIP/Archived/Created/Last edited time', () => {
  const page = {
    id: 'page-123',
    properties: {
      Name: { title: [{ plain_text: 'My Great Post' }] },
      Filename: { rich_text: [{ plain_text: 'my-great-post' }] },
      Date: { date: { start: '2016-07-06' } },
      Category: { type: 'select', select: { name: 'Life' } },
      Summary: { rich_text: [{ plain_text: 'A post summary' }] },
      Published: { checkbox: true },
      WIP: { checkbox: true },
      Archived: { checkbox: false },
      'Last edited time': { type: 'last_edited_time', last_edited_time: '2026-11-08T08:00:00.000Z' },
      Created: { type: 'created_time', created_time: '2026-11-07T08:00:00.000Z' },
    },
  };

  const props = extractProperties(page);
  assert.equal(props.title, 'My Great Post');
  assert.equal(props.slug, 'my-great-post');
  assert.equal(props.date, '2016-07-06T00:00:00-08:00');
  assert.equal(props.categories, 'Life');
  assert.equal(props.draft, false);
  assert.equal(props.wip, undefined);
  assert.equal(props.archived, undefined);
  assert.equal(props['last edited time'], undefined);
  assert.equal(props.created, undefined);

  const yamlOutput = renderYamlFrontmatter(props);
  assert.ok(yamlOutput.startsWith('---\n'));
  assert.ok(yamlOutput.endsWith('---\n\n'));
  assert.match(yamlOutput, /title: "My Great Post"/);
  assert.match(yamlOutput, /categories: "Life"/);
  assert.doesNotMatch(yamlOutput, /^slug:/m);
  assert.doesNotMatch(yamlOutput, /wip:/i);
  assert.doesNotMatch(yamlOutput, /archived:/i);
});

test('NotionService.queryRecentlyChangedPages builds server-side last_edited_time + WIP=false filter', async () => {
  const service = new NotionService('secret_dummy');
  const capturedQueries = [];
  service.client.databases.query = async (args) => {
    capturedQueries.push(args);
    return { results: [], has_more: false };
  };

  await service.queryRecentlyChangedPages('0341d5b6-2282-4928-ae97-ebfb4fc8bff8', '2026-11-08T08:00:00.000Z');
  assert.equal(capturedQueries.length, 1);
  assert.deepEqual(capturedQueries[0].filter, {
    and: [
      {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: '2026-11-08T08:00:00.000Z' },
      },
      {
        property: 'WIP',
        checkbox: { equals: false },
      },
    ],
  });

  await service.queryRecentlyChangedPages('0341d5b6-2282-4928-ae97-ebfb4fc8bff8', null);
  assert.equal(capturedQueries.length, 2);
  assert.deepEqual(capturedQueries[1].filter, {
    property: 'WIP',
    checkbox: { equals: false },
  });
});
