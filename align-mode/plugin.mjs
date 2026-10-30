/**
 * align-mode — 交付对齐模式（DSH 插件）
 *
 * 定位：模型与人类的实时对齐机制。与 plan mode 无关，也不是审批闸门。
 * 载体：一个 AI 自主决定何时使用的工具 align_deliver —— 给场景，不给死规则。
 *
 * 三项能力：
 *   1) 交付并对齐（create / append / replace）
 *   2) 用户主改闭环：检测外部改动、校验用户改动未被回退
 *   3) 返工（rework）：主动发起推倒重来，先备份、再对齐新方向，才允许重写
 *
 * 工具描述与参数描述照官方 write / edit / ask_user_question 的风格写：
 *   工具描述 = 一两句话说清做什么；细节放参数描述；用法场景放提示词段落。
 *   output 用结构化 JSON Schema，便于程序化消费与前端渲染。
 *
 * 只使用 node: 内置模块；不 import 任何 @deepseek-ai/* 裸包。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const name = 'align-mode'

/** tools 用于注册工具；userQuestions 用于对齐。二者缺一不可。 */
export const inject = ['tools', 'userQuestions']

const DEFAULTS = {
  toolName: 'align_deliver',
  teachScenario: true,
  scenarioText: '',
  maxPreviewChars: 16000,
  echoAfterEditChars: 0,
  backupOnRework: true,
  /** 对照实验用：false 时不补发 fs/observed（预期导致后续原生 edit 被拒）。 */
  emitObserved: true,
  backupDir: '',
  logPath: '',
}

const OPT_CONFIRM = '确认，继续下一段 (Recommended)'
const OPT_EDITED = '我改过了，按我的版本继续'
const OPT_REDIRECT = '方向要微调'
const OPT_REWORK = '方向不对，推倒重来'
const OPT_EXPLAIN = '先解释这一块'
const OPT_RW_OK = '同意，按这个新方向重写 (Recommended)'
const OPT_RW_ADJUST = '新方向我还想调整'
const OPT_RW_HOLD = '先不返工，保留现状'

const SCENARIO_SECTION = 'align-mode:scenario'

/** 每个文件的交付状态（内存派生缓存，重启即失）。 */
const fileState = new Map()

/** 工具内部用运行时构造反引号，使源码本身不含反引号，避免转义问题。 */
const BK = String.fromCharCode(96)

function bound(text, max) {
  if (max <= 0 || text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.floor(max * 0.25)
  return text.slice(0, head) + '\n\n……（省略 ' + (text.length - head - tail) + ' 字符，完整内容见文件）……\n\n' + text.slice(text.length - tail)
}

function addedLines(before, after) {
  const seen = new Set((before === null ? '' : before).split('\n').map((s) => s.trim()).filter(Boolean))
  return after.split('\n').map((s) => s.trim()).filter((l) => l.length > 0 && !seen.has(l))
}

function missingLines(added, next) {
  const hay = new Set(next.split('\n').map((s) => s.trim()))
  return added.filter((l) => !hay.has(l))
}

function simpleDiff(before, after) {
  const a = before === null ? [] : before.split('\n')
  const b = after.split('\n')
  if (before === null) return b.map((l) => '+ ' + l).join('\n')
  let start = 0
  const min = Math.min(a.length, b.length)
  while (start < min && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  const out = []
  const ctx = Math.max(0, start - 2)
  if (ctx > 0) out.push('   …（前 ' + ctx + ' 行未变）')
  for (let i = ctx; i < start; i++) out.push('   ' + a[i])
  for (let i = start; i <= endA; i++) out.push('-  ' + a[i])
  for (let i = start; i <= endB; i++) out.push('+  ' + b[i])
  const ts = endB + 1
  const ca = Math.min(b.length, ts + 2)
  for (let i = ts; i < ca; i++) out.push('   ' + b[i])
  if (ca < b.length) out.push('   …（后 ' + (b.length - ca) + ' 行未变）')
  return out.join('\n')
}

function hostPath(target, agent) {
  if (path.isAbsolute(target)) return target
  const cwd = (agent && (agent.cwd || (agent.session && agent.session.cwd))) || process.cwd()
  return path.resolve(cwd, target)
}

function compose(existing, content, mode) {
  const sep = existing === null || existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  if (mode === 'replace' || existing === null || existing.length === 0) {
    return { next: content, kind: existing === null ? 'create' : 'replace' }
  }
  return { next: existing + sep + content, kind: 'append' }
}


// ════════════════════ 原生兼容层 ════════════════════
// 目标：让本工具与官方 write / read / edit 完全互操作。
//
// 核心事实（rc.5 读实现得出）：
//   - dsh-fs-observation-policy 以 (owner=agent.session, target.targetKey) 记录读过的版本。
//   - 官方 write = resolve → fs/write-intent 瀑布（得 replaceIfVersion / createIfAbsent）
//              → ctx.fs.writeText(target, content, intent, signal, policy)
//   - 官方 read 完成后会 emit 'fs/observed'（{kind:'present', version}）。
//   - 官方 edit 走 fs/edit-intent：未观测 → FS_NOT_OBSERVED；版本不符 → FS_STALE_VERSION。
//
// 所以本插件必须在写入后**补发 fs/observed**（带新版本），
// 否则用户随后让 AI 用原生 edit 改这个文件会被直接拒绝 —— 这是兼容性的关键一环。
// 同时优先走 ctx.fs，以便自动参与沙箱策略与版本校验。

/** 缓存通过 ctx.inject(['fs']) 解析到的后端（direct get 取不到 isolate realm 里的服务）。 */
let scopedFs = undefined

function fsBackend(ctx) {
  if (scopedFs !== undefined) return scopedFs
  try {
    const direct = ctx.get('fs')
    if (direct !== undefined) return direct
  } catch {}
  return undefined
}

/**
 * 在 apply 时通过 ctx.inject(['fs']) 预解析后端（cordis 要求服务走 inject，
 * 直接 ctx.get 拿不到 isolate realm 里的 fs）。
 */
function primeFsBackend(ctx) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['fs'], (scoped) => {
      try {
        if (scoped.fs !== undefined) {
          scopedFs = scoped.fs
          try { fs.appendFileSync('C:/Users/zuoye/Desktop/daima/dsh修复/_probe/align.log', new Date().toISOString() + ' [align] ctx.fs RESOLVED via inject\n') } catch {}
        }
      } catch (e) {
        try { fs.appendFileSync('C:/Users/zuoye/Desktop/daima/dsh修复/_probe/align.log', new Date().toISOString() + ' [align] ctx.fs inject ERR ' + e.message + '\n') } catch {}
      }
    })
  } catch {}
}

function isUsableFs(s) {
  return s !== undefined && s !== null && typeof s.resolve === 'function' &&
    typeof s.readText === 'function' && typeof s.writeText === 'function' && typeof s.stat === 'function'
}

/** 解析成 provider target；无 ctx.fs 时退化为 host 路径。 */
async function makeRef(ctx, resolvedPath, agent) {
  const s = fsBackend(ctx)
  if (!isUsableFs(s)) return { kind: 'host', path: resolvedPath }
  try {
    const target = await s.resolve(resolvedPath, agent !== undefined ? { agent } : undefined)
    return { kind: 'fs', target, svc: s, path: resolvedPath }
  } catch {
    return { kind: 'host', path: resolvedPath }
  }
}

/** 读当前内容与版本（不 emit，读取方会自行 emit）。 */
async function readRef(ref, signal) {
  if (ref.kind === 'host') {
    try { return { content: await fsp.readFile(ref.path, 'utf8'), version: undefined, exists: true } }
    catch { return { content: null, version: undefined, exists: false } }
  }
  let info
  try { info = await ref.svc.stat(ref.target) } catch { info = undefined }
  const exists = info !== undefined && info !== null
  let content = null
  if (exists) { try { content = await ref.svc.readText(ref.target, signal) } catch { content = null } }
  return { content, version: exists ? info.version : undefined, exists }
}

/** 写入：优先 ctx.fs（参与 intent 瀑布与版本校验），否则 node:fs。 */
async function writeRef(ref, ctx, exec, content) {
  if (ref.kind === 'host') {
    await fsp.mkdir(path.dirname(ref.path), { recursive: true })
    await fsp.writeFile(ref.path, content, 'utf8')
    return
  }
  let intent
  try { intent = await ctx.waterfall('fs/write-intent', ref.target, exec, () => undefined) } catch { intent = undefined }
  await ref.svc.writeText(ref.target, content, intent, exec && exec.signal)
}

/** 补发 fs/observed，使后续原生 edit 能通过读后写与版本校验。 */
async function observeRef(ref, ctx, exec) {
  if (ref.kind !== 'fs') return
  if (globalThis.__alignGate_emitObserved === false) return
  let info
  try { info = await ref.svc.stat(ref.target) } catch { info = undefined }
  if (info === undefined || info === null) return
  try { ctx.emit('fs/observed', ref.target, { kind: 'present', version: info.version }, exec) } catch {}
}

/** 把 fs 错误翻成给模型的明确指令。 */
function explainFsError(e) {
  const code = (e && e.code) || (e && e.cause && e.cause.code)
  if (code === 'FS_NOT_OBSERVED') return '该文件尚未被读取过，按项目的读后写策略不能直接覆盖。请先用 read 读取它，再重试交付。'
  if (code === 'FS_STALE_VERSION') return '该文件在你上次读取之后已被改动（可能是用户直接编辑的）。请先重新 read，以最新内容为准再交付。'
  if (code === 'FS_NOT_FOUND') return '文件不存在。若这是首次交付，请用 mode=auto 或 create。'
  if (code === 'FS_NOT_REGULAR_FILE') return '目标不是普通文件，无法写入。'
  return (e && e.message) || 'filesystem error'
}
function scenarioText(cfg) {
  if (typeof cfg.scenarioText === 'string' && cfg.scenarioText.length > 0) return cfg.scenarioText
  const L = []
  L.push('## 交付对齐')
  L.push('')
  L.push('本项目启用「交付对齐」：当你的产出会成为项目的**真实交付物**（开发文档、方案与约定、说明、明确的业务代码模块）时，用 ' + cfg.toolName + ' 逐块交付。')
  L.push('')
  L.push('每次交付会真正写入文件；用户可以立刻读到它、**直接在文件里修改它**，然后选择继续、按他改后的版本继续、微调方向、推倒重来、或先让你解释。你会从工具返回的结构化结果里拿到下一步该怎么做。')
  L.push('')
  L.push('为什么这样更高效：先落盘，用户就能在真实内容上直接改，而不是用语言描述他想改什么；你随后重新读取他的版本再润色与结构化，不必猜测、也不必反复重做同一段。')
  L.push('')
  L.push('**用不用、一次交付多少，由你判断。** 判断依据是"用户是否需要在这块内容上掌握方向与进度"：')
  L.push('- 适合：方向性强、后续内容会建立在这块之上、写错代价高。')
  L.push('- 不适合：探索与试错、临时脚本、调试、纯解释性说明、你自己就能验证对错的小改动。')
  L.push('')
  L.push('一块应当是一个**连贯单元**：大到让用户能对方向下判断，小到他能一次读完并给出意见。')
  L.push('')
  L.push('被用户改过之后：**先读取文件当前内容，以用户的版本为准**；你负责润色、补全与重新结构化，**不要回退或覆盖用户的方向性修改**。若你认为用户的改法有问题，先说清楚，不要直接改掉。')
  L.push('')
  L.push('**方向走错、不得不返工时**：不要默默覆盖已确认的内容。调用 ' + cfg.toolName + ' 时用 mode=rework —— 它会先备份原内容，再请用户确认新方向，然后你才重写；原内容可随时取回。用户也可能在审阅卡里直接选「' + OPT_REWORK + '」。')
  return L.join('\n')
}

export function apply(ctx, injected) {
  const cfg = { ...DEFAULTS, ...(injected || {}) }
  const log = (m) => {
    if (!cfg.logPath) return
    try { fs.appendFileSync(cfg.logPath, new Date().toISOString() + ' ' + m + '\n') } catch {}
  }
  const toolName = String(cfg.toolName || DEFAULTS.toolName)
  primeFsBackend(ctx)
  globalThis.__alignGate_emitObserved = cfg.emitObserved !== false
  log('[align] loaded; tool=' + toolName)

  const code = (s) => BK + s + BK
  const fence = (lang, body) => BK + BK + BK + lang + '\n' + body + '\n' + BK + BK + BK

  async function backupFile(resolved, current) {
    if (current === null || !cfg.backupOnRework) return null
    const dir = typeof cfg.backupDir === 'string' && cfg.backupDir.length > 0 ? cfg.backupDir : path.dirname(resolved)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(dir, path.basename(resolved) + '.rework-backup-' + stamp)
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.writeFile(dest, current, 'utf8')
      log('[align] backed up -> ' + dest)
      return dest
    } catch (e) {
      log('[align] backup failed: ' + (e && e.message))
      return null
    }
  }

  async function ask(exec, question) {
    const svc = ctx.userQuestions || ctx.get('userQuestions')
    if (svc === undefined || typeof svc.ask !== 'function') return { unavailable: true }
    try {
      const answer = await svc.ask({
        questions: [question],
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        signal: exec.signal,
      })
      const first = (answer && answer.answers && answer.answers[0]) || {}
      return {
        choice: (first.selected && first.selected[0]) || '',
        custom: typeof first.custom === 'string' ? first.custom.trim() : '',
      }
    } catch (e) {
      log('[align] ask failed: ' + (e && e.message))
      return { failed: (e && e.message) || 'unknown error' }
    }
  }

  const definition = {
    name: toolName,
    description:
      'Deliver one block of a project artifact by writing it to a file, then ask the user to align on it. ' +
      'The write happens immediately, so the user can read it and edit the file directly before answering. ' +
      'Use it when the user needs to hold direction and progress on that content; skip it for exploration, scratch work, debugging, or pure explanation. ' +
      'Set mode=rework instead when the direction was wrong and a rewrite is unavoidable.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to deliver into, resolved by the filesystem backend. Provide ' + BK + 'path' + BK + ' before ' + BK + 'content' + BK + ' in the arguments.',
        },
        content: {
          type: 'string',
          description: 'The complete content of this one block. Required except for mode=rework, where omitting it means you only want to align on the new direction before rewriting.',
        },
        note: {
          type: 'string',
          description: 'One short line saying what this block is. It becomes the review card heading, so write it in the user language.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'create', 'append', 'replace', 'rework'],
          description: 'auto (default) creates the file when absent and appends when present; append always appends; create refuses when the file already exists; replace overwrites the whole file; rework backs the file up first, aligns the new direction with the user, and only then rewrites.',
        },
        reason: {
          type: 'string',
          description: 'Only for mode=rework: why the direction was wrong and what the new direction is. Shown to the user verbatim.',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['create', 'append', 'replace', 'rework'] },
          outcome: { type: 'string', enum: ['confirmed', 'user_edited', 'redirected', 'rework_requested', 'explained', 'unanswered', 'unavailable'] },
          message: { type: 'string' },
          userNote: { type: 'string' },
          backupPath: { type: 'string' },
          lostUserLines: { type: 'integer' },
        },
        required: ['path', 'operation', 'outcome', 'message'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.message) }],
      presentationMeta: (args, value) => ({
        card: 'diff',
        title: 'Deliver ' + (value.path || args.path),
        diffs: [{ path: value.path || args.path, oldText: null, newText: typeof args.content === 'string' ? args.content : '' }],
        locations: [{ path: value.path || args.path }],
      }),
    },

    async execute(args, exec) {
      const target = typeof args.path === 'string' ? args.path : ''
      const content = typeof args.content === 'string' ? args.content : ''
      const mode = typeof args.mode === 'string' ? args.mode : 'auto'
      const note = typeof args.note === 'string' && args.note.length > 0 ? args.note : '内容交付'
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''

      if (target.length === 0) {
        return { path: '', operation: 'create', outcome: 'unavailable', message: toolName + ': missing required argument path. Nothing changed.' }
      }

      const resolved = hostPath(target, exec.agent)
      const prev = fileState.get(resolved)
      const base = path.basename(resolved)

      const ref = await makeRef(ctx, resolved, exec.agent)
      let snap = await readRef(ref, exec && exec.signal)
      let existing = snap.content

      let externallyChanged = false
      if (prev !== undefined && prev.lastWritten !== null && existing !== null && existing !== prev.lastWritten) {
        externallyChanged = true
        prev.userAuthoritative = existing
        // 关键：在覆盖 lastWritten 之前，先把"用户相对我们上次写入的增量"固定下来。
        // 否则下一次写入会把 lastWritten 变成超集，用户的净增量就再也算不出来了。
        prev.userAdded = addedLines(prev.lastWritten, existing)
        log('[align] external change detected: ' + resolved + ' userAdded=' + prev.userAdded.length)
      }

      if (mode === 'rework') {
        const backupPath = await backupFile(resolved, existing)
        const sum = []
        sum.push('**操作**：返工对齐' + (content.length > 0 ? '（将覆盖重写）' : '（仅对齐方向，暂不写入）'))
        sum.push('**原内容**：' + (existing === null ? '（文件不存在）' : existing.length + ' 字符 / ' + existing.split('\n').length + ' 行'))
        if (backupPath !== null) sum.push('**已备份到**：' + code(backupPath))
        if (reason.length > 0) sum.push('**返工原因 / 新方向**：' + reason)
        const detail = [
          sum.join('  \n'), '', '---', '', '### 该文件当前内容', '',
          existing === null ? '（文件不存在）' : bound(existing, cfg.maxPreviewChars), '',
          '> 若同意重写，原内容已备份，可随时取回。',
        ].join('\n')

        const rw = await ask(exec, {
          id: 'align-rework',
          header: '返工对齐 · ' + base,
          question: 'AI 认为方向需要推倒重来，想对 ' + code(base) + ' 返工。是否按它提出的新方向重写？',
          detail,
          options: [
            { label: OPT_RW_OK, description: '同意按上述新方向重写；原内容已备份。' },
            { label: OPT_RW_ADJUST, description: '新方向我还想调整，会在下方写清楚。' },
            { label: OPT_RW_HOLD, description: '先不返工，保留现状。' },
          ],
          intent: { kind: 'align-rework', approve: OPT_RW_OK, callId: exec.callId },
        })

        if (rw.unavailable) {
          return { path: resolved, operation: 'rework', outcome: 'unavailable', backupPath: backupPath || '', message: 'Rework did not start: the alignment channel is unavailable. ' + (backupPath !== null ? 'The original content is backed up at ' + backupPath + '. ' : '') + 'Tell the user before rewriting anything.' }
        }
        if (rw.failed !== undefined) {
          return { path: resolved, operation: 'rework', outcome: 'unavailable', backupPath: backupPath || '', message: 'Rework did not start: the request could not reach the user (' + rw.failed + '). ' + (backupPath !== null ? 'Original backed up at ' + backupPath + '. ' : '') + 'Do not rewrite.' }
        }
        if (rw.choice === OPT_RW_OK) {
          if (content.length === 0) {
            return { path: resolved, operation: 'rework', outcome: 'confirmed', backupPath: backupPath || '', message: 'The user approved the new direction. Rewrite ' + resolved + ' now, block by block. ' + (backupPath !== null ? 'The original content is backed up at ' + backupPath + '.' : '') }
          }
          try {
            await writeRef(ref, ctx, exec, content)
            await observeRef(ref, ctx, exec)
          } catch (e) {
            return { path: resolved, operation: 'rework', outcome: 'unavailable', backupPath: backupPath || '', message: 'Rework 写入未完成：' + explainFsError(e) + ' 原文件未改动。' + (backupPath !== null ? '备份：' + backupPath : '') }
          }
          fileState.set(resolved, { lastWritten: content, userAuthoritative: null })
          return { path: resolved, operation: 'rework', outcome: 'confirmed', backupPath: backupPath || '', message: 'Rework written to ' + resolved + '. ' + (backupPath !== null ? 'Original backed up at ' + backupPath + '. ' : '') + 'Continue with the next block.' }
        }
        if (rw.choice === OPT_RW_ADJUST) {
          return { path: resolved, operation: 'rework', outcome: 'redirected', backupPath: backupPath || '', userNote: rw.custom, message: 'The user wants to adjust the new direction before you rewrite. ' + (rw.custom.length > 0 ? 'Their note: ' + rw.custom : '(No note given; ask what they want changed instead of guessing.)') + ' Do not rewrite ' + resolved + ' yet.' }
        }
        return { path: resolved, operation: 'rework', outcome: 'unanswered', backupPath: backupPath || '', userNote: rw.custom, message: 'The user chose not to rework for now. Leave ' + resolved + ' as it is.' + (rw.custom.length > 0 ? ' Their note: ' + rw.custom : '') }
      }

      if (content.length === 0) {
        return { path: resolved, operation: 'create', outcome: 'unavailable', message: toolName + ': content is empty and mode is not rework, so nothing was written. Pass content to deliver, or mode=rework to start a rework.' }
      }
      if (mode === 'create' && existing !== null) {
        return { path: resolved, operation: 'create', outcome: 'unavailable', message: 'The file already exists and mode=create refuses to write: ' + resolved + '. Use append, replace, or rework.' }
      }

      const composed = compose(existing, content, mode)
      try {
        await writeRef(ref, ctx, exec, composed.next)
        await observeRef(ref, ctx, exec)
      } catch (e) {
        return { path: resolved, operation: composed.kind, outcome: 'unavailable', message: toolName + ': 写入未完成 —— ' + explainFsError(e) }
      }
      log('[align] wrote ' + composed.kind + ' ' + resolved + ' (+' + content.length + ' chars)')

      const userAdded = prev !== undefined && Array.isArray(prev.userAdded) ? prev.userAdded : []
      const lost = userAdded.length > 0 ? missingLines(userAdded, composed.next) : []
      if (lost.length > 0) log('[align] WARNING: ' + lost.length + ' user-added line(s) missing')

      fileState.set(resolved, {
        lastWritten: composed.next,
        userAuthoritative: prev !== undefined ? prev.userAuthoritative : null,
        userAdded,
      })

      const extras = []
      if (externallyChanged) extras.push('> ⚑ 该文件在本次交付前被**外部修改过**（很可能是你直接编辑的）。')
      if (lost.length > 0) {
        extras.push('> ⚠️ **注意**：你先前增补的 ' + lost.length + ' 行在当前文件里已不存在，请确认是否还需要恢复：\n> ' + lost.slice(0, 8).map((l) => '- ' + code(l.length > 80 ? l.slice(0, 80) + '…' : l)).join('\n> '))
      }

      const opLabel = composed.kind === 'create' ? '新建' : composed.kind === 'append' ? '追加' : '覆盖'
      const detailParts = [
        '**操作**：' + opLabel + ' ' + code(base),
        '**路径**：' + code(resolved),
        '**本次交付**：' + content.length + ' 字符 · 该文件现共 ' + composed.next.split('\n').length + ' 行',
        '', '---', '', '### 本次交付的内容', '', bound(content, cfg.maxPreviewChars),
      ]
      if (existing !== null && composed.kind === 'replace') {
        detailParts.push('', '### 与原文的差异', '', fence('diff', bound(simpleDiff(existing, composed.next), cfg.maxPreviewChars)))
      }
      for (const e of extras) detailParts.push('', e)
      detailParts.push('', '> 你可以**直接编辑这个文件**，然后选「' + OPT_EDITED + '」。')

      const res = await ask(exec, {
        id: 'align-deliver',
        header: note,
        question: '这一块已写入 ' + code(base) + '。请审阅，然后告诉我如何继续。',
        detail: detailParts.join('\n'),
        options: [
          { label: OPT_CONFIRM, description: '这一块没问题，继续往下交付。' },
          { label: OPT_EDITED, description: '我已在文件里改过，请按我改后的版本继续。' },
          { label: OPT_REDIRECT, description: '方向需要微调，我会在下方写清楚。' },
          { label: OPT_REWORK, description: '这块或整个文件推倒重来，先重新对齐方向。' },
          { label: OPT_EXPLAIN, description: '先别往下走，先解释这一块在做什么。' },
        ],
        intent: { kind: 'align-deliver', approve: OPT_CONFIRM, callId: exec.callId },
      })

      const baseResult = { path: resolved, operation: composed.kind, lostUserLines: lost.length }

      if (res.unavailable) {
        return { ...baseResult, outcome: 'unavailable', message: 'Wrote ' + resolved + ' (' + composed.kind + '), but the alignment channel is unavailable, so no confirmation was obtained. Tell the user the file has changed; do not stack more content on top.' }
      }
      if (res.failed !== undefined) {
        return { ...baseResult, outcome: 'unavailable', message: 'Wrote ' + resolved + ', but the alignment request could not reach the user (' + res.failed + '). Tell the user the file changed and wait for instruction.' }
      }
      log('[align] choice=' + res.choice + ' custom=' + res.custom.slice(0, 60))

      const lostNote = lost.length > 0 ? '\n\nWarning: ' + lost.length + ' line(s) the user had added are no longer present; ask whether to restore them.' : ''

      if (res.choice === OPT_CONFIRM) {
        return { ...baseResult, outcome: 'confirmed', message: 'The user confirmed this block (' + base + ', ' + composed.kind + '). Continue with the next block.' + lostNote }
      }
      if (res.choice === OPT_EDITED) {
        let current = ''
        try { const again = await readRef(ref, exec && exec.signal); current = again.content === null ? '' : again.content } catch {}
        const unchanged = current === composed.next
        const head = unchanged
          ? 'The user chose the edited option, but the file content is unchanged from what you just wrote. Confirm whether they actually edited before continuing; do not assume a change you cannot see.'
          : 'The user edited ' + resolved + ' directly. Read the file first and continue from their version. Your job is to polish, complete, and restructure — never revert or overwrite their directional edits.'
        const tail = cfg.echoAfterEditChars > 0 && current.length > 0 ? '\n\n(current content excerpt)\n' + bound(current, cfg.echoAfterEditChars) : ''
        return { ...baseResult, outcome: 'user_edited', userNote: res.custom, message: head + tail + (res.custom.length > 0 ? '\n\nUser added: ' + res.custom : '') + lostNote }
      }
      if (res.choice === OPT_REDIRECT) {
        return { ...baseResult, outcome: 'redirected', userNote: res.custom, message: 'The user wants the direction adjusted. ' + (res.custom.length > 0 ? 'Their note: ' + res.custom : '(No note given; ask what to adjust instead of guessing.)') + ' Read ' + resolved + ' first. If it is a small fix, overwrite this block with ' + toolName + '; if the direction fails as a whole, use mode=rework.' + lostNote }
      }
      if (res.choice === OPT_REWORK) {
        return { ...baseResult, outcome: 'rework_requested', userNote: res.custom, message: 'The user says the direction is wrong and wants to start over. ' + (res.custom.length > 0 ? 'Their note: ' + res.custom : '(No note given; ask what direction they expect.)') + ' Call ' + toolName + ' with mode=rework to start the rework: state the new direction in reason, or pass the rewritten content. It backs the file up and re-aligns the direction first. Do not overwrite now.' + lostNote }
      }
      if (res.choice === OPT_EXPLAIN) {
        return { ...baseResult, outcome: 'explained', userNote: res.custom, message: 'The user wants this block explained before you continue. Explain in plain language: what problem it solves, the key tradeoffs, and any hidden assumptions or risks. Do not write the same content again.' + (res.custom.length > 0 ? '\n\nUser added: ' + res.custom : '') + lostNote }
      }
      return { ...baseResult, outcome: 'unanswered', userNote: res.custom, message: 'No explicit confirmation was given (the card was closed or nothing was selected). This block is already written to ' + resolved + '. Confirm with the user how to proceed; do not stack more content on top.' + (res.custom.length > 0 ? '\n\nUser added: ' + res.custom : '') + lostNote }
    },
  }

  try {
    ctx.tools.register(definition)
    log('[align] tool registered: ' + toolName)
  } catch (e) {
    log('[align] tool registration FAILED: ' + (e && e.message))
    throw e
  }

  if (cfg.teachScenario) {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (scoped) => {
        const sp = scoped.systemPrompt
        if (sp === undefined || typeof sp.section !== 'function') {
          log('[align] systemPrompt unusable; scenario not registered')
          return
        }
        const b = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0
        const order = (typeof b === 'number' ? b : 0) + 12
        scoped.effect(() => sp.section({ name: SCENARIO_SECTION, order, text: scenarioText(cfg) }), 'align-mode.scenario')
        log('[align] scenario section registered (order=' + order + ')')
      })
    } else {
      log('[align] ctx.inject unavailable; scenario not registered')
    }
  }
}