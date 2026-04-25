/* Modals.jsx — three overlay modals: approval, memory editor, command palette.
   Each renders as a self-contained block of fixed-width <pre>-style rows
   over a `surface-lifted` background. The shell handles centering + dimming.
*/

/* ───────────── APPROVAL ───────────── */
function ApprovalModal() {
  const W = 70;            // inner width between ║ … ║
  const RED = '#C1443E';
  const ORANGE = '#D97706';
  const FG = '#F5E6C8';
  const DIM = '#8B7A63';
  const LIFT = '#3A342F';

  const top = '╔' + '═'.repeat(W) + '╗';
  const mid = '╠' + '═'.repeat(W) + '╣';
  const bot = '╚' + '═'.repeat(W) + '╝';

  const Row = ({ children, len }) => (
    <div>
      <span style={{ color: RED }}>║</span>
      {children}
      <span>{' '.repeat(Math.max(0, W - len))}</span>
      <span style={{ color: RED }}>║</span>
    </div>
  );
  const Blank = () => <Row len={0}>{null}</Row>;

  // Title row centered
  const titleText = '◆  APPROVAL REQUIRED';
  const titleLeft = Math.floor((W - titleText.length) / 2);
  const titleRight = W - titleText.length - titleLeft;

  return (
    <div style={{ background: LIFT, padding: '0', whiteSpace: 'pre', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.4 }}>
      <div style={{ color: RED }}>{top}</div>
      <Row len={W}>
        <span>{' '.repeat(titleLeft)}</span>
        <span style={{ color: RED, letterSpacing: '0.2em' }}>{titleText}</span>
        <span>{' '.repeat(titleRight)}</span>
      </Row>
      <div style={{ color: RED }}>{mid}</div>
      <Blank />
      <Row len={'  You are about to execute:'.length}>
        <span style={{ color: FG }}>{'  You are about to execute:'}</span>
      </Row>
      <Blank />
      <Row len={'      rm -rf node_modules/'.length}>
        <span>{'      '}</span>
        <span style={{ color: ORANGE }}>{'rm -rf node_modules/'}</span>
      </Row>
      <Blank />
      <Row len={'  This will remove 234MB of installed packages — irreversible.'.length}>
        <span style={{ color: DIM }}>{'  This will remove 234MB of installed packages — irreversible.'}</span>
      </Row>
      <Row len={'  After: pnpm install will need to re-fetch ~6,400 deps (~3 min).'.length}>
        <span style={{ color: DIM }}>{'  After: pnpm install will need to re-fetch ~6,400 deps (~3 min).'}</span>
      </Row>
      <Blank />
      <Blank />
      <Row len={'  Proceed?      [Y]es           [N]o           [A]lways'.length}>
        <span style={{ color: FG }}>{'  Proceed?      '}</span>
        <span style={{ color: ORANGE }}>{'[Y]es'}</span>
        <span>{'           '}</span>
        <span style={{ color: FG }}>{'[N]o'}</span>
        <span>{'           '}</span>
        <span style={{ color: DIM }}>{'[A]lways'}</span>
      </Row>
      <Blank />
      <div style={{ color: RED }}>{bot}</div>
    </div>
  );
}

/* ───────────── MEMORY EDITOR ───────────── */
function MemoryEditor() {
  const W = 92;
  const PURPLE = '#8E7AB5';
  const ORANGE = '#D97706';
  const FG = '#F5E6C8';
  const DIM = '#8B7A63';
  const LIFT = '#3A342F';

  const top = '╔' + '═'.repeat(W) + '╗';
  const bot = '╚' + '═'.repeat(W) + '╝';

  const Row = ({ children, len }) => (
    <div>
      <span style={{ color: PURPLE }}>║</span>
      {children}
      <span>{' '.repeat(Math.max(0, W - len))}</span>
      <span style={{ color: PURPLE }}>║</span>
    </div>
  );
  const Blank = () => <Row len={0}>{null}</Row>;

  // Header row: title left, "● learning" pinned right
  const titleStr = '  MEMORY · 55 facts';
  const stateStr = '● learning  ';
  const headerPad = W - titleStr.length - stateStr.length;
  const headerRow = (
    <Row len={W}>
      <span style={{ color: ORANGE, letterSpacing: '0.18em' }}>{titleStr}</span>
      <span>{' '.repeat(headerPad)}</span>
      <span style={{ color: PURPLE }}>{stateStr}</span>
    </Row>
  );

  const sectionRow = (title) => {
    const inner = ` ${title} `;
    const pad = '════════';
    const text = `   ${pad}${inner}${pad}`;
    return (
      <Row len={text.length}>
        <span style={{ color: ORANGE, letterSpacing: '0.12em' }}>{text}</span>
      </Row>
    );
  };

  const factRow = (text) => {
    const body = `   ❧ ${text}`;
    return (
      <Row len={body.length}>
        <span>{'   '}</span>
        <span style={{ color: PURPLE }}>{'❧'}</span>
        <span>{' '}</span>
        <span style={{ color: FG }}>{text}</span>
      </Row>
    );
  };

  // Bottom hint bar — divider line then keys
  const dividerStr = ' ' + '─'.repeat(W - 2);
  const hints = [
    { k: '⌘S', v: 'save' },
    { k: '⌘N', v: 'new fact' },
    { k: '⌘D', v: 'delete' },
    { k: '⌘F', v: 'find' },
    { k: '⌘W', v: 'close' },
  ];

  const hintsLen = ' '.length + hints.reduce((a, h) => a + h.k.length + 1 + h.v.length + 4, 0);

  return (
    <div style={{ background: LIFT, padding: 0, whiteSpace: 'pre', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.4 }}>
      <div style={{ color: PURPLE }}>{top}</div>
      {headerRow}
      <Blank />
      {sectionRow('IDENTITY')}
      <Blank />
      {factRow('You are Dhruv Kelawala — senior engineer at Argent.')}
      {factRow('Based in London · BST timezone.')}
      <Blank />
      {sectionRow('PREFERENCES')}
      <Blank />
      {factRow('TypeScript strict — no any, no implicit returns.')}
      {factRow('pnpm, never npm. Bun where it works.')}
      {factRow('Prettier: single quotes, no semicolons, 100 cols.')}
      {factRow('Imperative commit subjects, no scope prefix.')}
      <Blank />
      {sectionRow('STACK')}
      <Blank />
      {factRow('React + Vite + Tailwind v4 (web).')}
      {factRow('React Native + Expo (mobile).')}
      {factRow('Starknet · Cairo · zk-proof tooling.')}
      <Blank />
      {sectionRow('PROJECTS')}
      <Blank />
      {factRow('argent-x — Starknet privacy wallet extension (main work).')}
      {factRow('readyx — React Native consumer app, pre-launch.')}
      {factRow('sumocode — personal Pi extension, terminal AI.')}
      <Blank />
      <Row len={dividerStr.length}>
        <span style={{ color: '#3A2F25' }}>{dividerStr}</span>
      </Row>
      <Row len={hintsLen}>
        <span>{' '}</span>
        {hints.map((h, i) => (
          <React.Fragment key={i}>
            <span style={{ color: ORANGE }}>{h.k}</span>
            <span>{' '}</span>
            <span style={{ color: DIM }}>{h.v}</span>
            <span>{'    '}</span>
          </React.Fragment>
        ))}
      </Row>
      <div style={{ color: PURPLE }}>{bot}</div>
    </div>
  );
}

/* ───────────── COMMAND PALETTE ───────────── */
function CommandPalette() {
  const W = 72;
  const ORANGE = '#D97706';
  const FG = '#F5E6C8';
  const DIM = '#8B7A63';
  const LIFT = '#3A342F';
  const DIV = '#3A2F25';
  const WALNUT = '#1A1511';

  const top = '╔' + '═'.repeat(W) + '╗';
  const mid = '╠' + '═'.repeat(W) + '╣';
  const bot = '╚' + '═'.repeat(W) + '╝';

  const Row = ({ children, len, frame = ORANGE }) => (
    <div>
      <span style={{ color: frame }}>║</span>
      {children}
      <span>{' '.repeat(Math.max(0, W - len))}</span>
      <span style={{ color: frame }}>{'║'}</span>
    </div>
  );
  const Blank = () => <Row len={0}>{null}</Row>;

  const titleStr = 'COMMAND PALETTE';
  const tLeft = Math.floor((W - titleStr.length) / 2);
  const tRight = W - titleStr.length - tLeft;

  const rows = [
    { k: 'session',  v: 'work-20260424',     hint: 'switch · new · archive' },
    { k: 'model',    v: 'claude-opus-4-7',   hint: 'switch model',           star: true },
    { k: 'thinking', v: 'medium',            hint: 'low · medium · high · ultra' },
    { k: 'memory',   v: '55 facts',          hint: 'view · edit · prune' },
    { k: 'mcp',      v: '4 connected · 1 down', hint: 'manage servers' },
    { k: 'export',   v: 'session as markdown', hint: 'copy · save · share' },
  ];

  // Highlighted row index — the user's current model
  const SEL = 1;

  // search input box (single-line) inside palette
  const innerW = W - 6;        // 3 spaces padding each side
  const searchTop = '┌' + '─'.repeat(innerW) + '┐';
  const searchBot = '└' + '─'.repeat(innerW) + '┘';
  const searchPlaceholder = ' enter command or search…';

  return (
    <div style={{ background: LIFT, padding: 0, whiteSpace: 'pre', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.4 }}>
      <div style={{ color: ORANGE }}>{top}</div>
      <Row len={W}>
        <span>{' '.repeat(tLeft)}</span>
        <span style={{ color: ORANGE, letterSpacing: '0.2em' }}>{titleStr}</span>
        <span>{' '.repeat(tRight)}</span>
      </Row>
      <div style={{ color: ORANGE }}>{mid}</div>
      <Blank />
      <Row len={3 + searchTop.length}>
        <span>{'   '}</span>
        <span style={{ color: DIM }}>{searchTop}</span>
      </Row>
      <Row len={3 + 1 + searchPlaceholder.length + 1 + (innerW - searchPlaceholder.length - 3) + 1}>
        <span>{'   '}</span>
        <span style={{ color: DIM }}>{'│'}</span>
        <span style={{ color: ORANGE }}>{' ❧'}</span>
        <span style={{ color: DIM }}>{searchPlaceholder.replace(/^ /,'')}</span>
        <span style={{ color: ORANGE }}>{' █'}</span>
        <span>{' '.repeat(Math.max(0, innerW - 2 - searchPlaceholder.length - 2))}</span>
        <span style={{ color: DIM }}>{'│'}</span>
      </Row>
      <Row len={3 + searchBot.length}>
        <span>{'   '}</span>
        <span style={{ color: DIM }}>{searchBot}</span>
      </Row>
      <Blank />

      {rows.map((r, i) => {
        const selected = i === SEL;
        const text = `   §  ${r.k.padEnd(10, ' ')}►  current: ${r.v}${r.star ? '   ★' : ''}`;
        const hintStr = `   ${r.hint}`;
        const total = text.length + hintStr.length;
        return (
          <Row key={r.k} len={W}>
            <span style={{
              background: selected ? ORANGE : 'transparent',
              color: selected ? WALNUT : FG,
              display: 'inline-block',
              width: `${W}ch`,
              whiteSpace: 'pre',
            }}>
              <span>{'   '}</span>
              <span style={{ color: selected ? WALNUT : DIM }}>{'§'}</span>
              <span>{'  '}</span>
              <span>{r.k.padEnd(10, ' ')}</span>
              <span style={{ color: selected ? WALNUT : DIM }}>{'►'}</span>
              <span>{'  current: '}</span>
              <span>{r.v}</span>
              {r.star ? <span style={{ color: selected ? WALNUT : ORANGE }}>{'   ★'}</span> : null}
              <span>{' '.repeat(Math.max(0, W - text.length - hintStr.length))}</span>
              <span style={{ color: selected ? WALNUT : DIM }}>{hintStr}</span>
            </span>
          </Row>
        );
      })}

      <Blank />
      <Row len={3 + (W - 6)}>
        <span>{'   '}</span>
        <span style={{ color: DIV }}>{'─'.repeat(W - 6)}</span>
      </Row>
      <Row len={'   ↑↓ navigate    ↵ select    esc close'.length}>
        <span>{'   '}</span>
        <span style={{ color: ORANGE }}>{'↑↓'}</span>
        <span style={{ color: DIM }}>{' navigate    '}</span>
        <span style={{ color: ORANGE }}>{'↵'}</span>
        <span style={{ color: DIM }}>{' select    '}</span>
        <span style={{ color: ORANGE }}>{'esc'}</span>
        <span style={{ color: DIM }}>{' close'}</span>
      </Row>
      <div style={{ color: ORANGE }}>{bot}</div>
    </div>
  );
}

Object.assign(window, { ApprovalModal, MemoryEditor, CommandPalette });
