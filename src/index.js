import express from 'express';
import { MatrixServer } from './matrix.js';
import { createMatrixMessage, createSummaryMessage, createSilencesMessage } from './messages.js';
import { checkMentionMessages, checkSchedule, getSilencesFilterFunction, getSeverityMatchFunction, getAlertValue } from './util.js';
import { 
    initDB, 
    getAllActiveAlerts, 
    getActiveAlert, 
    hasActiveAlert, 
    setActiveAlert, 
    deleteActiveAlert, 
    getAlertIdFromEvent, 
    hasMessageMap, 
    setMessageMap,
    deleteMessageMapByAlertId,
    deleteAllMessageMaps,
    getBotState,
    setBotState,
    deleteBotState} from './db.js';
import { config, reloadConfig } from './config.js';
import { sendGrafanaSilence, fetchGrafanaSilences, fetchGrafanaActiveAlerts } from './grafana.js';
import { notifyWebhookProcessingError } from './webhook-error.js';

const app = express();

initDB();

if (!config.MATRIX_ACCESS_TOKEN || !config.MATRIX_ROOM_ID || !config.MATRIX_HOMESERVER_URL) {
    throw new Error("MATRIX_ACCESS_TOKEN or MATRIX_ROOM_ID or MATRIX_HOMESERVER_URL is not defined in environment variables or config file");
}


app.use(express.json());

app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

const matrix = new MatrixServer(config.MATRIX_HOMESERVER_URL, config.MATRIX_ROOM_ID, config.MATRIX_ACCESS_TOKEN);

const DURATION_UNIT_TO_MS = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000
};

const formatDuration = (days = 0, hours = 0, minutes = 0) => {
    const parts = [];

    if (days > 0) {
        parts.push(`${days} day${days === 1 ? '' : 's'}`);
    }
    if (hours > 0) {
        parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
    }
    if (minutes > 0) {
        parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
    }

    return parts.join(' ');
};

const parseDurationInput = (rawInput) => {
    if (!rawInput || typeof rawInput !== 'string') {
        return null;
    }

    const input = rawInput.trim().toLowerCase();
    if (!input) {
        return null;
    }

    // Colon format: D:H:M (left to right, missing tail segments allowed)
    if (/^\d+(?::\d+){0,2}$/.test(input)) {
        const parts = input.split(':').map(Number);
        if (parts.some(Number.isNaN)) {
            return null;
        }

        const [days = 0, hours = 0, minutes = 0] = parts;
        const durationMs = (days * DURATION_UNIT_TO_MS.d) + (hours * DURATION_UNIT_TO_MS.h) + (minutes * DURATION_UNIT_TO_MS.m);
        if (durationMs <= 0) {
            return null;
        }

        return {
            durationMs,
            text: formatDuration(days, hours, minutes)
        };
    }

    // Compact format: 2d1h10m
    if (/^\d+d(?:\d+h)?(?:\d+m)?$|^\d+h(?:\d+m)?$|^\d+m$/.test(input)) {
        const matches = [...input.matchAll(/(\d+)([dhm])/g)];
        let days = 0;
        let hours = 0;
        let minutes = 0;
        let lastRank = -1;
        const rank = { d: 0, h: 1, m: 2 };

        for (const [, amountRaw, unit] of matches) {
            const amount = Number(amountRaw);
            if (Number.isNaN(amount)) {
                return null;
            }

            if (rank[unit] < lastRank) {
                return null;
            }

            lastRank = rank[unit];

            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }

        const durationMs = (days * DURATION_UNIT_TO_MS.d) + (hours * DURATION_UNIT_TO_MS.h) + (minutes * DURATION_UNIT_TO_MS.m);
        if (durationMs <= 0) {
            return null;
        }

        return {
            durationMs,
            text: formatDuration(days, hours, minutes)
        };
    }

    // Word format: 2 hours 30 minutes, 1 day, 1 hour
    if (/^(?:\d+\s*(?:days?|hours?|minutes?|mins?|d|h|m)\s*)+$/.test(input)) {
        const matches = [...input.matchAll(/(\d+)\s*(days?|hours?|minutes?|mins?|d|h|m)/g)];
        let days = 0;
        let hours = 0;
        let minutes = 0;
        let lastRank = -1;
        const rank = { d: 0, h: 1, m: 2 };

        for (const [, amountRaw, rawUnit] of matches) {
            const amount = Number(amountRaw);
            if (Number.isNaN(amount)) {
                return null;
            }

            let unit = rawUnit;
            if (rawUnit.startsWith('day')) unit = 'd';
            if (rawUnit.startsWith('hour')) unit = 'h';
            if (rawUnit.startsWith('min')) unit = 'm';

            if (rank[unit] < lastRank) {
                return null;
            }

            lastRank = rank[unit];

            if (unit === 'd') days = amount;
            if (unit === 'h') hours = amount;
            if (unit === 'm') minutes = amount;
        }

        const durationMs = (days * DURATION_UNIT_TO_MS.d) + (hours * DURATION_UNIT_TO_MS.h) + (minutes * DURATION_UNIT_TO_MS.m);
        if (durationMs <= 0) {
            return null;
        }

        return {
            durationMs,
            text: formatDuration(days, hours, minutes)
        };
    }

    return null;
};

const buildAlertLabelsKey = (labels = {}) => {
    return Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${value}`)
        .join('|');
};

const buildActiveAlertsIndex = (alertsFromGrafana) => {
    const fingerprints = new Set();
    const labelKeys = new Set();

    for (const alert of alertsFromGrafana) {
        const statusState = alert.status?.state;
        if (statusState === 'resolved') {
            continue;
        }

        if (alert.fingerprint) {
            fingerprints.add(alert.fingerprint);
        }

        const labels = alert.labels || {};
        const labelKey = buildAlertLabelsKey(labels);
        if (labelKey) {
            labelKeys.add(labelKey);
        }
    }

    return { fingerprints, labelKeys };
};

const isAlertVerifiedAsActive = (alert, activeAlertsIndex) => {
    if (!activeAlertsIndex) {
        return false;
    }

    if (alert.fingerprint && activeAlertsIndex.fingerprints.has(alert.fingerprint)) {
        return true;
    }

    const labelKey = buildAlertLabelsKey(alert.labels || {});
    return Boolean(labelKey) && activeAlertsIndex.labelKeys.has(labelKey);
};

const getVerifiedActiveAlerts = (alerts, activeAlertsIndex) => {
    return alerts.filter((alert) => isAlertVerifiedAsActive(alert, activeAlertsIndex));
};

const pruneUnverifiedActiveAlerts = (alerts, activeAlertsIndex) => {
    for (const alert of alerts) {
        if (!isAlertVerifiedAsActive(alert, activeAlertsIndex)) {
            if (alert.fingerprint) {
                console.log(`Pruning stale DB alert (not active in Grafana): ${alert.fingerprint} (${alert.labels?.alertname})`);
                deleteActiveAlert(alert.fingerprint);
                deleteMessageMapByAlertId(alert.fingerprint);
            }
        }
    }
};

const fetchVerifiedActiveAlertsFromDB = async () => {
    const alertsFromGrafana = await fetchGrafanaActiveAlerts();

    if (!alertsFromGrafana) {
        return null;
    }

    const activeAlertsIndex = buildActiveAlertsIndex(alertsFromGrafana);
    const dbAlerts = getAllActiveAlerts();
    pruneUnverifiedActiveAlerts(dbAlerts, activeAlertsIndex);
    return getVerifiedActiveAlerts(dbAlerts, activeAlertsIndex);
};

const sendSummary = async (severity, enforceSending = false, verifiedAlerts = null) => {
    const alertsForSeverity = [];
    
    const matcherFunc = getSeverityMatchFunction(severity);

    const activeAlerts = verifiedAlerts ?? await fetchVerifiedActiveAlertsFromDB();
    if (!activeAlerts) {
        console.warn(`Skipping summary for severity ${severity}: failed to verify active alerts in Grafana.`);
        return;
    }

    for (const alert of activeAlerts) {
        const sev = getAlertValue(alert, "severity", "UNKNOWN").toUpperCase();        

        if (matcherFunc(sev)) {
            alertsForSeverity.push(alert);
        }
    }

    if (config.SUMMARY_SCHEDULE_SKIP_EMPTY && alertsForSeverity.length === 0 && !enforceSending) {
        console.log(`Skipping summary for severity: ${severity}`);
        return;
    } else {
        console.log(`Sending summary for severity: ${severity}`);
        const silencesWithSeverity = (await fetchGrafanaSilences()).filter(getSilencesFilterFunction(severity));
        const summaryMessage = createSummaryMessage(severity, alertsForSeverity, silencesWithSeverity);
        await matrix.sendMatrixNotification(summaryMessage);
    }
};

async function createGrafanaSilence(alertId, matrixEventId, durationMs = DURATION_UNIT_TO_MS.d, durationText = '24h') {
    const alert = getActiveAlert(alertId);

    if (!alert) {
        console.error('Alert not found for silence:', alertId);
        return;
    }

    const now = new Date();
    const endTime = new Date(now.getTime() + durationMs);
    
    const silenceResult = await sendGrafanaSilence(alert, now, endTime);
    let reaction = '☑️';
    const host = getAlertValue(alert, "host") ?? getAlertValue(alert, "instance") ?? "Unknown Host";
    const severity = getAlertValue(alert, "severity", "UNKNOWN");

    if (silenceResult) {
        console.log(`Alert ${alertId} silenced successfully for ${durationText}.`);
        
        await matrix.sendMatrixNotification(`🔇 Alert silenced for ${durationText}: ${severity} ${host} ${alert.labels.alertname}`);
        deleteActiveAlert(alertId);
        deleteMessageMapByAlertId(alertId);

    } else {
        await matrix.sendMatrixNotification(`Alert could not be silenced: ${severity} ${host} ${alert.labels.alertname}`);
        reaction = '⛔️';
    }

    if (matrixEventId) {
        matrix.sendReaction(matrixEventId, reaction);
    }
}

async function deleteAndSilenceAlert(alertId, matrixEventId, durationDays = 60) {
    const alert = getActiveAlert(alertId);

    if (!alert) {
        console.error('Alert not found for deletion:', alertId);
        return;
    }

    const now = new Date();
    const endTime = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
    
    const silenceResult = await sendGrafanaSilence(alert, now, endTime);
    let reaction = '☑️';
    const host = getAlertValue(alert, "host") ?? getAlertValue(alert, "instance") ?? "Unknown Host";
    const severity = getAlertValue(alert, "severity", "UNKNOWN");

    if (silenceResult) {
        console.log(`Alert ${alertId} deleted and silenced for ${durationDays} days.`);
        
        await matrix.sendMatrixNotification(`🚮 Alert deleted and silenced for ${durationDays} days: ${severity} ${host} ${alert.labels.alertname}`);
        deleteActiveAlert(alertId);
        deleteMessageMapByAlertId(alertId);

    } else {
        await matrix.sendMatrixNotification(`Alert could not be processed: ${severity} ${host} ${alert.labels.alertname}`);
        reaction = '⛔️';
    }

    if (matrixEventId) {
        matrix.sendReaction(matrixEventId, reaction);
    }
}

matrix.on("reaction", async (reaction) => {
    const {key, targetEventId} = reaction;

    if (!hasMessageMap(targetEventId)) {
        return;
    }

    const alertId = getAlertIdFromEvent(targetEventId);

    // Mute for 24h
    if (key === '🔇' || key === ':mute:') {
        console.log(`Received mute reaction for event ${targetEventId}, alert ${alertId}`);
        await createGrafanaSilence(alertId, targetEventId, DURATION_UNIT_TO_MS.d, '24h');
    }

    // Delete and silence for 60 days (2 months)
    if (key === '🚮' || key === '❌' || key === '❌️') {
        console.log(`Received delete reaction for event ${targetEventId}, alert ${alertId}`);
        await deleteAndSilenceAlert(alertId, targetEventId, 60);
    }

    // Silence for N days based on number emoji
    const numberEmojiMap = {
        '1️⃣': 1, '2️⃣': 2, '3️⃣': 3, '4️⃣': 4, '5️⃣': 5, '6️⃣': 6, '7️⃣': 7
    };

    if (numberEmojiMap[key]) {
        const days = numberEmojiMap[key];
        console.log(`Received reaction for ${days} day(s) silence for event ${targetEventId}, alert ${alertId}`);
        await createGrafanaSilence(alertId, targetEventId, days * DURATION_UNIT_TO_MS.d, `${days} day${days === 1 ? '' : 's'}`);
    }
})

matrix.on("loop", () => {
    setBotState('last_matrix_received', new Date().toISOString());
})

matrix.on("userMessage", async (event) => {
    const body = event.content?.body;
    if (!body) {
        return;
    } 

    const replyToEventId = event.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    if (replyToEventId && hasMessageMap(replyToEventId)) {
        const parsedDuration = parseDurationInput(body);

        if (parsedDuration) {
            const alertId = getAlertIdFromEvent(replyToEventId);
            console.log(`Received reply silence request for event ${replyToEventId}, alert ${alertId}: ${parsedDuration.text}`);
            await createGrafanaSilence(alertId, replyToEventId, parsedDuration.durationMs, parsedDuration.text);
            await matrix.sendReaction(event.event_id, '☑️');
            return;
        }
    }

    if (body.startsWith(".summary")) {
        await matrix.sendReaction(event.event_id, '☑️');
        const parts = body.split(/\s+/);
        if (parts.length > 1) {
            const severity = parts[1].toUpperCase();
            console.log(`Received manual summary request for: ${severity}`);
            await sendSummary(severity, true);
        } else {
            await matrix.sendMatrixNotification("Usage: .summary <severity> (e.g. CRITICAL, WARNING)");
        }
    }

    if (body.startsWith(".silences")) {
        await matrix.sendReaction(event.event_id, '☑️');
        let filterFunc = () => true;
        const parts = body.split(/\s+/);

        if (parts.length > 1) {
            filterFunc = getSilencesFilterFunction(parts[1]);
        }

        try {
            console.log("Fetching silences...");
            const silences = (await fetchGrafanaSilences()).filter(filterFunc);
            const message = createSilencesMessage(silences);
            await matrix.sendMatrixNotification(message);
        } catch (error) {
            console.error("Failed to fetch silences:", error);
            await matrix.sendReaction(event.event_id, '❌');
            await matrix.sendMatrixNotification(`Failed to fetch silences: ${error.message}`);
        }
    }

    if (body === ".reload-config") {
        await matrix.sendReaction(event.event_id, '☑️');
        try {
            console.log("Reloading configuration...");
            reloadConfig();
            
            // Update matrix server instance with new config
            const matrixUpdated = matrix.updateConfig(config.MATRIX_HOMESERVER_URL, config.MATRIX_ROOM_ID, config.MATRIX_ACCESS_TOKEN);

            if (matrixUpdated) {
                console.log("Matrix settings changed. Clearing stored Matrix message IDs.");
                deleteAllMessageMaps();
                deleteBotState('status_message_id');
            }

            await matrix.sendReaction(event.event_id, '✅');
            console.log("Configuration reloaded.");
        } catch (error) {
            console.error("Failed to reload config:", error);
            await matrix.sendReaction(event.event_id, '❌');
            await matrix.sendMatrixNotification(`Failed to reload config: ${error.message}`);
        }
    }
});

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        
        console.log('Received webhook:', JSON.stringify(data, null, 2));

        setBotState('last_webhook_received', new Date().toISOString());

        // Handle Grafana Unified Alerting (Prometheus style)
        if (data.alerts && Array.isArray(data.alerts)) {
            const alertsToNotify = [];

            // Filter and Deduplicate
            for (const alert of data.alerts) {
                const id = alert.fingerprint;
                const alertStatus = alert.status; // 'firing' or 'resolved'

                if (!id) {
                    console.warn(`Skipping unified alert without fingerprint: ${alert.labels?.alertname || 'Unknown Alert'}`);
                    continue;
                }

                if (alertStatus === 'firing') {
                    if (!hasActiveAlert(id)) {
                        console.log(`New firing alert: ${id} (${alert.labels?.alertname})`);
                        alertsToNotify.push(alert);
                        alert.mentionsSent = { primary: false, secondary: false };
                    } else {
                        const existing = getActiveAlert(id);
                        alert.mentionsSent = existing.mentionsSent || { primary: false, secondary: false };    
                    }

                    // Always update/add the alert to map to keep latest state
                    setActiveAlert(id, alert);
                } else if (alertStatus === 'resolved') {
                    if (hasActiveAlert(id)) {
                        console.log(`Alert resolved: ${id} (${alert.labels?.alertname})`);
                        deleteActiveAlert(id);
                        deleteMessageMapByAlertId(id);
                        alertsToNotify.push(alert);
                    } else {
                        alertsToNotify.push(alert);
                    }
                }
            }

            if (alertsToNotify.length === 0) {
                console.log('No state changes detected (all alerts are duplicates). Skipping individual Matrix notification.');

                const verifiedActiveAlerts = await fetchVerifiedActiveAlertsFromDB();
                if (!verifiedActiveAlerts) {
                    console.warn('Skipping repeat notifications for webhook duplicates: failed to verify active alerts in Grafana.');
                    return res.status(200).send('Processed');
                }

                const verifiedAlertFingerprints = new Set(verifiedActiveAlerts.map((a) => a.fingerprint).filter(Boolean));
                const verifiedWebhookAlerts = data.alerts.filter((a) => a.fingerprint && verifiedAlertFingerprints.has(a.fingerprint));

                const messages = checkMentionMessages(verifiedWebhookAlerts, "webhook");

                for (const msg of messages) {
                    await matrix.sendMatrixNotification(msg);
                }

                return res.status(200).send('Processed');
            }

            // Send separate message for each alert
            for (const a of alertsToNotify) {
               
                const matrixMessage = createMatrixMessage(a);

                const sentEventId = await matrix.sendMatrixNotification(matrixMessage);
                if (sentEventId && a.status === 'firing') {
                     const id = a.fingerprint;
                     setMessageMap(sentEventId, id);
                }
            }

            // Prune zombie alerts (alerts that are in DB but not in the current webhook request, but ONLY for alertnames present in the webhook)
            const receivedAlertIds = new Set(data.alerts.map(a => a.fingerprint).filter(Boolean));
            const receivedAlertNames = new Set(data.alerts.map(a => a.labels?.alertname).filter(Boolean));
            const activeAlerts = getAllActiveAlerts();

            for (const activeAlert of activeAlerts) {
                const activeAlertName = activeAlert.labels?.alertname;
                if (activeAlertName && receivedAlertNames.has(activeAlertName) && !receivedAlertIds.has(activeAlert.fingerprint)) {
                    console.log(`Pruning zombie alert: ${activeAlert.fingerprint} (${activeAlertName})`);
                    deleteActiveAlert(activeAlert.fingerprint);
                    deleteMessageMapByAlertId(activeAlert.fingerprint);
                }
            }
        } 
        // Handle Legacy Grafana Alerting (No deduplication logic applied here as it's singular)
        else {
            const status = data.state;
            const title = data.title || 'Grafana Alert';
            const messageBody = data.message || 'No message provided';
            const ruleUrl = data.ruleUrl;

            const isAlerting = status === 'firing' || status === 'alerting';
            const icon = isAlerting ? '🚨' : '✅';
            const statusDisplay = isAlerting ? 'Firing' : 'Resolved';

            const matrixMessage = `## ${icon} ${statusDisplay}: ${title}\n\n` +
                                  `${messageBody}\n\n` +
                                  (ruleUrl ? `[View in Grafana](${ruleUrl})` : '');

            await matrix.sendMatrixNotification(matrixMessage);
        }
        
        console.log('Notification(s) sent to Matrix');
        res.status(200).send('Notification sent');

    } catch (error) {
        await notifyWebhookProcessingError(matrix, error);
        res.status(500).send('Error processing webhook');
    }
});

let counter = 0;
// Periodic Summary Logic
const checkSummariesAndMentions = async () => {
    const keepAliveInterval = config.KEEP_ALIVE_INTERVAL;

    if (keepAliveInterval > 0 && counter === 0) {

        let lastWebhook = getBotState('last_webhook_received');
        let lastMatrix = getBotState('last_matrix_received');

        if (lastWebhook) {
            lastWebhook = new Date(lastWebhook).toLocaleString("en-GB");
        } else {
            lastWebhook = 'Never';
        }

        if (lastMatrix) {
            lastMatrix = new Date(lastMatrix).toLocaleString("en-GB");
        } else {
            lastMatrix = 'Never';
        }
        const statusMessage = `Last Matrix Check: ${lastMatrix} (UTC) Last Webhook received: ${lastWebhook} (UTC)`;
        const storedStatusId = getBotState('status_message_id');
        
        if (storedStatusId) {
            // Try to edit
            await matrix.editMessage(storedStatusId, statusMessage);
        } else {
            // Create new
            const newId = await matrix.sendMatrixNotification(statusMessage);
            await matrix.sendMatrixNotification("The above message will be updated continuously. Consider pining it to the channel.")
            if (newId) {
                setBotState('status_message_id', newId);
            }
        }
    }   
    if (keepAliveInterval > 0) {
        counter = (counter + 1) % keepAliveInterval;
    } else {
        counter = 0;
    }
    
    const verifiedActiveAlerts = await fetchVerifiedActiveAlertsFromDB();
    if (!verifiedActiveAlerts) {
        console.warn('Skipping summary and repeat checks: failed to verify active alerts in Grafana.');
        return;
    }

    // Check mentions
    const messages = checkMentionMessages(verifiedActiveAlerts, "loop");

     for (const msg of messages) {
        await matrix.sendMatrixNotification(msg);
    }

    const sendCrit = await checkSchedule('CRIT', config.SUMMARY_SCHEDULE_CRIT || "6:00,14:30");
    const sendWarn = await checkSchedule('WARN', config.SUMMARY_SCHEDULE_WARN || "6:00,14:30");

    if (sendCrit) sendSummary("CRIT", false, verifiedActiveAlerts);
    if (sendWarn) sendSummary("WARN", false, verifiedActiveAlerts);
};

// Check every minute
setInterval(checkSummariesAndMentions, 60 * 1000);

app.listen(config.PORT, () => {
    console.log(`Server is running on port ${config.PORT}`);
    matrix.listJoinedRooms();
});
