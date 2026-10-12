(function (root, factory) {
    const schema = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = schema;
    root.CimWorkflowSchema = schema;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const MAX_INPUTS = 25;
    const MAX_PAYLOAD_CHARS = 65535;
    const MAX_YAML_BYTES = 1048576;
    const MAX_DESCRIPTION_CHARS = 500;
    const MAX_OPTIONS = 50;
    const MAX_OPTION_CHARS = 200;
    const MAX_INPUT_NAME_CHARS = 100;
    const SUPPORTED_TYPES = ['string', 'boolean', 'number', 'choice', 'environment'];
    const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
    const INPUT_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

    function getYamlLib() {
        if (globalThis.jsyaml && typeof globalThis.jsyaml.load === 'function') return globalThis.jsyaml;
        try {
            // Node unit tests load the pinned local vendor UMD artifact.
            const vendor = require('./vendor/js-yaml.umd.min.js');
            if (vendor && typeof vendor.load === 'function') return vendor;
            if (vendor && vendor.jsyaml && typeof vendor.jsyaml.load === 'function') return vendor.jsyaml;
            return vendor;
        } catch { return null; }
    }

    function safeLoadYaml(text) {
        const lib = getYamlLib();
        if (!lib) throw new Error('YAML parser is unavailable.');
        const options = { schema: lib.CORE_SCHEMA };
        // Merge-only tag keeps << merges working without executable tags.
        try {
            if (lib.mergeTag && typeof options.schema.withTags === 'function') options.schema = options.schema.withTags([lib.mergeTag]);
        } catch { /* CORE_SCHEMA alone still parses safely. */ }
        options.maxDepth = 50;
        options.maxAliases = 100;
        options.maxTotalMergeKeys = 10000;
        return lib.load(String(text), options);
    }

    function own(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    }

    function isPlainMapping(value) {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    function readOnValue(parsed) {
        if (!isPlainMapping(parsed)) return undefined;
        if (Object.prototype.hasOwnProperty.call(parsed, 'on')) return parsed.on;
        // Tolerate YAML 1.1 boolean-true key without relying on it.
        if (Object.prototype.hasOwnProperty.call(parsed, true)) return parsed[true];
        return undefined;
    }

    function normalizeTrigger(onValue) {
        if (typeof onValue === 'string') return onValue === 'workflow_dispatch' ? { found: true, config: null } : { found: false };
        if (Array.isArray(onValue)) {
            if (onValue.length > 50) return { found: false };
            return { found: onValue.includes('workflow_dispatch'), config: null };
        }
        if (isPlainMapping(onValue)) {
            if (Object.prototype.hasOwnProperty.call(onValue, 'workflow_dispatch')) return { found: true, config: onValue.workflow_dispatch };
            if (Object.prototype.hasOwnProperty.call(onValue, true)) return { found: true, config: onValue[true] };
            return { found: false };
        }
        return { found: false };
    }

    function boundDescription(value) {
        if (value === undefined || value === null) return '';
        if (typeof value !== 'string') return null;
        return value.length > MAX_DESCRIPTION_CHARS ? value.slice(0, MAX_DESCRIPTION_CHARS) : value;
    }

    function absent(value) {
        return value === undefined || value === null;
    }

    // GitHub coerces finite numeric/boolean YAML scalars to text for string inputs.
    function coerceStringDefault(value) {
        if (typeof value === 'string') return { ok: true, value };
        if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) };
        if (typeof value === 'boolean') return { ok: true, value: String(value) };
        return { ok: false };
    }

    function extractInputs(dispatchConfig) {
        if (dispatchConfig === null || dispatchConfig === undefined) return { ok: true, inputs: [] };
        if (!isPlainMapping(dispatchConfig)) return { ok: false, reason: 'This workflow’s workflow_dispatch trigger is malformed.' };
        const rawInputs = own(dispatchConfig, 'inputs');
        if (rawInputs === undefined || rawInputs === null) return { ok: true, inputs: [] };
        if (!isPlainMapping(rawInputs)) return { ok: false, reason: 'This workflow’s workflow_dispatch inputs are malformed.' };
        const names = Object.keys(rawInputs);
        if (names.length > MAX_INPUTS) return { ok: false, reason: `This workflow declares ${names.length} inputs; GitHub supports at most ${MAX_INPUTS}.` };
        const inputs = [];
        for (const name of names) {
            if (name.length < 1 || name.length > MAX_INPUT_NAME_CHARS || !INPUT_NAME_PATTERN.test(name) || PROTOTYPE_KEYS.has(name)) return { ok: false, reason: `Unsupported workflow input: ${name}.` };
            const raw = rawInputs[name];
            const config = raw === null || raw === undefined ? {} : raw;
            if (!isPlainMapping(config)) return { ok: false, reason: `Unsupported value for input ${name}.` };
            // Shallow primitive fields only; never deep-traverse the workflow graph.
            const description = boundDescription(own(config, 'description'));
            if (description === null) return { ok: false, reason: `Unsupported description for input ${name}.` };
            const requiredRaw = own(config, 'required');
            const required = requiredRaw === undefined || requiredRaw === null ? false : requiredRaw;
            if (typeof required !== 'boolean') return { ok: false, reason: `Unsupported required flag for input ${name}.` };
            const typeRaw = own(config, 'type');
            const type = typeRaw === undefined || typeRaw === null ? 'string' : typeRaw;
            if (typeof type !== 'string' || !SUPPORTED_TYPES.includes(type)) return { ok: false, reason: `Unsupported type for input ${name}.` };
            const defaultValue = own(config, 'default');
            if (defaultValue !== undefined && defaultValue !== null && (typeof defaultValue === 'object')) return { ok: false, reason: `Unsupported default for input ${name}.` };
            if (typeof defaultValue === 'number' && !Number.isFinite(defaultValue)) return { ok: false, reason: `Unsupported default for input ${name}.` };
            // Reject unknown declaration keys to avoid silent YAML object values.
            for (const key of Object.keys(config)) {
                if (!['description', 'required', 'default', 'type', 'options'].includes(key)) return { ok: false, reason: `Unsupported field for input ${name}: ${key}.` };
            }
            if (type === 'string' || type === 'environment' || typeRaw === undefined || typeRaw === null) {
                if (!absent(defaultValue)) {
                    const coerced = coerceStringDefault(defaultValue);
                    if (!coerced.ok) return { ok: false, reason: `Unsupported default for input ${name}.` };
                    inputs.push({ name, type, description, required, default: coerced.value, options: undefined });
                    continue;
                }
                inputs.push({ name, type, description, required, default: undefined, options: undefined });
                continue;
            }
            if (type === 'boolean' && !absent(defaultValue) && typeof defaultValue !== 'boolean') return { ok: false, reason: `Unsupported default for input ${name}.` };
            if (type === 'number' && !absent(defaultValue) && (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))) return { ok: false, reason: `Unsupported default for input ${name}.` };
            let options;
            if (type === 'choice') {
                const rawOptions = own(config, 'options');
                if (!Array.isArray(rawOptions) || rawOptions.length < 1 || rawOptions.length > MAX_OPTIONS) return { ok: false, reason: `Choice input ${name} needs 1–${MAX_OPTIONS} options.` };
                options = [];
                const seen = new Set();
                for (const option of rawOptions) {
                    // Option values are array items, never dictionary keys: coerce
                    // finite scalars to text instead of prototype-blocking them.
                    const coerced = coerceStringDefault(option);
                    if (!coerced.ok || !coerced.value || coerced.value.length > MAX_OPTION_CHARS) return { ok: false, reason: `Unsupported option for input ${name}.` };
                    if (!seen.has(coerced.value)) { seen.add(coerced.value); options.push(coerced.value); }
                }
                if (!options.length) return { ok: false, reason: `Choice input ${name} needs 1–${MAX_OPTIONS} options.` };
                if (!absent(defaultValue)) {
                    const coerced = coerceStringDefault(defaultValue);
                    if (!coerced.ok) return { ok: false, reason: `Unsupported default for input ${name}.` };
                    if (!seen.has(coerced.value)) return { ok: false, reason: `Default for input ${name} must be one of its options.` };
                    inputs.push({ name, type, description, required, default: coerced.value, options });
                } else {
                    inputs.push({ name, type, description, required, default: undefined, options });
                }
                continue;
            } else if (own(config, 'options') !== undefined) return { ok: false, reason: `Unsupported options for input ${name}.` };
            inputs.push({ name, type, description, required, default: absent(defaultValue) ? undefined : defaultValue, options });
        }
        return { ok: true, inputs };
    }

    function parseWorkflowYaml(text) {
        if (typeof text !== 'string' || !text) return { dispatchable: false, reason: 'Workflow file is empty.', inputs: [] };
        if (text.length > MAX_YAML_BYTES) return { dispatchable: false, reason: 'Workflow file is too large.', inputs: [] };
        let parsed;
        try { parsed = safeLoadYaml(text); }
        catch { return { dispatchable: false, reason: 'Workflow file could not be parsed.', inputs: [] }; }
        if (!isPlainMapping(parsed)) return { dispatchable: false, reason: 'Workflow file is invalid.', inputs: [] };
        const trigger = normalizeTrigger(readOnValue(parsed));
        if (!trigger.found) return { dispatchable: false, reason: 'This workflow does not run manually (no workflow_dispatch trigger).', inputs: [] };
        const extracted = extractInputs(trigger.config);
        if (!extracted.ok) return { dispatchable: false, reason: extracted.reason, inputs: [] };
        return { dispatchable: true, reason: '', inputs: extracted.inputs };
    }

    function validateDispatchValues(schemaInputs, values) {
        const errors = Object.create(null);
        const payload = Object.create(null);
        const known = new Set();
        for (const input of schemaInputs || []) known.add(input.name);
        if (values && typeof values === 'object') {
            for (const key of Object.keys(values)) {
                if (!known.has(key)) errors[key] = `Unknown workflow input: ${key}.`;
            }
        }
        for (const input of schemaInputs || []) {
            const hasOwn = Boolean(values) && typeof values === 'object' && Object.prototype.hasOwnProperty.call(values, input.name);
            const raw = hasOwn ? values[input.name] : undefined;
            if (!hasOwn || raw === undefined || raw === null) {
                if (input.required) errors[input.name] = 'This input is required.';
                continue;
            }
            if (input.type === 'string' || input.type === 'environment') {
                if (typeof raw !== 'string') { errors[input.name] = 'Enter text for this input.'; continue; }
                // Preserve whitespace/UTF-8/multiline exactly; required means non-empty.
                if (input.required && raw === '') { errors[input.name] = 'This input is required.'; continue; }
                // Optional empty uses repo default (omitted); explicitly cleared
                // strings are prefilled with defaults so empty here means cleared.
                if (raw === '' && !input.required) { payload[input.name] = ''; continue; }
                payload[input.name] = raw;
            } else if (input.type === 'boolean') {
                // Required false and optional false are both valid; never use HTML required.
                let coerced = raw;
                if (typeof raw === 'string') {
                    if (raw === 'true') coerced = true;
                    else if (raw === 'false') coerced = false;
                    else { errors[input.name] = 'Choose true or false.'; continue; }
                }
                if (typeof coerced !== 'boolean') { errors[input.name] = 'Choose true or false.'; continue; }
                payload[input.name] = coerced;
            } else if (input.type === 'number') {
                if (raw === '' && !input.required) continue;
                if (raw === '' && input.required) { errors[input.name] = 'This input is required.'; continue; }
                // Booleans/objects/whitespace never coerce: Number('   ') is 0
                // and must not become a genuine zero.
                if (typeof raw === 'boolean' || (typeof raw === 'object' && raw !== null)) { errors[input.name] = 'Enter a finite number.'; continue; }
                if (typeof raw === 'string' && raw.trim() === '') {
                    if (input.required) errors[input.name] = 'This input is required.';
                    continue;
                }
                const numeric = typeof raw === 'number' ? raw : Number(String(raw));
                if (!Number.isFinite(numeric)) { errors[input.name] = 'Enter a finite number.'; continue; }
                // Required zero is valid; check presence, not truthiness.
                payload[input.name] = numeric;
            } else if (input.type === 'choice') {
                if (typeof raw !== 'string') { errors[input.name] = 'Choose one of the listed options.'; continue; }
                if (raw === '' && !input.required) continue;
                if (raw === '' && input.required) { errors[input.name] = 'This input is required.'; continue; }
                if (!input.options || !input.options.includes(raw)) { errors[input.name] = 'Choose one of the listed options.'; continue; }
                payload[input.name] = raw;
            }
        }
        return { ok: Object.keys(errors).length === 0, errors, inputs: payload };
    }

    function isPayloadTooLarge(ref, inputs) {
        try { return JSON.stringify({ ref: String(ref), inputs: inputs || {} }).length > MAX_PAYLOAD_CHARS; }
        catch { return true; }
    }

    return { MAX_INPUTS, MAX_PAYLOAD_CHARS, MAX_YAML_BYTES, MAX_DESCRIPTION_CHARS, MAX_OPTIONS, MAX_OPTION_CHARS, SUPPORTED_TYPES, parseWorkflowYaml, validateDispatchValues, isPayloadTooLarge };
});
