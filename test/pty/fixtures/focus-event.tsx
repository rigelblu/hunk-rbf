import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";

/** Advertise listener readiness and whether OpenTUI parsed one focus-in sequence. */
function FocusEventFixture() {
  const renderer = useRenderer();
  const [ready, setReady] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const handleFocus = () => setFocused(true);
    renderer.on(CliRenderEvents.FOCUS, handleFocus);
    setReady(true);
    return () => {
      renderer.off(CliRenderEvents.FOCUS, handleFocus);
    };
  }, [renderer]);

  const status = focused ? "FOCUS_RECEIVED" : ready ? "FOCUS_READY" : "FOCUS_STARTING";
  return <text>{status}</text>;
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  screenMode: "alternate-screen",
  useThread: false,
});
createRoot(renderer).render(<FocusEventFixture />);
