# align-mode · 交付对齐模式

> **定位**：模型与人类的**实时对齐**机制 —— 提高准确性与人类对项目的掌握度。
> **不是** plan mode 的优化，**不是**审批闸门，**与 plan mode 没有任何关系**。
> 对齐版本：DSH **0.2.1-rc.5**（8 条契约逐条核实，见 §7）。
> 当前状态：P1（场景调优）、P2（用户主改可靠性）、**返工能力**均已完成并实测。

---

## 1. 它解决什么问题

三个真实失败模式：

1. **AI 太爱不做规划直接开始**。你反复说"先计划"，它计划完就认为可以动手了。
2. **产出一次性倒出来，人类无法逐段控制**。而只让它在聊天里输出的话，永远是一大段文本，更难限缩。
3. **方向走错后只能推倒重来**，却没有安全的返工路径 —— 要么默默覆盖已确认的内容，要么从头开始。

关键判断：**AI 必须真的动手写文件（尤其是 md 文档）**。内容只有落到磁盘上，你才能在**真实内容**上直接修改，而不是用语言描述你想改什么。

所以本插件提供的不是"拦截"，而是**一个 AI 自主决定何时使用的工具**：把一块内容交出来 → 真正落盘 → 当场与你对齐 → 你可以在文件里直接改 → 它重新读取你的版本再继续。

## 2. 核心差异：给场景，不给死规则

| 不做 | 理由 |
|---|---|
| 不限制单块体积（无 chars/lines 上限） | 死规则会干扰 AI 的自主判断 |
| 不强制拦截 `write` / `edit` | 同上 |
| 不绑定 plan mode | plan mode 不让 AI 动手，反而是问题所在 |

取而代之：工具的**描述**说明"做什么"，一段**使用场景**（提示词段落）说明"什么场合适合用"，**用不用、一次交付多少由 AI 判断** —— 场景文字里明确写着"判断权在你"。

## 3. 工作流程

```
AI 产出一块内容
      │
      ▼
align_deliver({ path, content, note })    ← AI 自主决定调用
      │
      ├─ 真正写入文件（create / append / replace；已存在则追加）
      │
      ▼
弹出审阅卡片（detail 以 Markdown 渲染，可直接读全文）
      │
      │   ⚑ 此时你可以**直接编辑这个文件**（卡片不会挡住你）
      │
      ▼
你选一个：
   ● 确认，继续下一段 (Recommended)
   ● 我改过了，按我的版本继续
   ● 方向要微调
   ● 方向不对，推倒重来          ← 触发下面的返工流程
   ● 先解释这一块
      │
      ▼
工具返回**结构化结果**（含 outcome 枚举）→ AI 据此继续
```

## 4. 返工能力（本次新增）

方向走错、不得不返工时，**AI 可以主动发起返工**，而不是默默覆盖：

```
AI 或你在卡片里判定「方向不对」
      │
      ▼
AI 调用 align_deliver({ path, mode: 'rework', reason: '新方向是…' })
      │
      ├─ ① 先把原内容备份到 <file>.rework-backup-<时间戳>   ← 可随时取回
      │
      ▼
弹出「返工对齐」卡片：展示返工原因 + 完整原内容
   ● 同意，按这个新方向重写 (Recommended)
   ● 新方向我还想调整
   ● 先不返工，保留现状
      │
      ▼
只有你同意后，AI 才重写（且分块交付、逐块确认）
```

**三种结果都被实测覆盖**：同意 → 重写并保留备份；想调整 → **不写入**，要求 AI 先更新方案；保留现状 → **不写入**。

### 实测记录（rc.5，真实模型）

```
[align] wrote append ...rework-demo.md (+54 chars)
[align] choice=方向不对，推倒重来
[align] backed up -> ...rework-demo.md.rework-backup-2026-10-30T07-23-10-538Z
[align] wrote replace ...rework-demo.md (+231 chars)      ← 方向获批后才重写
[align] wrote append ...rework-demo.md (+245 chars)
[align] wrote append ...rework-demo.md (+160 chars)
```

模型自述：
> 你判定方向不对后，**我没有直接覆盖**，而是走 `mode=rework`：原内容**已备份**到 …，并**先与新方向对齐**（目标与读者优先，实现细节降为附录）。

## 5. 用户主改的可靠性保障（P2）

「我改过了」是这套设计的灵魂，所以它有**程序级**保障：

| 机制 | 作用 |
|---|---|
| 检测外部改动 | 交付前若文件与上次我们写入的不一致，判定为你直接改过，并在卡片上标注 ⚑ |
| 记录用户增量 | 在你改动的**那一刻**固定下"你相对我们上次写入新增了哪些行"（基线不能事后补算） |
| 校验未被回退 | 后续写入若让这些行消失，返回里带 `lostUserLines` 并在卡片和结果中明确告警 |
| 误点检测 | 你选了「我改过了」但文件内容其实没变，它会提示 AI 先确认，**不要假设看不见的改动** |

> 诚实说明：行级比对是**启发式**（按去空白后的行文本），不是语义判断。它用于发现"明显被吞掉"，不做内容理解。

## 6. 工具描述与参数（照官方风格写）

参考官方 `write` / `edit` / `ask_user_question` 的写法做了三处对齐：

| 官方做法 | 本插件的做法 |
|---|---|
| 工具描述**一两句话**说清做什么，细节放参数描述 | 工具描述 4 句：做什么、立即落盘、何时用/不用、何时改用 rework |
| 参数描述精确，含顺序提示与默认值 | `path` 写明 "Provide path before content"；`mode` 逐值解释；`reason` 标注仅 rework 用 |
| 推荐项**放第一个并加 `(Recommended)`** | 确认项与返工同意项都遵守此约定 |
| **结构化 output**（不是纯字符串） | 见下 |

### 结构化输出

```jsonc
{
  "path": "...",
  "operation": "create | append | replace | rework",
  "outcome": "confirmed | user_edited | redirected | rework_requested | explained | unanswered | unavailable",
  "message": "给模型的下一步指令（人类可读，也是渲染给模型的文本）",
  "userNote": "你的意见原文",
  "backupPath": "返工备份路径",
  "lostUserLines": 0
}
```

程序化调用方可以按 `outcome` 分支，而不是解析散文。同时提供 `presentationMeta`（与官方 `write` 一致）供 host 侧消费者使用 —— 内置 Web 客户端不消费它，但这是官方约定，便于将来接入。

## 7. 版本对齐与未来兼容性

### 7.1 已核实的契约（rc.3 与 rc.5 均成立）

只依赖**公开可校验**的契约，不 import 任何 `@deepseek-ai/*` 裸包：

| # | 契约 |
|---|---|
| C1 | `ctx.tools.register(plainObject)` 接受普通对象，要求 `output{schema,render}`，拒绝保留名 `run_code` |
| C2 | `defineTool` 只是便利层（参数规格→JSON Schema + 校验包装） |
| C3 | `parameters` 必须是受支持的 JSON Schema（object 根） |
| C4 | `ask()`：声明 `intent` 则 `approve` 必须命中该问题自己的某个 `option.label`，否则 `BAD_INTENT` |
| C5 | `ask()`：声明 `intent` 必须带 `detail`，否则 `BAD_INTENT` |
| C6 | 无 answerer 时 `ask()` 抛 `NO_PROVIDER` |
| C7 | `systemPrompt.section` 要求 `order` 为 finite number |
| C8 | 问答卡片把 `question.detail` 以 Markdown 渲染 |

### 7.2 升级回归：一条命令

```bash
node align-mode/_test/compat-probe.mjs
```

它**直接从当前 app.asar 读取实现**并逐条断言上表契约。rc.5 实测：8/8 成立。退出码非 0 时指出破裂位置。

**每次升级后的标准动作**：跑探针 → 跑离线单测（52 项）→ 跑一次真实端到端。

## 8. 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolName` | `align_deliver` | 工具名（模型可见） |
| `teachScenario` | `true` | 是否写入使用场景段落 |
| `scenarioText` | `''` | 覆盖默认场景文本，便于按项目调整 |
| `maxPreviewChars` | `16000` | 卡片展示内容上限 |
| `echoAfterEditChars` | `0` | 「我改过了」时附带当前内容节选；**0 = 让它自己 read**（当前选择） |
| `backupOnRework` | `true` | 返工前自动备份 |
| `backupDir` | `''` | 备份目录；留空 = 与目标同目录 |
| `logPath` | `''` | 调试日志 |

## 9. 验证方式（四层）

| 层 | 手段 | 现状 |
|---|---|---|
| L1 | `node --check` | ✅ |
| L2 | 离线单测（mock ctx 驱动 execute 与卡片构造） | ✅ **52 项全通过** |
| L3 | 真实进程 + 自动 answerer（`--patch` 叠加 headless） | ✅ 交付 / 用户主改 / 返工 三条流程通过 |
| L4 | 你在 GUI 里实际点 | ⏳ 待安装 |

## 10. 局限性

### 设计边界
- **依赖 AI 主动使用**（刻意的代价：换来自主性与灵活性）。若它某次没用，你说一句即可。
- 只覆盖这个工具；AI 若改用 `write` 就绕过对齐（实测它没有）。
- **不是裁判**：保证"你看到了"，不保证"内容是对的"。
- 不做代码 debug 辅助、不做违规检测、不做体积护栏（均为你的明确决定）。

### 平台约束
- 卡片受限于问答卡：无并排 diff、无行内评论、无多块批量确认。
- 子代理内调用不弹卡（live child 不能调人类交互）。
- 无 UI 环境无法对齐（已写入但明确告知未送达，不假装成功）。
- 不能新增持久 session 事件 → 交付状态是内存派生缓存，重启即失（用户增量基线与漏检告警同样如此）。
- desktop profile 由 Electron 独占 → 安装必须走 GUI。

### 尚未对齐的拓展性差距（诚实记录）
- 官方 `write` 走 `ctx.fs`：`resolve` → `fs/write-intent` 瀑布 → `writeText(target, content, intent, signal, policy)`，因此能参与文件系统策略、沙箱与观察策略。
- 本插件直接用 `node:fs`，**不触发这些扩展点**。要补齐需要 `sessionResolveOptions` 与 `sandbox.resolvePolicy` —— 这两个 helper 是 `dsh-tool-fs` 的内部实现，第三方插件无法直接复用。这是"第三方工具拓展性天然弱于官方工具"的**具体证据**，已列为后续项。
- 官方工具还有 `presentCall()` / `presentResult()`，内置 Web 客户端不消费；要拿到原生级渲染需注册 `tool.call.toolview` 客户端插件。

### 版本脆弱性
- 依赖的 8 条契约是从**编译产物**读出的实现细节；上游重构可能改变措辞或结构 → 用 §7.2 的探针把关。

## 12. 与原生工具的兼容（实测 A/B 对照）

官方 `write` / `edit` 走 `ctx.fs`，并参与两层原生策略：

1. **读后写策略**（`dsh-fs-observation-policy`）：以 `(owner=agent.session, target.targetKey)` 记录“读过的版本”；
   未观测 → `FS_NOT_OBSERVED`；版本不符 → `FS_STALE_VERSION`。
2. **写入意图瀑布**：`fs/write-intent` 决定本次是 `replaceIfVersion` 还是 `createIfAbsent`。

### 12.1 我们做了什么

| 环节 | 做法 |
|---|---|
| 后端 | 通过 `ctx.inject(['fs'])` 解析真实后端（**直接 `ctx.get('fs')` 取不到**，见 §12.2） |
| 读取 | `resolve` → `stat` → `readText`，拿到内容与版本 |
| 写入 | 先取 `fs/write-intent` 结果，再 `writeText(target, content, intent, signal)` —— 与官方同一条路径 |
| **关键一步** | 写入后**补发 `fs/observed`**（带新版本），让策略层知道这个文件已被观测 |
| 错误翻译 | `FS_NOT_OBSERVED` / `FS_STALE_VERSION` / `FS_NOT_FOUND` 都翻成明确的下一步指令 |
| 降级 | 没有 `ctx.fs`（如 headless 无后端、或测试环境）时回落 `node:fs` |

### 12.2 一个必须记住的坑

实测：
```
ctx.get('fs')            → undefined       ← 直接 get 拿不到
ctx.inject(['fs'], ...)  → RESOLVED        ← 必须走 inject
```

原因：`fs` 由 `dsh-fs-sandbox` 提供，且处在 agent preset 的 `isolate` realm 内。
cordis 的服务必须通过 `inject` 或注入作用域解析。我最初用 `ctx.fs` 直接取，日志一直是 `available = false`。

### 12.3 A/B 对照实验（证明桥接是必要条件，不是巧合）

两个用例完全相同：**用 `align_deliver` 写入 → 不调 `read` → 直接用原生 `edit` 改词**。只切换 `emitObserved` 开关：

| `emitObserved` | 原生 `edit` 结果 | 证据 |
|---|---|---|
| `true`（默认） | ✅ **成功** | 文件中 `BETA` 变为 `GAMMA` |
| `false` | ❌ **失败** | `Error: cannot modify ... file has not been read — read the file, then retry` |

关闭桥接时，模型自己得出了错误结论：
> align_deliver 写入**不会**计入 edit 的“已读”状态 …… `align_deliver → edit` 这条链路并不天然兼容。

开启桥接时，模型的结论正好相反：
> 本会话的 fs 观测策略通常要求“改前先读”，但 `align_deliver` 写入的文件被视为已观测 …… 直接 `edit` 通过了观测校验。

**所以：没有这一层桥接，“我们的工具 + 原生工具”混用会在第二步就断掉。**

### 12.4 仍然存在的差距（诚实）

| 项 | 状态 |
|---|---|
| 写入参与读后写策略 / 版本校验 / 写入意图瀑布 | ✅ 已接入 |
| 写入遵守沙箱策略 | ⚠️ **部分**：`dsh-fs-sandbox` 的 `writeText` 内部会做 `checkedTarget` 校验，但官方的 `sandbox.resolvePolicy('write', args, exec)` 是 `dsh-tool-fs` 的内部 helper，第三方拿不到 → 可能缺少逐调用策略与升级审批 |
| 原生卡片渲染（`tool.call.toolview`） | ❌ 未做，需写客户端插件 |
| `presentCall`/`presentResult` | ⚠️ 已提供 `presentationMeta`（与官方 write 同款），但内置 Web 客户端不消费 |

## 11. 文件清单

| 文件 | 作用 |
|---|---|
| `plugin.mjs` | 插件本体（工具 + 场景段落），只依赖 `node:` 内置模块 |
| `cordis.patch.yml` | 装配层 |
| `package.json` | bundle 清单（`dsh.bundle.patch`） |
| `_test/logic.test.mjs` | 离线单测 52 项 |
| `_test/compat-probe.mjs` | 升级回归探针（8 条契约） |
| `ROADMAP.md` | 开发路线图 |