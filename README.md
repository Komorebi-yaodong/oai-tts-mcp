# oai-tts-mcp

一个通过 **stdio** 运行的 OpenAI 兼容 TTS MCP 服务。AI 可调用它来：

1. 查询当前模型的可用音色；
2. 将文本按指定音色和语气转换为音频。

## 功能

- `list_voices`
  - 默认请求 `GET /v1/tts/voices?model={OAI_TTS_MODEL}`。
  - 对 Base URL 自动规整：`https://host` 与 `https://host/v1` 均可，绝不会产生 `/v1/v1`。
  - 上游请求失败、超时或响应不包含有效 `voices[]` 时，返回内置回退音色，并标记 `source: "fallback"` 和原因。
- `text_to_speech`
  - 请求 `POST /v1/audio/speech`。
  - 传入 `instructions` 即可要求语气/表达，例如“平静、温暖、适合睡前故事，语速自然，句末轻柔收束”。
  - 默认 `speed` 是 **1.25**；可选范围 `0.25` 到 `4`。
  - 将音频上传至 Urusai 文件托管并返回公开 HTTPS URL；不返回 Base64 音频，减少上下文和客户端兼容性问题。

## 要求

- Node.js `>= 20`
- pnpm
- 有效的 OpenAI 或 OpenAI 兼容 TTS 服务地址与 API Key

## 安装

```powershell
Set-Location "E:\Programming\oai-tts-mcp"
pnpm install
```

参照仓库内的 `env.example`，将以下变量填入 MCP 客户端的 `env` 配置或受保护的系统环境变量：

```dotenv
OAI_TTS_BASE_URL=https://api.openai.com/v1
OAI_TTS_API_KEY=your_api_key_here
OAI_TTS_MODEL=gpt-4o-mini-tts
OAI_TTS_VOICE=marin

# 可选：Urusai 图床访问令牌。音频将上传至第三方并返回公开 URL；请勿上传敏感内容。
URUSAI_API_TOKEN=your_optional_urusai_token

# 可选：默认 https://api.urusai.cc/v1/upload；仅用于自建兼容上传服务或本机测试。
URUSAI_UPLOAD_URL=https://api.urusai.cc/v1/upload

```

> 推荐模型为 `gpt-4o-mini-tts`，它支持使用 `instructions` 细调表达。兼容服务是否支持该字段及具体音色，以该服务的实现为准。

## 构建与启动

```powershell
pnpm build
pnpm start
```

开发时：

```powershell
pnpm dev
```

> MCP 使用 stdio 通信；不要把服务日志写入 stdout。运行日志仅输出至 stderr。

## MCP 客户端配置示例

以支持 stdio MCP 的客户端为例，配置命令为：

```json
{
  "mcpServers": {
    "oai-tts": {
      "command": "node",
      "args": ["E:\\Programming\\oai-tts-mcp\\dist\\index.js"],
      "env": {
        "OAI_TTS_BASE_URL": "https://api.openai.com/v1",
        "OAI_TTS_API_KEY": "your_api_key_here",
        "OAI_TTS_MODEL": "gpt-4o-mini-tts",
        "OAI_TTS_VOICE": "marin",
        "URUSAI_API_TOKEN": "your_optional_urusai_token",
        "URUSAI_UPLOAD_URL": "https://api.urusai.cc/v1/upload"
      }
    }
  }
}
```

服务仅从进程环境变量读取配置；由 MCP 客户端 `env` 注入是推荐且安全的方式。

## 工具说明

### `list_voices`

无参数。返回文本摘要和结构化结果：

```json
{
  "voices": [
    { "voice_id": "eve", "name": "Eve", "language": "en" }
  ],
  "source": "remote"
}
```

若远程音色接口不可用，则返回 `source: "fallback"`。内置回退集为：

`alloy`、`ash`、`ballad`、`coral`、`echo`、`fable`、`nova`、`onyx`、`sage`、`shimmer`、`verse`、`marin`、`cedar`。

> `tts-1` 与 `tts-1-hd` 的可用音色较少；请优先调用 `list_voices`，并以远程结果为准。

### `text_to_speech`

参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `input` | 是 | 要朗读的文本，最多 4096 个字符。 |
| `voice` | 否 | 音色 ID；缺省时使用 `OAI_TTS_VOICE`。 |
| `instructions` | 否 | 语气、情绪、节奏、口音或表达方式；`gpt-4o-mini-tts` 支持效果最佳。 |
| `speed` | 否 | 语速倍率，默认 `1.25`，范围 `0.25`–`4`。 |
| `response_format` | 否 | `mp3`（默认）、`opus`、`aac`、`flac`、`wav` 或 `pcm`。 |

成功时工具仅返回文本 JSON 和结构化结果，其中 `url` 是图床返回的公开直链：

```json
{
  "status": "success",
  "url": "https://example.com/oai-tts-...-Eve.mp3",
  "model": "grok-voice-think-fast-2.0",
  "voice": "Eve",
  "speed": 1.25,
  "format": "mp3",
  "mime_type": "audio/mpeg"
}
```

图床上传失败时，本次调用会返回错误，不会返回 Base64 音频或本地临时路径。

调用意图示例：

```text
使用 text_to_speech，以 marin 音色、温暖平静的睡前故事语气朗读这段文本。
```

## 图床上传与安全说明

- `text_to_speech` 将音频二进制上传到 Urusai 默认端点 `https://api.urusai.cc/v1/upload`，成功后使用响应内的 `data.url_direct` 作为公开直链。
- 生成的音频会离开本机并可能被持有 URL 的人访问；**不要对机密、隐私、个人信息或未获授权的内容使用此工具**。
- `URUSAI_API_TOKEN` 是可选的上传服务令牌；`URUSAI_UPLOAD_URL` 仅用于覆盖默认端点（例如自建兼容服务）。不要把任一令牌提交到 Git。
- TTS API Key 和上传 Token 均不会被写入日志、构建产物或仓库；请仅通过 MCP 客户端 `env` 或受保护的系统环境变量提供。
- `list_voices` 上游请求失败会静默降级为公开内置列表；TTS 或上传失败会返回安全的错误摘要，不回显认证信息。

## 参考

- [OpenAI Text-to-speech 指南](https://developers.openai.com/api/docs/guides/text-to-speech)
- [OpenAI Audio API 参考](https://developers.openai.com/api/docs/api-reference/audio)
