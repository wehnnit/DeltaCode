import { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { PromptGlyph } from "./animations";
import { theme } from "./theme";

interface InputBoxProps {
  placeholder: string;
  disabled: boolean;
  busy: boolean;
  commands: string[];
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
  onCancel: () => void;
}

export function InputBox({ placeholder, disabled, busy, commands, onSubmit, onInterrupt, onCancel }: InputBoxProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [escArmed, setEscArmed] = useState(false);

  const paletteOpen = !disabled && value.startsWith("/");
  const filtered = paletteOpen
    ? commands.filter((c) => c.startsWith(value)).slice(0, 12)
    : [];
  const paletteIdxRef = useRef(0);
  paletteIdxRef.current = paletteIdx;

  useEffect(() => {
    setPaletteIdx(0);
  }, [value]);

  useInput((input, key) => {
    if (key.escape) {
      if (busy && !escArmed) {
        setEscArmed(true);
        return;
      }
      if (busy && escArmed) {
        setEscArmed(false);
        onInterrupt();
        return;
      }
      setValue("");
      setEscArmed(false);
      return;
    }

    if (disabled) return;

    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    const trailingEnter = /[\n\r]+$/.test(input);
    const barePress =
      input === "" &&
      !key.escape &&
      !key.tab &&
      !key.backspace &&
      !key.delete &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.ctrl;

    // command palette navigation
    if (paletteOpen) {
      if (key.upArrow) {
        setPaletteIdx((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
        return;
      }
      if (key.downArrow) {
        setPaletteIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
        return;
      }
      if (key.tab || key.rightArrow) {
        const sel = filtered[paletteIdxRef.current];
        if (sel) setValue(sel + " ");
        return;
      }
      if (key.return || barePress || trailingEnter) {
        const sel = filtered[paletteIdxRef.current];
        const submitValue = sel && filtered.length === 1 && value === sel ? sel : sel ?? value;
        setValue("");
        setEscArmed(false);
        onSubmit(submitValue);
        return;
      }
    }

    if (key.return || barePress || trailingEnter) {
      const typed = input.replace(/[\n\r]+$/, "");
      const combined = (value + typed).trim();
      if (combined) {
        setHistory((h) => [combined, ...h]);
        setHistoryIdx(-1);
      }
      setValue("");
      setEscArmed(false);
      onSubmit(combined);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.upArrow) {
      if (!paletteOpen) {
        const next = Math.min(historyIdx + 1, history.length - 1);
        if (history[next] !== undefined) {
          setHistoryIdx(next);
          setValue(history[next]!);
        }
      }
      return;
    }
    if (key.downArrow) {
      if (!paletteOpen) {
        const next = historyIdx - 1;
        if (next < 0) {
          setHistoryIdx(-1);
          setValue("");
        } else if (history[next] !== undefined) {
          setHistoryIdx(next);
          setValue(history[next]!);
        }
      }
      return;
    }
    if (key.leftArrow || key.tab) return;

    if (input) {
      setValue((v) => v + input.replace(/[\n\r]+$/, ""));
    }
  });

  return (
    <Box flexDirection="column">
      {paletteOpen && filtered.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.oceanDim} paddingX={1}>
          {filtered.map((cmd, i) => (
            <Text key={cmd} color={i === paletteIdxRef.current ? theme.ocean : theme.mist} bold={i === paletteIdxRef.current}>
              {i === paletteIdxRef.current ? "∿ " : "  "}
              {cmd}
            </Text>
          ))}
          <Text color={theme.oceanDim}>tab to complete · enter to run · esc to close</Text>
        </Box>
      )}
      <Box>
        <PromptGlyph />
        <Text> </Text>
        {value ? (
          <Text color={theme.foam}>{value}</Text>
        ) : (
          <Text color={theme.oceanDim}>{placeholder}</Text>
        )}
      </Box>
      {escArmed && busy && (
        <Text color={theme.gold}>press esc again to cancel the current turn</Text>
      )}
    </Box>
  );
}
