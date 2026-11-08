/**
 * 左侧栏入口 + 总线面板 + **Session 行菜单里的项目开关**（Client 半）。
 *
 * 为什么这一半是纯 JS：dsh 的 Client 半必须是 `window.__ModuleLoader__.load({...})`
 * 形态的单文件产物；宿主角色的行为逻辑全在 host 半（TS），这一半只做渲染与 fetch。
 *
 * 挂载点（见 cordis_inspect Slots / ui-workspace README）：
 *   sidebar.workspaces.session.menu.item —— Session 行「...」菜单里的一行（**项目开关**）
 *   sidebar.panellist                     —— 左侧栏面板图标
 *   main                                  —— 点图标后主区整页
 *   shell.overlay                         —— 未读浮标
 *
 * 关于「项目开关放在 Session 行菜单」这件事：
 *   宿主**没有**给 Workspace（项目）行本身开放菜单扩展点 ——
 *   ui-workspace 里那个 "..." 菜单是硬编码的 [rename, delete] 两行，
 *   全仓唯一的 workspace 级扩展点是 `sidebar.workspaces.directoryFlow`（目录选择）。
 *   因此这里挂在 Session 行菜单上，并**作用于该会话所属的项目**：
 *   拿 sessionId → 用宿主 useSessions 找到它的 workspace → 读/写该项目的 .dsh-bus.json。
 *   菜单文字直接写清作用对象（项目名），避免误解成「只对这个会话」。
 *
 * 数据面：只调 host 半暴露的 /plugins/dsh-session-send/*，
 * 不直接读写文件、不自己改配置。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-send',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-send'
    const API = '/plugins/dsh-session-send'

    /** 侧栏图标：一条「总线 + 两个端点」，跟插件的实际含义对应。 */
    function BusIcon(props) {
      const size = props?.size ?? 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 3.6, cy: 10, r: 2 }),
        h('circle', { cx: 16.4, cy: 5.2, r: 2 }),
        h('circle', { cx: 16.4, cy: 14.8, r: 2 }),
        h('path', { d: 'M5.6 10h4.2M9.8 10c0-2.6 1.4-4.8 4.6-4.8M9.8 10c0 2.6 1.4 4.8 4.6 4.8' }),
      )
    }

    /** 开关状态圆点：开=实心，关=空心，读不到=灰。 */
    function StateDot(props) {
      const state = props?.state
      const color =
        state === 'on'
          ? 'var(--dsh-color-accent, #4c8dff)'
          : state === 'off'
            ? 'var(--dsh-color-text-tertiary, rgba(128,128,128,.75))'
            : 'var(--dsh-color-text-quaternary, rgba(128,128,128,.45))'
      return h(
        'span',
        {
          'aria-hidden': 'true',
          style: {
            width: 8,
            height: 8,
            borderRadius: '50%',
            flex: '0 0 auto',
            background: state === 'on' ? color : 'transparent',
            border: `1.5px solid ${color}`,
            boxSizing: 'border-box',
          },
        },
        null,
      )
    }

    const CSS = `
.odbus-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsh-color-text-primary, inherit); }
.odbus-head { display:flex; align-items:center; gap:8px; padding:14px 18px 10px; border-bottom:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.22)); }
.odbus-title { font-size:15px; font-weight:600; letter-spacing:.2px; }
.odbus-pill { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.35)); opacity:.85; }
.odbus-pill.on { border-color:var(--dsh-color-accent, #4c8dff); color:var(--dsh-color-accent, #4c8dff); }
.odbus-body { display:flex; flex:1; min-height:0; }
.odbus-col { display:flex; flex-direction:column; min-height:0; }
.odbus-list { width:264px; border-right:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.22)); overflow:auto; padding:8px; }
.odbus-flow { flex:1; min-width:0; display:flex; flex-direction:column; }
.odbus-row { display:flex; align-items:center; gap:8px; width:100%; text-align:left; padding:8px 10px; border-radius:8px; border:1px solid transparent; background:transparent; color:inherit; cursor:pointer; font:inherit; }
.odbus-row:hover { background:var(--dsh-color-fill-hover, rgba(128,128,128,.12)); }
.odbus-row.active { border-color:var(--dsh-color-accent, #4c8dff); background:var(--dsh-color-fill-active, rgba(76,141,255,.12)); }
.odbus-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.odbus-src { font-size:11px; opacity:.55; }
.odbus-badge { min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--dsh-color-accent, #4c8dff); color:#fff; font-size:11px; line-height:18px; text-align:center; }
.odbus-msgs { flex:1; overflow:auto; padding:14px 18px; display:flex; flex-direction:column; gap:10px; }
.odbus-msg { border:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.22)); border-radius:10px; padding:9px 11px; font-size:13px; line-height:1.55; }
.odbus-msg.mine { background:var(--dsh-color-fill-active, rgba(76,141,255,.08)); }
.odbus-meta { font-size:11px; opacity:.6; margin-bottom:4px; display:flex; gap:8px; flex-wrap:wrap; }
.odbus-text { white-space:pre-wrap; word-break:break-word; }
.odbus-compose { border-top:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.22)); padding:10px 18px 14px; display:flex; gap:8px; align-items:flex-end; }
.odbus-input { flex:1; min-height:38px; max-height:132px; resize:vertical; padding:8px 10px; border-radius:8px; border:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.35)); background:transparent; color:inherit; font:inherit; }
.odbus-btn { padding:7px 14px; border-radius:8px; border:1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.35)); background:transparent; color:inherit; font:inherit; cursor:pointer; }
.odbus-btn.primary { background:var(--dsh-color-accent, #4c8dff); border-color:transparent; color:#fff; }
.odbus-btn[disabled] { opacity:.45; cursor:not-allowed; }
.odbus-note { padding:18px; font-size:13px; line-height:1.7; opacity:.8; }
.odbus-note code { font-size:12px; padding:1px 5px; border-radius:4px; background:rgba(128,128,128,.16); }
.odbus-kind { font-size:11px; padding:0 6px; border-radius:6px; border:1px solid currentColor; opacity:.7; }
.odbus-pre { margin:8px 0 0; padding:10px 12px; border-radius:8px; background:rgba(128,128,128,.12); font-size:12px; line-height:1.6; overflow:auto; }
`

    /** 一次 fetch：统一错误码翻译，UI 上只显示人话。 */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, { cache: 'no-store', ...init })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const error = body && body.error ? body.error : { code: `HTTP_${response.status}`, message: `HTTP ${response.status}` }
        const wrapped = new Error(error.message || 'request failed')
        wrapped.code = error.code
        throw wrapped
      }
      return body
    }

    function fmtTime(ts) {
      try {
        return new Date(ts).toLocaleTimeString()
      } catch {
        return String(ts)
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Session 行「...」菜单里的一行：项目开关
    // ─────────────────────────────────────────────────────────────

    /** 菜单行显示文案：动作 + 项目名 + 当前状态。 */
    function menuLabel(state, projectName, busy) {
      if (busy) return '会话总线：切换中…'
      if (state === undefined) return '会话总线：状态未知'
      const action = state.enabled ? '关闭' : '开启'
      const where = projectName ? `「${projectName}」` : '本项目'
      return `会话总线：${action}${where}`
    }

    /**
     * 菜单行组件。
     *
     * ── 为什么不再读 useSessions / MenuItemButton ──────────────────
     * 真实事故：同一个菜单项在有些会话里渲染、有些会话里完全消失，
     * 而且是静默的（没报错）。根因是宿主给 slot 注入的 props 不稳定：
     * 有的会话带 useSessions，有的不带；组件里的 `useMenuOpenState()`
     * 这种「宿主 hook」在非 React 渲染路径下会抛 Invalid hook call，
     * 被 slot 的 reportEntryError 吞掉，整行就不显示了。
     *
     * 现在一律不碰宿主注入的东西：
     *   · 项目根：调 host 的 /whoami?session=<id>，由 host 侧查会话目录
     *   · 状态/切换：/project 路由
     *   · 渲染：只用 React 自身的 useState/useEffect + 原生 button
     * 这样它就是一个普通 React 组件，与宿主 props 完全解耦。
     */
    function ProjectToggleMenuItem(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''

      const [state, setState] = React.useState(undefined)
      const [projectRoot, setProjectRoot] = React.useState(undefined)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      // 打开菜单时读一次 whoami（不轮询：菜单是短暂出现的）
      React.useEffect(() => {
        let alive = true
        if (sessionId === '') {
          setState(undefined)
          setProjectRoot(undefined)
          return () => { alive = false }
        }
        api(`/whoami?session=${encodeURIComponent(sessionId)}`)
          .then((body) => {
            if (!alive) return
            setProjectRoot(typeof body?.projectRoot === 'string' ? body.projectRoot : undefined)
            setState(body?.project ?? null)
          })
          .catch((caught) => {
            if (alive) {
              setState(undefined)
              setError(caught?.message ?? String(caught))
            }
          })
        return () => { alive = false }
      }, [sessionId])

      async function toggle() {
        if (projectRoot === undefined || busy) return
        setBusy(true)
        try {
          const body = await api('/project', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project: projectRoot }),
          })
          setState(body?.project ?? null)
          setError('')
        } catch (caught) {
          setError(`${caught?.code ? `[${caught.code}] ` : ''}${caught?.message ?? String(caught)}`)
        } finally {
          setBusy(false)
        }
      }

      const projectName = projectRoot === undefined ? '' : (projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '')
      const dotState = state === undefined ? 'unknown' : state.enabled ? 'on' : 'off'
      const disabled = projectRoot === undefined || busy
      const title = error !== '' ? error : projectRoot === undefined ? '无法定位该会话所属项目' : undefined

      const children = [
        h(StateDot, { key: 'dot', state: dotState }),
        h('span', { key: 'label', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          menuLabel(state, projectName, busy)),
      ]

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled,
          title: title ?? (displayTitle ? `项目：${projectName}` : undefined),
          onClick: (event) => {
            event.stopPropagation()
            void toggle()
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            padding: '6px 10px',
            border: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          },
        },
        ...children,
      )
    }

    // ─────────────────────────────────────────────────────────────
    // 主面板
    // ─────────────────────────────────────────────────────────────

    function BusPanel(props) {
      const [status, setStatus] = React.useState(null)
      const [agents, setAgents] = React.useState([])
      const [unread, setUnread] = React.useState([])
      const [messages, setMessages] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const owner = typeof props?.owner === 'string' ? props.owner : ''
      const pollMs = typeof props?.pollMs === 'number' ? props.pollMs : 4000
      const bottomRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const statusBody = await api('/status')
          setStatus(statusBody.status)
          if (!statusBody.status?.enabled) {
            setAgents([])
            setMessages([])
            setUnread([])
            return
          }
          const [agentsBody, messagesBody] = await Promise.all([
            api(`/agents?owner=${encodeURIComponent(owner)}`),
            api(`/messages?owner=${encodeURIComponent(owner)}&limit=200`),
          ])
          setAgents(Array.isArray(agentsBody.agents) ? agentsBody.agents : [])
          setUnread(Array.isArray(agentsBody.unread) ? agentsBody.unread : [])
          setMessages(Array.isArray(messagesBody.messages) ? messagesBody.messages : [])
          setError('')
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        }
      }, [owner])

      React.useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), pollMs)
        return () => clearInterval(timer)
      }, [load, pollMs])

      React.useEffect(() => {
        const element = bottomRef.current
        if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'end' })
      }, [messages.length])

      const unreadOf = (id) => {
        const found = unread.find((item) => item.target === id)
        return found ? found.count : 0
      }

      async function send() {
        const text = draft.trim()
        const to = selected.trim() || '*'
        if (text === '') return
        setBusy(true)
        try {
          await api('/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from: owner, to, kind: 'text', payload: { text } }),
          })
          setDraft('')
          setError('')
          await load()
        } catch (caught) {
          setError(`${caught?.code ? `[${caught.code}] ` : ''}${caught?.message ?? String(caught)}`)
        } finally {
          setBusy(false)
        }
      }

      async function markRead() {
        if (owner === '') return
        const ids = messages.filter((message) => message.toId === owner && message.fromId !== owner).map((message) => message.id)
        if (ids.length === 0) return
        try {
          await api('/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: owner, ids }),
          })
          await load()
        } catch (caught) {
          setError(caught?.message ?? String(caught))
        }
      }

      /** 面板里也放一个开关：不方便找 Session 行菜单时还能从这里切。 */
      async function toggleHere() {
        const root = status?.projectRoot
        if (typeof root !== 'string' || root === '') return
        setBusy(true)
        try {
          await api('/project', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ project: root }),
          })
          await load()
        } catch (caught) {
          setError(`${caught?.code ? `[${caught.code}] ` : ''}${caught?.message ?? String(caught)}`)
        } finally {
          setBusy(false)
        }
      }

      const enabled = status?.enabled === true
      const shown = selected === '' ? messages : messages.filter((message) => message.toId === selected || message.fromId === selected)
      const configPath = status?.projectConfigPath ?? '.dsh-bus.json'

      return h(
        'div',
        { className: 'odbus-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'odbus-head' },
          h('span', { className: 'odbus-title' }, '会话总线'),
          h('span', { className: `odbus-pill${enabled ? ' on' : ''}` }, enabled ? `on · ${status?.transport ?? ''}` : '未开启'),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { className: `odbus-btn${enabled ? '' : ' primary'}`, onClick: () => void toggleHere(), disabled: busy, type: 'button' },
            enabled ? '关闭本项目' : '开启本项目',
          ),
          enabled ? h('button', { className: 'odbus-btn', onClick: markRead, type: 'button' }, '全部已读') : null,
        ),
        !enabled
          ? h(
              'div',
              { className: 'odbus-note' },
              h('div', null, '会话总线在本项目里是关闭的（默认就是关闭）。'),
              h('div', { style: { marginTop: 8 } }, '点上面的「开启本项目」即可 —— 它会写入：'),
              h('div', { style: { marginTop: 4 } }, h('code', null, configPath)),
              h('pre', { className: 'odbus-pre' }, JSON.stringify({ enabled: true, transport: { kind: 'sqlite' } }, null, 2)),
              h('div', { style: { marginTop: 8 } }, '项目根：', h('code', null, status?.projectRoot ?? '(未知)')),
              status?.disabledReason ? h('div', { style: { marginTop: 8 } }, '当前原因：', status.disabledReason) : null,
              status?.warnings && status.warnings.length > 0
                ? h('div', { style: { marginTop: 10, opacity: 0.75 } }, status.warnings.join('；'))
                : null,
            )
          : h(
              'div',
              { className: 'odbus-body' },
              h(
                'div',
                { className: 'odbus-list odbus-col' },
                h(
                  'button',
                  { className: `odbus-row${selected === '' ? ' active' : ''}`, onClick: () => setSelected(''), type: 'button' },
                  h('span', { className: 'odbus-name' }, '全部消息'),
                ),
                agents.map((agent) =>
                  h(
                    'button',
                    {
                      key: `${agent.source}:${agent.id}`,
                      className: `odbus-row${selected === agent.id ? ' active' : ''}`,
                      onClick: () => setSelected(agent.id),
                      type: 'button',
                      title: agent.id,
                    },
                    h('span', { className: 'odbus-name' }, agent.name || agent.id.slice(0, 8)),
                    h('span', { className: 'odbus-src' }, agent.source === 'dsh-team' ? 'team' : 'session'),
                    unreadOf(agent.id) > 0 ? h('span', { className: 'odbus-badge' }, unreadOf(agent.id)) : null,
                  ),
                ),
                unreadOf(owner) > 0
                  ? h('div', { className: 'odbus-note', style: { padding: '8px 10px', fontSize: 12 } }, `你有 ${unreadOf(owner)} 条未读`)
                  : null,
              ),
              h(
                'div',
                { className: 'odbus-flow' },
                h(
                  'div',
                  { className: 'odbus-msgs' },
                  shown.length === 0 ? h('div', { className: 'odbus-note' }, '还没有消息。选一个身份，在下面发第一条。') : null,
                  shown.map((message) =>
                    h(
                      'div',
                      { key: message.id, className: `odbus-msg${message.fromId === owner ? ' mine' : ''}` },
                      h(
                        'div',
                        { className: 'odbus-meta' },
                        h('span', null, message.fromName || message.fromId.slice(0, 8)),
                        h('span', null, '→'),
                        h('span', null, message.toName || message.toId.slice(0, 8)),
                        h('span', { className: 'odbus-kind' }, message.kind),
                        h('span', null, fmtTime(message.ts)),
                        message.replyTo ? h('span', null, '回复') : null,
                      ),
                      h('div', { className: 'odbus-text' }, message.payload?.text ?? ''),
                    ),
                  ),
                  h('div', { ref: bottomRef }),
                ),
                error
                  ? h('div', { className: 'odbus-note', style: { color: 'var(--dsh-color-danger, #e5484d)', padding: '8px 18px' } }, error)
                  : null,
                h(
                  'div',
                  { className: 'odbus-compose' },
                  h('textarea', {
                    className: 'odbus-input',
                    value: draft,
                    placeholder: selected ? `发给 ${selected.slice(0, 12)}…` : '广播：发给所有可寻址身份（选一个身份可单发）',
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        void send()
                      }
                    },
                  }),
                  h(
                    'button',
                    { className: 'odbus-btn primary', disabled: busy || draft.trim() === '', onClick: () => void send(), type: 'button' },
                    busy ? '发送中…' : '发送',
                  ),
                ),
              ),
            ),
      )
    }

    /** 未读浮标（shell.overlay 席位）：有未读才出现，点开进总线面板。 */
    function UnreadFloater(props) {
      const [state, setState] = React.useState({ enabled: false, unread: 0 })
      const pollMs = typeof props?.pollMs === 'number' ? props.pollMs : 8000

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const owner = readOwner()
            if (owner === '') return
            const body = await api(`/agents?owner=${encodeURIComponent(owner)}`)
            if (!alive) return
            const mine = Array.isArray(body?.unread) ? body.unread.find((item) => item.target === owner) : undefined
            setState({ enabled: body?.enabled === true, unread: mine ? mine.count : 0 })
          } catch {
            if (alive) setState({ enabled: false, unread: 0 })
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), pollMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [pollMs])

      if (!state.enabled || state.unread <= 0) return null
      return h(
        'button',
        {
          type: 'button',
          onClick: () => props?.onOpen?.(),
          title: `会话总线：${state.unread} 条未读`,
          style: {
            position: 'fixed',
            right: '18px',
            bottom: '18px',
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 14px',
            borderRadius: '999px',
            border: '1px solid var(--dsh-color-border-subtle, rgba(128,128,128,.35))',
            background: 'var(--dsh-color-accent, #4c8dff)',
            color: '#fff',
            font: 'inherit',
            fontSize: '13px',
            cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
          },
        },
        h(BusIcon, { size: 15 }),
        h('span', null, `会话总线 ${state.unread}`),
      )
    }

    // ── DOM 兜底：不依赖 slot 服务的菜单注入 ────────────────────────
    //
    // 宿主 ui-workspace 给每个 session 行打 `data-row-key="session:<id>"`，
    // 菜单是 `[role="menu"]` 的浮层。做法：
    //   · 捕获阶段记录最近一次点开的 session id（从行 DOM 上读）
    //   · MutationObserver 观察菜单出现，若里面没有我们的行就插一个原生行
    //   · 行内按钮点击 → /whoami 拿项目 → /project POST 翻转 → 刷新文案
    //
    // 与 codex-ui 的「分叉会话」是同一条路径，已在目标机器上稳定生效。
    // 不碰 ctx.slots / register / 任何宿主 hook，因此不会被 park 或吞错。
    function installDomFallback() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      const ATTR = 'data-dsh-bus-menu-item'
      let lastSessionId = ''

      // 记录最近点开的会话：优先读行上的 data-row-key，
      // 再退到菜单锚点向上找带该属性的祖先。
      function findSessionId(node) {
        let cur = node
        for (let i = 0; i < 8 && cur; i += 1, cur = cur.parentElement) {
          const key = cur?.getAttribute?.('data-row-key')
          if (typeof key === 'string' && key.startsWith('session:')) return key.slice(8)
        }
        return ''
      }

      document.addEventListener('pointerdown', (event) => {
        const id = findSessionId(event.target)
        if (id !== '') lastSessionId = id
      }, true)

      async function refresh(button, sessionId) {
        const label = button.querySelector('[data-dsh-bus-label]')
        const setText = (t) => { if (label) label.textContent = t }
        if (sessionId === '') { setText('会话总线：无法确定会话'); return }
        try {
          const body = await api(`/whoami?session=${encodeURIComponent(sessionId)}`)
          if (!body?.projectRoot) { setText('会话总线：无法定位项目'); return }
          const name = body.projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? '本项目'
          const enabled = body.project?.enabled === true
          setText(`会话总线：${enabled ? '关闭' : '开启'}「${name}」`)
          button.dataset.project = body.projectRoot
          button.dataset.enabled = enabled ? '1' : '0'
        } catch (e) {
          setText(`会话总线：${e?.message ?? '状态未知'}`)
        }
      }

      function buildRow(menu, sessionId) {
        // 有干净 slot 行就不重复插
        if (menu.querySelector(`[${ATTR}]`) !== null) return
        const reference = menu.querySelector('button[role="menuitem"]')
        if (reference === null) return

        const wrap = document.createElement('div')
        wrap.setAttribute(ATTR, '1')
        wrap.setAttribute('role', 'menuitem')
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        Object.assign(button.style, {
          display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
          padding: '6px 10px', border: 0, background: 'transparent',
          color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        })
        const dot = document.createElement('span')
        Object.assign(dot.style, { width: '7px', height: '7px', borderRadius: '50%', background: '#888', flex: 'none' })
        const label = document.createElement('span')
        label.setAttribute('data-dsh-bus-label', '1')
        label.textContent = '会话总线：读取中…'
        button.append(dot, label)

        button.addEventListener('click', async (event) => {
          event.preventDefault()
          event.stopPropagation()
          const project = button.dataset.project
          if (!project) { label.textContent = '会话总线：无法定位项目'; return }
          label.textContent = '会话总线：切换中…'
          try {
            const body = await api('/project', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ project }),
            })
            const enabled = body?.project?.enabled === true
            label.textContent = `会话总线：${enabled ? '关闭' : '开启'}「${project.split(/[\\/]/).filter(Boolean).pop() ?? '本项目'}」`
            dot.style.background = enabled ? '#3c9' : '#888'
            button.dataset.enabled = enabled ? '1' : '0'
          } catch (e) {
            label.textContent = `会话总线：${e?.message ?? '切换失败'}`
          }
        })

        wrap.appendChild(button)
        // 插到最后一个菜单项之后（同一容器），与宿主行共用表面
        const container = reference.parentElement?.parentElement ?? menu
        container.appendChild(wrap)
        void refresh(button, sessionId)
      }

      const observer = new MutationObserver(() => {
        const menus = Array.from(document.querySelectorAll('[role="menu"]'))
        for (const menu of menus) {
          if (menu.querySelector('button[role="menuitem"]') === null) continue
          buildRow(menu, lastSessionId)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })

      // 菜单可能在 observer 装好之前就已存在，补一次
      try {
        for (const menu of document.querySelectorAll('[role="menu"]')) buildRow(menu, lastSessionId)
      } catch { /* 忽略 */ }

      return () => observer.disconnect()
    }

    // 注入声明只保留 slots 一个（宿主菜单 slot 用它，一定存在）。
    // 早先还声明了 layout，但如果客户端没有这个服务名，runner 会把整个
    // package park 掉 —— apply 根本不跑，菜单项永远不出现。
    return {
      inject: ['slots'],
      apply(ctx) {
        let selectPanel = () => {}

        // ── ① DOM 兜底（主路径，与「分叉会话」同源）──
        //
        // 为什么不再只靠 slots.register：那条链路经过 guardedSlots →
        // env.claim → reportEntryError，任何一环抛错都会被静默吞掉，
        // 表现为「同一份代码，有的会话显示、有的会话整行消失」。
        // 这里改成纯浏览器 API：捕获点击记录 sessionId，菜单出现时若
        // 没有我们的行就直接插一个原生菜单行。不碰 ctx，不可能被 park。
        installDomFallback()

        const slots = ctx.slots
        if (slots !== undefined && typeof slots.inject === 'function' && typeof slots.register === 'function') {

          // ② 干净的 slot 注册（可用就用；DOM 兜底会先检查避免重复）。
          slots.inject('sidebar.workspaces.session.menu.item', () =>
            slots.register(
              {
                name: 'sidebar.workspaces.session.menu.item',
                id: NS,
                order: 500,
                inject: () => ({}),
              },
              (props) => h(ProjectToggleMenuItem, props),
            ),
          )

          // ② 左侧栏一级入口（图标）。点它 → 宿主用同一个 id 打开 main 面板。
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: NS, order: 40, label: '会话总线' }, (props) =>
              h(BusIcon, { size: props?.size ?? 18 }),
            ),
          )

          // ③ 点图标后的整页。key 与侧栏 id 相同，宿主据此把两者绑在一起。
          slots.inject('main', () =>
            slots.register({ name: 'main', key: NS }, () => h(BusPanel, { owner: readOwner(), pollMs: 4000 })),
          )

          // ④ 浮动未读提示（shell.overlay）。
          slots.inject('shell.overlay', () =>
            slots.register({ name: 'shell.overlay', id: `${NS}-unread`, order: 60 }, () =>
              h(UnreadFloater, { pollMs: 8000, onOpen: () => selectPanel(NS) }),
            ),
          )
        }

        // layout 同样直接读 ctx.layout
        const layout = ctx.layout
        if (layout !== undefined && typeof layout.selectPanel === 'function') {
          selectPanel = (id) => layout.selectPanel(id)
        }
      },
    }

    /** 当前会话 id：宿主把 session 放在 query 里，取不到就留空（面板仍可用）。 */
    function readOwner() {
      try {
        const params = new URLSearchParams(window.location.search)
        return params.get('session') ?? params.get('sessionId') ?? ''
      } catch {
        return ''
      }
    }
  },
})
