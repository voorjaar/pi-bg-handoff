import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { adjudicateDelegateTerminal } from './delegate/runner.js';
import { readFusionCommittedResult, readFusionFailureResult } from './fusion/result-package.js';
import { HOST_MAX_INLINE_RESULT_BYTES, HostApiError, boundedHostErrorMessage, } from './host-protocol.js';
/**
 * Read-only verified result views for the optional host interface.
 *
 * This module is loaded lazily by the extension entrypoint, so process-only
 * startup never imports delegate or Fusion verifiers. It reuses the existing
 * integrity verifiers directly and is deliberately side-effect free:
 *
 * - delegate reads call the pure `adjudicateDelegateTerminal` boundary, never
 *   the `evaluateDelegateTerminal` wrapper that writes `outcome.json`;
 * - Fusion reads never call `claimFusionUsage`, so the once-only model usage
 *   accounting claim stays with the first ordinary `bg_result` retrieval;
 * - nothing here emits tool results, messages or session entries.
 *
 * An answer above the inline bound is returned as an artifact reference with
 * its exact verified length and digest, never as truncated text.
 */
/** Delegate adjudication codes that mean committed bytes failed verification. */
const DELEGATE_INTEGRITY_FAILURE_CODES = new Set([
    'child_result_invalid',
    'child_result_encoding_invalid',
    'route_attestation_missing',
    'route_mismatch',
    'seed_hash_mismatch',
    'answer_hash_mismatch',
    'artifact_read_failed',
    'artifact_error',
]);
function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function plainSha256(value) {
    return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}
function committedView(task, kind, answer, answerBytes, answerSha256, artifactPath) {
    const encoded = Buffer.from(answer, 'utf8');
    if (encoded.length !== answerBytes || sha256Hex(encoded) !== answerSha256) {
        throw new HostApiError('RESULT_INVALID', `${kind} result for ${task.id} does not match its verified length and digest`);
    }
    const view = {
        taskId: task.id,
        kind,
        state: 'committed',
        delivery: answerBytes <= HOST_MAX_INLINE_RESULT_BYTES ? 'inline' : 'artifact',
        answerBytes,
        answerSha256,
        artifactPath,
    };
    if (view.delivery === 'inline')
        view.text = answer;
    return view;
}
async function readDelegateResult(task) {
    const facts = task.delegate;
    if (facts === undefined) {
        throw new HostApiError('NO_RESULT', `task ${task.id} has no delegate result`);
    }
    const status = task.status;
    if (status === 'running') {
        return { taskId: task.id, kind: 'delegate', state: 'running', delivery: 'none' };
    }
    const evaluation = await adjudicateDelegateTerminal({
        artifactDirAbs: facts.artifactDirAbs,
        taskId: facts.taskId,
        launchNonce: facts.launchNonce,
        seedSha256: facts.seedSha256,
        route: { provider: facts.route.provider, model: facts.route.model },
        taskStatus: status,
        taskError: task.error,
        taskOutputPath: task.outputPath,
        taskOutputAbsPath: task.outputAbsPath,
    });
    const verified = evaluation.result;
    if (verified !== undefined) {
        return committedView(task, 'delegate', verified.answer, verified.package.answer.byte_length, plainSha256(verified.package.answer.sha256), join(facts.artifactDir, 'result.json'));
    }
    const code = evaluation.error?.code;
    if (code !== undefined && DELEGATE_INTEGRITY_FAILURE_CODES.has(code)) {
        throw new HostApiError('RESULT_INVALID', `delegate result for ${task.id} failed integrity verification (${code}): ${evaluation.error?.message ?? 'no detail'}`);
    }
    const view = {
        taskId: task.id,
        kind: 'delegate',
        state: evaluation.outcome.status === 'cancelled' ? 'cancelled' : 'failed',
        delivery: 'none',
    };
    if (code !== undefined)
        view.errorCode = code;
    if (evaluation.error !== undefined) {
        view.message = boundedHostErrorMessage(evaluation.error.message);
    }
    return view;
}
async function readFusionResult(task) {
    const fusion = task.fusion;
    if (fusion === undefined) {
        throw new HostApiError('NO_RESULT', `task ${task.id} has no Fusion result`);
    }
    if (task.status === 'running') {
        return { taskId: task.id, kind: 'fusion', state: 'running', delivery: 'none' };
    }
    const options = {
        artifactDirAbs: fusion.artifactDirAbs,
        artifactDir: fusion.artifactDir,
        runId: fusion.runId,
        workflow: fusion.workflow,
    };
    if (task.status !== 'completed' || fusion.outcome?.status !== 'committed') {
        const failure = await readFusionFailureResult(options);
        return {
            taskId: task.id,
            kind: 'fusion',
            state: fusion.outcome?.status === 'cancelled' || task.status === 'killed'
                ? 'cancelled'
                : 'failed',
            delivery: 'none',
            fusionFailure: failure,
        };
    }
    let verified;
    try {
        verified = await readFusionCommittedResult(options);
    }
    catch (error) {
        throw new HostApiError('RESULT_INVALID', `Fusion result for ${task.id} failed integrity verification: ${boundedHostErrorMessage(error)}`);
    }
    const bytes = Buffer.from(verified.mergedText, 'utf8');
    return committedView(task, 'fusion', verified.mergedText, bytes.length, sha256Hex(bytes), join(fusion.artifactDir, 'merged.md'));
}
/** Read one exact task's verified result view without any write or usage claim. */
export async function readHostTaskResult(task) {
    if (task.fusion !== undefined)
        return readFusionResult(task);
    if (task.delegate !== undefined)
        return readDelegateResult(task);
    throw new HostApiError('NO_RESULT', `task ${task.id} has no delegate or Fusion result; read ordinary task output with logs`);
}
//# sourceMappingURL=host-results.js.map