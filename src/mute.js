const DURATION_UNIT_TO_MS = {
    M: 30 * 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000
};

const formatDuration = (months = 0, weeks = 0, days = 0, hours = 0, minutes = 0) => {
    const parts = [];

    if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`);
    if (weeks > 0) parts.push(`${weeks} week${weeks === 1 ? '' : 's'}`);
    if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
    if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);

    return parts.join(' ');
};

const parseDurationInput = (rawInput) => {
    if (!rawInput || typeof rawInput !== 'string') return null;

    const input = rawInput.trim();
    if (!input) return null;

    let months = 0;
    let weeks = 0;
    let days = 0;
    let hours = 0;
    let minutes = 0;

    if (/^\d+(?::\d+){0,2}$/.test(input)) {
        [days = 0, hours = 0, minutes = 0] = input.split(':').map(Number);
    } else if (/^\d+[wWdM](?:\d+[dhm])*$/.test(input)) {
        for (const [, amountRaw, unit] of input.matchAll(/(\d+)([wWdM])/g)) {
            const amount = Number(amountRaw);
            if (unit.toLowerCase() === 'w') weeks = amount;
            if (unit === 'M') months = amount;
            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }
    } else if (/^\d+(?:\s*(?:weeks?|days?|hours?|minutes?|mins?|w|d|h|m|M)\s*)+$/.test(input)) {
        let lastRank = -1;
        const rank = { M: 0, w: 1, d: 2, h: 3, m: 4 };

        for (const [, amountRaw, rawUnit] of input.matchAll(/(\d+)\s*(weeks?|days?|hours?|minutes?|mins?|w|d|h|m|M)/gi)) {
            const amount = Number(amountRaw);
            let unit = rawUnit;
            if (/^weeks?$/i.test(rawUnit)) unit = 'w';
            if (/^days?$/i.test(rawUnit)) unit = 'd';
            if (/^hours?$/i.test(rawUnit)) unit = 'h';
            if (/^mins?$|^minutes?$/i.test(rawUnit)) unit = 'm';

            // Uppercase M means month; lowercase m means minute.
            if (rawUnit === 'M') unit = 'M';

            if (rank[unit] < lastRank) return null;
            lastRank = rank[unit];

            if (unit === 'M') months = amount;
            if (unit === 'w') weeks = amount;
            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }
    } else if (/^\d+d(?:\d+h)?(?:\d+m)?$|^\d+h(?:\d+m)?$|^\d+m$/.test(input.toLowerCase())) {
        for (const [, amountRaw, unit] of input.toLowerCase().matchAll(/(\d+)([dhm])/g)) {
            const amount = Number(amountRaw);
            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }
    } else {
        return null;
    }

    const durationMs = (months * DURATION_UNIT_TO_MS.M) + (weeks * DURATION_UNIT_TO_MS.w) + (days * DURATION_UNIT_TO_MS.d) + (hours * DURATION_UNIT_TO_MS.h) + (minutes * DURATION_UNIT_TO_MS.m);
    if (durationMs <= 0) return null;

    return { durationMs, text: formatDuration(months, weeks, days, hours, minutes) };
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
