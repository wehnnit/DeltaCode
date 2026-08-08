import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { PROVIDER_PRESETS, getPreset, createClient } from "../providers/index";
import { saveConfig, FREE_PROVIDER_ID, type DeltaConfig } from "../config";
import type { McpRegistry } from "../mcp/registry";
import { theme } from "./theme";
import { DeltaArt } from "./splash";
import { WaterSpinner } from "./animations";
import { ModelPicker } from "./modelpicker";

interface SetupScreenProps {
  config: DeltaConfig;
  mcp: McpRegistry;
  onDone: (config: DeltaConfig) => void;
  onQuit: () => void;
}

type Step = "provider" | "statement" | "key" | "model" | "saving";

const PROVIDER_LABELS = PROVIDER_PRESETS.map((p) =>
  p.id === FREE_PROVIDER_ID
    ? `${p.name} — free · no API key · powered by Z.AI`
    : `${p.name} · ${p.envVar}`,
);

export function SetupScreen({ config, mcp, onDone, onQuit }: SetupScreenProps) {
  const [step, setStep] = useState<Step>("provider");
  const [providerIdx, setProviderIdx] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [exaStatus, setExaStatus] = useState<"checking" | "ok" | "fail">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const entry = mcp.tools.get("web_search_exa");
    if (!entry) {
      setExaStatus("fail");
      return;
    }
    entry.client
      .callTool("web_search_exa", { query: "exa mcp server free web search", numResults: 1 })
      .then(() => alive && setExaStatus("ok"))
      .catch(() => alive && setExaStatus("fail"));
    return () => {
      alive = false;
    };
  }, [mcp]);

  const preset = PROVIDER_PRESETS[providerIdx]!;

  const finish = async (model: string) => {
    setStep("saving");
    config.provider = preset.id;
    if (preset.id === FREE_PROVIDER_ID) {
      config.apiKey = "delta-free"; // managed by the Delta proxy — no user key
      config.acceptedFreeModels = true;
    } else {
      config.apiKey = apiKey.trim();
    }
    config.model = model;
    config.models[preset.id] = model;
    await saveConfig(config);
    onDone(config);
  };

  // model step is handled entirely by <ModelPicker> (its own useInput)
  useInput((input, key) => {
    if (step === "provider") {
      if (key.return || /[\n\r]+$/.test(input)) {
        setStep(preset.id === FREE_PROVIDER_ID ? "statement" : "key");
      }
      if (key.downArrow) setProviderIdx((i) => (i + 1) % PROVIDER_PRESETS.length);
      if (key.upArrow) setProviderIdx((i) => (i - 1 + PROVIDER_PRESETS.length) % PROVIDER_PRESETS.length);
      if (key.escape || (key.ctrl && input === "c")) onQuit();
      return;
    }
    if (step === "statement") {
      if (key.return || /[\n\r]+$/.test(input)) setStep("model");
      if (key.escape || (key.ctrl && input === "c")) setStep("provider");
      return;
    }
    if (step === "key") {
      if (key.escape) {
        setStep("provider");
        return;
      }
      if (key.backspace || key.delete) {
        setApiKey((v) => v.slice(0, -1));
        return;
      }
      if (key.return || /[\n\r]+$/.test(input)) {
        const typed = input.replace(/[\n\r]+$/, "");
        const combined = (apiKey + typed).trim();
        setApiKey(combined);
        if (combined) {
          setStep("model");
        } else {
          setError("an API key is required — paste it to continue");
        }
        return;
      }
      if (input) setApiKey((v) => v + input.replace(/[\n\r]+$/, ""));
      return;
    }
    // step "model" / "saving": handled by ModelPicker / no input
  });

  if (step === "saving") {
    return (
      <Box flexDirection="column" alignItems="center" paddingTop={4}>
        <DeltaArt />
        <Box gap={1}>
          <WaterSpinner ms={110} />
          <Text color={theme.ocean}>
            connecting {preset.name} · {config.model || "…"}
          </Text>
        </Box>
      </Box>
    );
  }

  const masked = apiKey.length > 4 ? "•".repeat(apiKey.length - 4) + apiKey.slice(-4) : "•".repeat(apiKey.length);

  return (
    <Box flexDirection="column" alignItems="center" paddingTop={1}>
      <Text color={theme.mist}>SETUP GUIDE</Text>
      <Text color={theme.oceanDim}>connect one API key — the harness handles the rest</Text>
      <Box paddingTop={1} flexDirection="column" width={70} borderStyle="round" borderColor={theme.oceanDim} paddingX={2} paddingY={1}>
        {step === "statement" && (
          <>
            <Text color={theme.ocean} bold>
              Delta Free Models — powered by Z.AI
            </Text>
            <Text color={theme.foam}>
              Delta Free Models uses GLM-4.7-Flash through Z.AI&apos;s official API, which Z.AI offers free of charge.
            </Text>
            <Text color={theme.mist}>By using it you agree to:</Text>
            <Text color={theme.mist}>
              · fair use: token-based — 500 units/day (1M tokens = 10 units), reset at local midnight
            </Text>
            <Text color={theme.mist}>
              · a random, hashed device identifier is sent to the Delta proxy to enforce the fair-use pool; no personal data
            </Text>
            <Text color={theme.mist}>
              · your prompts are sent to Z.AI&apos;s servers for processing — don&apos;t send sensitive data
            </Text>
            <Text color={theme.mist}>
              · DeltaCode is not affiliated with Z.AI; Z.AI services are subject to Z.AI&apos;s Terms of Use (docs.z.ai/legal-agreement/terms-of-use)
            </Text>
            <Text color={theme.mist}>
              · DeltaCode is not responsible for Z.AI availability, rate limits, or changes to the free tier
            </Text>
            <Text color={theme.ocean}>[enter] I agree · [esc] go back</Text>
          </>
        )}
        {step === "provider" && (
          <>
            <Text color={theme.ocean} bold>
              Step 1 · provider
            </Text>
            {PROVIDER_LABELS.map((label, i) => (
              <Text key={label} color={i === providerIdx ? theme.ocean : theme.mist} bold={i === providerIdx}>
                {i === providerIdx ? "∿ " : "  "}
                {label}
              </Text>
            ))}
            <Text color={theme.oceanDim}>↑↓ navigate · enter select · esc quit</Text>
          </>
        )}
        {step === "key" && (
          <>
            <Text color={theme.ocean} bold>
              Step 2 · API key — {preset.name}
            </Text>
            <Box gap={1}>
              <Text color={theme.teal}>∿</Text>
              <Text color={theme.foam}>{masked || "paste your API key"}</Text>
            </Box>
            {error && <Text color={theme.coral}>⚠ {error}</Text>}
            <Text color={theme.oceanDim}>
              stored locally in ~/.delta/config.json (chmod 600) · or use the {preset.envVar} env var
            </Text>
          </>
        )}
        {step === "model" && (
          <ModelPicker
            preset={preset}
            apiKey={apiKey.trim()}
            currentModel=""
            onSelect={(m) => {
              void finish(m);
            }}
            onClose={() => setStep("key")}
          />
        )}
      </Box>
      <Box gap={1} paddingTop={1}>
        <Text color={exaStatus === "ok" ? theme.teal : exaStatus === "checking" ? theme.mist : theme.coral}>
          {exaStatus === "ok" ? "✓" : exaStatus === "checking" ? "~" : "✗"}
        </Text>
        <Text color={theme.mist}>
          {exaStatus === "ok"
            ? "Exa researcher connected — free web search for your agents, no key needed"
            : exaStatus === "checking"
              ? "checking Exa researcher (free web search)…"
              : "Exa researcher unavailable (free web search may need retry later)"}
        </Text>
      </Box>
    </Box>
  );
}
