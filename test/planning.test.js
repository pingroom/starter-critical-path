import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, tasksFor, calculatePlan, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/plan.json', import.meta.url), 16384);
const simple = () => ({ ...structuredClone(example), tasks: [structuredClone(example.tasks[0])] });
const twoTasks = () => ({ ...structuredClone(example), tasks: structuredClone(example.tasks.slice(0, 2)) });
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-critical-path-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.estimates.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later tasks; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoTasks()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'm15'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a task estimate', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'm15'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'm15'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.plan, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across tasks', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoTasks()); await s.run(); s.api.answer(id(1), 'm15'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).plan, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'm15');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'm15'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'm15'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'm15');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'm15'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).plan, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


const graph = (rows) => ({ planId: 'graph', title: 'Dependency fixture', tasks: rows.map(([id, dependsOn = [], minutes = [15, 30, 60]]) => ({ id, label: id, details: `Task ${id}`, dependsOn, minutes })) });
const durations = (input, values) => input.tasks.map((task, i) => ({ taskId: task.id, minutes: values[i] }));
const byTask = (plan, id) => plan.tasks.find((task) => task.taskId === id);

test('parallel branches and join use maximum predecessor finish, with backward-pass slack', () => {
  const input = graph([['a'], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]);
  const plan = calculatePlan(input, durations(input, [15, 30, 60, 15]));
  assert.equal(plan.projectDurationMinutes, 90);
  assert.deepEqual(plan.tasks.map((task) => [task.taskId, task.earliestStartMinutes, task.earliestFinishMinutes, task.latestStartMinutes, task.latestFinishMinutes, task.totalSlackMinutes]), [
    ['a', 0, 15, 0, 15, 0], ['b', 15, 45, 45, 75, 30], ['c', 15, 75, 15, 75, 0], ['d', 75, 90, 75, 90, 0],
  ]);
  assert.deepEqual(plan.criticalPaths, [{ taskIds: ['a', 'c', 'd'], durationMinutes: 90 }]);
  assert.deepEqual(plan.criticalEdges, [{ from: 'a', to: 'c' }, { from: 'c', to: 'd' }]);
});

test('all equal critical paths are reported; choosing one does not erase another bottleneck', () => {
  const input = graph([['a'], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]);
  const plan = calculatePlan(input, durations(input, [15, 30, 30, 15]));
  assert.equal(plan.projectDurationMinutes, 60); assert.ok(plan.tasks.every((task) => task.critical));
  assert.deepEqual(plan.criticalPaths, [{ taskIds: ['a', 'b', 'd'], durationMinutes: 60 }, { taskIds: ['a', 'c', 'd'], durationMinutes: 60 }]);
});

test('disconnected tasks start at zero and receive slack against the common project finish', () => {
  const input = graph([['a'], ['b', ['a']], ['c'], ['d']]);
  const plan = calculatePlan(input, durations(input, [15, 15, 15, 30]));
  assert.equal(plan.projectDurationMinutes, 30);
  assert.equal(byTask(plan, 'c').earliestStartMinutes, 0); assert.equal(byTask(plan, 'c').totalSlackMinutes, 15);
  assert.deepEqual(plan.criticalPaths, [{ taskIds: ['a', 'b'], durationMinutes: 30 }, { taskIds: ['d'], durationMinutes: 30 }]);
});

test('single task, transitive dependencies and input reordering preserve correct continuous relative time', () => {
  const one = graph([['a']]); assert.deepEqual(calculatePlan(one, durations(one, [15])).criticalPaths, [{ taskIds: ['a'], durationMinutes: 15 }]);
  const input = graph([['c', ['a', 'b']], ['b', ['a']], ['a']]);
  const before = structuredClone(input), estimates = durations(input, [15, 30, 15]);
  const result = calculatePlan(input, estimates); assert.equal(result.projectDurationMinutes, 60);
  assert.deepEqual(result.criticalPaths, [{ taskIds: ['a', 'b', 'c'], durationMinutes: 60 }]);
  const reordered = structuredClone(input); reordered.tasks.reverse(); reordered.tasks.at(-1).dependsOn.reverse();
  assert.deepEqual(calculatePlan(reordered, [...estimates].reverse()), result); assert.deepEqual(input, before);
});

test('CPM matches independent path enumeration across all four-task forward DAGs and duration combinations', () => {
  const ids = ['a', 'b', 'c', 'd'], edges = [[0,1], [0,2], [0,3], [1,2], [1,3], [2,3]];
  for (let mask = 0; mask < 64; mask++) for (let choice = 0; choice < 16; choice++) {
    const input = graph(ids.map((id, index) => [id, edges.filter(([a,b], bit) => b === index && (mask & (1 << bit))).map(([a]) => ids[a]), [1,2]]));
    const values = ids.map((_, index) => ((choice >> index) & 1) + 1), paths = [];
    const visit = (index, path, length) => {
      const next = input.tasks.map((task, i) => task.dependsOn.includes(ids[index]) ? i : -1).filter(i => i >= 0);
      const current = [...path, ids[index]], sum = length + values[index];
      if (!next.length) paths.push({ taskIds: current, durationMinutes: sum });
      for (const i of next) visit(i, current, sum);
    };
    input.tasks.forEach((task, i) => { if (!task.dependsOn.length) visit(i, [], 0); });
    const longest = Math.max(...paths.map(path => path.durationMinutes));
    const expectedPaths = paths.filter(path => path.durationMinutes === longest).sort((a,b) => a.taskIds.join(',').localeCompare(b.taskIds.join(',')));
    const result = calculatePlan(input, durations(input, values));
    assert.equal(result.projectDurationMinutes, longest);
    assert.deepEqual([...result.criticalPaths].sort((a,b) => a.taskIds.join(',').localeCompare(b.taskIds.join(','))), expectedPaths);
    assert.ok(result.tasks.every(task => task.totalSlackMinutes >= 0));
  }
});

test('cycle, unknown/self/duplicate dependencies and invalid task schemas fail before any API call', async t => {
  for (const mutate of [
    p => { p.tasks[0].dependsOn = ['b']; p.tasks[1].dependsOn = ['a']; }, p => { p.tasks[1].dependsOn = ['missing']; },
    p => { p.tasks[0].dependsOn = ['a']; }, p => { p.tasks[1].dependsOn = ['a', 'a']; }, p => { p.tasks[1].id = 'a'; },
    p => { p.tasks[0].id = 1; }, p => { p.tasks[0].id = 'constructor'; }, p => { p.tasks[0].minutes = [0, 15]; },
    p => { p.tasks[0].minutes = [15, 481]; }, p => { p.tasks[0].minutes = [15, 15]; }, p => { p.tasks[0].minutes = [30, 15]; },
    p => { p.tasks[0].minutes = [1.5, 15]; }, p => { p.tasks[0].minutes = ['15', 30]; }, p => { p.tasks[0].minutes = [15]; },
    p => { p.tasks[0].minutes = [1,2,3,4]; }, p => { p.tasks[0].details = 'line\nbreak'; }, p => { p.tasks[0].details = 'x'.repeat(101); },
    p => { p.tasks = []; }, p => { p.tasks = Array(13).fill(p.tasks[0]); }, p => { p.script = 'anything'; },
  ]) {
    const input = graph([['a'], ['b', ['a']]]); mutate(input); assert.throws(() => validateInput(input));
    const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
});

test('numeric planning refuses missing, duplicate, fabricated or Unknown estimates', () => {
  const input = graph([['a'], ['b']]);
  for (const evidence of [[], [{ taskId:'a', minutes:15 }], [{taskId:'a',minutes:15},{taskId:'a',minutes:30}],
    [{taskId:'a',minutes:15},{taskId:'missing',minutes:30}], [{taskId:'a',minutes:15},{taskId:'b',minutes:16}],
    [{taskId:'a',minutes:15},{taskId:'b',minutes:null}], [{taskId:'a',minutes:15},{taskId:'b',minutes:'30'}]]) assert.throws(() => calculatePlan(input, evidence));
});

test('Questions produce attributed numeric estimates and a complete plan; replay makes no requests', async t => {
  const s = await setup(t, structuredClone(example)), before = structuredClone(s.options.input);
  const result = await decide(s, ['m15', 'm30', 'm15', 'm10']);
  assert.equal(result.status, 'complete'); assert.equal(result.plan.projectDurationMinutes, 55);
  assert.deepEqual(result.plan.criticalPaths, [{ taskIds: ['draft', 'illustrate', 'package'], durationMinutes: 55 }]);
  assert.equal(result.estimates[0].responderId, CONFIG.participant.id); assert.equal(result.estimates[0].askerId, ASKER);
  assert.deepEqual(s.options.input, before); assert.deepEqual(result.unknownTaskIds, []);
  const calls = s.api.calls.length; assert.deepEqual((await s.run()).plan, result.plan); assert.equal(s.api.calls.length, calls);
});

test('Unknown is an explicit answer, never a zero duration; later estimates can be collected but plan stays null', async t => {
  const s = await setup(t, twoTasks());
  await decide(s, ['unknown']); let result = await localReport(s.directory, s.options.input);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.unknownTaskIds, ['draft']); assert.deepEqual(result.unansweredTasks, [{ taskId: 'illustrate', status: 'unasked' }]);
  assert.equal(result.estimates[0].status, 'answered'); assert.equal(result.estimates[0].minutes, null); assert.equal(result.plan, null);
  result = await decide(s, ['m15']); assert.equal(result.status, 'incomplete'); assert.equal(result.plan, null); assert.deepEqual(result.unansweredTasks, []);
  await s.run(); assert.equal(sends(s.api), 2);
});

test('pending, expired and cancelled task estimates block a complete plan and never become Unknown', async t => {
  for (const terminal of ['expired', 'cancelled']) {
    const s = await setup(t, twoTasks()); await decide(s, ['m15']); await s.run();
    assert.equal((await localReport(s.directory, s.options.input)).plan, null);
    if (terminal === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z';
    s.api.terminal(id(2), terminal); const result = await s.run();
    assert.equal(result.status, 'incomplete'); assert.equal(result.plan, null); assert.deepEqual(result.unknownTaskIds, []);
    assert.deepEqual(result.unansweredTasks, [{ taskId: 'illustrate', status: terminal }]); await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('changed dependencies, choices, descriptions, session, participant or credential cannot reuse estimates', async t => {
  const s = await setup(t, twoTasks()); await s.run();
  for (const mutate of [input => { input.planId = 'other'; }, input => { input.tasks[1].dependsOn = []; },
    input => { input.tasks[0].details = 'A different task'; }, input => { input.tasks[0].minutes = [15, 60]; }, input => { input.tasks.reverse(); }]) {
    const input = structuredClone(s.options.input); mutate(input); await assert.rejects(s.run({ input }), /changed task graph/);
  }
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'other' }), /another connection/); assert.equal(sends(s.api), 1);
});

test('twelve maximum-sized tasks fit prompt, state, report and longest duration bounds', async t => {
  const ids = Array.from({length:12},(_,i) => `t${String(i).padStart(2,'0')}${'x'.repeat(21)}`);
  const input = { planId:'p'.repeat(40), title:'t'.repeat(60), tasks: ids.map((id,i) => ({ id, label:'l'.repeat(40), details:'d'.repeat(100), dependsOn:ids.slice(0,i), minutes:[1,240,480] })) };
  const s = await setup(t,input), result = await decide(s, Array(12).fill('m480'));
  assert.equal(result.status,'complete'); assert.equal(result.plan.projectDurationMinutes,5760); assert.equal(result.plan.criticalPaths.length,1);
  assert.equal(result.plan.criticalPaths[0].taskIds.length,12); assert.equal(sends(s.api),12);
  for (const q of s.api.questions.values()) assert.ok(q.prompt.length <= 500);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(),null,2))+4096 < 1024*1024);
  await localReport(s.directory,input,{save:true}); assert.ok((await stat(join(s.directory,'report.json'))).size < 1024*1024);
});

test('a twelve-task layered graph retains all 81 critical paths within the report budget', () => {
  const rows = [];
  for (let layer=0;layer<4;layer++) for (let item=0;item<3;item++) rows.push([`l${layer}t${item}`, layer ? Array.from({length:3},(_,i)=>`l${layer-1}t${i}`) : []]);
  const input = graph(rows), result = calculatePlan(input,durations(input,Array(12).fill(15)));
  assert.equal(result.projectDurationMinutes,60); assert.equal(result.criticalPaths.length,81);
  assert.ok(result.tasks.every(task=>task.critical)); assert.ok(Buffer.byteLength(JSON.stringify(result,null,2))<1024*1024);
});
