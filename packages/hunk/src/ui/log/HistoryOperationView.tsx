/** Draw the retained source/destination docks and shared mutation confirmation/result slot. */
import type { HistoryOperationSnapshot, HistoryOperationViewFlow } from "./historyOperationTypes";
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

/** Reflow a factual notice and optional dismissal without adding operation chrome. */
export function historyResultNoticeLayout(text: string, terminalWidth: number) {
  const width = Math.max(1, terminalWidth - 2);
  const lines = wrapText(text, width);
  const inline = measureTextWidth(lines.at(-1) ?? "") + measureTextWidth(" · Esc Dismiss") <= width;
  return { lines, inline, rows: lines.length + (inline ? 0 : 1) };
}

/** Draw success while ordinary history keeps ownership of navigation and review. */
export function HistoryResultNotice({
  text,
  frame,
  dismiss,
}: {
  text: string;
  frame: HistoryMutationModalFrame;
  dismiss: () => void;
}) {
  const layout = historyResultNoticeLayout(text, frame.terminalWidth);
  return (
    <box
      style={{
        width: frame.terminalWidth,
        height: layout.rows,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "column",
        backgroundColor: frame.theme.panel,
      }}
    >
      {layout.lines.map((line, index) => (
        <box key={index} style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
          <text fg={frame.theme.text} style={{ flexShrink: 0 }}>
            {line}
          </text>
          {layout.inline && index === layout.lines.length - 1 ? (
            <>
              <text fg={frame.theme.muted} style={{ flexShrink: 0 }}>
                {" "}
                ·{" "}
              </text>
              <box style={{ width: measureTextWidth("Esc Dismiss"), height: 1, flexShrink: 0 }}>
                <DialogActionRow
                  actions={[{ id: "dismiss", keyLabel: "Esc", label: "Dismiss", run: dismiss }]}
                  theme={frame.theme}
                  primaryMouseOnly
                  compact
                />
              </box>
            </>
          ) : null}
        </box>
      ))}
      {layout.inline ? null : (
        <DialogActionRow
          actions={[{ id: "dismiss", keyLabel: "Esc", label: "Dismiss", run: dismiss }]}
          theme={frame.theme}
          primaryMouseOnly
          compact
        />
      )}
    </box>
  );
}

/** Use one visibility rule for the rendered Apply affordance and its keyboard route. */
export function historyOperationTooSmall(
  frame: HistoryMutationModalFrame,
  rebase: boolean,
  details = false,
) {
  return (
    frame.terminalWidth < (details ? 24 : rebase ? 33 : 32) ||
    frame.terminalHeight < (details ? 12 : rebase ? 13 : 12)
  );
}
/** Withhold execution when the compact graph dock cannot retain targets and actions. */
export function squashDockTooSmall(frame: HistoryMutationModalFrame) {
  return frame.terminalWidth < 28 || frame.terminalHeight < 14;
}

/** Offer actual diagnostics only when a Squash result needs failure recovery. */
export function squashErrorOutputAvailable(result: HistoryOperationSnapshot["result"]) {
  return Boolean(
    result &&
    (result.kind === "not-run"
      ? result.reason === "start-failed"
      : result.verdict.outcome === "failed" ||
        result.verdict.outcome === "unexpected" ||
        result.change.kind === "unread"),
  );
}

/** Keep Squash actions fixed while contextual messages scroll beside the graph. */
export function squashDockLayout(flow: HistoryOperationViewFlow, frame: HistoryMutationModalFrame) {
  const s = flow.getSnapshot();
  const width = Math.max(1, frame.terminalWidth - 2);
  const result = s.phase === "result";
  const tooSmall = result
    ? historyOperationTooSmall(frame, false, true)
    : squashDockTooSmall(frame);
  const close = () =>
    result ? flow.closeResult(s.attempt) : void flow.cancelVisit(s.visit!, s.attempt);
  const ready = !result && !tooSmall && flow.squashDestinationReady();
  const sourceCount =
    ready && s.prepared?.request.kind === "squash" ? s.prepared.request.sources.length : 0;
  const readySummary = sourceCount
    ? `${sourceCount} revision${sourceCount === 1 ? "" : "s"} will be squashed.`
    : null;
  const actions: ConfirmDialogAction[] = [
    ...(ready
      ? [
          {
            id: "squash",
            keyLabel: "Enter",
            label: "Squash",
            run: () => flow.previewDestination(s.visit!, s.attempt),
          },
        ]
      : []),
    ...(result && !tooSmall && squashErrorOutputAvailable(s.result)
      ? [
          {
            id: "output",
            keyLabel: "o",
            label: "Error output",
            run: () => flow.updateView({ details: true, scroll: 0 }, s),
          },
        ]
      : []),
    ...(result && s.refreshFailed && !tooSmall
      ? [
          {
            id: "retry",
            keyLabel: "r",
            label: "Retry refresh",
            run: () => {
              void flow.retryRefresh(s.attempt);
            },
          },
        ]
      : []),
    { id: "cancel", keyLabel: "Esc", label: result ? "Close" : "Cancel", run: close },
  ];
  const actionRows = layoutDialogActionRows(actions, width, 0);
  const destinationHint = !result && !tooSmall ? "↑↓ Destination" : null;
  const inlineHint = Boolean(
    destinationHint &&
    actionRows.length === 1 &&
    measureTextWidth(destinationHint) +
      3 +
      actions.reduce((n, action) => n + measureTextWidth(`${action.keyLabel} ${action.label}`), 0) +
      Math.max(0, actions.length - 1) * 3 <=
      width,
  );
  const chromeRows =
    (result ? 2 : 0) + actionRows.length + (destinationHint && !inlineHint ? 1 : 0);
  const refusal = flow.destinationRefusal(frame.highlighted);
  const messages = tooSmall
    ? ["Resize the terminal to continue."]
    : [
        ...(result
          ? mutationResultLines(s.result, s.prepared, false, { compact: true })
          : s.phase === "preparing"
            ? s.squashCheckingVisible
              ? ["Checking squash…"]
              : []
            : s.reason
              ? [s.reason]
              : refusal
                ? [refusal]
                : []),
        ...(result && s.reason ? [s.reason] : []),
        ...(readySummary ? [readySummary] : []),
        ...(!result && s.phase !== "preparing"
          ? (s.prepared?.projection.warnings ?? []).map((warning) => `Warning: ${warning}`)
          : []),
        ...(!result && s.phase !== "preparing"
          ? (s.prepared?.projection.notes ?? []).filter(
              (note) =>
                note !== "The source revision is removed." &&
                !/^\d+ other revisions? will be rebased\.$/.test(note),
            )
          : []),
        ...(s.providerText && s.providerText !== s.reason ? [s.providerText] : []),
        ...(result && !s.result && !s.reason ? ["No operation has run in this Hunk session."] : []),
        ...(s.refreshFailed
          ? ["History refresh failed. Retry refresh before another action."]
          : []),
      ];
  const all = mutationSafeLines(messages).flatMap((line) => wrapText(line, width));
  // Leave room for existing chrome and one complete focused history card.
  const budget = Math.max(
    1,
    frame.terminalHeight - 8 - chromeRows - (frame.historyHeaderRows ?? 0),
  );
  const overflow = all.length > budget;
  const bodyRows = overflow ? Math.max(1, budget - 1) : all.length;
  const maxScroll = Math.max(0, all.length - bodyRows);
  const top = Math.min(Math.max(0, s.scroll), maxScroll);
  const lines = all.slice(top, top + bodyRows);
  if (overflow)
    lines.push(
      fitText(
        `${width >= 38 ? "PgUp/PgDn Messages" : "PgUp/PgDn"} · ${top + 1}–${Math.min(all.length, top + bodyRows)}/${all.length}`,
        width,
        "…",
      ),
    );
  return {
    lines,
    actions,
    actionRows,
    rows: lines.length + chromeRows,
    destinationHint,
    inlineHint,
    tooSmall,
    overflow,
    bodyRows,
    top,
    maxScroll,
  };
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
  const confirming =
    s.prepared &&
    (s.phase === "confirmation" || (s.operation === "squash" && s.phase === "destination"));
  const modalWidth = Math.min(88, Math.max(1, frame.terminalWidth - (s.fullResult ? 2 : 4)));
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
  const tooSmall = historyOperationTooSmall(frame, Boolean(toggle), s.details);
  const cancel = () => {
    if (s.fullResult) flow.closeResult(s.attempt);
    else if (s.details) flow.updateView({ details: false, scroll: 0 }, s);
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
      ? s.fullResult
        ? [
            ...(s.refreshFailed
              ? [
                  {
                    id: "retry",
                    keyLabel: "r",
                    label: "Retry refresh",
                    run: () => {
                      void flow.retryRefresh(s.attempt);
                    },
                  },
                ]
              : []),
            { id: "close", keyLabel: "Esc", label: "Close", run: cancel },
          ]
        : [action("back", s.details ? "Back" : "Cancel", 0, cancel)]
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
      confirmDialogHeight(0, s.fullResult) -
      (toggle ? 1 : 0) -
      (s.fullResult ? 0 : 1) -
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
  if (
    s.operation === "squash" &&
    ["destination", "preparing", "result"].includes(s.phase) &&
    !s.details
  ) {
    const layout = squashDockLayout(flow, frame);
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
        onMouseScroll={(event) => {
          event.stopPropagation();
          const direction = event.scroll?.direction;
          if (layout.overflow && (direction === "up" || direction === "down"))
            flow.updateView(
              {
                scroll: Math.min(
                  layout.maxScroll,
                  Math.max(0, layout.top + (direction === "up" ? -1 : 1)),
                ),
              },
              s,
            );
        }}
      >
        {s.phase === "result" ? (
          <>
            <text fg={theme.text} style={{ height: 1, flexShrink: 0 }}>
              Squash
            </text>
            <box style={{ height: 1, flexShrink: 0 }} />
          </>
        ) : null}
        {layout.lines.map((line, index) => (
          <text key={index} fg={theme.text} style={{ height: 1, flexShrink: 0 }}>
            {fitText(line, width, "…")}
          </text>
        ))}
        {layout.destinationHint && !layout.inlineHint ? (
          <text fg={theme.muted} style={{ height: 1, flexShrink: 0 }}>
            {layout.destinationHint}
          </text>
        ) : null}
        {layout.actionRows.map((actions, index) => (
          <box key={index} style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            {layout.inlineHint && index === 0 ? (
              <text fg={theme.muted} style={{ flexShrink: 0 }}>
                {layout.destinationHint} ·{" "}
              </text>
            ) : null}
            <box
              style={{
                width: layout.inlineHint
                  ? width - measureTextWidth(layout.destinationHint!) - 3
                  : width,
                height: 1,
              }}
            >
              <DialogActionRow actions={actions} theme={theme} primaryMouseOnly compact />
            </box>
          </box>
        ))}
      </box>
    );
  }
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
  const confirming =
    s.prepared &&
    (s.phase === "confirmation" || (s.operation === "squash" && s.phase === "destination"));
  const modalWidth = Math.min(88, Math.max(1, frame.terminalWidth - (s.fullResult ? 2 : 4)));
  const innerWidth = Math.max(1, modalWidth - 4);
  const rebase = s.phase === "confirmation" && s.prepared?.request.kind === "rebase";
  const cancelSmall = () => {
    if (s.fullResult) flow.closeResult(s.attempt);
    else if (s.details) flow.updateView({ details: false, scroll: 0 }, s);
    else if (s.visit) void flow.cancelConfirmation(s.visit, s.attempt);
    else flow.closeResult(s.attempt);
  };
  if (historyOperationTooSmall(frame, Boolean(rebase), s.details)) {
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
      compact={s.fullResult}
      title={
        tooSmall
          ? "Action"
          : s.fullResult
            ? "Operation result"
            : s.details
              ? s.operation === "squash"
                ? "Squash error output"
                : "Action details"
              : confirming
                ? `Confirm ${s.operation}`
                : "Operation result"
      }
      width={modalWidth}
      height={confirmDialogHeight(
        bodyRows + (toggle ? 1 : 0) + cueRows + (s.fullResult ? 0 : 1) + actionRows.length - 1,
        s.fullResult,
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
      {s.fullResult ? null : (
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
      )}
    </ConfirmDialog>
  );
}
