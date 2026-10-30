/**
 * align-mode 兼容性探针
 *
 * 用途：每次 DSH 升级后跑一遍，确认本插件依赖的契约没有破裂。
 * 原理：直接从当前 app.asar 读取实现，断言关键契约字符串仍然存在。
 *      这不是"读文档猜"，而是"读实现验"。
 *
 * 用法：node align-mode/_test/compat-probe.mjs
 * 退出码：0 = 全部契约成立；1 = 有契约破裂（需按提示适配）
 */
import fs from 'node:fs'

const ASAR = 'C:/Users/zuoye/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

// ── 读取 asar 头部索引 ──
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const hdrSize = head.readUInt32LE(12)
const jb = Buffer.alloc(hdrSize)
fs.readSync(fd, jb, 0, hdrSize, 16)
const index = JSON.parse(jb.toString('utf8'))
const dataStart = 16 + hdrSize

const entries = new Map()
;(function walk(node, prefix) {
  for (const [k, v] of Object.entries(node || {})) {
    const p = prefix + '/' + k
    if (v.files) walk(v.files, p)
    else if (v.offset !== undefined) entries.set(p, { size: Number(v.size), offset: Number(v.offset) })
  }
})(index.files, '')

function readEntry(p) {
  const e = entries.get(p)
  if (e === undefined) return undefined
  const b = Buffer.alloc(e.size)
  fs.readSync(fd, b, 0, e.size, dataStart + e.offset)
  return b.toString('utf8')
}

const at = (pkg, rel) => readEntry('/dsh/node_modules/@deepseek-ai/' + pkg + '/' + rel)
const versionOf = (pkg) => {
  const t = at(pkg, 'package.json')
  if (t === undefined) return '?'
  try { return JSON.parse(t).version } catch { return '?' }
}
// ── 契约断言 ──
const results = []
function contract(id, desc, ok, detail) {
  results.push({ id, desc, ok, detail })
}

const version = versionOf('dsh-tools')
console.log('DSH 组件版本（以 dsh-tools 为准）: ' + version)
console.log('')

// C1: register 接受普通对象，要求 output{schema,render}，禁用 run_code
const toolsIdx = at('dsh-tools', 'lib/index.js') ?? ''
contract(
  'C1',
  'ctx.tools.register 接受含 output{schema,render} 的普通对象，且拒绝保留名 run_code',
  toolsIdx.includes('must declare output { schema, render') && toolsIdx.includes('is reserved'),
  'dsh-tools/lib/index.js 中的 register 校验分支'
)

// C2: defineTool 只是便利层（因此我们不 import 它也不会缺功能）
const schemaSrc = at('dsh-tools', 'lib/types/schema.js') ?? ''
contract(
  'C2',
  'defineTool 仅为便利层（参数规格→JSON Schema + 参数校验包装）',
  schemaSrc.includes('export function defineTool') && schemaSrc.includes('compilePropertyMap'),
  'dsh-tools/lib/types/schema.js'
)

// C3: 参数必须是受支持的 JSON Schema
contract(
  'C3',
  'parameters 需为合法受支持 JSON Schema（object 根）',
  toolsIdx.includes('assertSupportedJsonSchema'),
  'dsh-tools/lib/index.js'
)

// C4: ask() 的 intent 校验：approve 必须命中选项 label
const uq = at('dsh-user-questions', 'lib/index.js') ?? ''
contract(
  'C4',
  'userQuestions.ask: intent.approve 必须命中该问题自己的某个 option label，否则 BAD_INTENT',
  uq.includes('BAD_INTENT') && uq.includes('names none of its options'),
  'dsh-user-questions/lib/index.js'
)

// C5: ask() 的 intent 校验：必须带 detail
contract(
  'C5',
  'userQuestions.ask: 声明 intent 必须带 detail，否则 BAD_INTENT',
  uq.includes('without the detail it reviews'),
  'dsh-user-questions/lib/index.js'
)

// C6: 无 answerer 时的失败语义（我们据此做 fail-closed 降级）
contract(
  'C6',
  '无 answerer 时 ask 抛 NO_PROVIDER',
  uq.includes('no user-questions answerer accepted the request') && uq.includes('NO_PROVIDER'),
  'dsh-user-questions/lib/index.js'
)

// C7: systemPrompt.section 要求 order 为有限数
const sp = at('dsh-system-prompt', 'lib/index.js') ?? ''
contract(
  'C7',
  'systemPrompt.section 要求 order 为 finite number',
  sp.includes('order must be a finite number'),
  'dsh-system-prompt/lib/index.js'
)

// C8: 卡片 detail 仍以 Markdown 渲染（我们据此决定把内容放 detail）
const ui = at('dsh-client-ui-user-questions', 'lib/client.js') ?? ''
contract(
  'C8',
  '问答卡片把 question.detail 以 Markdown 渲染（可承载 diff/正文）',
  ui.includes('question.detail') && ui.includes('MarkdownText'),
  'dsh-client-ui-user-questions/lib/client.js'
)

// ── 输出 ──
let bad = 0
for (const r of results) {
  if (!r.ok) bad++
  console.log((r.ok ? '  OK   ' : '  BROKEN ') + r.id + '  ' + r.desc)
  if (!r.ok) console.log('         证据位置: ' + r.detail + '  —— 实现可能已变更，需人工核对')
}
console.log('')
fs.closeSync(fd)

console.log(bad === 0
  ? '结论: 契约全部成立，align-mode 可在此版本上运行（' + version + '）'
  : '结论: ' + bad + ' 条契约破裂，请先适配再启用 align-mode')
process.exit(bad === 0 ? 0 : 1)