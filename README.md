# dsh-model-gateway

把 DeepSeek Harness **已经接入的模型**（WorkBuddy / Qoder）开放成本地一个 **OpenAI 兼容 HTTP 接口**。

打开 DSH，接口就在；Postman、Cherry Studio、LobeChat、LangChain、`openai` SDK 只改 `base_url` 就能直接用，不用适配任何私有协议。

```
Postman ──OpenAI 格式──▶ DSH 进程内插件 ──ctx.llm──▶ workbuddy / qoder adapter ──▶ 上游
                        （复用 DSH 自己的端口）      （DSH 已有，这里零重复实现）
```

## 为什么是插件而不是独立服务

独立服务要自己实现 WorkBuddy 的 8 个鉴权头、会话三连 ID、强制流式、token 刷新，以及 Qoder 的 jobToken 交换和自定义编码——那是两份会持续腐坏的协议副本。做成插件后，协议细节由已有的 adapter 负责，本插件只做「OpenAI 格式 ↔ DSH 流」的翻译。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST | `/v1/chat/completions` | 聊天补全，流式与非流式 |
| GET | `/v1/gateway/providers` | 诊断：provider、模型数、统计、监听地址 |

**默认地址 `http://127.0.0.1:8787/v1`，端口可在设置页改。**

本插件启动**自己的** HTTP 监听器，与 DSH 的 Web GUI 端口互不影响——改端口不会断开你正在用的界面。

```bash
curl http://127.0.0.1:8787/v1/gateway/providers
```

## 模型命名

```
workbuddy/deepseek-v4.1-flash    ← 显式指定，永远不含糊
deepseek-v4.1-flash              ← 裸名，仅当跨 provider 唯一时接受
```

裸名重名时返回 **400** 并列出候选，绝不猜——猜错等于把请求发到你没选的那家：

```json
{
  "error": {
    "message": "model \"glm-5.3\" is advertised by more than one provider; qualify it as provider/model",
    "candidates": ["workbuddy/glm-5.3", "qoder/glm-5.3"]
  }
}
```

## Postman 调用

**非流式**

```
POST http://127.0.0.1:8787/v1/chat/completions
Content-Type: application/json

{
  "model": "workbuddy/deepseek-v4.1-flash",
  "messages": [{"role": "user", "content": "你好"}],
  "stream": false
}
```

**流式**（Postman：Body 同上去掉 `stream` 或写 `true`，响应面板会逐块显示；用 `curl -N` 更直观）

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"workbuddy/deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

**OpenAI SDK**

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")  # 未配置 apiKey 时占位即可
print(client.chat.completions.create(
    model="workbuddy/deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

## 字段映射

| 方向 | 处理 |
| --- | --- |
| `system` / `developer` 消息 | 收进 DSH 的 `GenerateOptions.system`，保持系统提示语义（留在 messages 里会被降级成普通 user 消息） |
| `text-delta` | → `delta.content` |
| `reasoning-delta` | → `delta.reasoning_content`，独立字段，**不混进 content** |
| `usage` | → `usage.prompt_tokens` / `completion_tokens` / `total_tokens` |
| `finish.kind` | `stop`→`stop`、`tool-calls`→`tool_calls`、`max-tokens`→`length` |
| 非流式 | 内部跑完整条流再聚合，保留 `reasoning_content` |
| 上游中途失败 | 已产出内容则补发一帧 `{error}` 再 `[DONE]`；未产出则改写成非 200 的 JSON 错误 |

`top_p` / `presence_penalty` / `frequency_penalty`：**DSH 的 `GenerateOptions` 没有对应字段**，收到后静默忽略，不假装支持。

## 设置页

**设置 → 插件 → 模型网关**，一页搞定：

| 区块 | 能力 |
| --- | --- |
| Base URL | 显示当前地址，**一键复制**（还有「复制 chat 端点」「复制请求示例」） |
| 试一下 | 用真实模型发一次最小请求，显示耗时与回复，验证链路通不通 |
| 监听配置 | 改 host / port / 本地令牌，保存后自动重绑监听器（不重启 DSH） |
| 厂商与模型 | **按厂商分组**列出全部模型，可折叠、可单独复制模型 ID，跨厂商重名会标「需写全厂商名」 |

## 配置项

也可直接编辑 profile 的 `cordis.patch.yml`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉即关闭监听器、卸载路由 |
| `host` | `127.0.0.1` | 监听地址。改 `0.0.0.0` 会暴露到局域网，自己承担风险 |
| `port` | `8787` | 监听端口。`0` = 由系统分配空闲端口 |
| `apiKey` | `''` | 留空 = 不校验；填写后需 `Authorization: Bearer <key>` 或 `x-api-key` |
| `providers` | `[]` | 暴露白名单，空 = 全部 |
| `allowBareModelId` | `true` | 是否允许裸模型名 |
| `requestTimeoutMs` | `300000` | 单次调用超时，0 = 不限 |

## 安全边界

- 监听地址沿用 DSH 自己的 `127.0.0.1`，**不暴露局域网/公网**。
- 凭据不经过本插件：它调用 `ctx.llm`，token 由 WorkBuddy/Qoder 插件各自保管。
- 客户端断开 → 立刻 abort 上游，不白烧 token。
- 本插件**绝不刷新** WorkBuddy 的 token（刷新会轮换 refreshToken，把你在用的 DSH 踢下线）。

## 当前不支持的

- **图片输入**：返回 `400 unsupported_content`。明确报错而不是静默丢内容。
- **工具调用的完整语义**：`tools` 定义会透传，`tool_calls` 会以标准格式回传，但完整的多轮工具编排未验证。

## 自测

```bash
node test/verify.mjs
```

58 项断言覆盖：自定义端口监听、`port:0` 系统分配、端口占用不崩溃、监听器 dispose 清理、模型列表、重名消歧、流式/非流式、usage、reasoning 隔离、鉴权（Bearer + x-api-key）、白名单、单 provider 失败降级、错误信封、上游失败、设置页 bridge（state / configure / probe）、apiKey 掩码、`enabled:false`。
