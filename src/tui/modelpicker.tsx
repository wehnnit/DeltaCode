import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ProviderPreset } from "../providers/index";
import { createClient } from "../providers/index";
import { FREE_PROVIDER_ID } from "../config";
import { theme } from "./theme";
import { OceanBox, WaterSpinner } from "./animations";

const CUSTOM_OPTION = "Custom model...";
const MAX_MODELS = 20;

interface ModelPickerProps {
  preset: ProviderPreset;
  apiKey: string;
  currentModel: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}

export function ModelPicker({ preset, apiKey, currentModel, onSelect, onClose }: ModelPickerProps) {
  const [models, setModels] = useState<string[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [custom, setCustom] = useState("");
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const client = await createClient(preset, apiKey, currentModel || preset.defaultModels[0]!);
      client
      .listModels()
      .then((ids) => {
        if (!alive) return;
        const list = ids.length ? ids.slice(0, MAX_MODELS) : preset.defaultModels;
        setModels(list);
        const cur = list.indexOf(currentModel);
        if (cur >= 0) setIdx(cur);
      })
        .catch(() => {
          if (!alive) return;
          setModels(preset.defaultModels);
        });
    })();
    return () => {
      alive = false;
    };
  }, [preset, apiKey, currentModel]);

  // Delta Free Models has a managed catalog — no custom model ids
  const options = models ? (preset.id === FREE_PROVIDER_ID ? models : [...models, CUSTOM_OPTION]) : [];

  useInput((input, key) => {
    if (key.escape) {
      if (customMode) setCustomMode(false);
      else onClose();
      return;
    }
    if (customMode) {
      if (key.backspace || key.delete) {
        setCustom((v) => v.slice(0, -1));
        return;
      }
      if (key.return || /[\n\r]+$/.test(input)) {
        const typed = input.replace(/[\n\r]+$/, "");
        const combined = (custom + typed).trim();
        setCustom(combined);
        if (combined) onSelect(combined);
        return;
      }
      if (input) setCustom((v) => v + input.replace(/[\n\r]+$/, ""));
      return;
    }
    if (key.upArrow) setIdx((i) => (i - 1 + options.length) % Math.max(options.length, 1));
    if (key.downArrow) setIdx((i) => (i + 1) % Math.max(options.length, 1));
    if (key.return || /[\n\r]+$/.test(input)) {
      if (options[idx] === CUSTOM_OPTION) setCustomMode(true);
      else if (options[idx]) {
        onSelect(options[idx]!);
      }
      return;
    }
  });

  if (customMode) {
    return (
      <OceanBox title={`custom model id — ${preset.name}`}>
        <Box gap={1}>
          <Text color={theme.teal}>∿</Text>
          <Text color={theme.foam}>{custom || "e.g. glm-5.2"}</Text>
        </Box>
        <Text color={theme.oceanDim}>enter to apply · esc back</Text>
      </OceanBox>
    );
  }

  return (
    <OceanBox title={`select model — ${preset.name}`}>
      {models === null ? (
        <Box gap={1}>
          <WaterSpinner ms={110} />
          <Text color={theme.mist}>fetching available models…</Text>
        </Box>
      ) : (
        options.map((m, i) => (
          <Text key={m} color={i === idx ? theme.ocean : theme.mist} bold={i === idx}>
            {i === idx ? "∿ " : "  "}
            {m === currentModel ? "(current) " : ""}
            {m.length > 64 ? m.slice(0, 61) + "…" : m}
          </Text>
        ))
      )}
      <Text color={theme.oceanDim}>↑↓ navigate · enter apply · esc cancel</Text>
    </OceanBox>
  );
}
