(function (root, factory) {
    const state = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = state;
    root.CimRunState = state;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function attemptNumber(value) {
        const next = Number(value);
        return Number.isFinite(next) ? next : null;
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
        return { run: { ...current, ...incoming }, advanced: isAttemptAdvance(previous, next), downgraded: false };
    }
    function shouldInvalidateJobs(previousAttempt, nextAttempt) {
        return isAttemptAdvance(previousAttempt, nextAttempt);
    }
    return { attemptNumber, isAttemptAdvance, mergeRunMetadata, shouldInvalidateJobs };
});
