import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, localReport } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';

const input = await readJson(new URL('../examples/plan.json', import.meta.url),16384);
for (const [name,choices] of [['Parallel preparation',['m15','m30','m15','m10']], ['Unknown duration',['m15','unknown','m15','m10']]]) {
  const directory = await mkdtemp(join(tmpdir(),'pingroom-critical-path-demo-'));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
  const options = { client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now };
  try {
    for (const [index,choice] of choices.entries()) { const pending = await step(options); assert.equal(pending.plan,null); api.answer(id(index+1),choice); await step(options); }
    const result = await localReport(directory,input,{save:true});
    console.log(JSON.stringify({ demo:name,transport:'real SDK with local mock; no network',status:result.status,unknownTaskIds:result.unknownTaskIds,plan:result.plan },null,2));
    const calls=api.calls.length; await step(options); assert.equal(api.calls.length,calls);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
