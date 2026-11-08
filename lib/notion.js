import { Client } from '@notionhq/client';

export class NotionService {
  constructor(apiKey, apiVersion = '2022-06-28') {
    this.client = new Client({
      auth: apiKey,
      notionVersion: apiVersion,
    });
    console.log(`[NotionService] Initialized Notion Client (API version: ${apiVersion})`);
  }

  async _executeWithRetry(fn, ...args) {
    let delay = 1000;
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn(...args);
      } catch (err) {
        const isRateLimited = err.status === 429 || err.code === 'rate_limited';
        const isServerError = err.status >= 500;

        if ((isRateLimited || isServerError) && attempt < maxRetries - 1) {
          console.warn(`[NotionService] API warning (${err.status || err.code}). Retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
          await new Promise((res) => setTimeout(res, delay));
          delay *= 2;
        } else {
          throw err;
        }
      }
    }
  }

  async getPage(pageId) {
    const cleanId = pageId.replace(/-/g, '');
    return this._executeWithRetry(() => this.client.pages.retrieve({ page_id: cleanId }));
  }

  async getDatabase(databaseId) {
    const cleanId = databaseId.replace(/-/g, '');
    return this._executeWithRetry(() => this.client.databases.retrieve({ database_id: cleanId }));
  }

  async queryPublishCandidates(databaseId) {
    const cleanId = databaseId.replace(/-/g, '');

    // 1. Query Published checkbox (paginated)
    try {
      const results = [];
      let startCursor = undefined;
      while (true) {
        const resp = await this._executeWithRetry(() =>
          this.client.databases.query({
            database_id: cleanId,
            page_size: 100,
            start_cursor: startCursor,
            filter: {
              property: 'Published',
              checkbox: { equals: true },
            },
          })
        );
        results.push(...(resp.results || []));
        if (!resp.has_more) break;
        startCursor = resp.next_cursor;
      }
      return results;
    } catch (err) {
      // Fallback to Status property equals 'Publish' if Published checkbox does not exist
    }

    // 2. Fallback to Status property equals 'Publish'
    try {
      const resp = await this._executeWithRetry(() =>
        this.client.databases.query({
          database_id: cleanId,
          filter: {
            property: 'Status',
            status: { equals: 'Publish' },
          },
        })
      );
      return resp.results || [];
    } catch (err) {
      console.error(`[NotionService] Error querying database: ${err.message}`);
      return [];
    }
  }

  async getAllBlocks(blockId, fetchChildren = true) {
    const cleanId = blockId.replace(/-/g, '');
    const blocks = [];
    let startCursor = undefined;

    while (true) {
      const resp = await this._executeWithRetry(() =>
        this.client.blocks.children.list({
          block_id: cleanId,
          page_size: 100,
          start_cursor: startCursor,
        })
      );

      blocks.push(...(resp.results || []));

      if (!resp.has_more) break;
      startCursor = resp.next_cursor;
    }

    if (fetchChildren) {
      for (const b of blocks) {
        if (b.has_children) {
          b.children = await this.getAllBlocks(b.id, true);
        }
      }
    }

    return blocks;
  }

  async updatePageStatus(pageId, newStatus = 'Published') {
    const cleanId = pageId.replace(/-/g, '');
    const page = await this.getPage(cleanId);
    const props = page.properties || {};

    const updateProps = {};
    if (props.Status) {
      if (props.Status.status?.name !== newStatus) {
        updateProps.Status = { status: { name: newStatus } };
      }
    } else if (props.Published && newStatus === 'Published') {
      if (props.Published.checkbox !== true) {
        updateProps.Published = { checkbox: true };
      }
    }

    // NOTE: All publication dates are manually set by the user in Notion.
    // The daemon does NOT overwrite or auto-set any Date or Published At property.

    if (Object.keys(updateProps).length === 0) {
      return page;
    }

    const updatedPage = await this._executeWithRetry(() =>
      this.client.pages.update({
        page_id: cleanId,
        properties: updateProps,
      })
    );

    console.log(`[NotionService] Updated Notion page ${pageId} Status -> '${newStatus}'`);
    return updatedPage;
  }
}

