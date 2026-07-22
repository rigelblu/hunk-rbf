import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";

/** Render whether OpenTUI parsed one terminal focus-in sequence. */
function FocusEventFixture() {
  const renderer = useRenderer();
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const handleFocus = () => setFocused(true);
    renderer.on(CliRenderEvents.FOCUS, handleFocus);
    return () => {
      renderer.off(CliRenderEvents.FOCUS, handleFocus);
    };
  }, [renderer]);

  return <text>{focused ? "FOCUS_RECEIVED" : "FOCUS_READY"}</text>;
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  screenMode: "alternate-screen",
  useThread: false,
});
createRoot(renderer).render(<FocusEventFixture />);
