/** Draw the retained source/destination docks and shared mutation confirmation/result slot. */
import type { HistoryOperationViewFlow } from "./historyOperationTypes";
import type { HistoryMutationModalFrame } from "./mutationFlow";
import { RevisionSourcePanel } from "./RevisionSourcePanel";
import {
  ConfirmDialog,
  DialogActionRow,
  confirmDialogHeight,
  type ConfirmDialogAction,
} from "../components/chrome/ConfirmDialog";
import { fitText, measureTextWidth, wrapText } from "../lib/text";
import { resolveModalGeometry } from "../lib/modalGeometry";
import { layoutDialogActionRows } from "../lib/dialogActions";
import { sanitizeTerminalLine } from "../../lib/terminalText";
import {
  mutationConfirmationLines,
  mutationResultLines,
  mutationSafeLines,
} from "./mutationPresentation";

/** Use one visibility rule for the rendered Apply affordance and its keyboard route. */
export function historyOperationTooSmall(frame: HistoryMutationModalFrame, rebase: boolean) {
  return frame.terminalWidth < (rebase ? 33 : 32) || frame.terminalHeight < (rebase ? 13 : 12);
}
/** Keep destination header/actions in one row where they fit and reflow them at narrow widths. */
export function destinationLayout(
  flow: HistoryOperationViewFlow,
  frame: HistoryMutationModalFrame,
) {
  const s = flow.getSnapshot();
  const width = Math.max(1, frame.terminalWidth - 2);
  const title = fitText(`Choose ${s.operation} destination`, width, "…");
  const refusal = flow.destinationRefusal(frame.highlighted);
  const actions: ConfirmDialogAction[] = [
    ...(!refusal
      ? [
          {
            id: "preview",
            keyLabel: "Enter",
            label: "Preview",
            run: () => flow.previewDestination(s.visit!, s.attempt),
          },
        ]
      : []),
    {
      id: "cancel",
      keyLabel: "Esc",
      label: s.focus === 1 && s.providerText ? "[Cancel]" : "Cancel",
      run: () => {
        void flow.cancelVisit(s.visit!, s.attempt);
      },
    },
    ...(s.providerText
      ? [
          {
            id: "details",
            keyLabel: "",
            label: s.focus === 2 ? "[Details]" : "Details",
            run: () => flow.updateView({ details: true, scroll: 0 }, s),
          },
        ]
      : []),
  ];
  const actionWidth =
    actions.reduce(
      (n, action) => n + measureTextWidth(`${action.keyLabel} ${action.label}`) + 2,
      0,
    ) +
    (actions.length - 1) * 3;
  const split = measureTextWidth(title) + actionWidth + 1 > width;
  const actionRows = layoutDialogActionRows(actions, width);
  const placements: ConfirmDialogAction[] = (
    [
      ["onto", "o", "Onto"],
      ["after", "A", "After"],
      ["before", "B", "Before"],
    ] as const
  ).map(([placement, keyLabel, label]) => ({
    id: placement,
    keyLabel,
    label: s.placement === placement ? `[${label}]` : label,
    run: () => flow.choosePlacement(s.visit!, placement, s.attempt),
  }));
  const placementRows = layoutDialogActionRows(placements, width);
  return {
    title,
    actions,
    actionRows,
    placementRows,
    split,
    actionWidth,
    rows:
      3 +
      (s.operation === "rebase" ? placementRows.length + 1 : 0) +
      (split ? actionRows.length : 0),
  };
}
/** Plan the same provider body bounds for visible rows, scroll cues, mouse and keyboard. */
export function planHistoryOperationOverlay(
  flow: HistoryOperationViewFlow,
  frame: HistoryMutationModalFrame,
) {
  const s = flow.getSnapshot();
  const confirming = s.phase === "confirmation" && s.prepared;
  const modalWidth = Math.min(88, Math.max(1, frame.terminalWidth - 4));
  const innerWidth = Math.max(1, modalWidth - 4);
  const raw = [
    ...(s.reason ? mutationSafeLines([s.reason]) : []),
    ...(confirming
      ? mutationConfirmationLines(s.prepared!, s.details)
      : mutationResultLines(s.result, s.prepared, s.details)),
    ...(s.providerText ? mutationSafeLines([s.providerText]) : []),
    ...(s.refreshFailed
      ? [
          "History could not be refreshed. The actual result is retained. Retry refresh before starting another action.",
        ]
      : []),
  ];
  const lines = raw.flatMap((line) => wrapText(line, innerWidth));
  const toggle = confirming && s.prepared!.request.kind === "rebase";
  const tooSmall = historyOperationTooSmall(frame, Boolean(toggle));
  const cancel = () => {
    if (s.details) flow.updateView({ details: false, scroll: 0 }, s);
    else if (s.visit) void flow.cancelConfirmation(s.visit, s.attempt);
    else flow.closeResult(s.attempt);
  };
  const action = (
    id: string,
    label: string,
    index: number,
    run: () => void,
  ): ConfirmDialogAction => ({
    id,
    keyLabel: "",
    label: s.focus === index ? `[${label}]` : label,
    focused: s.focus === index,
    run,
  });
  const actions =
    s.details || tooSmall
      ? [action("back", s.details ? "Back" : "Cancel", 0, cancel)]
      : confirming
        ? [
            action("cancel", "Cancel", 0, cancel),
            action("apply", "Apply", 1, () => flow.apply(s.visit!, s.attempt)),
            action("details", "Details", 2, () => flow.updateView({ details: true, scroll: 0 }, s)),
          ]
        : [
            action("close", "Close", 0, cancel),
            action("details", "Details", 1, () => flow.updateView({ details: true, scroll: 0 }, s)),
            ...(s.refreshFailed
              ? [
                  action("retry", "Retry refresh", 2, () => {
                    void flow.retryRefresh(s.attempt);
                  }),
                ]
              : []),
          ];
  const actionRows = layoutDialogActionRows(actions, innerWidth);
  const availableBodyRows = Math.max(
    1,
    frame.terminalHeight -
      2 -
      confirmDialogHeight(0) -
      (toggle ? 1 : 0) -
      1 -
      (actionRows.length - 1),
  );
  // Reserve a visible cue before clipping, so omitted consequences are discoverable before Apply.
  const overflow = lines.length > availableBodyRows;
  const cueRows = overflow && availableBodyRows > 1 ? 1 : 0;
  const bodyRows = Math.max(1, Math.min(lines.length || 1, availableBodyRows - cueRows));
  const top = Math.min(s.scroll, Math.max(0, lines.length - bodyRows));
  const scrollHint = `${innerWidth >= 48 ? "↑↓ / PgUp / PgDn Scroll" : "↑↓ Scroll"} · ${top + 1}–${Math.min(lines.length, top + bodyRows)}/${lines.length}`;
  return {
    lines,
    toggle,
    tooSmall,
    cancel,
    actions,
    actionRows,
    bodyRows,
    overflow,
    cueRows,
    top,
    maxScroll: Math.max(0, lines.length - bodyRows),
    scrollHint,
  };
}

/** Render one complete operation phase without inventing provider facts or results. */
export function HistoryOperationView({
  flow,
  frame,
}: {
  flow: HistoryOperationViewFlow;
  frame: HistoryMutationModalFrame;
}) {
  const s = flow.getSnapshot();
  const theme = frame.theme;
  const width = Math.max(1, frame.terminalWidth - 2);
  if (s.phase === "sources")
    return (
      <RevisionSourcePanel
        operationLabel={s.operation!}
        width={frame.terminalWidth}
        state={flow.sourceState()}
        actions={flow.sourceActions(frame)}
        theme={theme}
      />
    );
  if (s.phase === "destination" && !s.details) {
    const layout = destinationLayout(flow, frame);
    const source = s.sources[0]!;
    const candidate = frame.highlighted;
    const same = candidate?.revisionId === source.revisionId;
    const line = (text: string) => fitText(sanitizeTerminalLine(text), width, "…");

    return (
      <box
        style={{
          width: frame.terminalWidth,
          height: layout.rows,
          paddingLeft: 1,
          paddingRight: 1,
          flexDirection: "column",
          backgroundColor: theme.panel,
        }}
      >
        <box style={{ height: 1, flexDirection: "row" }}>
          <text
            fg={theme.text}
            style={{ width: layout.split ? width : Math.max(1, width - layout.actionWidth) }}
          >
            {layout.title}
          </text>
          {layout.split ? null : (
            <DialogActionRow actions={layout.actions} theme={theme} primaryMouseOnly />
          )}
        </box>
        {layout.split
          ? layout.actionRows.map((actions, index) => (
              <DialogActionRow key={index} actions={actions} theme={theme} primaryMouseOnly />
            ))
          : null}
        <text style={{ height: 1 }} fg={theme.muted}>
          {line(`Source: ${source.displayId} ${source.subject} · ${source.revisionId.slice(0, 8)}`)}
        </text>
        <text style={{ height: 1 }} fg={theme.muted}>
          {line(
            `Destination: ${!candidate || same ? "not chosen" : `${candidate.displayId} ${candidate.subject} · ${candidate.revisionId.slice(0, 8)}`}`,
          )}
        </text>
        {s.operation === "rebase" ? (
          <>
            {layout.placementRows.map((actions, index) => (
              <DialogActionRow key={index} actions={actions} theme={theme} primaryMouseOnly />
            ))}
            <text style={{ height: 1 }} fg={theme.muted}>
              {line(
                s.placement === "onto"
                  ? "Source becomes a child of the destination."
                  : s.placement === "after"
                    ? "Source goes between the destination and its children."
                    : "Source goes between the destination and its parents.",
              )}
            </text>
          </>
        ) : null}
      </box>
    );
  }
  if (s.phase === "preparing" || s.phase === "applying")
    return (
      <text style={{ height: 1, paddingLeft: 1 }} fg={theme.muted}>
        {s.reason === "Cancelling action…"
          ? s.reason
          : s.phase === "applying"
            ? "Running action…"
            : "Preparing action…"}
      </text>
    );
  const confirming = s.phase === "confirmation" && s.prepared;
  const modalWidth = Math.min(88, Math.max(1, frame.terminalWidth - 4));
  const innerWidth = Math.max(1, modalWidth - 4);
  const rebase = s.phase === "confirmation" && s.prepared?.request.kind === "rebase";
  const cancelSmall = () => {
    if (s.details) flow.updateView({ details: false, scroll: 0 }, s);
    else if (s.visit) void flow.cancelConfirmation(s.visit, s.attempt);
    else flow.closeResult(s.attempt);
  };
  if (historyOperationTooSmall(frame, Boolean(rebase))) {
    const message = wrapText(
      "Terminal is too small to show this action. Resize to continue.",
      innerWidth,
    );
    const geometry = resolveModalGeometry({
      width: modalWidth,
      height: confirmDialogHeight(message.length, true),
      terminalWidth: frame.terminalWidth,
      terminalHeight: frame.terminalHeight,
      compact: true,
    });
    const visible = Math.max(
      0,
      Math.min(message.length, geometry.height - confirmDialogHeight(0, true)),
    );
    const clipped = message.slice(0, visible);
    if (visible && visible < message.length)
      clipped[visible - 1] = fitText(`${message.slice(visible - 1).join(" ")}…`, innerWidth, "…");
    return (
      <ConfirmDialog
        compact
        title="Action"
        width={modalWidth}
        height={geometry.height}
        terminalWidth={frame.terminalWidth}
        terminalHeight={frame.terminalHeight}
        theme={theme}
        actions={[
          { id: "cancel", keyLabel: "", label: "[Cancel]", focused: true, run: cancelSmall },
        ]}
        primaryMouseOnly
        onClose={cancelSmall}
      >
        <box
          style={{ height: visible, flexDirection: "column", overflow: "hidden", flexShrink: 0 }}
        >
          {clipped.map((line, index) => (
            <text key={index} fg={theme.text} style={{ height: 1, flexShrink: 0 }}>
              {line}
            </text>
          ))}
        </box>
      </ConfirmDialog>
    );
  }
  const {
    lines,
    toggle,
    tooSmall,
    cancel,
    actions,
    actionRows,
    bodyRows,
    overflow,
    cueRows,
    top,
    scrollHint,
  } = planHistoryOperationOverlay(flow, frame);
  return (
    <ConfirmDialog
      title={
        tooSmall
          ? "Action"
          : s.details
            ? "Action details"
            : confirming
              ? `Confirm ${s.operation}`
              : "Operation result"
      }
      width={modalWidth}
      height={confirmDialogHeight(
        bodyRows + (toggle ? 1 : 0) + cueRows + 1 + actionRows.length - 1,
      )}
      terminalWidth={frame.terminalWidth}
      terminalHeight={frame.terminalHeight}
      theme={theme}
      actions={actions}
      actionRows={actionRows}
      primaryMouseOnly
      onClose={cancel}
      onMouseScroll={(event) => {
        const direction = event.scroll?.direction;
        if (direction === "up" || direction === "down")
          flow.updateView({ scroll: Math.max(0, top + (direction === "up" ? -1 : 1)) }, s);
      }}
    >
      <box style={{ height: bodyRows, flexDirection: "column" }}>
        {(tooSmall
          ? wrapText("Terminal is too small to show this action. Resize to continue.", innerWidth)
          : lines.slice(top, top + bodyRows)
        ).map((line, index) => (
          <text key={index} fg={theme.text} style={{ height: 1 }}>
            {fitText(line, innerWidth, "…")}
          </text>
        ))}
      </box>
      {cueRows ? (
        <text style={{ height: 1, flexShrink: 0 }} fg={theme.muted}>
          {fitText(scrollHint, innerWidth, "…")}
        </text>
      ) : null}
      {toggle && !tooSmall ? (
        <DialogActionRow
          actions={[
            {
              id: "skipEmptied",
              keyLabel: "s",
              label: `abandon if empty: ${s.prepared!.request.kind === "rebase" && s.prepared!.request.skipEmptied ? "on" : "off"}`,
              run: () => {
                void flow.toggleSkipEmptied(s.visit!, s.attempt);
              },
            },
          ]}
          theme={theme}
          primaryMouseOnly
        />
      ) : null}
      <text style={{ height: 1 }} fg={theme.muted}>
        {fitText(
          overflow && !cueRows
            ? scrollHint
            : s.details
              ? "Enter Back · Esc Back"
              : `Tab Choose · Enter Select · Esc ${confirming ? "Cancel" : "Close"}`,
          innerWidth,
          "…",
        )}
      </text>
    </ConfirmDialog>
  );
}
