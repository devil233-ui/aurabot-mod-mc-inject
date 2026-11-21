// 把 MemoryConstellations 接进每一轮对话，并把 aura 的聊天记录回填给它。
//
// 两件事放在同一个模块里，因为它们是同一条链的两头：
//   收：api.every 定时把 chatlog 增量写进 MC 的 POST /api/messages
//   发：听 aura 的 `prompt` 事件，在用户这句话前面插一段「记忆库里相关的事」
//
// 注入只作用于这一轮，不写进会话、不产生 system 消息（塞 role=system 会把 DSH
// 会话写坏：message must have role "user"）。检索走 MC 自己的出站接口
// POST /api/recall（只读），返回它格式化好的文本。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MC_BASE = 'http://127.0.0.1:3100'
const MC_RECALL = MC_BASE + '/api/recall'
const MC_MESSAGES = MC_BASE + '/api/messages'

// aura 插件的聊天记录目录；面板可覆盖
const CHATLOG_DIR = '/root/.dsh/plugins-data/aurabot/chatlog'
// MC 的库文件：读它的 chats 表，把「QQ 群 123」自动认成 group:123
const MC_DB = '/opt/memory-constellations/sanctuary.db'

const pad = (x) => String(x).padStart(2, '0')

// 毫秒 → 'YYYY-MM-DD HH:MM:SS'（本地时区；toISOString 是 UTC，凌晨会差出一天）
function fmtTime(ms) {
  const d = new Date(Number(ms))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function readJsonl(file) {
  const out = []
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) } catch { /* 跳过坏行 */ }
  }
  return out
}

// 一条 chatlog 记录 → MC 的 /api/messages 报文
function toPayload(rec, chatId, isGroup) {
  const who = String(rec.who || '')
  const isBot = who === 'bot'
  let content = String(rec.text ?? '').trim()
  if (!content) return null
  // 群聊里把昵称拼进正文，MC 抽取时才分得清谁说的（与旧的独立桥同一约定）
  if (isGroup && who && !isBot) content = `${who}：${content}`
  return {
    chat_id: chatId,
    sender: isBot ? 'ai' : 'user',
    content,
    timestamp: fmtTime(rec.t),
  }
}

export default {
  id: 'mc-inject',
  name: '每轮记忆注入（MC）',
  version: '0.3.0',
  api: 1,
  description: '每轮自动从 MemoryConstellations 召回相关记忆塞进这一轮；同时把 aura 的聊天记录增量回填进记忆库。',
  defaults: {
    enabled: true,
    limit: 6,
    minChars: 6,
    maxChars: 600,
    timeoutMs: 1500,
    cacheSeconds: 60,
    tool: false,
    ingest: false,
    ingestMinutes: 5,
    ingestBatch: 500,
    chatlogDir: '',
    ingestDb: '',
    ingestMap: '',
  },
  settings: [
    { key: 'enabled', label: '启用召回', type: 'boolean', hint: '关掉后每轮不再查记忆库，行为回到普通对话' },
    { key: 'limit', label: '最多几条', type: 'number', hint: 'MC 单次召回上限 20' },
    { key: 'minChars', label: '太短的话不查', type: 'number', hint: '短于这个字数的句子不查，省一次请求' },
    { key: 'maxChars', label: '塞进上下文最多多少字', type: 'number', hint: '超出截断，防止一段记忆把上下文撑满' },
    { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', hint: '查不到就当没有，不耽误回复' },
    { key: 'cacheSeconds', label: '同一句话缓存秒数', type: 'number', hint: '防止同一句被追问时重复请求' },
    { key: 'tool', label: '注册 recall_memory 工具', type: 'boolean', hint: '关掉后只做每轮注入；合并召回（MC+本地）由 memory 模块提供，两个模块同名工具会被宿主判重名而丢弃后者' },
    { key: 'ingest', label: '回填聊天记录到记忆库', type: 'boolean', hint: '接管原来独立脚本 aura-to-mc 的活。开了它就该停掉那个脚本的定时器，否则两边各写各的进度会重复入库' },
    { key: 'ingestMinutes', label: '回填间隔（分钟）', type: 'number', hint: '默认 5 分钟一次；改了要重载模块才生效' },
    { key: 'ingestBatch', label: '每轮最多回填条数', type: 'number', hint: '首次开启要补历史时靠它分批，免得一次卡太久；默认 500' },
    { key: 'chatlogDir', label: 'chatlog 目录', type: 'string', hint: '留空用 aurabot 默认目录' },
    { key: 'ingestDb', label: 'MC 数据库路径', type: 'string', hint: '用来读会话表自动认群；留空用默认路径，填 - 表示关闭自动枚举' },
    { key: 'ingestMap', label: '会话映射（JSON）', type: 'string', hint: '形如 {"group:123":103}，补自动枚举认不出的会话；显式映射优先' },
  ],
  setup(api) {
    const cache = new Map() // query → { at, text }

    const recall = async (query) => {
      const cfg = { ...api.defaults, ...(api.settings() || {}) }
      if (!cfg.enabled) return ''
      const q = String(query || '').trim()
      if (q.length < Number(cfg.minChars || 6)) return ''
      const hit = cache.get(q)
      const ttl = Number(cfg.cacheSeconds || 60) * 1000
      if (hit && Date.now() - hit.at < ttl) return hit.text
      let text = ''
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), Number(cfg.timeoutMs || 1500))
        const res = await fetch(MC_RECALL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: q, limit: Math.min(Number(cfg.limit || 6), 20) }),
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer))
        const data = await res.json().catch(() => null)
        if (data && data.success && Number(data.count) > 0) {
          const body = String(data.formatted || '').trim()
          if (body) {
            text = '【你自己记着的事（记忆库检索，可能过时或记错，只当参考；和眼前聊天冲突时以聊天为准，别照抄原话）】\n'
              + body.slice(0, Number(cfg.maxChars || 600))
          }
        }
      } catch (error) {
        api.log.debug('召回失败：' + (error?.message ?? String(error)))
      }
      cache.set(q, { at: Date.now(), text })
      if (cache.size > 200) cache.delete(cache.keys().next().value)
      return text
    }

    api.on('prompt', async (content, info) => {
      try {
        const chat = info?.chat
        if (!chat || chat.kind === 'system') return content
        if (!Array.isArray(content)) return content
        const block = await recall(info.queryText)
        if (!block) {
          api.log.debug(`召回：没有相关记忆（${String(info.queryText || '').slice(0, 20)}）`)
          return content
        }
        api.log.debug(`召回：注入 ${block.length} 字（${String(info.queryText || '').slice(0, 20)}）`)
        return [{ type: 'text', text: block }, ...content]
      } catch {
        return content
      }
    })

    api.rule(() => '你的上下文里有时会出现一段「你自己记着的事」——那是记忆库按当前话题捞出来的旧记忆，可能过时、可能记错。用它帮你想起来，但别把它当圣旨：和眼前聊天对不上就信聊天，也别把它原样念出来。')

    // 合并召回（MC + 本地库）由 memory 模块提供；这里默认不再注册同名工具，
    // 否则同名工具会被宿主判为重名而丢弃（日志：工具 recall_memory 重名）。
    // 想回到「只查 MC」的老行为：把 ext['mc-inject'].tool 设回 true，并关掉 memory 的合并工具。
    if (api.settings()?.tool !== false) api.tool(() => [
      api.defineTool({
        name: 'recall_memory',
        description: '想不起来某件事时，主动去记忆库里搜一下（比如「上次他说想要什么」「那部片子叫什么」）。返回的是旧记忆原文，可能不准。',
        properties: {
          query: { type: 'string', description: '要搜的关键词或一句话' },
          limit: { type: 'number', description: '最多几条，默认 6，上限 20' },
        },
        required: ['query'],
        execute: async ({ query, limit }) => {
          const q = String(query || '').trim()
          if (!q) return { ok: false, message: '要搜什么？' }
          try {
            const res = await fetch(MC_RECALL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ query: q, limit: Math.min(Number(limit || 6), 20) }),
            })
            const data = await res.json()
            if (!data?.success) return { ok: false, message: '记忆库没答上来：' + String(data?.error ?? res.status) }
            if (!Number(data.count)) return { ok: true, message: '记忆库里没有相关的' }
            return { ok: true, message: String(data.formatted || '').slice(0, 1200) }
          } catch (error) {
            return { ok: false, message: '查记忆库失败：' + (error?.message ?? String(error)) }
          }
        },
      }),
    ])

    // ── 回填：aura 的 chatlog → MC ────────────────────────────────────
    // 这条路以前是独立脚本 + systemd 定时器（/root/DSH/bin/aura-to-mc.js）。
    // 搬进来后跟模块同生共死：调试模式不跑、模块卸载自动停，也不用维护第二份代码。
    // 每次全扫 chatlog 目录（实测 23 个文件 1.2 万条 0.5 秒），靠进度文件跳过已同步。
    const stateFile = (() => {
      try { return typeof api.dataDir === 'function' ? api.dataDir('ingest-state.json') : null } catch { return null }
    })()

    const readState = () => {
      if (!stateFile) return { lastT: {} }
      try {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'))
        return { lastT: s?.lastT && typeof s.lastT === 'object' ? s.lastT : {} }
      } catch { return { lastT: {} } }
    }
    const saveState = (s) => {
      if (!stateFile) return
      try { writeFileSync(stateFile, JSON.stringify(s, null, 2)) } catch (error) { api.log.warn?.('回填进度保存失败：' + error.message) }
    }

    // aura 的会话键（private:<qq> / group:<群号>）→ MC 的 chats.id
    const loadChatMap = async (cfg) => {
      const map = {}
      if (cfg.ingestMap) {
        try {
          const extra = JSON.parse(String(cfg.ingestMap))
          if (extra && typeof extra === 'object') for (const k of Object.keys(extra)) map[k] = Number(extra[k])
        } catch { api.log.warn?.('会话映射不是合法 JSON，按没用处理') }
      }
      const dbPath = String(cfg.ingestDb ?? '').trim() || MC_DB
      if (dbPath === '-') return map
      let DatabaseSync = null
      try { ({ DatabaseSync } = await import('node:sqlite')) } catch { return map } // Node < 22 就只用手填映射
      let db = null
      try {
        db = new DatabaseSync(dbPath, { readOnly: true })
        for (const row of db.prepare('SELECT id, name FROM chats').all()) {
          const name = String(row.name || '').trim()
          const g = /^QQ\s*群\s*(\d+)$/.exec(name)
          const p = /^QQ\s*私聊\s*(\d+)$/.exec(name)
          const key = g ? `group:${g[1]}` : p ? `private:${p[1]}` : null
          if (key && map[key] === undefined) map[key] = row.id
        }
      } catch (error) {
        api.log.debug?.('读不到 MC 会话表（' + error.message + '），只用已有映射')
      } finally {
        try { db?.close?.() } catch { /* 忽略 */ }
      }
      return map
    }

    const syncOnce = async () => {
      const cfg = { ...api.defaults, ...(api.settings() || {}) }
      if (!cfg.ingest) return null
      if (!stateFile) { api.log.warn?.('拿不到模块数据目录，回填跳过'); return null }
      const dir = String(cfg.chatlogDir || '').trim() || CHATLOG_DIR
      let files = []
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(dir, f))
      } catch (error) {
        api.log.debug?.('读不到 chatlog 目录（' + error.message + '），回填跳过')
        return null
      }
      const map = await loadChatMap(cfg)
      const state = readState()
      const batch = Math.max(1, Number(cfg.ingestBatch || 500))
      let sent = 0, skipped = 0, unknown = 0
      for (const file of files) {
        const recs = readJsonl(file).sort((a, b) => Number(a.t) - Number(b.t))
        for (const rec of recs) {
          const key = String(rec.chatId || '')
          const chatId = map[key]
          if (!chatId) { unknown++; continue }
          const t = Number(rec.t)
          if (!Number.isFinite(t) || t <= Number(state.lastT[key] || 0)) { skipped++; continue }
          const payload = toPayload(rec, chatId, key.startsWith('group:'))
          if (!payload) { skipped++; continue }
          try {
            const res = await fetch(MC_MESSAGES, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            const body = await res.text()
            let json = null
            try { json = JSON.parse(body) } catch { /* 非 JSON */ }
            // 302→/login 时 fetch 会跟到登录页并返回 200 HTML，必须确认真是 JSON 成功
            if (!res.ok || !json || json.success !== true) throw new Error(`ingest ${res.status}: ${body.slice(0, 120)}`)
          } catch (error) {
            // 写不进去就把进度落盘再退出，别让一条坏消息把后面全堵死
            saveState(state)
            api.log.warn?.(`回填写入失败（${key}）：${error.message}`)
            return { sent, skipped, unknown, error: error.message }
          }
          state.lastT[key] = t
          sent++
          if (sent >= batch) {
            saveState(state)
            api.log.debug?.(`回填：本轮写满 ${sent} 条（还有待补，下一轮继续）`)
            return { sent, skipped, unknown, more: true }
          }
        }
      }
      saveState(state)
      if (sent || unknown) api.log.debug?.(`回填：写入 ${sent} 条，跳过 ${skipped} 条，未知会话 ${unknown} 条`)
      return { sent, skipped, unknown }
    }

    // 间隔在注册时定死：改了 ingestMinutes 要重载模块才生效（宿主会按配置重载）。
    const minutes = Math.max(1, Number(api.settings()?.ingestMinutes || 5))
    api.every(minutes * 60_000, syncOnce, '回填聊天记录到 MC')
  },
}
