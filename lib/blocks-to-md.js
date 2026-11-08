export function richTextToMarkdown(richTexts) {
  if (!richTexts || richTexts.length === 0) return '';

  return richTexts
    .map((item) => {
      if (item.type === 'equation' && item.equation?.expression) {
        return `$${item.equation.expression}$`;
      }
      const text = item.plain_text || '';
      if (!text) return '';

      const annotations = item.annotations || {};
      const href = item.href;

      // Extract leading and trailing whitespace to keep delimiters clean
      const match = text.match(/^(\s*)(.*?)(\s*)$/s);
      if (!match) return text;

      const [, leadWs, cleanText, trailWs] = match;
      if (!cleanText) return text;

      let formatted = cleanText;

      // Inline code takes precedence
      if (annotations.code) {
        formatted = `\`${formatted}\``;
      } else {
        if (annotations.bold) formatted = `**${formatted}**`;
        if (annotations.italic) formatted = `*${formatted}*`;
        if (annotations.strikethrough) formatted = `~~${formatted}~~`;
        if (annotations.underline) formatted = `<u>${formatted}</u>`;
      }

      if (href && !/^mailto:/i.test(href)) {
        formatted = `[${formatted}](${href})`;
      }

      return `${leadWs}${formatted}${trailWs}`;
    })
    .join('');
}

export function extractYouTubeId(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) {
      return parsed.pathname.replace(/^\//, '').split('?')[0];
    }
    if (parsed.hostname.includes('youtube.com')) {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      if (parsed.pathname.includes('/embed/')) {
        return parsed.pathname.split('/embed/')[1].split('/')[0];
      }
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

export class BlockParser {
  constructor({ imageStore = null, postSlug = 'post' } = {}) {
    this.imageStore = imageStore;
    this.postSlug = postSlug;
  }

  async parseBlocks(blocks, indentLevel = 0) {
    const output = [];
    let i = 0;
    const n = blocks.length;

    while (i < n) {
      const block = blocks[i];
      const blockType = block.type;

      // 1. Group consecutive numbered list items
      if (blockType === 'numbered_list_item') {
        const items = [];
        while (i < n && blocks[i].type === 'numbered_list_item') {
          items.push(blocks[i]);
          i++;
        }
        for (let idx = 0; idx < items.length; idx++) {
          output.push(await this._parseListItem(items[idx], indentLevel, idx + 1));
        }
        if (indentLevel === 0) output.push('\n');
        continue;
      }

      // 2. Group consecutive bulleted list items
      if (blockType === 'bulleted_list_item') {
        const items = [];
        while (i < n && blocks[i].type === 'bulleted_list_item') {
          items.push(blocks[i]);
          i++;
        }
        for (const item of items) {
          output.push(await this._parseListItem(item, indentLevel, null));
        }
        if (indentLevel === 0) output.push('\n');
        continue;
      }

      // 3. Table blocks
      if (blockType === 'table') {
        output.push(this._parseTable(block));
        i++;
        continue;
      }

      // 4. Single blocks
      const text = await this._parseSingleBlock(block, indentLevel);
      if (text) output.push(text);
      i++;
    }

    return output.join('');
  }

  async _parseListItem(block, indentLevel, listNum = null) {
    const prefix = '  '.repeat(indentLevel);
    const marker = listNum ? `${listNum}. ` : '- ';
    const itemData = block[block.type] || {};
    const content = richTextToMarkdown(itemData.rich_text || []);
    let line = `${prefix}${marker}${content}\n`;

    if (block.children && block.children.length > 0) {
      const childText = await this.parseBlocks(block.children, indentLevel + 1);
      line += childText;
    }

    return line;
  }

  async _parseSingleBlock(block, indentLevel) {
    const bType = block.type;
    const data = block[bType] || {};
    const prefix = '  '.repeat(indentLevel);

    if (bType === 'heading_1') {
      const text = richTextToMarkdown(data.rich_text);
      return `${prefix}## ${text}\n\n`;
    }
    if (bType === 'heading_2') {
      const text = richTextToMarkdown(data.rich_text);
      return `${prefix}### ${text}\n\n`;
    }
    if (bType === 'heading_3') {
      const text = richTextToMarkdown(data.rich_text);
      return `${prefix}#### ${text}\n\n`;
    }

    if (bType === 'paragraph') {
      const text = richTextToMarkdown(data.rich_text).trim();
      let res = text ? `${prefix}${text}\n\n` : '';
      if (block.children && block.children.length > 0) {
        res += await this.parseBlocks(block.children, indentLevel + 1);
      }
      return res;
    }

    if (bType === 'code') {
      let lang = (data.language || '').toLowerCase();
      if (['plain text', 'none', ''].includes(lang)) lang = '';
      const text = richTextToMarkdown(data.rich_text);
      return `${prefix}\`\`\`${lang}\n${text}\n${prefix}\`\`\`\n\n`;
    }

    if (bType === 'quote') {
      const text = richTextToMarkdown(data.rich_text);
      const quoteLines = [];
      if (text) {
        for (const l of text.split('\n')) {
          quoteLines.push(l ? `${prefix}> ${l}` : `${prefix}>`);
        }
      }
      if (block.children && block.children.length > 0) {
        const childMd = (await this.parseBlocks(block.children, 0)).replace(/\n+$/, '');
        if (childMd) {
          if (quoteLines.length > 0) quoteLines.push(`${prefix}>`);
          for (const l of childMd.split('\n')) {
            quoteLines.push(l ? `${prefix}> ${l}` : `${prefix}>`);
          }
        }
      }
      if (quoteLines.length === 0) return `${prefix}>\n\n`;
      return quoteLines.join('\n') + '\n\n';
    }

    if (bType === 'callout') {
      let icon = '';
      if (data.icon?.type === 'emoji') icon = `${data.icon.emoji} `;
      const text = richTextToMarkdown(data.rich_text);
      let res = `${prefix}> ${icon}${text}\n\n`;
      if (block.children && block.children.length > 0) {
        res += await this.parseBlocks(block.children, indentLevel + 1);
      }
      return res;
    }

    if (bType === 'to_do') {
      const box = data.checked ? '[x]' : '[ ]';
      const text = richTextToMarkdown(data.rich_text);
      return `${prefix}- ${box} ${text}\n`;
    }

    if (bType === 'divider') {
      return `${prefix}---\n\n`;
    }

    if (bType === 'equation') {
      const expr = data.expression || '';
      return `${prefix}$$\n${expr}\n$$\n\n`;
    }

    if (bType === 'image') {
      let imgUrl = '';
      if (data.type === 'external') imgUrl = data.external?.url || '';
      else if (data.type === 'file') imgUrl = data.file?.url || '';

      if (imgUrl && this.imageStore) {
        imgUrl = await this.imageStore.rehostImage(imgUrl, this.postSlug);
      }

      const caption = richTextToMarkdown(data.caption) || 'IMAGE';
      return `${prefix}![${caption}](${imgUrl})\n\n`;
    }

    if (bType === 'bookmark') {
      const url = data.url || '';
      const caption = richTextToMarkdown(data.caption) || url;
      return `${prefix}[${caption}](${url})\n\n`;
    }

    if (bType === 'video' || bType === 'embed') {
      const url = data.external?.url || data.file?.url || data.url || '';
      const ytId = extractYouTubeId(url);
      if (ytId) {
        return `${prefix}<iframe style="position: relative; width: 100%;" height="360" src="https://www.youtube.com/embed/${ytId}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>\n\n`;
      }
      return `${prefix}[Video/Embed](${url})\n\n`;
    }

    // Fallback for unhandled blocks
    let childText = '';
    if (block.children && block.children.length > 0) {
      childText = await this.parseBlocks(block.children, indentLevel);
    }
    return `${prefix}<!-- Notion block: ${bType} -->\n${childText}`;
  }

  _parseTable(tableBlock) {
    const children = tableBlock.children || [];
    if (children.length === 0) return '';

    const rows = [];
    for (const child of children) {
      if (child.type === 'table_row') {
        const cells = child.table_row?.cells || [];
        const rowStr = cells
          .map((cell) => richTextToMarkdown(cell).replace(/\n/g, '<br>'))
          .join(' | ');
        rows.push(`| ${rowStr} |`);
      }
    }

    if (rows.length === 0) return '';

    const hasColumnHeader = tableBlock.table?.has_column_header ?? true;
    if (hasColumnHeader && rows.length > 0) {
      const cellCount = children[0]?.table_row?.cells?.length || 1;
      const delimiter = '| ' + Array(cellCount).fill('---').join(' | ') + ' |';
      return `${rows[0]}\n${delimiter}\n${rows.slice(1).join('\n')}\n\n`;
    }

    return `${rows.join('\n')}\n\n`;
  }
}

