(function (root, factory) {
    const state = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = state;
    root.CimRunState = state;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function attemptNumber(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === 'string' && value.trim() === '') return null;
        const next = Number(value);
        if (!Number.isInteger(next) || next <= 0) return null;
        return next;
    }
    function isAttemptAdvance(previous, next) {
        const current = attemptNumber(previous);
        const incoming = attemptNumber(next);
        if (incoming === null) return false;
        if (current === null) return true;
        return incoming > current;
    }
    // Never downgrade a known higher attempt when delayed metadata returns lower.
    function mergeRunMetadata(current, incoming) {
        const previous = attemptNumber(current?.run_attempt);
        const next = attemptNumber(incoming?.run_attempt);
        if (previous !== null && next !== null && next < previous) return { run: current, advanced: false, downgraded: true };
        // Unknown incoming attempt must not wipe a known attempt, but other fields still merge.
        if (previous !== null && next === null && incoming && typeof incoming === 'object') {
            const rest = { ...incoming };
            delete rest.run_attempt;
            return { run: { ...current, ...rest, run_attempt: previous }, advanced: false, downgraded: false };
        }
        return { run: { ...current, ...incoming }, advanced: isAttemptAdvance(previous, next), downgraded: false };
    }
    function shouldInvalidateJobs(previousAttempt, nextAttempt) {
        return isAttemptAdvance(previousAttempt, nextAttempt);
    }
    return { attemptNumber, isAttemptAdvance, mergeRunMetadata, shouldInvalidateJobs };
});
