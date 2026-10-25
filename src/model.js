import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


function orderedTasks(tasks) {
  const remaining = new Set(tasks.map((task) => task.id));
  const order = [];
  while (remaining.size) {
    const ready = tasks.filter((task) => remaining.has(task.id) && task.dependsOn.every((id) => !remaining.has(id))).sort((a, b) => compare(a.id, b.id));
    if (!ready.length) throw new Error('Task dependencies contain a cycle.');
    for (const task of ready) { order.push(task); remaining.delete(task.id); }
  }
  return order;
}

export function validateInput(input) {
  if (!keys(input, ['planId', 'title', 'tasks']) || !word(input.planId) || !line(input.title, 60)
    || !Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > 12) throw new Error('Provide a plan ID, title, and one to twelve tasks.');
  const ids = new Set();
  for (const task of input.tasks) {
    if (!keys(task, ['id', 'label', 'details', 'dependsOn', 'minutes']) || !word(task.id) || task.id.length > 24 || ids.has(task.id)
      || ['constructor', 'prototype', '__proto__'].includes(task.id) || !line(task.label, 40) || !line(task.details, 100)
      || !Array.isArray(task.dependsOn) || task.dependsOn.length > 11 || new Set(task.dependsOn).size !== task.dependsOn.length
      || !Array.isArray(task.minutes) || task.minutes.length < 2 || task.minutes.length > 3
      || task.minutes.some((value, i) => !Number.isInteger(value) || value < 1 || value > 480 || i > 0 && value <= task.minutes[i - 1])) throw new Error('Tasks need unique IDs, bounded text, distinct dependencies, and two or three increasing integer minute choices from 1 to 480.');
    ids.add(task.id);
  }
  for (const task of input.tasks) if (task.dependsOn.some((id) => typeof id !== 'string' || !ids.has(id) || id === task.id)) throw new Error('Dependencies must reference other known task IDs.');
  orderedTasks(input.tasks);
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact planner UUID and label.');
  return structuredClone(config);
}

export const tasksFor = (input) => orderedTasks(validateInput(input).tasks);

export function requestFor(input, config, taskId, attemptId) {
  const task = tasksFor(input).find((item) => item.id === taskId);
  if (!task || !isId(attemptId)) throw new Error('Invalid task or attempt.');
  const key = `critical-${attemptId}`;
  const prompt = `${input.title}\nTask ${task.id}: ${task.label}\n${task.details}\nEstimate this task's elapsed minutes once its prerequisites are complete. Exclude prerequisite time. Assume uninterrupted work and enough resources. Choose Unknown if none of the exact choices is defensible.`;
  if (prompt.length > 500) throw new Error('Task prompt exceeds 500 characters.');
  return { prompt, context: `Plan ${hash({ input, taskId }).slice(0, 20)}`,
    options: [...task.minutes.map((minutes) => [`m${minutes}`, `${minutes} min`]), ['unknown', 'Unknown']]
      .map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

export function validateState(state, input) {
  validateInput(input);
  const tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed task graph. Restore the original input and configuration.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.taskId !== tasks[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved estimate request.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last task may have an active Question.');
  }
  return state;
}

/** Finish-to-start CPM in relative integer minutes, with unlimited parallel resources. */
export function calculatePlan(rawInput, estimates) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(estimates) || estimates.length !== tasks.length) throw new Error('Every task needs a numeric estimate before planning.');
  const durations = new Map();
  for (const item of estimates) {
    const task = tasks.find((task) => task.id === item?.taskId);
    if (!keys(item, ['taskId', 'minutes']) || !task || durations.has(item.taskId) || !task.minutes.includes(item.minutes)) throw new Error('Invalid or missing task estimate.');
    durations.set(item.taskId, item.minutes);
  }
  const successors = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) for (const predecessor of task.dependsOn) successors.get(predecessor).push(task.id);
  const computed = new Map();
  for (const task of tasks) {
    const earliestStartMinutes = Math.max(0, ...task.dependsOn.map((id) => computed.get(id).earliestFinishMinutes));
    const durationMinutes = durations.get(task.id);
    computed.set(task.id, { taskId: task.id, label: task.label, dependsOn: [...task.dependsOn].sort(compare), durationMinutes,
      earliestStartMinutes, earliestFinishMinutes: earliestStartMinutes + durationMinutes });
  }
  const projectDurationMinutes = Math.max(...[...computed.values()].map((task) => task.earliestFinishMinutes));
  for (const task of [...tasks].reverse()) {
    const result = computed.get(task.id), after = successors.get(task.id);
    result.latestFinishMinutes = after.length ? Math.min(...after.map((id) => computed.get(id).latestStartMinutes)) : projectDurationMinutes;
    result.latestStartMinutes = result.latestFinishMinutes - result.durationMinutes;
    result.totalSlackMinutes = result.latestStartMinutes - result.earliestStartMinutes;
    result.critical = result.totalSlackMinutes === 0;
  }
  const criticalEdges = [];
  for (const task of tasks) for (const predecessor of [...task.dependsOn].sort(compare)) {
    const before = computed.get(predecessor), after = computed.get(task.id);
    if (before.critical && after.critical && before.earliestFinishMinutes === after.earliestStartMinutes) criticalEdges.push({ from: predecessor, to: task.id });
  }
  const criticalPaths = [];
  const walk = (taskId, path) => {
    const next = criticalEdges.filter((edge) => edge.from === taskId).map((edge) => edge.to).sort(compare);
    if (!next.length) {
      if (computed.get(taskId).earliestFinishMinutes !== projectDurationMinutes) throw new Error('Critical path calculation is inconsistent.');
      criticalPaths.push({ taskIds: [...path, taskId], durationMinutes: projectDurationMinutes });
      return;
    }
    for (const id of next) walk(id, [...path, taskId]);
  };
  for (const task of tasks) if (computed.get(task.id).critical && computed.get(task.id).earliestStartMinutes === 0) walk(task.id, []);
  return { assumptions: { dependencies: 'finish_to_start_zero_lag', resources: 'unlimited_parallel', time: 'continuous_relative_minutes', durations: 'fixed_human_estimates' },
    projectDurationMinutes, tasks: tasks.map((task) => computed.get(task.id)), criticalEdges, criticalPaths };
}

export function report(state, input) {
  validateState(state, input);
  const estimates = tasksFor(input).map((task) => {
    const attempt = state.attempts.find((item) => item.taskId === task.id), answer = attempt?.observation?.answer;
    const minutes = task.minutes.find((value) => answer?.value === `m${value}`) ?? null;
    return { taskId: task.id, label: task.label, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, minutes, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = estimates.find((item) => ['create_unknown', 'pending'].includes(item.status));
  const complete = estimates.every((item) => item.minutes !== null);
  const status = active?.status ?? (estimates.some((item) => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  return { planId: input.planId, title: input.title, inputHash: hash(input), status, participant: state.config.participant, estimates,
    unknownTaskIds: estimates.filter((item) => item.choice === 'unknown').map((item) => item.taskId),
    unansweredTasks: estimates.filter((item) => item.status !== 'answered').map(({ taskId, status }) => ({ taskId, status })),
    plan: complete ? calculatePlan(input, estimates.map(({ taskId, minutes }) => ({ taskId, minutes }))) : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved duration evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain duration evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved task request, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
