import { OpenAICompatClient } from "./openai-compat";
import { getDeviceId } from "../device-id";

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  envVar: string;
  defaultModels: string[];
  extraHeaders?: Record<string, string>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "delta-free",
    name: "Delta Free Models (GLM-4.7-Flash-Free · free)",
    baseUrl: "https://deltacode-free.wehnit-studios.workers.dev/v1",
    envVar: "DELTA_FREE_BASE_URL",
    defaultModels: ["glm-4.7-flash"],
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    envVar: "ANTHROPIC_API_KEY",
    defaultModels: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    defaultModels: ["gpt-5.6", "gpt-5.4-mini", "gpt-5.2"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    defaultModels: [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6",
      "google/gemini-3.6-flash",
      "z-ai/glm-5.2",
    ],
    extraHeaders: { "HTTP-Referer": "https://delta.dev", "X-Title": "Delta" },
  },
  {
    id: "zai",
    name: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    envVar: "ZAI_API_KEY",
    defaultModels: ["glm-5.2", "glm-5.1", "glm-4.7-flash"],
    extraHeaders: { "Accept-Language": "en-US,en" },
  },
  {
    id: "gemini",
    name: "Google Gemini/Gemma",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envVar: "GEMINI_API_KEY",
    defaultModels: ["gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-2.5-flash"],
  },
  {
    id: "zenmux",
    name: "ZenMux",
    baseUrl: "https://zenmux.ai/api/v1",
    envVar: "ZENMUX_API_KEY",
    defaultModels: [
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6",
      "google/gemini-3.6-flash",
      "z-ai/glm-5.2",
      "qwen/qwen3-max",
    ],
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export async function createClient(
  preset: ProviderPreset,
  apiKey: string,
  model: string,
  timeouts?: { requestTimeoutMs?: number; idleTimeoutMs?: number; maxTokens?: number },
): Promise<OpenAICompatClient> {
  const freeBase = preset.id === "delta-free" ? process.env.DELTA_FREE_BASE_URL?.trim() : undefined;
  const deviceHeader =
    preset.id === "delta-free"
      ? { "X-Delta-User": await getDeviceId(), "X-Delta-Date": new Date().toISOString().slice(0, 10) }
      : undefined;
  return new OpenAICompatClient({
    baseUrl: freeBase || process.env.DELTA_BASE_URL?.trim() || preset.baseUrl,
    apiKey,
    model,
    extraHeaders: { ...preset.extraHeaders, ...deviceHeader },
    ...timeouts,
  });
}
