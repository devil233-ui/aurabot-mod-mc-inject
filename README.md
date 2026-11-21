# aurabot-mod-mc-inject

Aurabot（DSH 的 QQ 插件 `dsh-aurabot-qq`）的「每轮记忆注入（MC）」模块：默认每一轮都自动向 [MemoryConstellations](https://github.com/devil233-ui/MemoryConstellations) 召回一次相关记忆并注入 `prompt`（只读）；另有一条可开关的回填通道，把 aura 的聊天记录增量写进 MC。这里的「召回」指检索那一步（`POST /api/recall`），「注入」指投递那一步；这两个动作都不需要模型主动调用。

## 它做什么

- 监听 `api.on('prompt')`：拿这一轮的用户原话去查 MC 的 `POST /api/recall`，命中就在本轮内容最前面插一段「你自己记着的事」。
- 只作用于这一轮：不写会话历史、不产生 system 消息（塞 `role=system` 会把 DSH 会话写坏）。
- 注入文本受 `maxChars` 限制（默认 600 字）；超时/查不到一律当「没有」，不阻塞回复。
- 另注册一条 `api.rule()`：提醒模型这段旧记忆可能过时，和眼前聊天冲突时以聊天为准，别照抄原话。
- 可选回填：定时把 aura 的 chatlog 增量写进 MC 的 `POST /api/messages`（见下文）。

## 配置（`config.json` 的 `ext['mc-inject']`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后每轮不再查记忆库 |
| `limit` | `6` | 单次召回条数，MC 上限 20 |
| `minChars` | `6` | 短于这个字数的句子不查，省一次请求 |
| `maxChars` | `600` | 塞进上下文的上限，超出截断 |
| `timeoutMs` | `1500` | 查不到就当没有 |
| `cacheSeconds` | `60` | 同一句话的缓存时间 |
| `tool` | `false` | 是否注册 `recall_memory` 工具；默认关，避免与 memory 模块的合并版重名 |
| `ingest` | `false` | 回填开关，默认关（开着它就该停掉独立脚本的定时器） |
| `ingestMinutes` | `5` | 回填间隔，改了要重载模块才生效 |
| `ingestBatch` | `500` | 每轮最多写多少条，首次补历史靠它分批 |
| `chatlogDir` | 空 | 留空用 aurabot 默认的 chatlog 目录 |
| `ingestDb` | 空 | MC 的库文件路径（用于自动认群）；留空用默认，填 `-` 关闭自动枚举 |
| `ingestMap` | 空 | 额外会话映射，JSON，形如 `{"group:123":103}`；显式映射优先 |

**默认就是 `tool: false`**：合并召回（MC + 本地库、去重、带来源标注）由 [`aurabot-mod-memory`](https://github.com/devil233-ui/aurabot-mod-memory) 提供，本模块只负责每轮注入。

## 接口契约

召回：

```
POST http://127.0.0.1:3100/api/recall
body: {"query": "...", "limit": 6}
resp: {"success": true, "count": 3, "formatted": "【记忆库检索结果】\n..."}
```

`success && count > 0` 才注入 `formatted`；其余情况（503、`success:false`、超时）都按「没有相关记忆」处理。

回填：

```
POST http://127.0.0.1:3100/api/messages
body: {"chat_id": 103, "sender": "user" | "ai", "content": "...", "timestamp": "YYYY-MM-DD HH:MM:SS"}
resp: {"success": true, ...}
```

三条约定，缺一条 MC 那边就分不清人：

- `sender` 只有两个值：`who === 'bot'` 记 `ai`，其余全记 `user`。
- **群聊把昵称拼进正文**（`甲：内容`），否则抽取时分不出说话人。
- 时间戳用本地时区格式化；`toISOString()` 是 UTC，东八区凌晨会算成前一天。

## 回填是怎么做的

这条路原来是独立脚本 `/root/DSH/bin/aura-to-mc.js` 加两个 systemd 定时器（5 分钟增量 + 每天全量）。收进模块是因为它跟注入是同一条链的两头：一个往库里写、一个从库里读，合起来才是一个完整通道；而且模块里的定时器跟模块同生共死——调试模式不跑、模块卸载自动停，不用再维护第二份代码和第二个状态文件。

- 每 `ingestMinutes` 分钟全扫一遍 chatlog 目录（实测 23 个文件 1.2 万条，0.46 秒），靠进度文件跳过已同步。**不区分增量和全量**：全扫本身就够快，两套逻辑反而容易漏。
- 进度存模块数据目录的 `ingest-state.json`，按会话键记最后一条已同步的时间戳。
- 会话映射两层：`ingestMap` 显式指定 → 读 MC 的 `chats` 表自动认（`QQ 群 123456789` → `group:123456789`、`QQ 私聊 987654321` → `private:987654321`）。以后 MC 里新建群，这里不用改。
- 每次最多写 `ingestBatch` 条就落盘退出，剩下的下一轮继续，避免首次补历史时长时间占住定时器。

两个坑：

- **MC 对未知 `chat_id` 会自动建会话**（名字 `Ingest <id>`），所以映射错了不会报错，只会安静地多出一个脏会话。
- **别和独立脚本同时开**：两边各存各的进度，会重复入库。切换步骤是停掉 `aura-to-mc.timer` 和 `aura-to-mc-full.timer`，再把 `ingest` 打开。

## 与 memory 模块的分工

| 通道 | 谁负责 | 进哪里 |
|---|---|---|
| MC 片段注入 | 本模块（`api.on('prompt')`） | 本轮对话内容 |
| 本地记忆注入（去重后） | `aurabot-mod-memory` | 本轮对话内容 |
| 常驻记忆块（面板 1200 字） | `aurabot-mod-memory` 的 `api.context` | 运行时上下文快照 |
| `recall_memory` 工具 | `aurabot-mod-memory`（合并 MC + 本地） | 模型主动调用 |
| 聊天记录回填 MC | 本模块（`api.every`，默认关） | 记忆库的 `messages` 表 |

**重名会静默失效**：两个模块都注册 `recall_memory` 时，宿主的日志是 `[debug] [modules] 工具 recall_memory 重名，模块「memory」的没挂` —— 谁先注册谁留下，后者直接不挂，且只有 debug 级日志。这就是本模块加 `tool` 开关的原因。

## 为什么事实与态度交给 MC

MC 的记忆是从**逐条消息**长出来的：Scribe 只提取「最小完整语义观察 + 主体 + 逐字引文 + 消息 ID/指纹」，`claim_review_a` 与 `claim_review_b` 两个独立审查在同一 revision 上一致才发布成 Claim，再按 duty 分类进 Profile（Facts/Status/Judgment 各自可回滚），任一校验不符就 fail-closed。本地库是对话级抽取、直接写入，没有引文与审核，擅长的是口吻、称呼、关系亲疏这类印象层。

所以：**事实与态度走 MC，本地补印象层**。不把 MC 的数据搬进本地——那会丢掉引文、主体和 revision，等于把可审计的记忆降级成不可追溯的文本。

## 安装

```
/root/.dsh/plugins-data/aurabot/modules/mc-inject/index.mjs
```

改文件后宿主会自己热重载（日志 `模块「mc-inject」文件改了，重新加载`），不需要重启宿主。

## 版本

- `v0.3.0`：**接管回填**——把独立脚本 `aura-to-mc.js` 的活收进模块（`api.every` + `ingest-state.json`），会话映射改成「手填 + 读 MC 会话表自动认」，新增 `ingest`/`ingestMinutes`/`ingestBatch`/`chatlogDir`/`ingestDb`/`ingestMap` 六个配置。默认仍是关，切换时先停旧定时器再打开，否则两边会重复入库。
- `v0.2.0`：**改名**——模块 id、目录、仓库统一从 `mc-recall` 换成 `mc-inject`。`recall` 是 MC 库那边的检索动词，这个模块做的是宿主每轮的投递，挂调用方的动词容易读错。配置键随之变成 `ext['mc-inject']`，旧键 `ext['mc-recall']` 不再被读取。顺带把 `minChars` 的说明改成中性表述——原来那句按默认 6 写死「在吗」这类不触发，值调小后就不成立了。
- `v0.1.2`：`tool` 默认改为 `false`——宿主重载会把模块默认值写回配置，默认 true 会让开关每次重载后被重置。
- `v0.1.1`：新增 `tool` 开关，用于把 `recall_memory` 让给 memory 模块的合并版。
- `v0.1.0`：初版（每轮注入 + `recall_memory` 直查 MC）。
