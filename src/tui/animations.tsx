import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Box, Text, useStdout } from "ink";
import { theme, WATER_CHARS, BUBBLES, PROMPT_CHARS } from "./theme";

/**
 * ONE shared animation clock. Every animated component derives its frame from
 * a single 100ms interval — one re-render per tick instead of one per
 * animation component. (Independent per-component intervals saturated the
 * event loop: ~8 intervals × ~10Hz full-tree Ink renders starved setTimeout
 * and input by seconds, freezing the app on the splash screen.)
 */
const TICK_MS = 100;
const AnimationContext = createContext(0);

export function AnimationProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return <AnimationContext.Provider value={tick}>{children}</AnimationContext.Provider>;
}

function useTick(ms: number): number {
  const tick = useContext(AnimationContext);
  // advance at the consumer's own speed: 90ms ≈ every tick, 420ms ≈ every 4th
  return Math.floor(tick / Math.max(1, Math.round(ms / TICK_MS)));
}

/** Current terminal height in rows (falls back to 24). */
export function useTerminalRows(): number {
  const { stdout } = useStdout();
  return stdout.rows ?? 24;
}

/**
 * Renders blank lines so a fixed-height screen (splash, home) sits near the
 * vertical center of the terminal, like opencode.
 */
export function VCenterPad({ contentHeight, extra = 0 }: { contentHeight: number; extra?: number }) {
  const rows = useTerminalRows();
  const pad = Math.max(1, Math.floor((rows - contentHeight) / 2) - 1 + extra);
  return (
    <Box flexDirection="column">
      {Array.from({ length: pad }, (_, i) => (
        <Text key={i}> </Text>
      ))}
    </Box>
  );
}

/** "Δ delta" with a light that sweeps across like a sunbeam over water. */
export function ShimmerText({ text }: { text: string }) {
  const tick = useTick(90);
  const gradient = [
    theme.deep,
    theme.ocean,
    theme.ocean,
    theme.foam,
    theme.ocean,
    theme.ocean,
    theme.deep,
    theme.abyss,
    theme.abyss,
  ];
  return (
    <Text bold>
      {text.split("").map((ch, i) => (
        <Text key={i} color={gradient[(i + tick) % gradient.length]!}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

/** Animated flowing wave divider. */
export function WaveDivider({ width = 44 }: { width?: number }) {
  const tick = useTick(110);
  const chars = Array.from({ length: width }, (_, p) => {
    const ch = WATER_CHARS[(p + tick) % WATER_CHARS.length]!;
    const bright = (p + tick) % 4 === 0;
    return (
      <Text key={p} color={bright ? theme.ocean : theme.oceanDim}>
        {ch}
      </Text>
    );
  });
  return (
    <Box width={width}>
      <Text>{chars}</Text>
    </Box>
  );
}

/** Rotating water/spinner glyph. */
export function WaterSpinner({ ms = 140 }: { ms?: number }) {
  const tick = useTick(ms);
  return (
    <Text color={tick % 2 === 0 ? theme.ocean : theme.teal} bold>
      {BUBBLES[tick % BUBBLES.length]}
    </Text>
  );
}

/** Slow breathing animated prompt glyph for the input line. */
export function PromptGlyph({ chars = PROMPT_CHARS, ms = 420 }: { chars?: readonly string[]; ms?: number }) {
  const tick = useTick(ms);
  return (
    <Text color={theme.teal} bold>
      {chars[tick % chars.length]}
    </Text>
  );
}

/** Animated status line shown while an agent is working, with elapsed seconds. */
export function AgentStatus({ agent }: { agent: string }) {
  const tick = useTick(200);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const bar = Array.from({ length: 6 }, (_, p) => {
    const active = (tick + p) % 12 < 6;
    return (
      <Text key={p} color={active ? theme.ocean : theme.oceanDim}>
        ≈
      </Text>
    );
  });
  return (
    <Box gap={1}>
      <WaterSpinner ms={120} />
      <Text color={theme.foam} bold>
        {agent}
      </Text>
      <Text color={theme.mist}>is working</Text>
      <Text>{bar}</Text>
      <Text color={theme.oceanDim}>{elapsed}s</Text>
    </Box>
  );
}

/** Wraps children in a rounded ocean-styled box. */
export function OceanBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.oceanDim} paddingX={1}>
      {title && (
        <Text color={theme.ocean} bold>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
}
