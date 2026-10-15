import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { HOST_CHANGE_COALESCE_MS, HOST_CHANGED_CHANNEL, HOST_CHANGED_SCHEMA, HOST_DEFAULT_LOG_BYTES, HOST_DEFAULT_PAGE_SIZE, HOST_LIST_PREVIEW_CHARS, HOST_MAX_IN_FLIGHT, HOST_MAX_LEASES, HOST_REPLAY_CACHE_SIZE, HOST_REQUEST_CHANNEL, HOST_RESPONSE_CHANNEL, HostApiError, boundedHostErrorMessage, compareNewestFirst, decodeHostCursor, encodeHostCursor, hostCapabilities, hostErrorBody, hostErrorFrame, hostSuccessFrame, parseHostRequest, serializeHostResponse, } from './host-protocol.js';
function isUtf8Continuation(byte) {
    return (byte & 0xc0) === 0x80;
}
function utf8SequenceLength(lead) {
    if (lead < 0x80)
        return 1;
    if ((lead & 0xe0) === 0xc0)
        return 2;
    if ((lead & 0xf0) === 0xe0)
        return 3;
    if ((lead & 0xf8) === 0xf0)
        return 4;
    return 1;
}
/** Exclusive end that does not split a trailing UTF-8 sequence. */
function completeUtf8End(buffer, start, end) {
    let index = end - 1;
    let inspected = 0;
    while (index >= start && inspected < 4) {
        const byte = buffer.readUInt8(index);
        if (!isUtf8Continuation(byte)) {
            return index + utf8SequenceLength(byte) <= end ? end : index;
        }
        index -= 1;
        inspected += 1;
    }
    return end;
}
/**
 * Read one bounded window of a task output file. Window boundaries never split
 * a UTF-8 sequence; the exact returned byte range is reported so a consumer can
 * see what was omitted. Bytes are untrusted text.
 */
export async function readHostLogWindow(absPath, maxBytes, tail) {
    const handle = await open(absPath, 'r');
    try {
        const { size } = await handle.stat();
        const length = Math.min(size, maxBytes);
        const position = tail ? size - length : 0;
        const buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
            const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
            if (bytesRead === 0)
                break;
            filled += bytesRead;
        }
        let start = 0;
        if (position > 0) {
            while (start < filled && start < 3 && isUtf8Continuation(buffer.readUInt8(start))) {
                start += 1;
            }
        }
        const end = completeUtf8End(buffer, start, filled);
        const bytes = buffer.subarray(start, end);
        return {
            text: bytes.toString('utf8'),
            bytesRead: bytes.length,
            totalBytes: size,
            windowStart: position + start,
            windowEnd: position + end,
        };
    }
    finally {
        await handle.close();
    }
}
export function hostTaskKind(task) {
    if (task.fusion !== undefined)
        return 'fusion';
    if (task.delegate !== undefined)
        return 'delegate';
    if (task.attestedPi !== undefined || task.eventsAbsPath !== undefined)
        return 'attested';
    if (task.managedCancel !== undefined)
        return 'managed';
    return task.isAgent ? 'agent-shell' : 'shell';
}
const RERUN_GUIDANCE = {
    'agent-shell': 'agent shell tasks launch model work and are not rerun from the host interface; start a new run through bg_run or /bg --agent',
    delegate: 'delegate tasks are typed workflows; relaunch through bg_delegate',
    fusion: 'Fusion tasks are typed workflows; relaunch through the owning Fusion tool or /fusion',
    attested: 'attested Pi tasks are evidence producers; relaunch through bg_run_pi_attested',
    managed: 'managed tasks are typed workflows; relaunch through their owning tool',
};
function previewText(value, field, truncated) {
    if (value === undefined || value.length <= HOST_LIST_PREVIEW_CHARS)
        return value;
    truncated.push(field);
    return `${value.slice(0, HOST_LIST_PREVIEW_CHARS - 1)}…`;
}
class InstalledBackgroundTaskHostService {
    activationId = `act-${randomBytes(16).toString('hex')}`;
    events;
    registry;
    getContext;
    isSeen;
    markSeenIds;
    readResult;
    logger;
    now;
    coalesceMs;
    unsubscribeRequests;
    leases = new Map();
    clientLeases = new Map();
    serviceState = 'open';
    isReady = false;
    sessionId;
    currentRevision = 0;
    lastChangedAt = 0;
    changeTimer;
    inFlightCount = 0;
    publicationFailureCount = 0;
    constructor(options) {
        this.events = options.events;
        this.registry = options.registry;
        this.getContext = options.getContext;
        this.isSeen = options.isSeen;
        this.markSeenIds = options.markSeen;
        this.readResult = options.readResult;
        this.logger = options.logger ?? console;
        this.now = options.now ?? Date.now;
        this.coalesceMs = options.coalesceMs ?? HOST_CHANGE_COALESCE_MS;
        this.unsubscribeRequests = this.events.on(HOST_REQUEST_CHANNEL, (data) => {
            this.handle(data);
        });
    }
    get state() {
        return this.serviceState;
    }
    get ready() {
        return this.isReady;
    }
    get revision() {
        return this.currentRevision;
    }
    get leaseCount() {
        return this.leases.size;
    }
    get inFlight() {
        return this.inFlightCount;
    }
    get changePending() {
        return this.changeTimer !== undefined;
    }
    get publicationFailures() {
        return this.publicationFailureCount;
    }
    markReady() {
        if (this.serviceState === 'closed' || this.isReady)
            return;
        const ctx = this.getContext();
        if (ctx?.sessionId === undefined || this.registry.isShuttingDown())
            return;
        this.sessionId = ctx.sessionId;
        this.isReady = true;
        this.publishChange('ready');
    }
    invalidate() {
        if (this.serviceState === 'closed')
            return;
        this.currentRevision += 1;
        if (!this.isReady || this.leases.size === 0 || this.changeTimer !== undefined)
            return;
        const delay = Math.max(0, this.lastChangedAt + this.coalesceMs - this.now());
        const timer = setTimeout(() => {
            this.changeTimer = undefined;
            if (this.serviceState === 'closed' || this.leases.size === 0)
                return;
            this.publishChange('changed');
        }, delay);
        timer.unref();
        this.changeTimer = timer;
    }
    close() {
        if (this.serviceState === 'closed')
            return;
        const announce = this.isReady;
        this.serviceState = 'closed';
        if (this.changeTimer !== undefined) {
            clearTimeout(this.changeTimer);
            this.changeTimer = undefined;
        }
        try {
            this.unsubscribeRequests();
        }
        catch (error) {
            this.logger.error(`[background-tasks] host interface listener removal failed: ${boundedHostErrorMessage(error)}`);
        }
        for (const lease of this.leases.values())
            lease.disposed = true;
        this.leases.clear();
        this.clientLeases.clear();
        if (announce)
            this.publishChange('closed');
    }
    // -------------------------------------------------------------------------
    // Frames
    // -------------------------------------------------------------------------
    counts() {
        const counts = {
            running: 0,
            completed: 0,
            failed: 0,
            killed: 0,
            unseenCompleted: 0,
            unseenFailed: 0,
            unseenKilled: 0,
            total: 0,
        };
        for (const task of this.registry.allTasks()) {
            counts.total += 1;
            if (task.status === 'running') {
                counts.running += 1;
                continue;
            }
            const seen = this.isSeen(task.id);
            if (task.status === 'completed') {
                counts.completed += 1;
                if (!seen)
                    counts.unseenCompleted += 1;
            }
            else if (task.status === 'failed') {
                counts.failed += 1;
                if (!seen)
                    counts.unseenFailed += 1;
            }
            else {
                counts.killed += 1;
                if (!seen)
                    counts.unseenKilled += 1;
            }
        }
        return counts;
    }
    publishChange(kind) {
        const sessionId = this.sessionId;
        if (sessionId === undefined)
            return;
        let frame;
        try {
            frame = {
                schema_version: HOST_CHANGED_SCHEMA,
                kind,
                activationId: this.activationId,
                sessionId,
                revision: this.currentRevision,
                observedAt: this.now(),
                counts: this.counts(),
            };
        }
        catch (error) {
            this.publicationFailureCount += 1;
            this.logger.error(`[background-tasks] host ${kind} frame could not be prepared: ${boundedHostErrorMessage(error)}`);
            return;
        }
        this.lastChangedAt = frame.observedAt;
        try {
            this.events.emit(HOST_CHANGED_CHANNEL, frame);
        }
        catch (error) {
            // Never recorded as delivered. Consumers resynchronize from any list or
            // subscribe response, which always carries the current revision.
            this.publicationFailureCount += 1;
            this.logger.error(`[background-tasks] host ${kind} frame publication failed (revision ${String(frame.revision)}): ${boundedHostErrorMessage(error)}`);
        }
    }
    emitText(text) {
        try {
            this.events.emit(HOST_RESPONSE_CHANNEL, JSON.parse(text));
        }
        catch (error) {
            this.logger.error(`[background-tasks] host response emit failed: ${boundedHostErrorMessage(error)}`);
        }
    }
    emitFrame(frame) {
        this.emitText(serializeHostResponse(frame));
    }
    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------
    handle(data) {
        if (this.serviceState === 'closed')
            return;
        const parsed = parseHostRequest(data);
        if (!parsed.ok) {
            this.emitFrame(hostErrorFrame(parsed.requestId, parsed.operation, parsed.error));
            return;
        }
        const request = parsed.request;
        const body = request.body;
        try {
            switch (body.operation) {
                case 'capabilities':
                    this.emitFrame(hostSuccessFrame(request.requestId, body.operation, hostCapabilities()));
                    return;
                case 'subscribe':
                    this.emitFrame(hostSuccessFrame(request.requestId, body.operation, this.subscribe(body.payload.clientId)));
                    return;
                default:
                    this.handleLeased(request, body);
                    return;
            }
        }
        catch (error) {
            this.emitFrame(hostErrorFrame(request.requestId, body.operation, hostErrorBody(error)));
        }
    }
    handleLeased(request, body) {
        const lease = this.authorize(body.payload);
        const sequence = body.payload.sequence;
        if (sequence <= lease.highWater) {
            const completed = lease.completed.get(sequence);
            if (completed !== undefined) {
                if (completed.fingerprint !== request.fingerprint) {
                    throw new HostApiError('CONFLICT', `sequence ${String(sequence)} was already used by a different request on this lease`);
                }
                this.emitText(completed.frame);
                return;
            }
            const pending = lease.pending.get(sequence);
            if (pending !== undefined) {
                if (pending.fingerprint !== request.fingerprint) {
                    throw new HostApiError('CONFLICT', `sequence ${String(sequence)} is in flight for a different request on this lease`);
                }
                pending.replays += 1;
                return;
            }
            throw new HostApiError('STALE_REQUEST', `sequence ${String(sequence)} is at or below this lease's high-water mark ${String(lease.highWater)} and its response is no longer retained; it was not executed again`);
        }
        if (this.inFlightCount >= HOST_MAX_IN_FLIGHT) {
            throw new HostApiError('BUSY', `at most ${String(HOST_MAX_IN_FLIGHT)} host operations may be in flight; retry with the same sequence after a response arrives`);
        }
        lease.highWater = sequence;
        const pending = { fingerprint: request.fingerprint, replays: 0 };
        lease.pending.set(sequence, pending);
        this.inFlightCount += 1;
        const operation = this.execute(body, lease);
        void operation
            .then((result) => hostSuccessFrame(request.requestId, body.operation, result), (error) => hostErrorFrame(request.requestId, body.operation, hostErrorBody(error)))
            .then((frame) => {
            this.settle(request, body, lease, sequence, pending, frame);
        });
    }
    settle(request, body, lease, sequence, pending, frame) {
        this.inFlightCount -= 1;
        lease.pending.delete(sequence);
        // A request admitted before closure may report failure, never success
        // from a closed activation.
        const finalFrame = this.serviceState === 'closed' && frame.ok
            ? hostErrorFrame(request.requestId, body.operation, {
                code: 'CLOSED',
                message: 'the host interface activation closed before this request completed; subscribe to the current activation',
            })
            : frame;
        const text = serializeHostResponse(finalFrame);
        if (!lease.disposed && this.serviceState === 'open') {
            lease.completed.set(sequence, { fingerprint: pending.fingerprint, frame: text });
            while (lease.completed.size > HOST_REPLAY_CACHE_SIZE) {
                const oldest = lease.completed.keys().next();
                if (oldest.done === true)
                    break;
                lease.completed.delete(oldest.value);
            }
        }
        for (let emitted = 0; emitted <= pending.replays; emitted += 1)
            this.emitText(text);
    }
    authorize(fields) {
        if (fields.activationId !== this.activationId) {
            throw new HostApiError('ACTIVATION_MISMATCH', 'activationId does not name the current host activation; subscribe again');
        }
        const lease = this.leases.get(fields.leaseId);
        if (lease === undefined || lease.disposed) {
            throw new HostApiError('LEASE_INVALID', 'leaseId is not a live lease of this activation');
        }
        return lease;
    }
    requireContext() {
        if (this.serviceState === 'closed') {
            throw new HostApiError('CLOSED', 'the host interface activation is closed');
        }
        if (this.registry.isShuttingDown()) {
            throw new HostApiError('UNAVAILABLE', 'the background task activation is shutting down');
        }
        const ctx = this.getContext();
        if (!this.isReady || ctx === undefined) {
            throw new HostApiError('UNAVAILABLE', 'the background task host interface has no initialized session context yet; wait for its ready frame');
        }
        return ctx;
    }
    activationFacts() {
        this.requireContext();
        const sessionId = this.sessionId;
        if (sessionId === undefined) {
            throw new HostApiError('UNAVAILABLE', 'the activation has no session identity');
        }
        return {
            activationId: this.activationId,
            sessionId,
            revision: this.currentRevision,
            observedAt: this.now(),
            counts: this.counts(),
        };
    }
    subscribe(clientId) {
        const facts = this.activationFacts();
        const existingId = this.clientLeases.get(clientId);
        const existing = existingId === undefined ? undefined : this.leases.get(existingId);
        if (existing !== undefined && !existing.disposed)
            return { ...facts, leaseId: existing.leaseId };
        if (this.leases.size >= HOST_MAX_LEASES) {
            throw new HostApiError('LEASE_LIMIT', `at most ${String(HOST_MAX_LEASES)} host leases may be live in one activation`);
        }
        const lease = {
            leaseId: `lease-${randomBytes(16).toString('hex')}`,
            clientId,
            highWater: 0,
            disposed: false,
            completed: new Map(),
            pending: new Map(),
        };
        this.leases.set(lease.leaseId, lease);
        this.clientLeases.set(clientId, lease.leaseId);
        return { ...facts, leaseId: lease.leaseId };
    }
    // -------------------------------------------------------------------------
    // Operations
    // -------------------------------------------------------------------------
    async execute(body, lease) {
        switch (body.operation) {
            case 'unsubscribe':
                return this.unsubscribeLease(lease);
            case 'list':
                return this.list(body.payload);
            case 'detail':
                return this.detail(body.payload.taskId);
            case 'logs':
                return this.logs(body.payload);
            case 'stop':
                return this.stop(body.payload.taskId);
            case 'stop_all':
                return this.stopAll(body.payload.taskIds);
            case 'rerun':
                return this.rerun(body.payload.taskId);
            case 'result':
                return this.result(body.payload.taskId);
            case 'mark_seen':
                return this.markSeen(body.payload.taskIds);
        }
    }
    unsubscribeLease(lease) {
        lease.disposed = true;
        this.leases.delete(lease.leaseId);
        if (this.clientLeases.get(lease.clientId) === lease.leaseId) {
            this.clientLeases.delete(lease.clientId);
        }
        if (this.leases.size === 0 && this.changeTimer !== undefined) {
            clearTimeout(this.changeTimer);
            this.changeTimer = undefined;
        }
        return { leaseId: lease.leaseId, released: true };
    }
    findTask(taskId) {
        const task = this.registry.allTasks().find((candidate) => candidate.id === taskId);
        if (task === undefined) {
            throw new HostApiError('NOT_FOUND', `no retained background task has exact id ${taskId}`);
        }
        return task;
    }
    view(task, preview) {
        const snapshot = { ...this.registry.snapshot(task) };
        const truncatedFields = [];
        if (preview) {
            snapshot.command = previewText(snapshot.command, 'command', truncatedFields) ?? '';
            snapshot.description = previewText(snapshot.description, 'description', truncatedFields);
            snapshot.error = previewText(snapshot.error, 'error', truncatedFields);
        }
        const kind = hostTaskKind(task);
        return {
            task: snapshot,
            kind,
            seen: task.status !== 'running' && this.isSeen(task.id),
            canRerun: kind === 'shell',
            canReadResult: kind === 'delegate' || kind === 'fusion',
            truncatedFields,
        };
    }
    list(payload) {
        const facts = this.activationFacts();
        const limit = payload.limit ?? HOST_DEFAULT_PAGE_SIZE;
        const ordered = this.registry.allTasks().sort(compareNewestFirst);
        let start = 0;
        if (payload.cursor !== undefined) {
            const position = decodeHostCursor(this.activationId, payload.cursor);
            start = ordered.findIndex((task) => compareNewestFirst(task, position) > 0);
            if (start < 0)
                start = ordered.length;
        }
        const page = ordered.slice(start, start + limit);
        const last = page.at(-1);
        const nextCursor = start + limit < ordered.length && last !== undefined
            ? encodeHostCursor(this.activationId, { startTime: last.startTime, id: last.id })
            : null;
        return { ...facts, tasks: page.map((task) => this.view(task, true)), nextCursor };
    }
    detail(taskId) {
        this.requireContext();
        return { task: this.view(this.findTask(taskId), false) };
    }
    async logs(payload) {
        this.requireContext();
        const task = this.findTask(payload.taskId);
        const maxBytes = payload.maxBytes ?? HOST_DEFAULT_LOG_BYTES;
        const tail = payload.tail ?? true;
        if (!existsSync(task.outputAbsPath)) {
            throw new HostApiError('LOG_UNAVAILABLE', `output file for ${task.id} does not exist (${task.outputPath}); the task has not produced an output file or it was removed`);
        }
        let window;
        try {
            window = await readHostLogWindow(task.outputAbsPath, maxBytes, tail);
        }
        catch (error) {
            throw new HostApiError('LOG_UNAVAILABLE', `output file for ${task.id} could not be read (${task.outputPath}): ${boundedHostErrorMessage(error)}`);
        }
        return {
            task: this.registry.snapshot(task),
            path: task.outputPath,
            text: window.text,
            tail,
            maxBytes,
            bytesRead: window.bytesRead,
            totalBytes: window.totalBytes,
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            truncated: window.windowStart > 0 || window.windowEnd < window.totalBytes,
            bytesWritten: task.bytesWritten,
        };
    }
    /** Stop one running task; resolves only after actual terminal settlement. */
    async stopOne(task) {
        if (task.status !== 'running')
            return 'already_terminal';
        try {
            await this.registry.stopTask(task, 'user');
        }
        catch (error) {
            if (task.status !== 'running')
                return 'already_terminal';
            throw new HostApiError('OPERATION_FAILED', `stopping ${task.id} failed: ${boundedHostErrorMessage(error)}`);
        }
        if (task.status === 'running') {
            throw new HostApiError('OPERATION_FAILED', `stopping ${task.id} returned before terminal settlement`);
        }
        return 'stopped';
    }
    async stop(taskId) {
        this.requireContext();
        const task = this.findTask(taskId);
        const outcome = await this.stopOne(task);
        return { task: this.registry.snapshot(task), alreadyTerminal: outcome === 'already_terminal' };
    }
    async stopAll(taskIds) {
        this.requireContext();
        // The frozen confirmed selection only; never a fresh registry-wide scan.
        const byId = new Map(this.registry.allTasks().map((task) => [task.id, task]));
        const results = await Promise.all(taskIds.map(async (taskId) => {
            const task = byId.get(taskId);
            if (task === undefined)
                return { taskId, outcome: 'not_found' };
            try {
                const outcome = await this.stopOne(task);
                return { taskId, outcome, status: task.status };
            }
            catch (error) {
                return {
                    taskId,
                    outcome: 'failed',
                    status: task.status,
                    error: boundedHostErrorMessage(error),
                };
            }
        }));
        const count = (outcome) => results.filter((entry) => entry.outcome === outcome).length;
        return {
            results,
            stopped: count('stopped'),
            alreadyTerminal: count('already_terminal'),
            notFound: count('not_found'),
            failed: count('failed'),
        };
    }
    async rerun(taskId) {
        const ctx = this.requireContext();
        const source = this.findTask(taskId);
        const kind = hostTaskKind(source);
        if (kind !== 'shell') {
            throw new HostApiError('NOT_RERUNNABLE', `${source.id}: ${RERUN_GUIDANCE[kind]}`);
        }
        // Exact original command through real registry admission; a new identity.
        // The ordinary user-initiated dock policy applies: notification on, no wake.
        const options = {
            name: source.name,
            isAgent: false,
            surviveReload: source.surviveReload === true,
            notifyOnCompletion: true,
            triggerOnCompletion: false,
        };
        if (source.description !== undefined)
            options.description = source.description;
        if (source.timeoutSeconds !== undefined)
            options.timeoutSeconds = source.timeoutSeconds;
        const task = await this.registry.startTask(ctx, source.command, options);
        return { sourceTaskId: source.id, task: this.registry.snapshot(task) };
    }
    async result(taskId) {
        this.requireContext();
        const task = this.findTask(taskId);
        const kind = hostTaskKind(task);
        if (kind !== 'delegate' && kind !== 'fusion') {
            throw new HostApiError('NO_RESULT', `${task.id} is a ${kind} task without a verified result; read its output with logs`);
        }
        if (task.status === 'running') {
            return { taskId: task.id, kind, state: 'running', delivery: 'none' };
        }
        return this.readResult(task);
    }
    markSeen(taskIds) {
        this.requireContext();
        const byId = new Map(this.registry.allTasks().map((task) => [task.id, task]));
        const marked = [];
        const results = taskIds.map((taskId) => {
            const task = byId.get(taskId);
            if (task === undefined)
                return { taskId, outcome: 'not_found' };
            // Viewing a running task can never pre-acknowledge its future completion.
            if (task.status === 'running')
                return { taskId, outcome: 'not_terminal' };
            if (this.isSeen(taskId))
                return { taskId, outcome: 'already_seen' };
            marked.push(taskId);
            return { taskId, outcome: 'marked' };
        });
        if (marked.length > 0)
            this.markSeenIds(marked);
        return { results, revision: this.currentRevision, counts: this.counts() };
    }
}
export function installBackgroundTaskHostApi(options) {
    return new InstalledBackgroundTaskHostService(options);
}
//# sourceMappingURL=host-api.js.map