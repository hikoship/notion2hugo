console.log('hgao')
const { Client } = require("@notionhq/client")
require('dotenv').config()
const fs = require('fs').promises;

const debug_mode = true

const notion = new Client({ auth: process.env.NOTION_KEY })
const databaseId = process.env.NOTION_DATABASE_ID
const post_dir = debug_mode ? 'debug_posts' : process.env.POST_DIR
const temp_post_dir = debug_mode ? 'debug_posts' : process.env.TEMP_POST_DIR

let prev_block_is_list = false


async function fetch() {
  const notion = new Client({ auth: process.env.NOTION_KEY })
  const database = await notion.databases.query({
    database_id: databaseId,
      filter: {
        property: "Published",
        checkbox: {
          equals: true
        }
      },
  })
  for (let i = 0; i < database.results.length; i++) {
 // for (let i = 0; i < 1; i++) {
    try {
      const page = database.results[i]
      const blocks = await notion.blocks.children.list({
        block_id: page.id
      })
      console.log(page.properties.Name.title[0].plain_text)
      // createMd(page, blocks)
    } catch (error) {
      console.error(error)
      continue
    }
  }
}

function createMd(page, blocks) {
	try {
    file_name = temp_post_dir + "/" + page.properties.Filename.rich_text[0].plain_text + ".md"
    console.log("Creating " + file_name)
    prev_block_is_list = false
    addHeader(file_name, page.properties)
    addContent(file_name, blocks.results)

    // console.log(page.properties.Name.title[0].plain_text)
    // console.log(blocks)
    // const blockType = blocks.results[0]
    // console.log(blocks.results[0].paragraph.rich_text[0].plain_text)
	} catch (error) {
    if (!debug_mode) {
      fs.unlink(file_name, appendErrorCallback)
    }
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

async function addContent(file_name, blocks) {
  for (let i = 0; i < blocks.length; i++) {
  // for (let i = 4; i>=0; i=-1) {
    try {
    console.log(blocks[i])
    console.log(blocks[i][blocks[i].type])
      const content = await Promise.resolve(parseBlock(blocks[i]))
      console.log(content)
    fs.appendFile(file_name, content, appendErrorCallback);
    } catch (error) {
      console.error(error)
      continue
    }
  }
}

function parseBlock(block) {
  // bulleted_list_item / numbered_list_item
  if (block.type.endsWith("list_item")) {
    prev_block_is_list = true
    return getList(block, 0)
  }

  let line = prev_block_is_list ? "\n" : ""
  prev_block_is_list = false

  // heading_1 .. heading 6
  if (block.type.startsWith("heading")) {
    line += getHeading(block)
  }
  else if (block.type == "paragraph") {
    line += getParagraph(block.paragraph)
  }
  else if (block.type == "image") {
    line += getImage(block.image)
  }
  return line
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
  const type = block.type
  const headingSize = parseInt(type[type.length - 1])
console.log(headingSize)
  return "#".repeat(headingSize) + " " + getLine(block[type]) + '\n\n'
}

function getParagraph(paragraph) {
  return getLine(paragraph) + "\n\n"
}

function getLine(obj) {
  return obj.rich_text.map(r => {
    let s = r.plain_text
    if (r.href != null) {
      s = "[" + s + "](" + r.href + ")"
    }
    if (r.annotations.bold) {
      s = "**" + s + "**"
    }
    if (r.annotations.italic) {
      s = "*" + s + "*"
    }
    if (r.annotations.code) {
      s = "`" + s + "`"
    }
    if (r.annotations.underline) {
      s = "<ins>" + s + "</ins>"
    }
    if (r.annotations.strikethrough) {
      s = "<del>" + s + "</del>"
    }
    return s;
  }).join("")
}

function getImage(image) {
  return "![IMAGE](" + image.external.url + ")\n\n"
}

async function getList(block, layer) {
  const type = block.type
  const ordered = block.type.startsWith("numbered")
  // indent: 4 for ordered list and 2 for unordered list
  const prefix = " ".repeat(layer * (ordered ? 4 : 2)) + (ordered ? "1. " : "* ")
  console.log(ordered)
  let line = prefix + getLine(block[type])
  if (block.has_children) {
    console.log("hascccccccccccc")
    const children = await notion.blocks.children.list({
      block_id: block.id
    })
    console.log(children)
    for (let i = 0; i < children.results.length; i++) {
      line += "\n" + await getList(children.results[i], layer + 1)
    }
  }
  // console.log(line)
  // only one line break.
  return line + "\n"

}

function appendErrorCallback(error) {
      if (error) throw error;
    }



console.log('hgao')
fetch()
