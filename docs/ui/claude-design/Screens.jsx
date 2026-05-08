/* Screens.jsx — left-pane rows for each of the 6 canonical states.
   Every helper returns a React node that renders as exactly LEFT_W (110) chars
   inside the SplitPane row.
*/

const L = 110; // left pane width

/* fixedRow: build a row that ends at exactly L characters by padding with spaces
   in the default colour. `content` is React; `used` is the number of visible chars. */
function fixedRow(content, used) {
  const pad = Math.max(0, L - used);
  return <span>{content}<span>{' '.repeat(pad)}</span></span>;
}
const blankRow = () => <span>{' '.repeat(L)}</span>;

/* ───────────── 1. IDLE ───────────── */
function buildIdleRows() {
  const rows = [];
  // Top breathing room — 4 blank rows
  for (let i = 0; i < 4; i++) rows.push(blankRow());

  // Quote (italic-ish via dim color; we don't change typeface)
  const quote = '"Perfection is achieved, not when there is nothing more to add,"';
  const quote2 = 'but when there is nothing left to take away.';
  const sig = '— Antoine de Saint-Exupéry';
  rows.push(fixedRow(<span><span>{'    '}</span><span style={{ color: '#8B7A63' }}>{quote}</span></span>, 4 + quote.length));
  rows.push(fixedRow(<span><span>{'    '}</span><span style={{ color: '#8B7A63' }}>{quote2}</span></span>, 4 + quote2.length));
  rows.push(blankRow());
  rows.push(fixedRow(<span><span>{'    '}</span><span style={{ color: '#6F5D46' }}>{sig}</span></span>, 4 + sig.length));

  // Vast empty middle
  while (rows.length < 36) rows.push(blankRow());

  // Framed input prompt — single-line border, 102 chars wide centered in 110
  const innerW = 102;
  const top = '┌' + '─'.repeat(innerW) + '┐';
  const bot = '└' + '─'.repeat(innerW) + '┘';
  // Inner: │ > █  + spaces to fill innerW + │
  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{top}</span>, top.length));
  rows.push(fixedRow(
    <span>
      <span style={{ color: '#3A2F25' }}>│</span>
      <span style={{ color: '#F5E6C8' }}>{' > '}</span>
      <span style={{ color: '#D97706' }}>█</span>
      <span>{' '.repeat(innerW - 4)}</span>
      <span style={{ color: '#3A2F25' }}>│</span>
    </span>,
    1 + 3 + 1 + (innerW - 4) + 1
  ));
  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{bot}</span>, bot.length));

  // Hints under input
  rows.push(blankRow());
  const hints = '   ⌘P  commands     ⌘M  memory     ⌘N  new session     ↵  send';
  rows.push(fixedRow(<span style={{ color: '#6F5D46' }}>{hints}</span>, hints.length));
  return rows;
}

/* ───────────── 2. STREAMING ───────────── */
function buildStreamingRows() {
  const rows = [];
  rows.push(blankRow());

  // User prompt echo
  const prompt = '> wire up react query for argent balance, with proper loading and error states';
  rows.push(fixedRow(<span><span style={{ color: '#F5E6C8' }}>{prompt}</span></span>, prompt.length));
  rows.push(blankRow());

  // Section banner —— APPROACH ——
  const banner = '── APPROACH ' + '─'.repeat(L - 12 - 4) + ' ──';
  rows.push(fixedRow(<span style={{ color: '#D97706', letterSpacing: '0.12em' }}>{banner}</span>, banner.length));
  rows.push(blankRow());

  // Prose
  const p1 = "I'll wire React Query into a custom useBigCoBalance hook that handles the loading";
  const p2 = "and error states cleanly. Cache for 30 seconds, refetch on window focus.";
  rows.push(fixedRow(<span style={{ color: '#F5E6C8' }}>{p1}</span>, p1.length));
  rows.push(fixedRow(<span style={{ color: '#F5E6C8' }}>{p2}</span>, p2.length));
  rows.push(blankRow());

  // Code block — double-line border, 100 chars wide
  const innerW = 100;
  const codeTop = '╔' + '═'.repeat(innerW) + '╗';
  const codeBot = '╚' + '═'.repeat(innerW) + '╝';
  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{codeTop}</span>, codeTop.length));

  // Build a code line: "║ NN  <syntax-highlighted code> <pad> ║"
  // We compute padding from the visible char count.
  const codeLine = (lineNo, segs) => {
    // segs is [{text, color}]; total visible chars is sum + " NN  "
    const numStr = String(lineNo).padStart(2, ' ');
    const prefix = ` ${numStr}  `; // 5 chars
    const codeLen = segs.reduce((acc, s) => acc + s.text.length, 0);
    const pad = Math.max(0, innerW - prefix.length - codeLen);
    const used = 1 + prefix.length + codeLen + pad + 1; // ║ + prefix + code + pad + ║
    return fixedRow(
      <span>
        <span style={{ color: '#3A2F25' }}>║</span>
        <span style={{ color: '#6F5D46' }}>{prefix}</span>
        {segs.map((s, i) => <span key={i} style={{ color: s.color }}>{s.text}</span>)}
        <span>{' '.repeat(pad)}</span>
        <span style={{ color: '#3A2F25' }}>║</span>
      </span>,
      used
    );
  };

  const KW = '#D97706', ST = '#7FB069', NM = '#E8B339', FG = '#F5E6C8', FN = '#E8B339', CM = '#6F5D46';
  rows.push(codeLine(1, [
    { text: 'function ', color: KW },
    { text: 'useBigCoBalance', color: FN },
    { text: '(account: ', color: FG },
    { text: 'string', color: KW },
    { text: ') {', color: FG },
  ]));
  rows.push(codeLine(2, [{ text: '  ', color: FG }, { text: 'return ', color: KW }, { text: 'useQuery({', color: FG }]));
  rows.push(codeLine(3, [
    { text: '    queryKey: [', color: FG },
    { text: "'balance'", color: ST },
    { text: ', account],', color: FG },
  ]));
  rows.push(codeLine(4, [
    { text: '    queryFn: () => ', color: FG },
    { text: 'fetchBalance', color: FN },
    { text: '(account),', color: FG },
  ]));
  rows.push(codeLine(5, [
    { text: '    staleTime: ', color: FG },
    { text: '30_000', color: NM },
    { text: ',  ', color: FG },
    { text: '// 30 seconds', color: CM },
  ]));
  rows.push(codeLine(6, [
    { text: '    refetchOnWindowFocus: ', color: FG },
    { text: 'true', color: KW },
    { text: ',', color: FG },
  ]));
  rows.push(codeLine(7, [{ text: '  });', color: FG }]));
  rows.push(codeLine(8, [{ text: '}', color: FG }]));

  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{codeBot}</span>, codeBot.length));
  rows.push(blankRow());

  // Trailing prose with mid-stream cursor
  const tail = "This caches for 30 seconds and re-fetches on focus. We can adjust staleTime";
  const tail2 = "based on network latency.";
  rows.push(fixedRow(<span><span style={{ color: '#F5E6C8' }}>{tail}</span></span>, tail.length));
  rows.push(fixedRow(
    <span>
      <span style={{ color: '#F5E6C8' }}>{tail2}</span>
      <span style={{ color: '#E8B339' }}>{' █'}</span>
    </span>,
    tail2.length + 2
  ));

  while (rows.length < 39) rows.push(blankRow());

  // ● thinking… indicator at bottom
  rows.push(fixedRow(
    <span>
      <span style={{ color: '#E8B339' }}>●</span>
      <span style={{ color: '#8B7A63' }}>{' thinking…   '}</span>
      <span style={{ color: '#6F5D46' }}>{'esc to interrupt'}</span>
    </span>,
    1 + 13 + 16
  ));
  return rows;
}

/* ───────────── 3. TOOL-RUNNING ───────────── */
function buildToolRows() {
  const rows = [];
  rows.push(blankRow());
  const echo = '> add blockTag and switch to argentClient.fetchBalance';
  rows.push(fixedRow(<span style={{ color: '#F5E6C8' }}>{echo}</span>, echo.length));
  rows.push(blankRow());

  // Tool pill: ━━━ [name]   target  ━━━ status
  const toolPill = (name, target, status, statusColor) => {
    const head = '━━━ ';
    const nameStr = `[${name}]`;
    const tgt = `   ${target}`;
    const tail = ' ';
    // total visible up to status
    const beforeStatus = head.length + nameStr.length + tgt.length;
    // status width is variable; pad to make line length 110
    const tailRailLen = Math.max(4, L - beforeStatus - 1 - status.length - 1 - 4);
    return fixedRow(
      <span>
        <span style={{ color: '#3A2F25' }}>{head}</span>
        <span style={{ color: '#D97706' }}>{nameStr}</span>
        <span style={{ color: '#F5E6C8' }}>{tgt}</span>
        <span style={{ color: '#3A2F25' }}>{' ' + '━'.repeat(tailRailLen) + ' '}</span>
        <span style={{ color: statusColor }}>{status}</span>
        <span style={{ color: '#3A2F25' }}>{' ━━━'}</span>
      </span>,
      head.length + nameStr.length + tgt.length + 1 + tailRailLen + 1 + status.length + 4
    );
  };

  rows.push(toolPill('read', 'src/main-app/balance.ts',          '✓', '#7FB069'));
  rows.push(toolPill('bash', 'pnpm test --filter @argent/sdk',   '▶ running', '#5B9BD5'));
  rows.push(toolPill('edit', 'src/main-app/balance.ts',          '✓', '#7FB069'));
  rows.push(blankRow());

  // DIFF box — single-line, with title in upper border: ┌── DIFF ─...─┐
  const innerW = 100;
  const titleSeg = '── DIFF ';
  const diffTop = '┌' + titleSeg + '─'.repeat(innerW - titleSeg.length) + '┐';
  const diffBot = '└' + '─'.repeat(innerW) + '┘';
  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{diffTop}</span>, diffTop.length));

  const diffLine = (sign, color, text) => {
    const body = `${sign} ${text}`;
    const pad = Math.max(0, innerW - body.length);
    const used = 1 + body.length + pad + 1;
    return fixedRow(
      <span>
        <span style={{ color: '#3A2F25' }}>│</span>
        <span style={{ color }}>{body}</span>
        <span>{' '.repeat(pad)}</span>
        <span style={{ color: '#3A2F25' }}>│</span>
      </span>,
      used
    );
  };
  rows.push(diffLine('-', '#D97706', 'const balance = await provider.getBalance(account);'));
  rows.push(diffLine('+', '#7FB069', 'const balance = await argentClient.fetchBalance(account, {'));
  rows.push(diffLine('+', '#7FB069', "  blockTag: 'latest',"));
  rows.push(diffLine('+', '#7FB069', '});'));
  rows.push(fixedRow(<span style={{ color: '#3A2F25' }}>{diffBot}</span>, diffBot.length));
  rows.push(blankRow());

  // Live test output — running
  const log1 = '   PASS  src/main-app/balance.test.ts  (4 tests, 318ms)';
  const log2 = '   PASS  src/main-app/account.test.ts  (12 tests, 612ms)';
  const log3 = '   RUNS  src/main-app/integration.test.ts';
  rows.push(fixedRow(<span style={{ color: '#7FB069' }}>{log1}</span>, log1.length));
  rows.push(fixedRow(<span style={{ color: '#7FB069' }}>{log2}</span>, log2.length));
  rows.push(fixedRow(<span style={{ color: '#5B9BD5' }}>{log3}</span>, log3.length));

  while (rows.length < 39) rows.push(blankRow());

  rows.push(fixedRow(
    <span>
      <span style={{ color: '#5B9BD5' }}>●</span>
      <span style={{ color: '#8B7A63' }}>{' working…   '}</span>
      <span style={{ color: '#6F5D46' }}>{'pnpm test (12.4s)   esc to cancel'}</span>
    </span>,
    1 + 12 + 33
  ));
  return rows;
}

/* ───────────── 4. APPROVAL — left-pane base same as tool ───────────── */
/* When the modal is open, the underlying screen dims to 50%.
   We reuse the tool-running rows underneath. */

/* ───────────── 5. MEMORY — base screen ───────────── */
/* Same dimming behaviour. We reuse idle's quote area as a calm backdrop. */

/* ───────────── 6. PALETTE — base screen ───────────── */

Object.assign(window, { buildIdleRows, buildStreamingRows, buildToolRows });
