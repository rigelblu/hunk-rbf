import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { MenuDropdown } from "./MenuDropdown";
import { HelpDialog } from "./HelpDialog";
import { resolveTheme } from "../../themes";

/** Read complete wrapped commands independently of border and row padding. */
function commandText(frame: string) {
  return frame.replace(/[│┌┐└┘─]/g, " ").replace(/\s+/g, " ");
}

test("28-column menu retains a full command/remapped key and every wrapped line activates it", async () => {
  let selected = 0;
  const setup = await testRender(
    <MenuDropdown
      activeMenuId="navigate"
      activeMenuEntries={[
        {
          kind: "item",
          label: "Clear selected revisions",
          hint: "Ctrl+Alt+Shift+M",
          action: () => {
            selected++;
          },
        },
      ]}
      activeMenuItemIndex={0}
      activeMenuSpec={{ id: "navigate", label: "Navigate", left: 1, width: 10 }}
      activeMenuWidth={60}
      terminalWidth={28}
      terminalHeight={14}
      theme={resolveTheme("nord", "dark")}
      onHoverItem={() => {}}
      onSelectItem={(entry) => entry.action()}
    />,
    { width: 28, height: 14 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    expect(commandText(frame)).toContain("Clear selected revisions Ctrl+Alt+Shift+M");
    expect(frame).not.toContain("…");
    const y = frame.split("\n").findIndex((line) => line.includes("revisions"));
    expect(y).toBeGreaterThanOrEqual(0);
    await act(async () => {
      await setup.mockMouse.click(4, y);
    });
    expect(selected).toBe(1);
  } finally {
    setup.renderer.destroy();
  }
});

test("28-column help retains full command and effective key across physical rows", async () => {
  const setup = await testRender(
    <HelpDialog
      sections={[
        {
          title: "Selection",
          rows: [{ keys: "Ctrl+Alt+Shift+M", description: "clear selected revisions" }],
        },
      ]}
      terminalWidth={28}
      terminalHeight={14}
      theme={resolveTheme("nord", "dark")}
      onClose={() => {}}
    />,
    { width: 28, height: 14 },
  );
  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const frame = setup.captureCharFrame();
    expect(commandText(frame)).toContain("Ctrl+Alt+Shift+M clear selected revisions");
    expect(frame).not.toContain("…");
  } finally {
    setup.renderer.destroy();
  }
});
