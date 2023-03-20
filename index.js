const { Client } = require("@notionhq/client")
require('dotenv').config()
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_KEY })
const databaseId = process.env.NOTION_DATABASE_ID
console.log('hgao')

async function fetch() {
  try {
    const notion = new Client({ auth: process.env.NOTION_KEY })
    const database = await notion.databases.query({
      database_id: databaseId,
        //   filter: {
        //     // property: "Landmark",
        //     // rich_text: {
        //     //   contains: "Bridge",
        //     // },
    })
    // for (let i = 0; i < database.results.length; i++) {
    for (let i = 0; i < 1; i++) {
      const page = database.results[i]
      const blocks = await notion.blocks.children.list({
        block_id: page.id
      })
      createMd(page, blocks)
    }
  } catch (error) {
    console.error(error)
  }
}

function createMd(page, blocks) {
	try {
    file_name = page.properties.Filename.rich_text[0].plain_text + ".md"
    addHeader(file_name, page.properties)
    addContent(file_name, blocks.results)
    
    // console.log(page.properties.Name.title[0].plain_text)
    // console.log(blocks)
    // const blockType = blocks.results[0]
    // console.log(blocks.results[0].paragraph.rich_text[0].plain_text)
	} catch (error) {
    console.error(error)
	}
}

function addHeader(file_name, properties) {
  fs.writeFile(file_name, '+++\n\n', appendErrorCallback);
  fs.appendFile(file_name, getCategory(properties.Category), appendErrorCallback);
  fs.appendFile(file_name, getDate(properties.Date), appendErrorCallback);
  fs.appendFile(file_name, getSummary(properties.Summary), appendErrorCallback);
  fs.appendFile(file_name, getTitle(properties.Name), appendErrorCallback);
  fs.appendFile(file_name, '\n+++\n\n', appendErrorCallback);
}

function addContent(file_name, blocks) {
  for (let i = 0; i < blocks.length; i++) {
    try {
    console.log(blocks[i])
    console.log(blocks[i][blocks[i].type])
    fs.appendFile(file_name, parseBlock(blocks[i]), appendErrorCallback);
    } catch (error) {
      console.error(error)
      continue
    }
  }
}

function parseBlock(block) {
  if (block.type.startsWith("heading")) {
    return getHeading(block)
  }
  switch (block.type) {
    case "heading_1":
      // console.log(block.heading_1)
      return ""
  }
  return ""
}

function getCategory(category) {
  return "categories = \"" + category.select.name + "\"\n"
}

function getDate(date) {
  // yyyy-mm-dd
  return "date = \"" + date.date.start + "T12:00:00+00:00\"\n"
}

function getSummary(summary) {
  if (summary.rich_text.length > 0) {
    return "summary = \"" + summary.rich_text[0].plain_text + "\"\n"
  }
}

function getTitle(name) {
  return "title = \"" + name.title[0].plain_text + "\"\n"
}

function getHeading(block) {

}

function appendErrorCallback(error) {
      if (error) throw error;
    }



console.log('hgao')
fetch()
