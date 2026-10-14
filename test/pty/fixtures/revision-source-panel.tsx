/** Mount the prepared panel with deterministic test sources, never a production operation. */
import { createCliRenderer } from "@opentui/core";
import { createRoot, useTerminalDimensions } from "@opentui/react";
import {
  createTestRevisionSourcePanelController,
  TestRevisionSourcePanel,
} from "../../helpers/revision-source-panel";
import { RevisionSourceSelection } from "../../../packages/hunk/src/ui/log/revisionSourceSelection";

const controller = await createTestRevisionSourcePanelController();
const selection = new RevisionSourceSelection(controller, () => ({ eligible: true }));
const visit = Symbol("PTY source panel test");
selection.begin(visit);

/** Follow real PTY resizes without inventing an operation host. */
function RevisionSourcePanelTestFixture() {
  const { width } = useTerminalDimensions();
  return (
    <TestRevisionSourcePanel
      controller={controller}
      selection={selection}
      visit={visit}
      width={width}
    />
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  screenMode: "alternate-screen",
  useThread: false,
});
createRoot(renderer).render(<RevisionSourcePanelTestFixture />);
