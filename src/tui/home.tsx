import { Box, Text } from "ink";
import { theme } from "./theme";
import { DeltaArt } from "./splash";
import { WaveDivider, VCenterPad } from "./animations";
import { InputBox } from "./input";

interface HomeScreenProps {
  projectDir: string;
  providerLabel: string;
  model: string;
  scopeLabel: string;
  commands: string[];
  onSubmit: (text: string) => void;
  onInterrupt: () => void;
  onCancel: () => void;
}

export function HomeScreen(props: HomeScreenProps) {
  return (
    <Box flexDirection="column">
      <VCenterPad contentHeight={13} />
      <Box flexDirection="column" alignItems="center">
        <DeltaArt />
        <Text color={theme.mist}>free coding tool framework — the harness handles the rest</Text>
        <Box marginTop={1}>
          <WaveDivider width={44} />
        </Box>
        <Text color={theme.oceanDim}>
          {props.projectDir.split("/").filter(Boolean).pop() ?? props.projectDir} · {props.providerLabel} · {props.model} · {props.scopeLabel}
        </Text>
        <Box width={74} marginTop={1}>
          <InputBox
            placeholder={'ask anything — e.g. "build a todo app"'}
            disabled={false}
            busy={false}
            commands={props.commands}
            onSubmit={props.onSubmit}
            onInterrupt={props.onInterrupt}
            onCancel={props.onCancel}
          />
        </Box>
        <Text color={theme.oceanDim}>type / for commands · esc clears input · ctrl-c quits</Text>
      </Box>
    </Box>
  );
}
