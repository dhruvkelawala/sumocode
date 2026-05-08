/* Sidebar.jsx — Cathedral right pane.
   Sections: CONTEXT · MCP · MEMORY. Each row is exactly 49 cells wide.
   The padR helper guarantees fixed-width strings.
*/

const SIDEBAR_W = 49;

/* Banner: ════════ TITLE ════════  in burnt orange */
function bannerRow(title) {
  // Total width 49. Banner format: "  ════════ TITLE ════════"
  // Choose: 2 leading spaces, then ═ pads either side of " TITLE ".
  const inner = ` ${title} `;
  const flank = Math.max(2, Math.floor((SIDEBAR_W - inner.length - 2) / 2));
  const left = '═'.repeat(flank);
  const right = '═'.repeat(Math.max(0, SIDEBAR_W - 2 - left.length - inner.length));
  // Render with leading 2 spaces in default fg, the rest accent
  return (
    <span>
      <span>{'  '}</span>
      <span style={{ color: '#D97706', letterSpacing: '0.12em' }}>{left + inner + right}</span>
    </span>
  );
}

/* Build the static sidebar rows once. */
function buildSidebarRows() {
  const rows = [];
  const blank = () => <span>{' '.repeat(SIDEBAR_W)}</span>;
  // Helper to make a fixed-width row from content + character length used.
  const fix = (content, used) => (
    <span>
      <span>{'  '}</span>{content}<span>{' '.repeat(Math.max(0, SIDEBAR_W - 2 - used))}</span>
    </span>
  );

  // 0: blank
  rows.push(blank());
  // 1: CONTEXT banner
  rows.push(bannerRow('CONTEXT'));
  // 2: blank
  rows.push(blank());
  // 3: main-app (main)
  rows.push(fix(<span style={{ color: '#F5E6C8' }}>{'main-app (main)'}</span>, 'main-app (main)'.length));
  // 4: progress bar  [████████░░░░] 42k/200k
  rows.push(fix(
    <span>
      <span style={{ color: '#3A2F25' }}>[</span>
      <span style={{ color: '#F5E6C8' }}>{'██████'}</span>
      <span style={{ color: '#6F5D46' }}>{'░░░░░░░░░░░░░░░░░░'}</span>
      <span style={{ color: '#3A2F25' }}>]</span>
      <span style={{ color: '#8B7A63' }}>{' 42k/200k'}</span>
    </span>,
    1 + 6 + 18 + 1 + 9
  ));
  // 5: $0.42 spent
  rows.push(fix(<span style={{ color: '#8B7A63' }}>{'$0.42 spent · session'}</span>, 'X'.repeat(21).length));
  // 6: blank
  rows.push(blank());
  // 7: MCP banner
  rows.push(bannerRow('MCP'));
  // 8: blank
  rows.push(blank());

  // MCP rows — name padded to width 14, status right-aligned
  const mcpRow = (color, name, status, statusColor) => {
    const np = name.padEnd(16, ' ');
    const sp = status;
    const totalLen = 1 + 1 + np.length + sp.length;
    return fix(
      <span>
        <span style={{ color }}>●</span>
        <span>{' '}</span>
        <span style={{ color: '#F5E6C8' }}>{np}</span>
        <span style={{ color: statusColor }}>{sp}</span>
      </span>,
      totalLen
    );
  };
  rows.push(mcpRow('#7FB069', 'stitch',   'ok',   '#8B7A63'));
  rows.push(mcpRow('#7FB069', 'context7', 'ok',   '#8B7A63'));
  rows.push(mcpRow('#7FB069', 'github',   'ok',   '#8B7A63'));
  rows.push(mcpRow('#8B7A63', 'railway',  'idle', '#8B7A63'));
  rows.push(mcpRow('#C1443E', 'figma',    'down', '#C1443E'));
  // blank
  rows.push(blank());
  // MEMORY banner
  rows.push(bannerRow('MEMORY'));
  rows.push(blank());

  const fact = (text) => {
    const t = text.length > 41 ? text.slice(0, 41) : text;
    return fix(
      <span>
        <span style={{ color: '#D97706' }}>❧</span>
        <span>{' '}</span>
        <span style={{ color: '#F5E6C8' }}>{t}</span>
      </span>,
      1 + 1 + t.length
    );
  };
  rows.push(fact('prefers TypeScript strict'));
  rows.push(fact('pnpm, not npm'));
  rows.push(fact('based in London · BST'));
  rows.push(fact('BigCo · main-app'));
  rows.push(fact('imperative commits'));
  rows.push(fact('readyx · React Native'));
  rows.push(fact('Bun where possible'));
  rows.push(blank());
  rows.push(fix(<span style={{ color: '#8B7A63' }}>{'48 more · ⌘M'}</span>, '48 more · ⌘M'.length));

  return rows;
}

const SIDEBAR_ROWS = buildSidebarRows();

window.SIDEBAR_ROWS = SIDEBAR_ROWS;
window.SIDEBAR_W = SIDEBAR_W;
