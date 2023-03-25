console.log(new Date().toLocaleString());
console.log('Starting the workflow')

const path = require('path');

const { Client } = require("@notionhq/client")
require('dotenv').config()
const fs = require('fs').promises;
const { exec } = require('child_process');

const debug_mode = false

const notion = new Client({ auth: process.env.NOTION_KEY })
const databaseId = process.env.NOTION_DATABASE_ID
const post_dir = debug_mode ? 'debug_posts' : process.env.POST_DIR
const temp_post_dir = debug_mode ? 'debug_posts' : process.env.TEMP_POST_DIR

let prev_block_is_list = false


async function fetch() {
  const notion = new Client({ auth: process.env.NOTION_KEY })
  console.log('Querying database')
  const database = await notion.databases.query({
    database_id: databaseId,
      filter: {
        property: "Published",
        checkbox: {
          equals: true
        }
      },
  })
  let count = 0
  for (let i = 0; i < database.results.length; i++) {
    try {
      const page = database.results[i]
      console.log("Processing article " + page.properties.Name.title[0].plain_text)
      const blocks = await notion.blocks.children.list({
        block_id: page.id
      })
      createMd(page, blocks)
      count++
    } catch (error) {
      console.error(error)
      continue
    }
  }
  console.log(count + 'Markdown files generated')
  //await exec('ls -l', (err, stdout, stderr) => {
  await exec('. ' + process.env.HUGO_SCRIPT, execCallback);

}

async function createMd(page, blocks) {
	try {
    file_name = path.resolve(post_dir + "/" + page.properties.Filename.rich_text[0].plain_text + ".md")
    console.log("Creating " + file_name)
    prev_block_is_list = false
    await addHeader(file_name, page.properties).then(() => {
    addContent(file_name, blocks.results)
    })
    console.log("Added header " + file_name)
    console.log("Added content " + file_name)
	} catch (error) {
    if (!debug_mode) {
      await fs.unlink(file_name, appendErrorCallback)
    }
    console.error(error)
	}
}

async function addHeader(file_name, properties) {
  await fs.writeFile(file_name, '+++\n\n', appendErrorCallback);
  await fs.appendFile(file_name, getCategory(properties.Category), appendErrorCallback);
  await fs.appendFile(file_name, getDate(properties.Date), appendErrorCallback);
  await fs.appendFile(file_name, getSummary(properties.Summary), appendErrorCallback);
  await fs.appendFile(file_name, getTitle(properties.Name), appendErrorCallback);
  await fs.appendFile(file_name, '\n+++\n\n', appendErrorCallback);
}

async function addContent(file_name, blocks) {
  for (let i = 0; i < blocks.length; i++) {
  // for (let i = 4; i>=0; i=-1) {
    try {
      const content = await parseBlock(blocks[i])
      await fs.appendFile(file_name, content, appendErrorCallback);
    } catch (error) {
      console.error(error)
      continue
    }
  }
}

async function parseBlock(block) {
  // bulleted_list_item / numbered_list_item
  if (block.type.endsWith("list_item")) {
    prev_block_is_list = true
    return getList(block, 0)
  }

  let line = prev_block_is_list ? "\n" : ""
  prev_block_is_list = false

  // heading_1 .. heading_3
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
  // Notion heading 1 = html heading 2
  const headingSize = parseInt(type[type.length - 1]) + 1
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
  let line = prefix + getLine(block[type])
  if (block.has_children) {
    const children = await notion.blocks.children.list({
      block_id: block.id
    })
    for (let i = 0; i < children.results.length; i++) {
      line += "\n" + getList(children.results[i], layer + 1)
    }
  }
  // only one line break.
  return line + "\n"
}

function appendErrorCallback(error) {
  if (error) throw error;
}

function execCallback(error, stdout, stderr) {
  if (error) {
    console.error(`Error executing command: ${error}`);
    return;
  }
  console.log(`stdout: ${stdout}`);
  console.error(`stderr: ${stderr}`);
}

fetch()
