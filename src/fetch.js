const DEFAULT_TIMEOUTS_MS = [5000, 10000, 15000];
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

const isRetryableResponse = (response) => {
    return RETRYABLE_HTTP_STATUSES.has(response.status) || response.status >= 500;
};

const getErrorMessage = (error) => {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return 'Request timed out';
    }

    return error?.message || String(error);
};

const buildTimeouts = (baseTimeoutMs = DEFAULT_TIMEOUTS_MS[0], attempts = DEFAULT_TIMEOUTS_MS.length) => {
    return Array.from({ length: attempts }, (_, index) => baseTimeoutMs + index * 5000);
};

const fetchWithRetry = async (url, options = {}, retryOptions = {}) => {
    const timeoutsMs = retryOptions.timeoutsMs ?? buildTimeouts(retryOptions.baseTimeoutMs);
    let lastError;

    for (let attemptIndex = 0; attemptIndex < timeoutsMs.length; attemptIndex += 1) {
        const timeoutMs = timeoutsMs[attemptIndex];
        const attempt = attemptIndex + 1;

        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(timeoutMs),
            });

            if (!isRetryableResponse(response) || attempt === timeoutsMs.length) {
                return response;
            }

            console.warn(`Fetch attempt ${attempt} failed with status ${response.status}; retrying with ${timeoutsMs[attemptIndex + 1]}ms timeout.`);
        } catch (error) {
            lastError = error;

            if (attempt === timeoutsMs.length) {
                throw error;
            }

            console.warn(`Fetch attempt ${attempt} failed: ${getErrorMessage(error)}; retrying with ${timeoutsMs[attemptIndex + 1]}ms timeout.`);
        }
    }

    throw lastError;
};

export { fetchWithRetry };
