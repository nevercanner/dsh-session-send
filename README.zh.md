[English](./README.md) · **简体中文**

# dsh-session-send

DSH 会话总线：让**不同 DSH session / agent 之间可以互相发消息**。

参考 OpenClaw 的 `session send` 建立的 agent 层通信**做法**，做成 DSH 插件。
默认关闭，只在「被手动开启的项目」内生效。

> **它不是 OpenClaw 插件。** 它运行在 DSH 宿主里，**不读也不写 `openclaw.json`**，
> 不读 OpenClaw 的 session 账本，不注册 channel。参考的是**消息语义**，不是它的配置或数据面。
> （早期版本曾把开关放在 `openclaw.json` 的 `dshBus` 块里 —— 那是定位错误，已移除。）

---

## 通信语义（对齐 openclaw `session send`）

```ts
send({ from, to, kind, payload, replyTo?, deliveryMode? })

// to           : session id | agent id | dsh-team 成员名 | "*"（广播）
// kind         : text | request | response | event
// deliveryMode : steer（默认）| followup | notify
// payload      : { text, data? }
// replyTo      : kind=response 时指向原消息的 id
```

### 关键：消息真的会把对方叫起来

这不是「写进数据库等人来读」。目标是活着的 DSH 会话时，消息直接进入**它自己的收件箱**
并唤醒它 —— 就像 openclaw 的 `session send`。

| openclaw `mode` | 本插件 `deliveryMode` | DSH 实际调用 | 行为 |
|---|---|---|---|
| `notify` | `notify` | `agent.inject(msg)` | 只放入收件箱，不唤醒 |
| `steer` | `steer`（默认） | `agent.steer(msg)` | 注入运行中的轮次（下个 step 边界）并唤醒 |
| `followup` | `followup` | `agent.followup(msg)` | 作为下一轮入队并唤醒 |

`agent.steer()` 的宿主实现是 `this.inbox.splice(target, Infinity, 0, [message])` +
`wakeDriver()` —— **直接往目标会话自己的收件箱追加，没有任何父子关系校验**。
所以 7 个彼此平级的独立会话之间可以任意互发，不需要谁是谁的子会话。

> 为什么不用 `ctx.subagents.sendMessage()`：它的契约是
> 「sender's **direct parent** or **direct continuable child**」，
> 平级会话之间会被 adjacency 校验直接拒掉。这里要的正是平级。

### 目标不在本进程时

`ctx.agents.get(id)` 返回 `undefined`（会话没打开 / 进程里没有它）：
消息**仍然落库**，`deliveries[].mode = "durable"`，等它下次打开时由
`dsh_bus_inbox` 取走。降级路径保留是必须的 —— 否则「发给一个没打开的会话」就变成永久失败。

### 实测证据（真实宿主，2026-11-08）

对 `D:\openclaw-data\agents\shared\SOP\loop` 下某个 idle 会话 steer 一条探针：

```
beforePhase: idle          ← 投递前空闲
result:      { outcome: "steered", detail: "已注入并唤醒目标" }
afterPhase:  running       ← 投递后真的跑起来了
```

目标会话的事件流里：探针在 seq 7343，之后是完整的一轮
`user/message → request/header → assistant/message → turn/end`，
它自己的回复是「连通性自检消息已收到，探针正常，无需操作。」

---

## 典型用法：一个项目里多个会话分工

```
管线维护  ──dsh_bus_send(to="跑章选手", "第三章管线就绪，请跑章")──▶ 跑章选手
跑章选手  ──dsh_bus_send(to="门禁", "第三章完成，请复核")──────────▶ 门禁
```

每个会话都是独立的、平级的、有自己的上下文。交接时**不需要人复制提示词**。

模型侧看到的是 4 个工具：

| 工具 | 作用 |
|---|---|
| `dsh_bus_send` | `{to, text, deliveryMode?, kind?, data?, replyTo?}` |
| `dsh_bus_inbox` | 读自己的来信 + 未读数（`markRead: true` 顺带标记） |
| `dsh_bus_agents` | 列**当前活着**的会话（只有它们能被立即唤醒）+ 各来源可用性 |
| `dsh_bus_reply` | 回一条消息（收件人自动取原消息发送方） |

---

## 项目根怎么定（重要）

**每次调用都按调用者解析**，不在装配时定死。

优先级：显式配置 `projectRoot` > 调用者会话的 `cwd` > 当前 initiator 的 cwd > 进程 cwd。

为什么必须这样：宿主长期运行，同一进程里有多个 workspace 的会话。
谁在启动瞬间触发装配，不该决定之后所有调用用哪个项目的配置 ——
否则会出现「A 项目里开的会话，发消息却去读 B 项目的开关」。

实测踩过的坑：插件启动时 `currentInitiator()` 为空，回退到 `process.cwd()`
（= `C:\Users\HUAWEI\.dsh\profiles\desktop`），把项目根定死在 profile 目录。
之后在 `D:\openclaw-data` 里调工具，报「本项目未启用：...\profiles\desktop\.dsh-bus.json 不存在」，
而那个项目里明明有配置文件。

修法：`BusService.useFor(exec)` 每次按调用者解析，命中不同项目就重装配（串行化，避免并发踩踏）。
回归测试见 `tests/project-resolution.test.mjs`（7 项，含并发串行化与「来回跨项目各自用自己的根」）。

---

## 开启方式（不用手写文件）

**点一下就行。** 左侧栏任意 Session 行的「...」菜单里有一行：

```
● 会话总线：开启「dsh-session-send」
```

- 圆点表示当前状态：实心 = 该项目已开启，空心 = 关闭，灰色 = 状态未知
- 文字写清作用对象（项目名）与将要执行的动作（开启 / 关闭）
- 点一下 → 写 `<workspace>/.dsh-bus.json` → **热生效**，不需要重启宿主
- 再点一下就是关闭（把 `enabled` 置 `false`，**不删文件**，你手写的其它字段保留）

总线面板（左侧栏图标进入）右上角也有一个「开启本项目 / 关闭本项目」按钮，
两条路径调同一个接口，行为完全一致。

### 为什么挂在 Session 行的菜单，而不是项目行

宿主**没有**给 Workspace（项目）行开放菜单扩展点。`ui-workspace` 里那个「...」
是硬编码的两行 `[rename, delete]`，全仓唯一的 workspace 级扩展点是
`sidebar.workspaces.directoryFlow`（目录选择用），不能塞菜单项。

宿主唯一开放的 Session 行菜单（`sidebar.workspaces.session.menu.item`）因此成为选择：
菜单行拿 `sessionId` → 用宿主 `useSessions` 找到该会话所属的 workspace →
读/写**那个项目**的开关。所以它就是「项目开关」，只是入口在会话行上。

### 另一把锁（插件自身允许运行）

`cordis.patch.yml` 里的 `enabled` 是「插件是否工作」，与项目开关无关：

```yaml
- insert:
    - id: dsh-session-send
      name: 'dsh-session-send'
      config:
        enabled: true                      # ← 打开第一把锁
        projectConfigName: '.dsh-bus.json'
```

项目开关（`.dsh-bus.json`）由菜单控制，**日常不需要碰这个文件**。

### 被写出来的配置长什么样

首次开启时创建（已存在则只改 `enabled`，其它字段原样保留）：

```json
{
  "enabled": true,
  "scope": "project",
  "transport": { "kind": "sqlite" }
}
```

想改传输方式等高级项，编辑这个文件即可；再次点菜单只会翻 `enabled`，不会覆盖你的设置。

配置文件损坏时**拒绝覆盖**（点了会报错并保持原文件）——覆盖等于悄悄丢掉你写的内容。

---

## 可覆盖的配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 本项目总开关 |
| `scope` | `'project'` | 只允许 `project` |
| `transport.kind` | `'sqlite'` | `sqlite` / `file` / `in-process` |
| `transport.sqlitePath` | `<项目>/.dsh-bus/bus.db` | 想复用别的库就指过去 |
| `transport.fileDir` | `<项目>/.dsh-bus` | `kind=file` 时的落盘目录 |
| `registry.sources` | `['dsh-team','dsh-sessions']` | 可寻址身份来源 |
| `registry.stateDir` | `'.agent-teams'` | dsh-team 的状态目录名 |
| `router.allowBroadcast` | `true` | 是否允许 `to: "*"` |
| `router.maxPayloadChars` | `20000` | 单条正文上限 |
| `router.dshTeam.enabled` | `true` | 是否接入 dsh-team |
| `router.dshTeam.target` | `'auto'` | `auto` / `service` / `mailbox` |
| `labels` | `{}` | 会话显示名映射：`{ "<session id>": "跑章选手" }` |
| `ui.entry` | `true` | 是否挂左侧栏入口 |
| `ui.pollMs` | `4000` | 面板轮询间隔 |

### 给会话起名：自注册（推荐，可推广）

宿主的会话 `title` 是异步生成的，历史会话大多为空 —— 列表里只能看到 uuid。
**不需要任何人手写 id 表**：让每个会话自己报名一次。

```
# 在「管线维护」那个会话里：
dsh_bus_register({ name: "管线维护" })

# 在「门禁」那个会话里：
dsh_bus_register({ name: "门禁" })
```

之后：

- 列表里直接显示这些名字
- 别的会话可以 `dsh_bus_send({ to: "门禁", text: "..." })` 直接按名字寻址
- 名册存在**项目内** `.dsh-bus/names.json`，不进全局配置，不跨项目泄漏
- 报名立刻生效，不用重启、不用改配置

```json
// <workspace>/.dsh-bus/names.json（自动维护，一般不用手改）
{
  "session-4c72b65e-da51-4a5f-999d-e9551e9f8dca": { "name": "管线维护", "at": 1794127757976 }
}
```

清除登记：`dsh_bus_register({ name: "" })`。

**批量报名**（整项目一次性初始化，不用逐个会话操作）：

```js
dsh_bus_register({
  selfName: "管线维护",                                    // ← 同时给**自己**起名
  entries: {
    "session-4c72b65e-da51-4a5f-999d-e9551e9f8dca": "cast",
    "session-da38f11a-5982-4d2c-bc3d-c5381400cf88": "outline",
    "session-54288ce6-ac61-446b-95ef-de3d2fe6fcb7": "gate"
  }
})
```

> **`entries` 不包含你自己。** 批量报名只给列表里那些会话起名，调用者本身不会自动获得名字 ——
> 除非传 `selfName`（或把自己的 id 也写进 `entries`）。
> 返回里会给出 `callerNamed`，调用后你仍然没有名字时会附带警告。
>
> 这是真实踩过的坑：一次批量报名写了 6 个 lane、忘了调用者自己，
> 看着全部成功，但调用者在列表里始终是无名状态。

返回 `applied`（成功）与 `rejected`（跨项目的 id 会被拒，附原因）。
用空字符串作为名字即清除该条。

**显示名优先级：自注册名 > 配置 `labels` > 宿主 title > 兜底名（`11-08 15:49 · e9f8dca`）**

### 什么可以用来寻址（重要）

`to` 只接受**绑定在 session id 上**的引用：

| 可用作 `to` | 说明 |
|---|---|
| **session id** | 唯一、稳定、永不变。**这是最可靠的键** |
| 自注册名 | 会话自己报的名，绑在 id 上 |
| 配置 `labels` 名 | 绑在 id 上 |
| 宿主 title | 宿主的正式字段 |
| `"*"` | 广播给本项目其它会话 |

**兜底显示名（`11-08 15:49 · e9f8dca`）不可寻址。**

它是从 id + 创建时间**派生**出来的显示字符串，不是身份。拿它当键会让派生值冒充身份，
也让使用者误以为名字可以随手写。它只用于**人看**，用来分辨「哪条是哪条」，
真要发消息请用 session id 或让对方 `dsh_bus_register` 报名。

```js
// ✅ 可靠
dsh_bus_send({ to: "session-76c2376e-62aa-4a4e-9609-a28be23df880", text: "..." })
dsh_bus_send({ to: "管线维护", text: "..." })   // 对方报名过

// ❌ 会被明确拒绝，并提示改用 id
dsh_bus_send({ to: "11-08 15:49 · e9f8dca", text: "..." })
```

配置里的 `labels` 是可选的覆盖手段 —— 想强制改某个名字时才用：

```json
{ "enabled": true, "labels": { "session-4c72...": "临时改名" } }
```

`labels` 同样参与 `to` 解析。两者都不写时，兜底名仍然保证 121 个会话不重名。

---

## 四层解耦

```
src/index.ts              插件入口：name / description / Config / apply（含 runtime 工厂）
src/config/schema.ts      zod 校验（zod 缺席时降级），enabled 默认 false
src/config/project-config.ts  <workspace>/.dsh-bus.json 读取
src/api/control.ts        项目开关的**唯一写入口**（只翻 enabled，保留其它字段）
src/transport/            sqlite | file | in-process，同一 Transport 接口
src/registry/             dsh-team adapter + dsh-sessions，同一 RegistryProvider 接口
src/router/               解析 → 落库 → 投递；广播、replyTo 关联
src/api/                  service（含热切换）/ routes（HTTP）/ tools（模型侧）
src/ui/client.js          左侧栏入口 + 面板 + 未读浮标 + **Session 行菜单开关**
src/compat.ts             宿主版本 fail-fast
```

**边界（硬约束）**

- `transport` 不 import `registry` / `router` / `ui`，不读任何配置文件；
- `router` 不 import `ui`，不读任何配置文件（配置由构造注入）；
- **dsh-team 只出现在 `src/registry/dsh-team-adapter.ts` 一处**——只包装，不 fork、不复制、不改它；
- `ui` 只通过 `/plugins/dsh-session-send/*` HTTP 面取数据，不直接读写文件；
- **只有 `src/api/control.ts` 会写文件**，且只写 `<workspace>/.dsh-bus.json` 的 `enabled`。

任意一层都可以独立替换：加一个 `Transport` / `RegistryProvider` 实现，改工厂里的一行。

---

## dsh-team（AgentTeams）集成

调研结论（实测 `@nanmicoder/dsh-agent-teams` v0.1.29）：

- 状态在 `<workspace>/.agent-teams/<teamId>/team.json`，邮箱是 `inbox/<agentKey>.jsonl`；
- 它导出的投递函数：`deliverToMember` / `steerCaptainReport` / `appendMailbox` / `mailboxPrompt`；
- 它自己的 `agent_teams_send_message` 返回 `delivered ∈ live | wake | mailbox | duplicate`。

adapter 的三种模式（自动降级，差异全在 adapter 内）：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `service` | 宿主有官方 `ctx.agentTeams` 服务且能找到发起方 Agent | 调 `service.sendMessage(caller, {target, content, signal})` |
| `mailbox` | 能加载它的 `members.js`（有 `deliverToMember`/`steerCaptainReport`） | 写它的 inbox + 尽力唤醒 |
| `fs-only` | 版本漂移、函数对不上、包没装 | 只写它的 inbox，保证消息不丢 |

`adapter.mode` 会出现在 `/plugins/dsh-session-send/status` 与 `dsh_bus_agents` 的输出里，
排查「为什么消息只落库没唤醒」时先看这一项。同时看 `adapter.resolved`：
`false` 表示模块还没加载，此时的 `mode` 只是初始值，不代表实际能力。

### 包解析为什么容易失败

本插件被 junction 链接进 profile，`import.meta.url` 解析到的是链接的**目标**
（`D:\openclaw-data\dsh-session-send`），从那里向上找不到 profile 的 `node_modules` ——
`createRequire` 必然 `MODULE_NOT_FOUND`。

而且本机只有 `DSH_PROFILE` + `DSH_HOME`，**没有** `DSH_PROFILE_DIR`。
早期实现只认 `DSH_PROFILE_DIR`，所以永远解析不到，adapter 静默退化为 `fs-only`。

现在的解析顺序（每步只检查 `package.json` 是否存在，绝不抛错）：

1. `OPENCLAW_DSH_BUS_DSH_TEAM_DIR`（显式指定，排障用）
2. `DSH_PROFILE_DIR/node_modules/<pkg>`
3. **`DSH_HOME/profiles/<DSH_PROFILE>/node_modules/<pkg>`** ← 本机主路径
4. `DSH_HOME/profiles/*/node_modules/<pkg>`（不知道 profile 名时扫一遍）
5. 从 `process.cwd()` 逐级向上找 `node_modules`
6. `createRequire(import.meta.url)`（普通安装布局下才有效）

回归测试见 `tests/dsh-team-resolve.test.mjs`（7 项，含「DSH_PROFILE_DIR 缺席」的真实事故现场）。

---

## 存储

默认 `<workspace>/.dsh-bus/bus.db`（sqlite，`node:sqlite` 内置，Node >= 22.5）。

两张表，DDL 见 `migrations/001_dsh_bus.sql`（与 `BUS_DDL` 逐字一致，幂等）：

- `dsh_bus_messages` —— 消息本体（from/to/kind/reply_to/broadcast_id/payload/meta）
- `dsh_bus_receipts` —— 每个身份的已读状态（`read_at IS NULL` = 未读）

数据落**项目内**：换项目换一份库，不与任何项目外的库耦合。
想复用外部库就在 `.dsh-bus.json` 写 `transport.sqlitePath`。

---

## 界面

**Session 行「...」菜单**（主要入口）：

```
● 会话总线：开启「项目名」      ← 空心点，点一下写入并热生效
```

点完变成：

```
● 会话总线：关闭「项目名」      ← 实心点，点一下关闭（保留其它配置）
```

**左侧栏图标**（`sidebar.panellist`，order 40）→ 点开主区整页（`main`）：

- 左列：可寻址身份（dsh-team 成员 + 活着的 DSH session），带未读数徽标
- 右列：消息流（按会话视角，自己的消息高亮）+ 输入框
- 右上角：「开启本项目 / 关闭本项目」按钮（与菜单同一接口）
- 未开启时显示「为什么没开」+ 会被写入的内容预览

**未读浮标**（`shell.overlay`）：有未读时出现在右下角，点开进面板。

---

## 模型侧工具

| 工具 | 作用 |
|---|---|
| `dsh_bus_send` | 发消息 `{to, text, deliveryMode?, kind?, data?, replyTo?, from?}` |
| `dsh_bus_inbox` | 读自己的来信 + 未读数（`direction: "outbox"` 看待发件箱） |
| `dsh_bus_agents` | 列**本项目**可寻址会话（只有它们能被立即唤醒）+ 各来源可用性 |
| `dsh_bus_reply` | 回一条消息（`kind=response` + `replyTo`，收件人自动取原消息发送方） |
| `dsh_bus_register` | **给自己报名**：`{ name: "管线维护" }`，之后别人可 `to: "管线维护"` |

未开启时全部返回 `E_DISABLED`，并在消息里写明怎么打开。

另注册只读斜杠命令 `/dsh-bus`：打印当前状态、兼容性、以及未开启时的开启方法。

---

## 开发

```bash
npm run build      # src/*.ts → lib/*.js（用 node:module.stripTypeScriptTypes，不依赖 tsc）
npm test           # 99 项测试
npm run typecheck  # 需要本机有 tsc
```

测试分组：

| 文件 | 覆盖 |
|---|---|
| `tests/router.test.mjs` | 路由语义（单播/广播/replyTo/未读/错误码） |
| `tests/config.test.mjs` | 配置校验与项目级配置读取 |
| `tests/transport.test.mjs` | 三种 transport 的接口契约 |
| `tests/dsh-team-adapter.test.mjs` | dsh-team 只包装不复制 |
| `tests/plugin.test.mjs` | 装配集成（假宿主） |
| `tests/control.test.mjs` | 项目开关写入口（只翻 enabled、坏配置拒覆盖、原子写） |
| `tests/switch.test.mjs` | 开关端到端（点一下 → 写盘 → 热生效） |
| `tests/routes.test.mjs` | 路由注册容错（一条失败不中断后面） |
| `tests/session-push.test.mjs` | **跨会话投递**（7 个平级会话互相流转） |
| `tests/project-resolution.test.mjs` | **项目根按调用者解析**（真实事故回归） |
| `tests/dsh-team-resolve.test.mjs` | **dsh-team 包解析**（junction + 缺 DSH_PROFILE_DIR 的真实事故） |

构建不依赖 TypeScript 编译器，只要求 Node >= 22.18（`stripTypeScriptTypes` 稳定）。

---

## 错误码

| 码 | HTTP | 含义 |
|---|---|---|
| `E_DISABLED` | 409 | 本项目未开启 |
| `E_TARGET_NOT_FOUND` | 404 | 目标不存在 |
| `E_AMBIGUOUS_TARGET` | 409 | 命中多个身份（返回候选列表） |
| `E_BROADCAST_DISABLED` | 403 | 配置禁用了广播 |
| `E_BROADCAST_EMPTY` | 409 | 广播没有目标 |
| `E_PAYLOAD_EMPTY` | 400 | 正文为空 |
| `E_PAYLOAD_TOO_LARGE` | 413 | 超过 `maxPayloadChars` |
| `E_REPLY_TARGET_MISSING` | 400 | `replyTo` 缺失或指向不存在的消息 |
| `E_TRANSPORT` | 500 | 存储层失败 |

---

## 已知限制

**热重载时路由会残留。** 宿主的 `webServer` 对 exact 路由去重，且 `loader.remove()`
不会摘除已注册的 HTTP 路由。因此热重载后新 entry 注册同一路径会撞上
`duplicate exact route`。

`src/api/routes.ts` 对此做了容错：**一条注册失败不中断后面的路由**（每条独立 try），
失败的记为 warning 并返回空 disposer。这样新增的路由（例如后来的 `/project`）
在重载后仍能挂上，只是旧路径继续由上一代的 handler 服务 —— 两者代码相同，行为一致。

彻底干净需要重启 dsh。这条限制来自宿主，不是插件能绕开的。
