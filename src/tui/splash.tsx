import { Box, Text } from "ink";
import { WaveDivider, WaterSpinner, VCenterPad } from "./animations";
import { theme } from "./theme";

const ART_ROWS: Array<{ text: string; color: string }> = [
  "██████╗ ███████╗██╗     ███████╗ █████╗  ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔══██╗██╔════╝██║     ╚═██╔══╝██╔══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "██║  ██║█████╗  ██║       ██║   ███████║██║     ██║   ██║██║  ██║█████╗  ",
  "██║  ██║██╔══╝  ██║       ██║   ██╔══██║██║     ██║   ██║██║  ██║██╔══╝  ",
  "██║  ██║███████╗███████╗  ██║   ██║  ██║╚██████╗╚██████╔╝██║  ██║███████╗",
  "╚██████╔╝╚══════╝╚══════╝  ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚██████╔╝╚══════╝",
].map((text, i) => ({
  text,
  color: [theme.ocean, theme.foam, theme.mist, theme.oceanDim, theme.foam, theme.deep][i]!,
}));

export function SplashScreen({ tagline = "the harness handles the rest" }: { tagline?: string }) {
  return (
    <Box flexDirection="column">
      <VCenterPad contentHeight={12} />
      <Box flexDirection="column" alignItems="center">
        {ART_ROWS.map((row, i) => (
          <Text key={i} color={row.color}>
            {row.text}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" alignItems="center">
        <WaveDivider width={40} />
        <Box>
          <Text color={theme.mist}>{tagline}</Text>
        </Box>
        <Box gap={1}>
          <WaterSpinner ms={110} />
          <Text color={theme.oceanDim}>loading the harness…</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function DeltaArt({ width }: { width?: number }) {
  return (
    <Box flexDirection="column" alignItems="center">
      {ART_ROWS.map((row, i) => (
        <Text key={i} color={row.color}>
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
