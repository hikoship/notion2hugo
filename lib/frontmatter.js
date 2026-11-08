import YAML from 'yaml';

export function extractRichText(prop) {
  if (!prop) return '';
  const items = prop.title || prop.rich_text || [];
  return items.map((item) => item.plain_text || '').join('').trim();
}

export function extractProperties(page) {
  const props = page.properties || {};
  const metadata = {};

  // 1. Title
  const title = extractRichText(props.Title) || extractRichText(props.Name) || 'Untitled';
  metadata.title = title;

  // 2. Slug
  let slug = extractRichText(props.Slug) || extractRichText(props.Filename);
  if (!slug) {
    slug = title
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || page.id;
  }
  metadata.slug = slug;

  // 3. Date (Manually set by user in Notion)
  const dateProp = props.Date;
  if (dateProp?.date?.start) {
    const start = dateProp.date.start;
    if (start.length === 10) {
      metadata.date = `${start}T00:00:00-08:00`;
    } else {
      metadata.date = start;
    }
  } else if (page.created_time) {
    metadata.date = page.created_time;
  }

  // 4. Category
  const catProp = props.Category || props.Categories;
  if (catProp) {
    if (catProp.type === 'select' && catProp.select?.name) {
      metadata.categories = catProp.select.name;
    } else if (catProp.type === 'multi_select' && catProp.multi_select?.length > 0) {
      const names = catProp.multi_select.map((s) => s.name);
      metadata.categories = names.length === 1 ? names[0] : names;
    } else if (catProp.type === 'rich_text') {
      const text = extractRichText(catProp);
      if (text) metadata.categories = text;
    }
  }

  // 5. Summary
  const summaryProp = props.Summary;
  if (summaryProp) {
    const text = extractRichText(summaryProp);
    if (text) metadata.summary = text;
  }

  // 6. Tags
  const tagsProp = props.Tags || props.Tag;
  if (tagsProp) {
    if (tagsProp.type === 'multi_select' && tagsProp.multi_select?.length > 0) {
      metadata.tags = tagsProp.multi_select.map((s) => s.name);
    } else if (tagsProp.type === 'rich_text') {
      const text = extractRichText(tagsProp);
      if (text) metadata.tags = text.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }

  // 7. Draft Status
  const statusProp = props.Status;
  if (statusProp?.status?.name) {
    metadata.draft = statusProp.status.name.toLowerCase() === 'draft';
  } else if (props.Published?.checkbox !== undefined) {
    metadata.draft = !props.Published.checkbox;
  } else {
    metadata.draft = false;
  }

  // 8. Extra custom properties
  for (const [key, val] of Object.entries(props)) {
    const lowerKey = key.toLowerCase();
    if (
      [
        'title',
        'name',
        'slug',
        'filename',
        'date',
        'category',
        'categories',
        'summary',
        'tags',
        'tag',
        'status',
        'published',
        'wip',
        'archived',
        'last edited time',
        'created',
      ].includes(lowerKey)
    ) {
      continue;
    }
    if (val.type === 'rich_text') {
      const text = extractRichText(val);
      if (text) metadata[lowerKey] = text;
    } else if (val.type === 'select' && val.select?.name) {
      metadata[lowerKey] = val.select.name;
    }
  }

  return metadata;
}

export function renderYamlFrontmatter(metadata) {
  const { slug: _slug, ...frontmatter } = metadata;
  const yamlStr = YAML.stringify(frontmatter, {
    indent: 2,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE',
    lineWidth: 0,
  });
  return `---\n${yamlStr}---\n\n`;
}

