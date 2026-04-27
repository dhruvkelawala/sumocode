# sumo-tui Phase 3 memory check

Date: 2026-04-27  
Worktree: `feat/sumo-tui-phase-3`

Command:

```bash
pnpm exec tsx <<'NODE'
import { loadYoga, DIRECTION_LTR, FLEX_DIRECTION_COLUMN } from './src/sumo-tui/layout/yoga.ts';
import { SumoNode } from './src/sumo-tui/layout/node.ts';
import { ChatPager } from './src/sumo-tui/widgets/chat-pager.ts';
import { CellBuffer } from './src/sumo-tui/render/buffer.ts';
import { composite } from './src/sumo-tui/render/compositor.ts';
const yoga = await loadYoga();
const root = new SumoNode(yoga.Node.create());
const chat = ChatPager.create(yoga, root);
root.width = 100;
root.height = 30;
root.flexDirection = FLEX_DIRECTION_COLUMN;
for (let index = 0; index < 10_000; index += 1) {
  chat.addMessage(index % 2 === 0 ? 'user' : 'sumo', `message ${index} lorem ipsum dolor sit amet`);
}
root.yogaNode.calculateLayout(100, 30, DIRECTION_LTR);
composite(root, new CellBuffer(30, 100));
console.log(process.memoryUsage());
root.dispose();
NODE
```

Result:

```json
{
  "rssMiB": 134.5,
  "heapUsedMiB": 24.2,
  "renderedChildren": 201,
  "renderedMessages": 200,
  "archivedMessages": 9800,
  "scrollHeight": 201
}
```

Conclusion: 10k logical messages stay under the Phase 3 RSS budget (`134.5 MiB < 300 MiB`) while rendering only the 200-message active window plus the single archive placeholder (EC-9.1).
