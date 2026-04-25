/* Terminal.jsx — Cathedral terminal shell.
   Renders the 160 × 45 monospace grid: tab bar, split-pane, separator, footer.
   Children control the chat-area content; the sidebar is fixed.
*/

const COLS = 160;
const LEFT_W = 110;     // chat pane: cols 1..110
const GUTTER_W = 1;     // col 111 (background)
const RIGHT_W = 49;     // sidebar: cols 112..160

/* Pad a string to exact length n with spaces (right-pad). Truncates if longer. */
function padR(s, n) {
  const raw = s == null ? '' : String(s);
  if (raw.length >= n) return raw.slice(0, n);
  return raw + ' '.repeat(n - raw.length);
}
function padL(s, n) {
  const raw = s == null ? '' : String(s);
  if (raw.length >= n) return raw.slice(0, n);
  return ' '.repeat(n - raw.length) + raw;
}
/* Center a string into width n. */
function center(s, n) {
  const raw = s == null ? '' : String(s);
  if (raw.length >= n) return raw.slice(0, n);
  const left = Math.floor((n - raw.length) / 2);
  const right = n - raw.length - left;
  return ' '.repeat(left) + raw + ' '.repeat(right);
}

/* ── TAB BAR (row 1) ──────────────────────────────────────────────────────
   Active session-tab wrapped in double-line ║…║ in burnt orange,
   with the sage state dot inside. Other tabs use single │ separators
   in dim foreground. We render a fixed-width 160-char row. */
function TabBar({ active, onSelect, screens }) {
  // active screen always represented as session 'work-20260424' with its mode label
  // Other "tabs" are sessions in dim (decorative) plus a `+ new` cap.
  const dotColor = {
    idle: '#7FB069', streaming: '#E8B339', tool: '#5B9BD5',
    approval: '#C1443E', memory: '#8E7AB5', palette: '#7FB069',
  }[active];
  const activeLabel = screens.find(s => s.id === active).label;
  const activeText = ` work-20260424 · ${activeLabel} `; // visual label

  // Session tabs (decorative — switch via top-of-page nav)
  const ghostTabs = [
    'readyx-20260423',
    'sumocode-20260420',
  ];

  return (
    <div className="row">
      {/* Active tab in double-line */}
      <span style={{ color: '#D97706' }}>║</span>
      <span style={{ color: dotColor }}>●</span>
      <span style={{ color: '#F5E6C8' }}>{activeText}</span>
      <span style={{ color: '#D97706' }}>║</span>

      {/* Decorative dim tabs */}
      {ghostTabs.map((t, i) => (
        <React.Fragment key={t}>
          <span style={{ color: '#8B7A63' }}>{'   │ '}</span>
          <span style={{ color: '#8B7A63' }}>{t}</span>
        </React.Fragment>
      ))}
      <span style={{ color: '#8B7A63' }}>{'   │ + new'}</span>

      {/* Pad to full 160 cols using a measurable filler */}
      <span style={{ color: '#8B7A63' }}>{(() => {
        const used =
          1 + 1 + activeText.length + 1
          + ghostTabs.reduce((acc, t) => acc + 5 + t.length, 0)
          + 8; // "   │ + new"
        return ' '.repeat(Math.max(0, COLS - used));
      })()}</span>
    </div>
  );
}

/* ── SPLIT PANE (rows 2-43) ───────────────────────────────────────────────
   Each row is a 160-char string composed of:
     [LEFT 110 chars] [GUTTER 1 char] [SIDEBAR 49 chars]
   Children pass per-row arrays; we zip them together.
*/
function SplitPane({ leftRows, sidebarRows }) {
  // Normalize to 42 rows
  const ROWS = 42;
  const left = [...leftRows];
  const right = [...sidebarRows];
  while (left.length < ROWS) left.push(null);
  while (right.length < ROWS) right.push(null);

  return (
    <>
      {Array.from({ length: ROWS }).map((_, i) => (
        <div className="row" key={i}>
          <span style={{ display: 'inline-block', width: `${LEFT_W}ch` }}>
            {left[i] ?? <span>{' '.repeat(LEFT_W)}</span>}
          </span>
          <span>{' '}</span>
          <span style={{ display: 'inline-block', width: `${RIGHT_W}ch` }}>
            {right[i] ?? <span>{' '.repeat(RIGHT_W)}</span>}
          </span>
        </div>
      ))}
    </>
  );
}

/* ── SEPARATOR (row 44) ─── full-width ─ in divider color. */
function Separator() {
  return <div className="row" style={{ color: '#3A2F25' }}>{'─'.repeat(COLS)}</div>;
}

/* ── FOOTER (row 45) ───────────────────────────────────────────────────── */
const STATE_META = {
  idle:      { color: '#7FB069', label: 'ready' },
  streaming: { color: '#E8B339', label: 'thinking' },
  tool:      { color: '#5B9BD5', label: 'working' },
  approval:  { color: '#C1443E', label: 'needs you' },
  memory:    { color: '#8E7AB5', label: 'learning' },
  palette:   { color: '#7FB069', label: 'ready' },
};

function Footer({ state }) {
  const meta = STATE_META[state];
  // Render as one row, padded to 160 cols.
  // Layout: ~/argent-x (main) · ↑12k ↓8k · $0.42 · 42%/200k · ● <label> · claude-opus-4-7
  const path     = '~/argent-x (main)';
  const tokens   = '↑12k ↓8k';
  const cost     = '$0.42';
  const ctx      = '42%/200k';
  const model    = 'claude-opus-4-7';

  // Compose with separators in --divider color, accent items in --foreground
  const sep = <span style={{ color: '#3A2F25' }}>{' · '}</span>;

  // Compute character length for padding (keep in sync with rendered text)
  const visible =
    path.length + 3 +
    tokens.length + 3 +
    cost.length + 3 +
    ctx.length + 3 +
    1 + 1 + meta.label.length + 3 +     // ● + space + label
    model.length;

  return (
    <div className="row">
      <span style={{ color: '#F5E6C8' }}>{path}</span>{sep}
      <span style={{ color: '#8B7A63' }}>{tokens}</span>{sep}
      <span style={{ color: '#8B7A63' }}>{cost}</span>{sep}
      <span style={{ color: '#8B7A63' }}>{ctx}</span>{sep}
      <span style={{ color: meta.color }}>●</span>
      <span style={{ color: '#F5E6C8' }}>{' ' + meta.label}</span>{sep}
      <span style={{ color: '#8B7A63' }}>{model}</span>
      <span>{' '.repeat(Math.max(0, COLS - visible))}</span>
    </div>
  );
}

/* ── TERMINAL SHELL ─────────────────────────────────────────────────────── */
function Terminal({ active, onSelect, screens, leftRows, sidebarRows, modal, dimUnder }) {
  const dim = !!modal && dimUnder;
  return (
    <div className="term">
      {/* sidebar mahogany backsplash */}
      <div className="sidebar-bg" />
      <div className={'layer' + (dim ? ' dimmed' : '')}>
        <TabBar active={active} onSelect={onSelect} screens={screens} />
        <SplitPane leftRows={leftRows} sidebarRows={sidebarRows} />
        <Separator />
        <Footer state={active} />
      </div>
      {modal && (
        <div className="modal-layer">
          <div className="modal">{modal}</div>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Terminal, padR, padL, center, COLS, LEFT_W, RIGHT_W, STATE_META });
