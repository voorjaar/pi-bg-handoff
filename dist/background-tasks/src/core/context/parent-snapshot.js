import { buildSessionContext, convertToLlm, } from '@earendil-works/pi-coding-agent';
import { isJsonObject } from '../common.js';
import { UnsupportedConversationBlockError } from './visible-conversation-v2.js';
function isConversationMessage(message) {
    switch (message.role) {
        case 'system':
            return false;
        case 'user':
        case 'assistant':
        case 'toolResult':
        case 'custom':
        case 'bashExecution':
        case 'branchSummary':
        case 'compactionSummary':
            return true;
        default:
            // Pi's converter drops unknown host roles. Reject before that lossy step;
            // only the known prompt-state role is intentionally outside conversation.
            throw new UnsupportedConversationBlockError(`message role ${message.role}`);
    }
}
function entriesById(entries) {
    const byId = new Map();
    for (const entry of entries)
        byId.set(entry.id, entry);
    return byId;
}
function readArray(record, key) {
    const value = record[key];
    return Array.isArray(value) ? value : undefined;
}
function recordOf(value) {
    if (!isJsonObject(value) || Array.isArray(value))
        return undefined;
    return value;
}
function entryMessage(entry) {
    if (entry.type !== 'message')
        return undefined;
    return recordOf(entry.message);
}
function toolCallPartMatches(part, toolCallId, toolName) {
    const record = recordOf(part);
    if (record === undefined || record['type'] !== 'toolCall')
        return false;
    if (toolCallId !== undefined)
        return record['id'] === toolCallId;
    return record['name'] === toolName;
}
function messageContainsToolCall(message, toolCallId, toolName) {
    if (message['role'] !== 'assistant')
        return false;
    const content = readArray(message, 'content');
    if (content === undefined)
        return false;
    for (const part of content) {
        if (toolCallPartMatches(part, toolCallId, toolName))
            return true;
    }
    return false;
}
function effectiveLeafForTool(sessionManager, toolCallId, toolName) {
    const leaf = sessionManager.getLeafEntry();
    if (leaf === undefined)
        return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
    const message = entryMessage(leaf);
    if (message !== undefined && messageContainsToolCall(message, toolCallId, toolName)) {
        return { leafId: leaf.parentId, activeToolCallLeafExcluded: true };
    }
    return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
}
export function resolveEffectiveLeaf(sessionManager, options) {
    if (!options.excludeActiveToolCallLeaf)
        return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
    return effectiveLeafForTool(sessionManager, options.toolCallId, options.toolName);
}
/**
 * Freeze the parent conversation into LLM messages.
 *
 * Callers must complete every downstream use of the returned snapshot without
 * re-reading the session, so the seed cannot drift while a child is being
 * launched.
 */
export function snapshotParentConversation(ctx, options) {
    const entries = ctx.sessionManager.getEntries();
    const leaf = resolveEffectiveLeaf(ctx.sessionManager, options);
    const sessionContext = buildSessionContext(entries, leaf.leafId, entriesById(entries));
    // Pi 0.86 persists prompt sections and tool declarations as system messages,
    // including a leading checkpoint after compaction. They are prompt state, not
    // conversation. Keep Pi's effective prompt once in the consumer envelope; do
    // not feed historical prompt/tool deltas into the frozen conversation ledger.
    // The structural role check also accepts older Message type unions.
    const conversation = sessionContext.messages.filter(isConversationMessage);
    return {
        systemPrompt: ctx.getSystemPrompt(),
        messages: convertToLlm(conversation),
        leafId: leaf.leafId,
        activeToolCallLeafExcluded: leaf.activeToolCallLeafExcluded,
    };
}
//# sourceMappingURL=parent-snapshot.js.map