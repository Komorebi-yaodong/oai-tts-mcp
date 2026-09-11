#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "oai-tts-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_SPEED = 1.25;
const REQUEST_TIMEOUT_MS = 60_000;
const URUSAI_UPLOAD_URL = "https://api.urusai.cc/v1/upload";


const fallbackVoices = [
  ["alloy", "Alloy"],
  ["ash", "Ash"],
  ["ballad", "Ballad"],
  ["coral", "Coral"],
  ["echo", "Echo"],
  ["fable", "Fable"],
  ["nova", "Nova"],
  ["onyx", "Onyx"],
  ["sage", "Sage"],
  ["shimmer", "Shimmer"],
  ["verse", "Verse"],
  ["marin", "Marin"],
  ["cedar", "Cedar"],
] as const;


type UrusaiUploadResponse = {
  status?: unknown;
  message?: unknown;
  data?: {
    url_direct?: unknown;
  };
};

type SpeechUrlResult = {
  status: "success";
  url: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
  mime_type: string;
};

type Voice = {
  voice_id: string;
  name: string;
  language?: string;
};

type VoiceListResult = {
  voices: Voice[];
  source: "remote" | "fallback";
  fallback_reason?: string;
};

function getRequiredEnv(name: "OAI_TTS_BASE_URL" | "OAI_TTS_API_KEY" | "OAI_TTS_MODEL" | "OAI_TTS_VOICE"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getApiBaseUrl(): string {
  const rawUrl = getRequiredEnv("OAI_TTS_BASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(rawUrl)) {
    throw new Error("OAI_TTS_BASE_URL must start with http:// or https://");
  }

  return rawUrl.endsWith("/v1") ? rawUrl : `${rawUrl}/v1`;
}

function createHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getRequiredEnv("OAI_TTS_API_KEY")}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function getModel(): string {
  return getRequiredEnv("OAI_TTS_MODEL");
}

function fallbackVoiceList(): Voice[] {
  return fallbackVoices.map(([voice_id, name]) => ({ voice_id, name }));
}

function parseVoiceList(payload: unknown): Voice[] | undefined {
  if (!payload || typeof payload !== "object" || !("voices" in payload) || !Array.isArray(payload.voices)) {
    return undefined;
  }

  const voices = payload.voices.flatMap((item): Voice[] => {
    if (!item || typeof item !== "object" || !("voice_id" in item) || typeof item.voice_id !== "string") {
      return [];
    }

    const voice_id = item.voice_id.trim();
    if (!voice_id) {
      return [];
    }

    return [{
      voice_id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : voice_id,
      ...(typeof item.language === "string" && item.language.trim() ? { language: item.language.trim() } : {}),
    }];
  });

  return voices.length > 0 ? voices : undefined;
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "request timed out" : error.message;
  }
  return "unknown request error";
}

async function listVoicesFromProvider(): Promise<VoiceListResult> {
  try {
    const url = new URL(`${getApiBaseUrl()}/tts/voices`);
    url.searchParams.set("model", getModel());

    const response = await fetch(url, {
      method: "GET",
      headers: createHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        voices: fallbackVoiceList(),
        source: "fallback",
        fallback_reason: `provider returned HTTP ${response.status}`,
      };
    }

    const voices = parseVoiceList(await response.json());
    if (!voices) {
      return {
        voices: fallbackVoiceList(),
        source: "fallback",
        fallback_reason: "provider response did not contain a non-empty voices array",
      };
    }

    return { voices, source: "remote" };
  } catch (error) {
    return {
      voices: fallbackVoiceList(),
      source: "fallback",
      fallback_reason: errorSummary(error),
    };
  }
}

function mimeTypeFor(format: string, responseContentType: string | null): string {
  if (responseContentType?.startsWith("audio/")) {
    return responseContentType.split(";", 1)[0];
  }

  const mimeTypes: Record<string, string> = {
    mp3: "audio/mpeg",
    opus: "audio/ogg",
    aac: "audio/aac",
    flac: "audio/flac",
    wav: "audio/wav",
    pcm: "audio/pcm",
  };
  return mimeTypes[format] ?? "application/octet-stream";
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = (await response.text()).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 800) : `HTTP ${response.status}`;
}

function getUrusaiUploadUrl(): string {
  const rawUrl = (process.env.URUSAI_UPLOAD_URL?.trim() || URUSAI_UPLOAD_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URUSAI_UPLOAD_URL must be a valid http(s) URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URUSAI_UPLOAD_URL must use http:// or https://");
  }
  return url.toString();
}

function fileExtensionFor(format: string): string {
  return format === "pcm" ? "pcm" : format;
}

function createAudioFilename(voice: string, format: string): string {
  const safeVoice = voice.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "voice";
  return `oai-tts-${Date.now()}-${crypto.randomUUID()}-${safeVoice}.${fileExtensionFor(format)}`;
}

function parseUploadedAudioUrl(payload: unknown): string | undefined {
  const result = payload as UrusaiUploadResponse;
  if (result?.status !== "success" || typeof result.data?.url_direct !== "string") {
    return undefined;
  }

  const url = result.data.url_direct.trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function uploadAudioToUrusai(audio: Buffer, filename: string, mimeType: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);

  const token = process.env.URUSAI_API_TOKEN?.trim();
  if (token) {
    formData.append("token", token);
  }
  formData.append("r18", "0");

  const response = await fetch(getUrusaiUploadUrl(), {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`audio upload failed: provider returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("audio upload failed: provider returned invalid JSON");
  }

  const url = parseUploadedAudioUrl(payload);
  if (!url) {
    throw new Error("audio upload failed: provider did not return a valid direct URL");
  }
  return url;
}


const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  "list_voices",
  {
    title: "获取可用 TTS 音色",
    description:
      "获取当前 OAI_TTS_MODEL 的可用音色。优先调用 GET /v1/tts/voices?model=...；上游失败、超时或响应无效时自动返回内置 OpenAI 音色，并在结构化结果中标记 source=fallback。",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const result = await listVoicesFromProvider();
    const lines = result.voices.map((voice) => {
      const language = voice.language ? ` (${voice.language})` : "";
      return `- ${voice.voice_id}: ${voice.name}${language}`;
    });
    const status = result.source === "remote" ? "上游音色列表" : `内置回退音色（原因：${result.fallback_reason}）`;

    return {
      content: [{ type: "text", text: `${status}\n${lines.join("\n")}` }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "text_to_speech",
  {
    title: "将文本转换为语音",
    description:
      "调用 OpenAI 兼容 POST /v1/audio/speech 生成语音，并上传到 Urusai 文件托管服务。传入 instructions 可指定语气、情绪、节奏或风格；未指定 voice 时使用 OAI_TTS_VOICE；未指定 speed 时默认 1.25。成功后仅返回公开音频 URL。",
    inputSchema: z.object({
      input: z.string().trim().min(1, "input 不能为空").max(4096, "input 最多 4096 个字符").describe("要转换为语音的文本"),
      voice: z.string().trim().min(1).max(128).optional().describe("可选，目标音色；默认使用 OAI_TTS_VOICE"),
      instructions: z.string().trim().min(1).max(4096).optional().describe("可选，语气、情绪、节奏、口音或表达方式说明；gpt-4o-mini-tts 支持效果最佳"),
      speed: z.number().min(0.25).max(4).optional().describe("可选，播放速度倍率；默认 1.25"),
      response_format: z.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"]).optional().describe("可选，音频格式；默认 mp3"),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ input, voice, instructions, speed, response_format }) => {
    try {
      const format = response_format ?? "mp3";
      const requestBody = {
        model: getModel(),
        input,
        voice: voice ?? getRequiredEnv("OAI_TTS_VOICE"),
        speed: speed ?? DEFAULT_SPEED,
        response_format: format,
        ...(instructions ? { instructions } : {}),
      };

      const response = await fetch(`${getApiBaseUrl()}/audio/speech`, {
        method: "POST",
        headers: { ...createHeaders(), Accept: "audio/*" },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `语音生成失败：${await readErrorMessage(response)}` }],
          isError: true,
        };
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.byteLength === 0) {
        return {
          content: [{ type: "text", text: "语音生成失败：上游返回了空音频。" }],
          isError: true,
        };
      }

      const mimeType = mimeTypeFor(format, response.headers.get("content-type"));
      const url = await uploadAudioToUrusai(audio, createAudioFilename(requestBody.voice, format), mimeType);
      const result: SpeechUrlResult = {
        status: "success",
        url,
        model: requestBody.model,
        voice: requestBody.voice,
        speed: requestBody.speed,
        format,
        mime_type: mimeType,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `语音生成请求失败：${errorSummary(error)}` }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(`${SERVER_NAME} failed to start: ${errorSummary(error)}`);
  process.exitCode = 1;
});
