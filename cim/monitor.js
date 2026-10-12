(function (root, factory) {
    const monitor = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = monitor;
    root.CimMonitor = monitor;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

    function nextPollAt(now, eligibleRequests, active, cooldowns) {
        const cadenceAt = eligibleRequests ? now + Math.max(active ? 10000 : 30000, Math.max(10000, eligibleRequests * 2000)) : 0;
        return cadenceAt && cooldowns.length ? Math.min(cadenceAt, ...cooldowns) : cadenceAt || (cooldowns.length ? Math.min(...cooldowns) : 0);
    }

    class ForegroundMonitor {
        constructor({ cycle, onCycle = () => {}, isVisible = () => true, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = (id) => globalThis.clearTimeout(id), now = () => Date.now(), fastMs = 10000, idleMs = 30000 }) {
            this.cycle = cycle;
            this.onCycle = onCycle;
            this.isVisible = isVisible;
            this.setTimer = setTimer;
            this.clearTimer = clearTimer;
            this.now = now;
            this.fastMs = fastMs;
            this.idleMs = idleMs;
            this.timer = null;
            this.controller = null;
            this.running = null;
            this.enabled = false;
            this.generation = 0;
        }
        start() { this.enabled = true; if (this.isVisible()) return this.refresh(); }
        stop() {
            this.enabled = false;
            this.generation++;
            this.clearTimer(this.timer);
            this.timer = null;
            this.controller?.abort();
            this.controller = null;
            this.running = null;
        }
        pause() {
            this.generation++;
            this.clearTimer(this.timer);
            this.timer = null;
            this.controller?.abort();
            this.controller = null;
            this.running = null;
        }
        resume() { if (this.enabled && this.isVisible()) return this.refresh(); }
        reset() { this.generation++; this.pause(); this.running = null; return this.refresh(); }
        refresh() {
            if (!this.enabled || !this.isVisible()) return Promise.resolve();
            if (this.running) return this.running;
            const generation = this.generation;
            this.clearTimer(this.timer);
            this.timer = null;
            const controller = new AbortController();
            this.controller = controller;
            this.running = Promise.resolve().then(() => this.cycle(controller.signal)).then((result) => {
                if (generation !== this.generation || controller.signal.aborted) return;
                this.onCycle(null, result);
                if (result?.continueMonitoring === false) return;
                const active = (result?.runs || []).some((run) => ACTIVE.has(run.status));
                const explicitNext = Number(result?.nextAt || result?.retryAt || 0);
                const next = explicitNext > 0 ? Math.max(this.now() + 1000, explicitNext) : this.now() + (active ? this.fastMs : this.idleMs);
                this.timer = this.setTimer(() => { this.timer = null; void this.refresh(); }, Math.max(1000, next - this.now()));
            }).catch((error) => {
                if (generation !== this.generation || controller.signal.aborted) return;
                this.onCycle(error);
                const retryAt = Number(error.retryAt) || 0;
                this.timer = this.setTimer(() => { this.timer = null; void this.refresh(); }, Math.max(this.idleMs, retryAt - this.now()));
            }).finally(() => {
                if (generation === this.generation) this.running = null;
            });
            return this.running;
        }
    }
    return { ACTIVE, nextPollAt, ForegroundMonitor };
});
