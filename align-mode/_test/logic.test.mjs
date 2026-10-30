/**
 * align-mode 离线单测（v2）
 * 覆盖：官方风格注册契约、结构化 output、五种交付选项、rework 三种结果、
 *       P2 的外部改动检测 / 用户改动被回退检测 / 未改动误报检测。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mod = await import('file:///C:/Users/zuoye/Desktop/daima/dsh%E4%BF%AE%E5%A4%8D/align-mode/plugin.mjs')

let registered = null
let lastReq = null
let sectionReg = null
let answer = { selected: [], custom: '' }
let askCalls = 0
let onAsk = null

function makeCtx(config) {
  const ctx = {
    config,
    tools: { register(def) { registered = def; return () => true } },
    userQuestions: {
      async ask(req) {
        askCalls++; lastReq = req
        if (onAsk !== null) await onAsk(req)
        return { answers: [{ id: req.questions[0].id, selected: answer.selected, ...(answer.custom ? { custom: answer.custom } : {}) }] }
      },
    },
    get(n) { return ctx[n] },
    inject(_d, cb) {
      cb({
        systemPrompt: { section(s) { sectionReg = s; return () => true }, getSectionOrder() { return 0 } },
        effect(fn) { return typeof fn === 'function' ? fn() : undefined },
      })
    },
    effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  }
  return ctx
}

mod.apply(makeCtx({ teachScenario: true }))
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'align2-'))
const exec = { callId: 'c1', signal: new AbortController().signal }
const run = (a) => registered.execute(a, exec)

let pass = 0, fail = 0
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + label) }
  else { fail++; console.log('FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 160) : '')) }
}
const LAST = '确认，继续下一段 (Recommended)'

// ── 注册契约（官方风格：结构化 output）──
check('工具已注册', registered !== null)
check('name 非保留字', registered.name !== 'run_code')
check('parameters 为 object 型 JSON Schema', registered.parameters.type === 'object')
check('required 仅 path（content 在 rework 时可省）', JSON.stringify(registered.parameters.required) === JSON.stringify(['path']))
check('mode 是 enum 且含 rework', Array.isArray(registered.parameters.properties.mode.enum) && registered.parameters.properties.mode.enum.includes('rework'))
check('output.schema 是结构性 object', registered.output.schema.type === 'object' && registered.output.schema.additionalProperties === false)
check('output 声明 required', Array.isArray(registered.output.schema.required) && registered.output.schema.required.includes('outcome'))
check('outcome 是枚举', Array.isArray(registered.output.schema.properties.outcome.enum))
check('render 返回 text block', registered.output.render({}, { message: 'hi' })[0].text === 'hi')
check('presentationMeta 提供 diff 卡片', (() => { const m = registered.output.presentationMeta({ path: 'a.md', content: 'X' }, { path: '/t/a.md' }); return m.card === 'diff' && m.diffs[0].newText === 'X' })())

// ── 四种 mode ──
const f1 = path.join(tmp, 'doc.md')
answer = { selected: [LAST], custom: '' }
let r1 = await run({ path: f1, content: '# A', note: '第一章' })
check('auto 新建', (await fsp.readFile(f1, 'utf8')) === '# A')
check('返回结构化 outcome=confirmed', r1.outcome === 'confirmed' && r1.operation === 'create', r1)
check('返回含 path', typeof r1.path === 'string' && r1.path.endsWith('doc.md'))

let r3 = await run({ path: f1, content: '## B' })
check('auto 追加', (await fsp.readFile(f1, 'utf8')).includes('## B'))
check('追加 outcome=confirmed', r3.outcome === 'confirmed' && r3.operation === 'append')

await run({ path: f1, content: 'REPLACED', mode: 'replace' })
check('replace 覆盖', (await fsp.readFile(f1, 'utf8')) === 'REPLACED')

const r5 = await run({ path: f1, content: 'x', mode: 'create' })
check('create 遇已存在拒绝', r5.outcome === 'unavailable')
check('拒绝时未改动', (await fsp.readFile(f1, 'utf8')) === 'REPLACED')

check('缺 path 返回 unavailable', (await run({ content: 'x' })).outcome === 'unavailable')
check('空 content 返回 unavailable', (await run({ path: f1, content: '' })).outcome === 'unavailable')

// ── 卡片契约 ──
answer = { selected: [LAST], custom: '' }
askCalls = 0
await run({ path: f1, content: 'C', note: '标题X' })
const q = lastReq.questions[0]
check('卡片 header = note', q.header === '标题X')
check('卡片 5 个选项', q.options.length === 5)
check('首个选项带 (Recommended)', /(Recommended)/.test(q.options[0].label))
check('intent.approve 命中选项', q.options.some((o) => o.label === q.intent.approve))
check('intent 带 callId', q.intent.callId === 'c1')
check('detail 有内容', typeof q.detail === 'string' && q.detail.length > 20)

// ── 各选项 outcome ──
onAsk = async () => { await fsp.appendFile(f1, '\nUSER REAL EDIT') }
answer = { selected: ['我改过了，按我的版本继续'], custom: '' }
const rE = await run({ path: f1, content: 'E' })
onAsk = null
check('改过 outcome=user_edited', rE.outcome === 'user_edited')
check('改过要求以其版本为准', /never revert or overwrite/.test(rE.message))

answer = { selected: ['方向要微调'], custom: '先讲背景' }
const rR = await run({ path: f1, content: 'R' })
check('微调 outcome=redirected', rR.outcome === 'redirected' && rR.userNote === '先讲背景')

answer = { selected: ['方向不对，推倒重来'], custom: '' }
const rW = await run({ path: f1, content: 'W' })
check('用户要求返工 outcome=rework_requested', rW.outcome === 'rework_requested')
check('返工建议含 mode=rework', /mode=rework/.test(rW.message))

answer = { selected: ['先解释这一块'], custom: '' }
const rX = await run({ path: f1, content: 'X' })
check('解释 outcome=explained', rX.outcome === 'explained')

answer = { selected: [], custom: '' }
const rN = await run({ path: f1, content: 'N' })
check('未选择 outcome=unanswered', rN.outcome === 'unanswered')

// ── rework 分支 ──
const f2 = path.join(tmp, 'plan.md')
await fsp.writeFile(f2, 'ORIGINAL CONTENT')
answer = { selected: ['同意，按这个新方向重写 (Recommended)'], custom: '' }
const rw1 = await run({ path: f2, content: '', mode: 'rework', reason: '方向错了，改为先讲目标' })
check('rework 仅对齐：不改文件', (await fsp.readFile(f2, 'utf8')) === 'ORIGINAL CONTENT')
check('rework 返回 backupPath', typeof rw1.backupPath === 'string' && rw1.backupPath.length > 0)
check('rework 备份文件存在', fs.existsSync(rw1.backupPath))
check('rework 指导重写', /Rewrite/.test(rw1.message))
check('rework 卡片是返工卡', lastReq.questions[0].id === 'align-rework' && lastReq.questions[0].options.length === 3)

answer = { selected: ['新方向我还想调整'], custom: '先讲范围' }
const rw2 = await run({ path: f2, content: 'NEW', mode: 'rework' })
check('rework 调整：不写入', (await fsp.readFile(f2, 'utf8')) === 'ORIGINAL CONTENT')
check('rework 调整 outcome=redirected', rw2.outcome === 'redirected' && rw2.userNote === '先讲范围')

answer = { selected: ['先不返工，保留现状'], custom: '' }
const rw3 = await run({ path: f2, content: 'NEW2', mode: 'rework' })
check('rework 保留：不写入', (await fsp.readFile(f2, 'utf8')) === 'ORIGINAL CONTENT')
check('rework 保留 outcome=unanswered', rw3.outcome === 'unanswered')

answer = { selected: ['同意，按这个新方向重写 (Recommended)'], custom: '' }
const rw4 = await run({ path: f2, content: 'NEW3', mode: 'rework' })
check('rework 同意且带 content：写入', (await fsp.readFile(f2, 'utf8')) === 'NEW3')
check('rework 写入 outcome=confirmed', rw4.outcome === 'confirmed')

// ── P2: 用户改动被回退检测 ──
const f3 = path.join(tmp, 'p2.md')
answer = { selected: [LAST], custom: '' }
await run({ path: f3, content: 'base line' })
// 模拟用户直接在文件里加一行
await fsp.appendFile(f3, '\nUSER ADDED IMPORTANT LINE')
answer = { selected: ['我改过了，按我的版本继续'], custom: '' }
const rEd = await run({ path: f3, content: 'base line' })
check('检测到外部改动（卡片 detail 标注）', /外部修改过/.test(lastReq.questions[0].detail))
// 下一次用 replace 丢掉用户那行 -> 应检出 lostUserLines
answer = { selected: [LAST], custom: '' }
const rLost = await run({ path: f3, content: 'totally new', mode: 'replace' })
check('检出用户改动被回退 lostUserLines>0', rLost.lostUserLines > 0, rLost.lostUserLines)
check('回退提示进入 message', /no longer present|restore/.test(rLost.message), rLost.message.slice(0, 120))

// ── P2: 误点「我改过了」但文件没变 ──
const f4 = path.join(tmp, 'p2b.md')
answer = { selected: [LAST], custom: '' }
await run({ path: f4, content: 'same' })
answer = { selected: ['我改过了，按我的版本继续'], custom: '' }
const rNo = await run({ path: f4, content: 'same' })
check('未改动时提示确认（不假设有改动）', /unchanged/.test(rNo.message), rNo.message.slice(0, 120))

// ── 场景段落 ──
check('场景段落已注册', sectionReg !== null && sectionReg.name === 'align-mode:scenario')
check('场景含工具名', sectionReg.text.includes('align_deliver'))
check('场景强调判断权在 AI', /由你判断/.test(sectionReg.text))
check('场景含返工指引', /rework/.test(sectionReg.text))


// ── 原生兼容：以源码断言保证桥接存在且受开关控制 ──
const srcText = fs.readFileSync('C:/Users/zuoye/Desktop/daima/dsh修复/align-mode/plugin.mjs', 'utf8')
check('兼容层：存在 makeRef', /function makeRef\(/.test(srcText))
check('兼容层：存在 writeRef 并走 fs.writeText', /await ref\.svc\.writeText\(/.test(srcText))
check('兼容层：存在 observeRef 并 emit fs/observed', /ctx\.emit\('fs\/observed'/.test(srcText))
check('兼容层：writeIntent 瀑布已接入', /ctx\.waterfall\('fs\/write-intent'/.test(srcText))
check('兼容层：读后写错误有明确指引', /FS_NOT_OBSERVED/.test(srcText) && /先用 read/.test(srcText))
check('兼容层：版本冲突错误有明确指引', /FS_STALE_VERSION/.test(srcText) && /重新 read/.test(srcText))
check('兼容层：通过 ctx.inject 解析 fs', /ctx\.inject\(\['fs'\]/.test(srcText))
check('兼容层：emitObserved 开关存在', /emitObserved: true/.test(srcText))

console.log()
console.log('PASS=' + pass + '  FAIL=' + fail + '  askCalls=' + askCalls)
await fsp.rm(tmp, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)