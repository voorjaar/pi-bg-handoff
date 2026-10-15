export const PI_BG_FEATURE_VALUES = Object.freeze([
    'process',
    'delegate',
    'fusion',
    'attested',
    'attribution',
]);
/**
 * pi-bg-handoff fork: the served package defaults to the background-task core only.
 * delegate (bg_delegate), fusion (fusion_*), attested (bg_run_pi_attested) and attribution
 * (anthropic-attribution) are opt-in through PI_BG_FEATURES; the package build uses the same selection
 * to skip the subsystem code those features lazily import.
 */
export const PI_BG_DEFAULT_FEATURES = Object.freeze(['process']);
export const PI_BG_DOCK_SHORTCUT_VALUES = Object.freeze([
    'shift+down',
    'ctrl+alt+b',
    'off',
]);
export const PI_BG_DEFAULT_DOCK_SHORTCUT = 'shift+down';
/**
 * pi-bg-handoff fork: the footer can spell out how to reach the dock and how to clear finished
 * cards. `off` keeps the footer to task state only; the shortcut and /bg-clear still work.
 */
export const PI_BG_FOOTER_HINT_VALUES = Object.freeze(['on', 'off']);
export const PI_BG_DEFAULT_FOOTER_HINTS = 'on';
const CONFIG_VALUE_EXCERPT_CHARS = 96;
function boundedConfigValue(value) {
    if (value.length <= CONFIG_VALUE_EXCERPT_CHARS)
        return JSON.stringify(value);
    return `${JSON.stringify(value.slice(0, CONFIG_VALUE_EXCERPT_CHARS))}… (${String(value.length)} chars)`;
}
function invalidConfig(variable, reason, value) {
    throw new Error(`pi_bg_config_invalid: ${variable} ${reason}; received ${boundedConfigValue(value)}`);
}
function parseFeatures(rawValue) {
    const raw = rawValue ?? PI_BG_DEFAULT_FEATURES.join(',');
    const accepted = PI_BG_FEATURE_VALUES.join(',');
    if (raw.length === 0) {
        invalidConfig('PI_BG_FEATURES', `must not be empty; accepted tokens: ${accepted}`, raw);
    }
    if (/\s/u.test(raw)) {
        invalidConfig('PI_BG_FEATURES', `must contain no whitespace; accepted tokens: ${accepted}`, raw);
    }
    const tokens = raw.split(',');
    if (tokens.some((token) => token.length === 0)) {
        invalidConfig('PI_BG_FEATURES', `contains a blank comma token; accepted tokens: ${accepted}`, raw);
    }
    const selected = new Set();
    for (const token of tokens) {
        if (!PI_BG_FEATURE_VALUES.includes(token)) {
            invalidConfig('PI_BG_FEATURES', `contains unknown token ${boundedConfigValue(token)}; accepted tokens: ${accepted}; bg_result is derived from delegate or fusion`, raw);
        }
        const feature = token;
        if (selected.has(feature)) {
            invalidConfig('PI_BG_FEATURES', `contains duplicate token ${feature}`, raw);
        }
        selected.add(feature);
    }
    if (!selected.has('process')) {
        invalidConfig('PI_BG_FEATURES', 'must include mandatory token process', raw);
    }
    return Object.freeze({
        process: true,
        delegate: selected.has('delegate'),
        fusion: selected.has('fusion'),
        attested: selected.has('attested'),
        attribution: selected.has('attribution'),
    });
}
function parseDockShortcut(rawValue) {
    const raw = rawValue ?? PI_BG_DEFAULT_DOCK_SHORTCUT;
    if (!PI_BG_DOCK_SHORTCUT_VALUES.includes(raw)) {
        invalidConfig('PI_BG_DOCK_SHORTCUT', `accepted values are exactly ${PI_BG_DOCK_SHORTCUT_VALUES.join(',')}`, raw);
    }
    return raw;
}
function parseFooterHints(rawValue) {
    const raw = rawValue ?? PI_BG_DEFAULT_FOOTER_HINTS;
    if (!PI_BG_FOOTER_HINT_VALUES.includes(raw)) {
        invalidConfig('PI_BG_FOOTER_HINTS', `accepted values are exactly ${PI_BG_FOOTER_HINT_VALUES.join(',')}`, raw);
    }
    return raw;
}
export function parseBackgroundTasksConfig(env = process.env) {
    const features = parseFeatures(env['PI_BG_FEATURES']);
    const dockShortcut = parseDockShortcut(env['PI_BG_DOCK_SHORTCUT']);
    const footerHints = parseFooterHints(env['PI_BG_FOOTER_HINTS']);
    return Object.freeze({ features, dockShortcut, footerHints });
}
export function footerHintsActive(hints) {
    if (hints === 'on')
        return true;
    return false;
}
/**
 * pi-bg-handoff fork: optional host switch for the footer hints.
 *
 * `PI_BG_FOOTER_HINTS` covers the usual case. This slot exists for the companion pi-bg-handoff
 * extension, which reads `pi-bg-handoff.json` and publishes `{ enabled: false }` here so a user can quiet
 * the footer from the shared config file without setting an environment variable. It is read when the
 * footer renders, so it never depends on which extension loaded first.
 */
export const FOOTER_HINTS_SLOT = Symbol.for('pi-bg-handoff.footer-hints:v1');
export function footerHintsSuppressedByHost() {
    const slot = globalThis[FOOTER_HINTS_SLOT];
    return !!slot && typeof slot === 'object' && slot.enabled === false;
}
export function dockShortcutFooterHint(shortcut) {
    if (shortcut === 'shift+down')
        return 'Shift↓';
    if (shortcut === 'ctrl+alt+b')
        return 'CtrlAltB';
    return '/tasks';
}
//# sourceMappingURL=config.js.map