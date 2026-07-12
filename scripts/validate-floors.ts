import { FLOORS } from '../src/world/specs';
import { validateSpec, parseRows } from '../src/world/grid';

let failed = false;
for (const spec of FLOORS) {
  const errors = validateSpec(spec);
  const rows = parseRows(spec.map);
  console.log(`floor ${spec.floor} (${spec.name}): ${rows[0].length}x${rows.length}, ${Object.keys(spec.anchors).length} anchors, pool ${spec.pool.length}, quota ${spec.quota}`);
  for (const e of errors) {
    console.log(`  ERROR: ${e}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
