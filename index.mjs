// 把 MemoryConstellations 的召回结果，接进每一轮对话。
//
// 做法：听 aura 的 `prompt` 事件（交给她的内容），在用户这句话前面插一段
// 「记忆库里相关的事」，只作用于这一轮，不写进会话、不产生 system 消息
// （塞 role=system 会把 DSH 会话写坏：message must have role "user"）。
//
// 检索走 MC 自己的出站接口 POST /api/recall（只读），返回它格式化好的文本。

const MC_URL = 'http://127.0.0.1:3100/api/recall'

export default {
  id: 'mc-recall',
  name: '记忆库召回（MC）',
  version: '0.1.1',
  api: 1,
  description: '每轮从 MemoryConstellations 里捞相关记忆，塞进这一轮的上下文（只进对话，不进会话历史）。',
  defaults: {
    enabled: true,
    limit: 6,
    minChars: 6,
    maxChars: 600,
    timeoutMs: 1500,
    cacheSeconds: 60,
    tool: true,
  },
  settings: [
    { key: 'enabled', label: '启用召回', type: 'boolean', hint: '关掉后每轮不再查记忆库，行为回到普通对话' },
    { key: 'limit', label: '最多几条', type: 'number', hint: 'MC 单次召回上限 20' },
    { key: 'minChars', label: '太短的话不查', type: 'number', hint: '「在吗」「哈哈」这类不触发，省一次请求' },
    { key: 'maxChars', label: '塞进上下文最多多少字', type: 'number', hint: '超出截断，防止一段记忆把上下文撑满' },
    { key: 'timeoutMs', label: '超时（毫秒）', type: 'number', hint: '查不到就当没有，不耽误回复' },
    { key: 'cacheSeconds', label: '同一句话缓存秒数', type: 'number', hint: '防止同一句被追问时重复请求' },
    { key: 'tool', label: '注册 recall_memory 工具', type: 'boolean', hint: '关掉后只做每轮注入；合并召回（MC+本地）由 memory 模块提供，两个模块同名工具会被宿主判重名而丢弃后者' },
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
        const res = await fetch(MC_URL, {
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
    // 想回到「只查 MC」的老行为：把 ext['mc-recall'].tool 设回 true，并关掉 memory 的合并工具。
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
            const res = await fetch(MC_URL, {
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
  },
}
