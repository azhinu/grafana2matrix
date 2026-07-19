const DURATION_UNIT_TO_MS = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000
};

const formatDuration = (days = 0, hours = 0, minutes = 0) => {
    const parts = [];

    if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);

    return parts.join(' ');
};

const parseDurationInput = (rawInput) => {
    if (!rawInput || typeof rawInput !== 'string') return null;

    const input = rawInput.trim().toLowerCase();
    if (!input) return null;

    let days = 0;
    let hours = 0;
    let minutes = 0;

    if (/^\d+(?::\d+){0,2}$/.test(input)) {
        [days = 0, hours = 0, minutes = 0] = input.split(':').map(Number);
    } else if (/^\d+d(?:\d+h)?(?:\d+m)?$|^\d+h(?:\d+m)?$|^\d+m$/.test(input)) {
        for (const [, amountRaw, unit] of input.matchAll(/(\d+)([dhm])/g)) {
            const amount = Number(amountRaw);
            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }
    } else if (/^(?:\d+\s*(?:days?|hours?|minutes?|mins?|d|h|m)\s*)+$/.test(input)) {
        let lastRank = -1;
        const rank = { d: 0, h: 1, m: 2 };

        for (const [, amountRaw, rawUnit] of input.matchAll(/(\d+)\s*(days?|hours?|minutes?|mins?|d|h|m)/g)) {
            const amount = Number(amountRaw);
            let unit = rawUnit;
            if (rawUnit.startsWith('day')) unit = 'd';
            if (rawUnit.startsWith('hour')) unit = 'h';
            if (rawUnit.startsWith('min')) unit = 'm';

            if (rank[unit] < lastRank) return null;
            lastRank = rank[unit];

            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }
    } else {
        return null;
    }

    const durationMs = (days * DURATION_UNIT_TO_MS.d) + (hours * DURATION_UNIT_TO_MS.h) + (minutes * DURATION_UNIT_TO_MS.m);
    if (durationMs <= 0) return null;

    return { durationMs, text: formatDuration(days, hours, minutes) };
};

const getReplyBody = (content = {}) => {
    const body = content['m.new_content']?.body ?? content.body;
    if (typeof body !== 'string') return body;

    const fallbackEnd = body.indexOf('\n\n');
    return body.startsWith('> ') && fallbackEnd !== -1 ? body.slice(fallbackEnd + 2) : body;
};

const getNumberEmojiDays = (key) => {
    const normalizedKey = String(key).replace(/[\uFE0E\uFE0F]/g, '');
    const match = normalizedKey.match(/^([1-7])\u20E3$/);
    return match ? Number(match[1]) : null;
};

const isDeleteCommand = (input) => /^(?:del|delete)$/i.test(String(input).trim());

export { DURATION_UNIT_TO_MS, getNumberEmojiDays, getReplyBody, isDeleteCommand, parseDurationInput };
