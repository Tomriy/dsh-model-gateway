/**
 * dsh-model-gateway — 把 DeepSeek Harness 已接入的模型开放成本地 OpenAI 兼容接口。
 *
 * 设计要点（都是先验证、后实现的事实）：
 *
 * 1. 不实现 WorkBuddy / Qoder 的协议。它们已经作为 adapter 注册进 `ctx.llm`，
 *    插件只调用 `ctx.llm.stream()`，协议细节由各自插件负责。
 * 2. 独立监听器。端口可自定义；**绝不修改 DSH 自己的 webserver 端口**——那会
 *    直接踢断正在用的 Web GUI。端口变更时只重启本插件的监听，不碰宿主。
 * 3. 零外部依赖、零裸模块导入：本包以符号链接方式装进 profile，realpath 在
 *    工作区之外，任何 `@deepseek-ai/*` 的裸导入都可能解析失败。只用 node 内置。
 *
 * @module dsh-model-gateway
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const PLUGIN = 'dsh-model-gateway'

/** 请求体上限，与 DSH 自身各处口径一致。 */
const MAX_BODY_BYTES = 20 * 1024 * 1024

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  port: 8787,
  apiKey: '',
  providers: [],
  allowBareModelId: true,
  requestTimeoutMs: 300000,
}

/** 把 row 配置归一化成完整形状，缺字段回落默认值而不是报错。 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const providers = Array.isArray(input.providers)
    ? input.providers.filter((p) => typeof p === 'string' && p.length > 0)
    : []
  const timeout = Number(input.requestTimeoutMs)
  const port = Number(input.port)
  const host = typeof input.host === 'string' && input.host.trim() !== '' ? input.host.trim() : DEFAULTS.host
  return {
    enabled: input.enabled !== false,
    host,
    // 0 = 让操作系统分配空闲端口（便于测试与端口冲突时兜底）。
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULTS.port,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : '',
    providers,
    allowBareModelId: input.allowBareModelId !== false,
    // 工具历史回放模式：
    //   'native' = 标准 OpenAI 形态透传（上游支持工具历史时最优）
    //   'text'   = 折叠成纯文本对话（对所有上游 100% 兼容）
    //   'auto'   = native 透传；失败的历史场景由客户端自行降级
    compatTools: input.compatTools === 'native' || input.compatTools === 'text' ? input.compatTools : 'native',
    requestTimeoutMs: Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULTS.requestTimeoutMs,
  }
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** OpenAI 风格的错误信封 —— 客户端 SDK 都按这个形状解析。 */
function sendError(res, status, message, type = 'invalid_request_error', code = undefined, extra = undefined) {
  sendJson(res, status, {
    error: { message, type, ...(code === undefined ? {} : { code }), ...(extra ?? {}) },
  })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        reject(Object.assign(new Error('request body exceeds the size limit'), { code: 'BodyTooLarge' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function isJsonContentType(req) {
  const raw = req.headers['content-type']
  if (typeof raw !== 'string') return false
  const media = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  return media === 'application/json' || media.endsWith('+json')
}

/** 常量时间比较，避免按前缀泄漏。 */
function secretMatches(presented, expected) {
  const a = Buffer.from(String(presented))
  const b = Buffer.from(String(expected))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 本地令牌校验：未配置 apiKey 时直接放行。 */
function authorized(req, config) {
  if (config.apiKey === '') return true
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match !== null && secretMatches(match[1], config.apiKey)) return true
  }
  const alt = req.headers['x-api-key']
  return typeof alt === 'string' && secretMatches(alt.trim(), config.apiKey)
}

// ---------------------------------------------------------------------------
// 消息转换：OpenAI wire 格式 → DSH Message
// ---------------------------------------------------------------------------

/** OpenAI 的 content 可能是字符串，也可能是 [{type:'text'|'image_url', ...}] 数组。 */
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('')
}

/** 收集图片输入，用于能力分流与计数。 */
function collectImages(messages) {
  let count = 0
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') count += 1
    }
  }
  return count
}

/**
 * 解析 OpenAI 的图片输入为二进制与媒体类型。
 *
 * 支持两种形态：
 *   - `data:` URL（Postman / SDK 最常用）
 *   - 纯 base64 字符串（部分客户端会把 data 前缀剥掉）
 *
 * HTTP(S) URL 不支持：拉取外部 URL 属于 SSRF 面，且 DSH 的附件管道要求
 * 调用方提供字节本身。明确报错，不静默降级。
 */
function parseImageInput(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { ok: false, message: 'image_url.url is empty' }
  }
  const value = rawUrl.trim()
  const dataMatch = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value)
  if (dataMatch !== null) {
    const mediaType = dataMatch[1].toLowerCase()
    const data = Buffer.from(dataMatch[2].replace(/\s/g, ''), 'base64')
    if (data.length === 0) return { ok: false, message: 'image_url.url decodes to zero bytes' }
    return { ok: true, mediaType, data }
  }
  if (/^https?:\/\//i.test(value)) {
    return { ok: false, message: 'http(s) image URLs are not supported; send the image as a base64 data URL instead' }
  }
  // 纯 base64 兜底：非 data: 非 http(s)，尝试按 base64 解。
  const data = Buffer.from(value.replace(/\s/g, ''), 'base64')
  if (data.length === 0) {
    return { ok: false, message: 'image_url.url is neither a data URL nor base64 image bytes' }
  }
  return { ok: true, mediaType: sniffImageMediaType(data), data }
}

/** 按魔数嗅探图片类型；DSH 的 saveImage 会再按解码字节复核一次。 */
function sniffImageMediaType(data) {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (data.length >= 6 && (data.toString('ascii', 0, 3) === 'GIF' + String.fromCharCode(0x38) || data.toString('ascii', 0, 3) === 'GIF' + String.fromCharCode(0x39))) return 'image/gif'
  return 'image/png'
}

/**
 * 构造一条 DSH 消息。
 *
 * DSH 的 Message 是不可变的 `{id, role, content:[block], source}`；模型适配器
 * 只读取这三个字段，所以这里直接构造并冻结，不需要引入 dsh-llm 的构造函数。
 */
function dshMessage(role, text) {
  return Object.freeze({
    id: randomUUID(),
    role,
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'user' }),
  })
}

/**
 * 把 OpenAI messages 拆成 DSH 的 `system` 字符串 + 消息数组。
 *
 * system / developer 统一收进 `GenerateOptions.system`：DSH 的 pi-ai 适配器
 * 会把它作为 systemPrompt 发送，而留在 messages 里会被降级成普通 user 消息，
 * 丢失系统提示的语义。
 *
 * `imageRefs` 是按请求顺序排列的已入库图片引用；遇到 user 消息里的图片部位
 * 时依序取出插入。文本与图片在 DSH 的 content 块中按原始顺序交织。
 *
 * 工具调用消息按 DSH 的线格式转换：
 *   - assistant 历史的 `tool_calls` → `{type:'tool-call', id, name, arguments}` 块
 *   - `role:'tool'` 的结果 → user 消息里的 `{type:'tool-result', toolCallId, content}` 块
 *     （DSH 约定 tool-result 块住在 user 角色消息里，由适配器翻译成上游的 toolResult）
 */
function normalizeToolCall(raw) {
  // OpenAI 形态：{id, type:'function', function:{name, arguments}}；兼容流式累积后的对象
  const fn = raw?.function ?? {}
  const id = typeof raw?.id === 'string' && raw.id !== '' ? raw.id : `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const name = typeof fn.name === 'string' ? fn.name : ''
  const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
  return { id, name, arguments: args }
}

export function buildDshRequest(messages, imageRefs, options = {}) {
  const systemParts = []
  const out = []
  let imageCursor = 0
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : ''
    if (role === 'system' || role === 'developer') {
      const text = flattenText(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(message.content)
      const blocks = []
      if (text.length > 0) blocks.push(Object.freeze({ type: 'text', text }))
      // 模型上一轮请求的工具调用要原样回放给上游，否则上游对不上号。
      // text 兼容模式下折叠成说明文本（部分上游网关不支持 OpenAI 工具历史回放）。
      let toolCallsText = ''
      if (Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map((raw) => normalizeToolCall(raw))
        if (options.compatTools === 'text') {
          for (const call of calls) {
            toolCallsText += `[调用工具 ${call.name}，参数 ${call.arguments}]`
          }
        } else {
          for (const call of calls) {
            blocks.push(Object.freeze({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }))
          }
        }
      }
      out.push(
        Object.freeze({
          id: randomUUID(),
          role: 'assistant',
          content: Object.freeze(blocks.length > 0 ? blocks : [{ type: 'text', text: toolCallsText }]),
          source: Object.freeze({ kind: 'model', provider: 'gateway-history', model: 'gateway-history' }),
        }),
      )
      continue
    }
    if (role === 'tool') {
      const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      const content = flattenText(message.content)
      if (options.compatTools === 'text') {
        // 折叠：工具结果并入 user 文本，所有上游都认识。
        out.push(dshMessage('user', `[工具 ${callId} 返回结果]: ${content}`))
        continue
      }
      out.push(
        Object.freeze({
          id: randomUUID(),
          role: 'user',
          content: Object.freeze([
            Object.freeze({
              type: 'tool-result',
              toolCallId: callId,
              content: Object.freeze([{ type: 'text', text: content }]),
              isError: message.is_error === true,
            }),
          ]),
          source: Object.freeze({ kind: 'user' }),
        }),
      )
      continue
    }
    // user 角色的多模态 content 在这里展开。
    const blocks = []
    if (role === 'user' && Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          blocks.push(Object.freeze({ type: 'text', text: part.text }))
        } else if (part.type === 'image_url' || part.type === 'input_image') {
          const ref = imageRefs[imageCursor]
          imageCursor += 1
          if (ref !== undefined) blocks.push(Object.freeze({ type: 'image', attachment: ref }))
        }
      }
    }
    if (blocks.length === 0) {
      out.push(dshMessage('user', flattenText(message.content)))
    } else {
      out.push(
        Object.freeze({
          id: randomUUID(),
          role: 'user',
          content: Object.freeze(blocks),
          source: Object.freeze({ kind: 'user' }),
        }),
      )
    }
  }
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  }
}

/**
 * OpenAI `tools` 定义 → DSH ToolSchema。
 * OpenAI: {type:'function', function:{name, description, parameters}}
 * 兼容直接传 {name, description, parameters} 的简写。
 */
export function buildToolSchemas(rawTools) {
  if (!Array.isArray(rawTools)) return undefined
  const schemas = []
  for (const tool of rawTools) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = tool.type === 'function' && typeof tool.function === 'object' && tool.function !== null ? tool.function : tool
    if (typeof fn.name !== 'string' || fn.name === '') continue
    schemas.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters !== undefined && typeof fn.parameters === 'object' && fn.parameters !== null ? fn.parameters : { type: 'object', properties: {} },
    })
  }
  return schemas.length > 0 ? schemas : undefined
}

// ---------------------------------------------------------------------------
// 模型目录与路由解析
// ---------------------------------------------------------------------------

/**
 * 展开所有已注册 provider 的模型。
 *
 * `listModels` 的结果按 DSH 的契约是**建议性**的：适配器可以接受未列出的模型
 * id。所以目录用于「选择」和「消歧」，不用于否决请求。
 */
async function buildCatalog(llm, config) {
  const allowed = config.providers.length > 0 ? new Set(config.providers) : null
  const catalog = []
  const failures = []
  for (const provider of llm.listProviders()) {
    if (allowed !== null && !allowed.has(provider.id)) continue
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        catalog.push({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          name: model.name,
          description: model.description,
          modalities: model.inputModalities,
          // 目录声明即权威：声明了 image 才放行图片输入。未声明 = 明确拒绝。
          supportsImage: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
        })
      }
    } catch (error) {
      // 一个 provider 拉不到模型不该让整个列表失败——记下来，其余照常返回。
      failures.push({ provider: provider.id, message: String(error?.message ?? error) })
    }
  }
  return { catalog, failures }
}

/**
 * 解析请求里的 `model`。
 *
 * 支持两种写法：
 *   `workbuddy/deepseek-v4.1-flash`  —— 显式，永远不含糊
 *   `deepseek-v4.1-flash`            —— 裸名，仅当跨 provider 唯一时接受
 *
 * 重名时返回 400 并列出候选，绝不猜——猜错等于把请求发到用户没选择的那家。
 */
function resolveRoute(catalog, requested, config) {
  const slash = requested.indexOf('/')
  if (slash > 0) {
    const provider = requested.slice(0, slash)
    const model = requested.slice(slash + 1)
    if (model.length === 0) {
      return { ok: false, status: 400, message: `model "${requested}" has an empty model id after the provider prefix` }
    }
    const known = catalog.some((entry) => entry.provider === provider)
    if (!known) {
      const providers = [...new Set(catalog.map((entry) => entry.provider))]
      return {
        ok: false,
        status: 400,
        message: `unknown provider "${provider}" in model "${requested}"; available providers: ${providers.join(', ') || '(none)'}`,
      }
    }
    const hit = catalog.find((entry) => entry.provider === provider && entry.model === model)
    return { ok: true, provider, model, advertised: hit !== undefined }
  }

  const hits = catalog.filter((entry) => entry.model === requested)
  if (hits.length === 1) return { ok: true, provider: hits[0].provider, model: requested, advertised: true }
  if (hits.length > 1) {
    return {
      ok: false,
      status: 400,
      message: `model "${requested}" is advertised by more than one provider; qualify it as provider/model`,
      candidates: hits.map((entry) => `${entry.provider}/${entry.model}`),
    }
  }
  const providers = [...new Set(catalog.map((entry) => entry.provider))]
  if (config.allowBareModelId && providers.length === 1) {
    return { ok: true, provider: providers[0], model: requested, advertised: false }
  }
  return {
    ok: false,
    status: 404,
    message: `unknown model "${requested}"; call GET /v1/models for the available list`,
    candidates: providers.length > 0 ? providers : undefined,
  }
}

// ---------------------------------------------------------------------------
// 流式转换：DSH StreamChunk → OpenAI chunk
// ---------------------------------------------------------------------------

/** DSH 的 finish reason → OpenAI 的 finish_reason 字符串。 */
function mapFinishReason(reason) {
  switch (reason?.kind) {
    case 'stop':
      return 'stop'
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    case 'aborted':
      return 'stop'
    case 'error':
      return 'stop'
    default:
      return 'stop'
  }
}

/** DSH TokenUsage → OpenAI usage。 */
function mapUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const inputTokens = Number(usage.inputTokens ?? 0)
  const outputTokens = Number(usage.outputTokens ?? 0)
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: Number(usage.totalTokens ?? inputTokens + outputTokens),
    ...(usage.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: Number(usage.cacheReadTokens) } }),
    ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: Number(usage.reasoningTokens) } }),
  }
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunkEnvelope(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/**
 * 把一条 DSH 流翻译成 OpenAI 输出。
 *
 * 三种终态：
 *   - 正常结束 → finish_reason + 可选 usage，然后 [DONE]
 *   - 流中途失败 → 发一条 `{error}` 数据帧再 [DONE]，已产出的内容不撤回
 *   - 尚未产出就失败 → 由调用方改写成非 200 的 JSON 错误
 */
async function pipeStream({ res, id, modelName, stream, includeUsage }) {
  let emitted = false
  let usage
  let finishReason = 'stop'
  let failure
  const toolIndexById = new Map()
  let nextToolIndex = 0

  try {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta': {
          if (typeof chunk.text !== 'string' || chunk.text.length === 0) break
          emitted = true
          sseChunk(res, chunkEnvelope(id, modelName, { content: chunk.text }))
          break
        }
        case 'reasoning-delta': {
          if (typeof chunk.text !== 'string' || chunk.text.length === 0) break
          emitted = true
          // 推理过程单独一个字段，绝不混进 content 污染业务文本。
          sseChunk(res, chunkEnvelope(id, modelName, { reasoning_content: chunk.text }))
          break
        }
        case 'tool-call-delta': {
          const key = String(chunk.id ?? '')
          let index = toolIndexById.get(key)
          if (index === undefined) {
            index = nextToolIndex
            nextToolIndex += 1
            toolIndexById.set(key, index)
          }
          emitted = true
          sseChunk(
            res,
            chunkEnvelope(id, modelName, {
              tool_calls: [
                {
                  index,
                  ...(chunk.name === undefined ? {} : { id: key, type: 'function' }),
                  function: {
                    ...(chunk.name === undefined ? {} : { name: chunk.name }),
                    arguments: String(chunk.argumentsDelta ?? ''),
                  },
                },
              ],
            }),
          )
          break
        }
        case 'usage': {
          usage = mapUsage(chunk.usage)
          break
        }
        case 'finish': {
          finishReason = mapFinishReason(chunk.reason)
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            failure = chunk.reason.failure
          }
          break
        }
        default:
          break
      }
    }
  } catch (error) {
    failure = { message: String(error?.message ?? error), code: 'GATEWAY_STREAM_ERROR' }
  }

  if (failure !== undefined && !emitted) {
    const status = typeof failure.status === 'number' && failure.status >= 400 ? failure.status : 502
    sendError(res, status, failure.message ?? 'the model provider failed', 'upstream_error', failure.code)
    return
  }

  if (failure !== undefined) {
    // 已经吐出内容：补一条错误帧，客户端至少能知道这次回答是残缺的。
    sseChunk(res, { error: { message: failure.message ?? 'the model provider failed', type: 'upstream_error', code: failure.code ?? 'UPSTREAM_ERROR' } })
  }

  if (includeUsage && usage !== undefined) {
    sseChunk(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName, choices: [], usage })
  }

  sseChunk(res, chunkEnvelope(id, modelName, {}, finishReason))
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 非流式：把整条流吸完，拼成一条 `chat.completion`。 */
async function collectCompletion({ id, modelName, stream }) {
  let content = ''
  let reasoning = ''
  let usage
  let finishReason = 'stop'
  let failure
  const tools = new Map()

  try {
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'text-delta':
          content += chunk.text
          break
        case 'reasoning-delta':
          reasoning += chunk.text
          break
        case 'tool-call-delta': {
          const key = String(chunk.id ?? '')
          let entry = tools.get(key)
          if (entry === undefined) {
            entry = { id: key, name: chunk.name ?? '', arguments: '' }
            tools.set(key, entry)
          }
          if (chunk.name !== undefined && entry.name === '') entry.name = chunk.name
          entry.arguments += String(chunk.argumentsDelta ?? '')
          break
        }
        case 'usage':
          usage = mapUsage(chunk.usage)
          break
        case 'finish':
          finishReason = mapFinishReason(chunk.reason)
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
          break
        default:
          break
      }
    }
  } catch (error) {
    failure = { message: String(error?.message ?? error), code: 'GATEWAY_STREAM_ERROR' }
  }

  if (failure !== undefined) return { ok: false, failure }

  const message = { role: 'assistant', content }
  // DeepSeek 系的约定：推理内容放在同级的 reasoning_content，不混进 content。
  if (reasoning.length > 0) message.reasoning_content = reasoning
  if (tools.size > 0) {
    message.tool_calls = [...tools.values()].map((entry) => ({
      id: entry.id,
      type: 'function',
      function: { name: entry.name, arguments: entry.arguments },
    }))
  }

  return {
    ok: true,
    completion: {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info(`${PLUGIN}: disabled by configuration; no listener started`)
    return
  }

  ctx.inject(['llm'], (sctx) => {
    const llm = sctx.llm
    // attachments 服务由 dsh-base 的 attachment-local 提供，软获取：缺失时
    // 图片请求返回 503 而不是拖垮整个网关（纯文本链路不应依赖它）。
    let attachments
    try {
      attachments = sctx.get?.('attachments')
    } catch {
      attachments = undefined
    }
    // 本插件可能先于 attachments 激活，那时 get 返回 undefined；用软 inject
    // 等它就绪后补上闭包引用。inject 对缺失服务不回调，网关照常服务纯文本。
    sctx.inject(['attachments'], (actx) => {
      attachments = actx.attachments
    })

    /** 最近一次统计，供 UI 展示；只有本插件内部计数，不含敏感内容。 */
    const stats = { requests: 0, errors: 0, lastErrorAt: null, lastError: null, startedAt: Date.now(), lastDispatch: null }
    const recordError = (error) => {
      stats.errors += 1
      stats.lastErrorAt = Date.now()
      stats.lastError = String(error?.message ?? error).slice(0, 300)
    }

    // ---- 复用同一套路由处理器：既能挂在独立监听器上，也能挂到 DSH webServer ----

    const requireAuth = (req, res) => {
      if (authorized(req, config)) return true
      sendError(res, 401, 'missing or invalid API key; send Authorization: Bearer <apiKey>', 'authentication_error', 'invalid_api_key')
      return false
    }

    /** GET /v1/models */
    const handleModels = async (req, res) => {
      if (!requireAuth(req, res)) return
      const { catalog, failures } = await buildCatalog(llm, config)
      const counts = new Map()
      for (const entry of catalog) counts.set(entry.model, (counts.get(entry.model) ?? 0) + 1)
      sendJson(res, 200, {
        object: 'list',
        data: catalog.map((entry) => ({
          id: `${entry.provider}/${entry.model}`,
          object: 'model',
          created: 0,
          owned_by: entry.provider,
          ...(counts.get(entry.model) === 1 ? { alias: entry.model } : {}),
          ...(entry.supportsImage ? { image_input: true } : {}),
        })),
        ...(failures.length === 0 ? {} : { gateway_warnings: failures }),
      })
    }

    /** GET /v1/gateway/providers —— 排障用，比 /v1/models 多给适配器状态。 */
    const handleProviders = async (req, res) => {
      if (!requireAuth(req, res)) return
      sendJson(res, 200, {
        plugin: PLUGIN,
        listeningOn: baseUrl(),
        authentication: config.apiKey === '' ? 'disabled' : 'bearer',
        stats,
        providers: await describeProviders(),
      })
    }

    /** POST /v1/chat/completions */
    const handleChat = async (req, res) => {
      if (!requireAuth(req, res)) return
      if (!isJsonContentType(req)) {
        sendError(res, 415, 'Content-Type must be application/json', 'invalid_request_error', 'unsupported_media_type')
        return
      }

      let body
      try {
        body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
      } catch (error) {
        if (error?.code === 'BodyTooLarge') {
          sendError(res, 413, `request body exceeds ${MAX_BODY_BYTES} bytes`, 'invalid_request_error', 'payload_too_large')
          return
        }
        sendError(res, 400, `body is not valid JSON: ${String(error?.message ?? error)}`, 'invalid_request_error', 'invalid_json')
        return
      }

      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendError(res, 400, 'body must be a JSON object', 'invalid_request_error', 'invalid_body')
        return
      }
      if (typeof body.model !== 'string' || body.model.trim() === '') {
        sendError(res, 400, 'missing required field "model"', 'invalid_request_error', 'missing_model')
        return
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        sendError(res, 400, 'missing required field "messages"', 'invalid_request_error', 'missing_messages')
        return
      }

      stats.requests += 1
      const { catalog } = await buildCatalog(llm, config)
      const requested = body.model.trim()
      const route = resolveRoute(catalog, requested, config)
      if (!route.ok) {
        recordError(new Error(route.message))
        sendError(res, route.status ?? 400, route.message, 'invalid_request_error', 'model_not_found', route.candidates ? { candidates: route.candidates } : undefined)
        return
      }

      // ---- 图片输入：按目标模型的能力分流 ----
      const imageCount = collectImages(body.messages)
      let imageRefs = []
      if (imageCount > 0) {
        const routeEntry = catalog.find((entry) => entry.provider === route.provider && entry.model === route.model)
        const supportsImage = routeEntry !== undefined ? routeEntry.supportsImage === true : false
        if (!supportsImage) {
          // 目录是权威声明：没声明 image 就明确拒绝，而不是静默丢图让模型"看不懂"。
          recordError(new Error(`model ${route.provider}/${route.model} does not support image input`))
          sendError(
            res,
            400,
            `model "${route.provider}/${route.model}" does not support image input. ` +
              `Pick an image-capable model (see GET /v1/models), or send text only.`,
            'invalid_request_error',
            'model_does_not_support_image',
            { model: `${route.provider}/${route.model}` },
          )
          return
        }
        if (attachments === undefined) {
          recordError(new Error('attachment service unavailable'))
          sendError(res, 503, 'the attachment service is not available in this Harness profile; image input cannot be stored', 'gateway_error', 'attachments_unavailable')
          return
        }
        // 先全部入库再组消息：入库失败时一个字节都没发给上游。
        for (const message of body.messages) {
          if (!Array.isArray(message?.content)) continue
          for (const part of message.content) {
            if (part === null || typeof part !== 'object') continue
            if (part.type !== 'image_url' && part.type !== 'input_image') continue
            const rawUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
            const parsed = parseImageInput(rawUrl)
            if (!parsed.ok) {
              recordError(new Error(parsed.message))
              sendError(res, 400, parsed.message, 'invalid_request_error', 'invalid_image')
              return
            }
            try {
              const ref = await attachments.saveImage({ data: new Uint8Array(parsed.data), mediaType: parsed.mediaType })
              imageRefs.push(ref)
            } catch (error) {
              recordError(error)
              sendError(res, 400, `image was rejected: ${String(error?.message ?? error)}`, 'invalid_request_error', 'invalid_image')
              return
            }
          }
        }
        if (imageRefs.length !== imageCount) {
          sendError(res, 400, 'internal image accounting mismatch', 'gateway_error', 'internal')
          return
        }
      }

      const { system, messages } = buildDshRequest(body.messages, imageRefs, { compatTools: config.compatTools })
      if (messages.length === 0) {
        sendError(res, 400, 'messages contained no user or assistant content', 'invalid_request_error', 'empty_messages')
        return
      }
      const toolSchemas = buildToolSchemas(body.tools)

      const wantStream = body.stream === true
      const includeUsage = body.stream_options?.include_usage === true
      const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`
      const modelName = requested

      // 客户端断开时立刻取消上游，避免白烧 token。
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      req.on('close', onClose)
      const timers = []
      if (config.requestTimeoutMs > 0) {
        const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        timers.push(timer)
      }
      const cleanup = () => {
        req.off('close', onClose)
        for (const timer of timers) clearTimeout(timer)
      }

      let stream
      try {
        if (config.debug === true) {
          const snapshotJson = JSON.stringify(messages)
          sctx.logger.info(`${PLUGIN}: dispatch messages=${snapshotJson}`)
          stats.lastDispatch = snapshotJson.slice(0, 4000)
        }
        stream = llm.stream({
          provider: route.provider,
          model: route.model,
          messages,
          ...(system === undefined ? {} : { system }),
          ...(toolSchemas === undefined ? {} : { tools: toolSchemas }),
          ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
          ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
          ...(Array.isArray(body.stop) && body.stop.length > 0 ? { stop: body.stop } : {}),
          // DSH 的 GenerateOptions 没有 top_p / presence_penalty / frequency_penalty，
          // 这几个字段被静默忽略（与多数网关一致），只在 README 里写明。
          signal: controller.signal,
        })
      } catch (error) {
        cleanup()
        recordError(error)
        sendError(res, 500, `cannot start the model stream: ${String(error?.message ?? error)}`, 'gateway_error', 'stream_start_failed')
        return
      }

      if (wantStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          // 独立监听器上允许浏览器页面直接调用（设置页的"试一下"按钮就是同源请求）。
          'access-control-allow-origin': '*',
        })
        try {
          await pipeStream({ res, id, modelName, stream, includeUsage })
        } finally {
          cleanup()
        }
        return
      }

      try {
        const result = await collectCompletion({ id, modelName, stream })
        cleanup()
        if (!result.ok) {
          recordError(result.failure)
          const status = typeof result.failure.status === 'number' && result.failure.status >= 400 ? result.failure.status : 502
          sendError(res, status, result.failure.message ?? 'the model provider failed', 'upstream_error', result.failure.code)
          return
        }
        sendJson(res, 200, result.completion)
      } catch (error) {
        cleanup()
        recordError(error)
        if (!res.headersSent) {
          sendError(res, 500, `gateway failure: ${String(error?.message ?? error)}`, 'gateway_error', 'internal')
        } else {
          res.end()
        }
      }
    }

    // ---- provider 描述：/v1/gateway/providers 与 UI 面板共用 ----

    async function describeProviders() {
      const allowed = config.providers.length > 0 ? new Set(config.providers) : null
      const providers = []
      for (const provider of llm.listProviders()) {
        const entry = {
          id: provider.id,
          name: provider.name,
          exposed: allowed === null || allowed.has(provider.id),
          models: [],
        }
        try {
          const models = await llm.listModels(provider.id)
          entry.models = models.map((model) => ({
            id: model.id,
            name: model.name,
            description: model.description,
            modalities: model.inputModalities,
            // 用于 UI 判断是否需要限定写法
            ambiguous: false,
          }))
        } catch (error) {
          entry.error = String(error?.message ?? error)
        }
        providers.push(entry)
      }
      // 标记跨 provider 重名的模型：裸名调用会 400，UI 需要提示。
      const counts = new Map()
      for (const provider of providers) for (const model of provider.models) counts.set(model.id, (counts.get(model.id) ?? 0) + 1)
      for (const provider of providers) for (const model of provider.models) model.ambiguous = (counts.get(model.id) ?? 0) > 1
      return providers
    }

    // ---- 独立监听器：端口可自定义，绝不碰 DSH 自己的端口 ----

    /** 当前监听地址；未启动时返回配置里的期望值。 */
    let listeningOn = null
    const baseUrl = () => listeningOn ?? `http://${config.host}:${config.port}/v1`

    let server = null
    let boundPort = null
    let portFellBack = false

    const dispatch = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://gateway.invalid')
      const path = url.pathname.replace(/\/+$/, '') || '/'

      // 独立监听器的路由表：/v1/* 为主，另外给设置页留一个健康检查。
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        await handleModels(req, res)
        return
      }
      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        await handleChat(req, res)
        return
      }
      if (req.method === 'GET' && path === '/v1/gateway/providers') {
        await handleProviders(req, res)
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, x-api-key',
          'access-control-max-age': '86400',
        })
        res.end()
        return
      }
      sendError(res, 404, `no such route: ${req.method} ${path}`, 'invalid_request_error', 'not_found')
    }

    const startServer = (port) =>
      new Promise((resolve, reject) => {
        const instance = createServer((req, res) => {
          dispatch(req, res).catch((error) => {
            recordError(error)
            if (!res.headersSent) sendError(res, 500, String(error?.message ?? error), 'gateway_error', 'internal')
            else res.end()
          })
        })
        instance.on('error', (error) => {
          reject(error)
        })
        instance.listen(port, config.host, () => {
          server = instance
          boundPort = instance.address().port
          portFellBack = boundPort !== config.port
          listeningOn = `http://${config.host}:${boundPort}/v1`
          resolve(listeningOn)
        })
      })

    sctx.effect(
      () => {
        let disposed = false
        // 端口被外部进程占用时自动回退到系统分配端口，而不是只打日志等死：
        // 网关的可用性比"端口必须是 8787"更重要，实际地址可从设置页读取。
        startServer(config.port)
          .catch((error) => {
            sctx.logger.warn(`${PLUGIN}: port ${config.port} unavailable (${String(error?.message ?? error)}); falling back to a system-assigned port`)
            if (disposed || config.port === 0) throw error
            return startServer(0)
          })
          .then((url) => {
            if (disposed) {
              server?.close()
              return
            }
            sctx.logger.info(`${PLUGIN}: OpenAI-compatible gateway listening at ${url} (auth=${config.apiKey === '' ? 'disabled' : 'bearer'})`)
          })
          .catch((error) => {
            sctx.logger.error(`${PLUGIN}: cannot listen on ${config.host} — ${String(error?.message ?? error)}`)
          })
        return () => {
          disposed = true
          listeningOn = null
          const closing = server
          server = null
          boundPort = null
          portFellBack = false
          if (closing !== null) {
            closing.close()
            try {
              closing.closeAllConnections?.()
            } catch {}
          }
        }
      },
      `${PLUGIN}: listener`,
    )

    // ---- 同套路由也挂到 DSH 自己的 webServer：固定入口，与独立监听器并存 ----
    // 注意：不能用 ctx.get('webServer') 预判——本插件可能先于 webServer 激活，
    // 那时 get 返回 undefined 会误判「不存在」。inject 会等依赖就绪，才是正确姿势。
    sctx.inject(['webServer'], (wctx) => {
      wctx.effect(() => {
        const disposers = [
          // 命名路由命中在浏览器鉴权之前（已实测），Postman 因此可直连。
          wctx.webServer.register({ kind: 'exact', path: '/v1/models', handler: handleModels }),
          wctx.webServer.register({ kind: 'exact', path: '/v1/chat/completions', handler: handleChat }),
          wctx.webServer.register({ kind: 'exact', path: '/v1/gateway/providers', handler: handleProviders }),
        ]
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, `${PLUGIN}: routes on the DSH web server`)
    })

    // ---- 设置页 bridge：只被本机的 DSH 页面调用，不受 apiKey 约束 ----

    sctx.inject(['webServer', 'configEditor'], (bctx) => {
      const BRIDGE = '/api/dsh-model-gateway'

      /** 供设置页读取的完整状态。 */
      const state = async () => ({
        config: {
          enabled: config.enabled,
          host: config.host,
          port: config.port,
          apiKey: config.apiKey === '' ? '' : '***',
          hasApiKey: config.apiKey !== '',
          providers: config.providers,
          allowBareModelId: config.allowBareModelId,
          requestTimeoutMs: config.requestTimeoutMs,
          compatTools: config.compatTools,
        },
        listener: { running: server !== null, baseUrl: baseUrl(), boundPort, portFellBack },
        stats,
        attachmentsAvailable: attachments !== undefined,
        providers: await describeProviders(),
      })

      /** 找到本插件在 profile 里的那一行，用于写回配置。 */
      const findEntry = () => {
        for (const entry of bctx.configEditor.entries()) {
          if (entry.options?.name === PLUGIN || entry.options?.id === PLUGIN) return entry
        }
        return undefined
      }

      const readJson = async (req) => {
        const raw = await readBody(req, 64 * 1024)
        if (raw.length === 0) return {}
        return JSON.parse(raw.toString('utf8'))
      }

      const routes = [
        {
          kind: 'exact',
          path: `${BRIDGE}/state`,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed: GET' })
              return
            }
            try {
              sendJson(res, 200, { ok: true, value: await state() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        },
        {
          kind: 'exact',
          path: `${BRIDGE}/configure`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed: POST' })
              return
            }
            let patch
            try {
              patch = await readJson(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: `body is not JSON: ${String(error?.message ?? error)}` })
              return
            }
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              sendJson(res, 400, { ok: false, error: 'body must be a JSON object' })
              return
            }

            // 只接受白名单字段，不把 UI 传来的任意键写进 profile。
            const next = {}
            if (typeof patch.host === 'string' && patch.host.trim() !== '') next.host = patch.host.trim()
            if (patch.port !== undefined) {
              const port = Number(patch.port)
              if (!Number.isInteger(port) || port < 0 || port > 65535) {
                sendJson(res, 400, { ok: false, error: 'port must be an integer between 0 and 65535' })
                return
              }
              next.port = port
            }
            if (patch.apiKey !== undefined) {
              if (typeof patch.apiKey !== 'string') {
                sendJson(res, 400, { ok: false, error: 'apiKey must be a string' })
                return
              }
              next.apiKey = patch.apiKey.trim()
            }
            if (patch.providers !== undefined) {
              if (!Array.isArray(patch.providers) || patch.providers.some((p) => typeof p !== 'string')) {
                sendJson(res, 400, { ok: false, error: 'providers must be an array of provider ids' })
                return
              }
              next.providers = patch.providers
            }
            if (patch.allowBareModelId !== undefined) next.allowBareModelId = patch.allowBareModelId === true
            if (patch.requestTimeoutMs !== undefined) {
              const ms = Number(patch.requestTimeoutMs)
              if (!Number.isFinite(ms) || ms < 0) {
                sendJson(res, 400, { ok: false, error: 'requestTimeoutMs must be a non-negative number' })
                return
              }
              next.requestTimeoutMs = ms
            }
            if (patch.enabled !== undefined) next.enabled = patch.enabled === true

            if (Object.keys(next).length === 0) {
              sendJson(res, 400, { ok: false, error: 'no recognized field to update' })
              return
            }

            const entry = findEntry()
            if (entry === undefined) {
              sendJson(res, 409, {
                ok: false,
                error: 'this plugin row is not managed by the profile config editor; edit cordis.patch.yml directly',
              })
              return
            }

            try {
              await bctx.configEditor.edit(entry, (current) => ({ ...current, ...next }))
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              return
            }
            // 配置写回后 Loader 会重载本插件；状态由下一次 state 请求读回。
            sendJson(res, 200, { ok: true, value: { saved: next, note: 'saved; the plugin reloads and rebinds the listener' } })
          },
        },
        {
          kind: 'exact',
          path: `${BRIDGE}/probe`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'method not allowed: POST' })
              return
            }
            // 用最小请求验证一次真实链路，供设置页的"试一下"按钮使用。
            // withImage: true 时优先挑一个声明了图片能力的模型，验证图片链路。
            let payload = {}
            try {
              payload = await readJson(req)
            } catch {}
            const model = typeof payload.model === 'string' && payload.model !== '' ? payload.model : undefined
            const wantImage = payload.withImage === true
            const { catalog } = await buildCatalog(llm, config)
            let target = model
            if (target === undefined && wantImage) {
              const imageModel = catalog.find((entry) => entry.supportsImage)
              if (imageModel !== undefined) target = `${imageModel.provider}/${imageModel.model}`
            }
            if (target === undefined) {
              const first = catalog[0] === undefined ? undefined : `${catalog[0].provider}/${catalog[0].model}`
              target = first
            }
            if (target === undefined) {
              sendJson(res, 200, { ok: false, error: 'no model is available to probe' })
              return
            }
            const route = resolveRoute(catalog, target, config)
            if (!route.ok) {
              sendJson(res, 200, { ok: false, error: route.message })
              return
            }

            // 组请求：普通探测用文本；图片探测生成 1 张红蓝 2x1 测试图。
            let requestMessages
            let imageNote
            if (wantImage) {
              const routeEntry = catalog.find((entry) => entry.provider === route.provider && entry.model === route.model)
              if (routeEntry === undefined || routeEntry.supportsImage !== true) {
                sendJson(res, 200, { ok: false, error: `model ${target} does not declare image support; pick an image-capable model` })
                return
              }
              if (attachments === undefined) {
                sendJson(res, 200, { ok: false, error: 'attachment service is not available in this profile' })
                return
              }
              // 2x1 PNG：左红右蓝，肉眼可辨的回答是"红"或"蓝/两色"。
              const png = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAA//d1/AAAAFklEQVR4nGP8z8DAwMDAxIAEAAAAAP//AwB0EQMAAAAA//8D', 'base64',
              )
              try {
                const ref = await attachments.saveImage({ data: new Uint8Array(png), mediaType: 'image/png' })
                requestMessages = [
                  Object.freeze({
                    id: randomUUID(),
                    role: 'user',
                    content: Object.freeze([
                      Object.freeze({ type: 'text', text: 'What color is on the LEFT side of this image? Answer with one word.' }),
                      Object.freeze({ type: 'image', attachment: ref }),
                    ]),
                    source: Object.freeze({ kind: 'user' }),
                  }),
                ]
                imageNote = `image probe on ${target}`
              } catch (error) {
                sendJson(res, 200, { ok: false, error: `image storage failed: ${String(error?.message ?? error)}` })
                return
              }
            } else {
              requestMessages = [dshMessage('user', 'Reply with exactly: OK')]
            }

            const started = Date.now()
            try {
              const chunks = []
              for await (const chunk of llm.stream({
                provider: route.provider,
                model: route.model,
                messages: requestMessages,
                maxTokens: 32,
                signal: AbortSignal.timeout(30000),
              })) {
                if (chunk.type === 'text-delta') chunks.push(chunk.text)
                if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
                  throw new Error(chunk.reason.failure?.message ?? 'model error')
                }
              }
              sendJson(res, 200, {
                ok: true,
                value: { model: target, ms: Date.now() - started, preview: chunks.join('').slice(0, 120), ...(imageNote === undefined ? {} : { mode: 'image' }) },
              })
            } catch (error) {
              sendJson(res, 200, { ok: false, error: String(error?.message ?? error), ms: Date.now() - started })
            }
          },
        },
      ]

      bctx.effect(() => {
        const disposers = routes.map((route) => bctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      }, `${PLUGIN}: settings bridge`)
    })
  })
}
