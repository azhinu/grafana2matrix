import EventEmitter from 'node:events';
import { fetchWithRetry } from './fetch.js';

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const decodeHtmlEntities = (value) => String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const createSafeLink = (label, rawUrl) => {
    try {
        const url = new URL(decodeHtmlEntities(rawUrl));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return label;
        }

        return `<a href="${escapeHtml(url.href)}">${label}</a>`;
    } catch {
        return label;
    }
};

const protectAllowedHtml = (messageContent) => {
    const allowedTags = [];
    const protectedContent = String(messageContent).replace(/<\/font>|<font color="#[0-9a-fA-F]{6}">/g, (tag) => {
        const placeholder = `\0G2M_ALLOWED_HTML_${allowedTags.length}\0`;
        allowedTags.push({ placeholder, tag });
        return placeholder;
    });

    return { protectedContent, allowedTags };
};

const restoreAllowedHtml = (formattedBody, allowedTags) => {
    let restoredBody = formattedBody;
    for (const { placeholder, tag } of allowedTags) {
        restoredBody = restoredBody.replaceAll(placeholder, tag);
    }
    return restoredBody;
};

const formatHtmlMessage = (messageContent) => {
    const { protectedContent, allowedTags } = protectAllowedHtml(messageContent);
    let formattedBody = escapeHtml(protectedContent);
    formattedBody = restoreAllowedHtml(formattedBody, allowedTags);

    formattedBody = formattedBody
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\(([^\s]+)\)/g, (_match, label, rawUrl) => createSafeLink(label, rawUrl))
        .replace(/\n/g, '<br>');

    return formattedBody;
};

const isReplyMessage = (event) => {
    const relatesTo = event.content?.['m.relates_to'];
    return Boolean(relatesTo?.['m.in_reply_to']?.event_id || relatesTo?.rel_type === 'm.thread');
};

class MatrixServer extends EventEmitter{

    constructor(homeserver, roomID, token) {
        super()
        this.homeserver = homeserver;
        this.roomID = roomID;
        this.token = token;
        this.nextBatch = null;
        this.userId = null;
        this.loop();
    }

    async safeEmitAsync(eventName, payload) {
        const listeners = this.listeners(eventName);

        for (const listener of listeners) {
            try {
                await listener(payload);
            } catch (error) {
                console.error(`Matrix ${eventName} handler failed:`, error);
            }
        }
    }

    async getUserId() {
        try {
            const res = await fetchWithRetry(`${this.homeserver}/_matrix/client/v3/account/whoami`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error(`Whoami failed: ${res.status}`);
            const data = await res.json();
            this.userId = data.user_id;
        } catch (err) {
            console.error('Failed to get user ID:', err.message);
            throw err;
        }
    }

    updateConfig(homeserver, roomID, token) {
        let thingsChangedFlag = false;

        if (this.roomID !== roomID) {
            // If we switch room, we need to pull all messages.
            this.nextBatch = null;
            this.roomID = roomID;
            thingsChangedFlag = true;
        }
        
        // Reset userId so it gets re-fetched with new token/server if needed
        if (this.homeserver !== homeserver || this.token !== token) {

            this.homeserver = homeserver;
            this.token = token;
            
            this.userId = null; 
            thingsChangedFlag = true;
        }

        console.log('MatrixServer config updated');
        return thingsChangedFlag;
    }

    async loop () {
        try {
            if (!this.userId) {
                await this.getUserId();
            }

            let data;
            const isInitialSync = this.nextBatch === null;
            if (isInitialSync) {
                data = await this.getNextBatch();
            } else {
                data = await this.getNextBatch(30000, this.nextBatch || '');
            }
            
            this.nextBatch = data.next_batch;
            
            // Process events
            const rooms = data.rooms?.join || {};
            if (rooms[this.roomID]) {
                 const timeline = rooms[this.roomID].timeline?.events || [];
                 for (const event of timeline) {
                     if (isInitialSync && event.origin_server_ts < Date.now() - 15 * 60 * 1000) {
                         continue;
                     }

                     if (event.type === 'm.reaction') {
                         const relatesTo = event.content?.['m.relates_to'];
                         if (relatesTo && relatesTo.rel_type === 'm.annotation') {
                             const key = relatesTo.key; // The emoji
                             const targetEventId = relatesTo.event_id;
                             
                            await this.safeEmitAsync("reaction", {key: key, targetEventId: targetEventId});
                         }
                     } else if (event.type === 'm.room.message') {
                        const alreadyReacted = await this.hasUserReacted(event.event_id, '☑️');
                        if (alreadyReacted) {
                            continue;
                        }

                        // A user may operate the bot from the same Matrix account as its access token.
                        // Ignore the bot's own notifications, but allow its replies to reach command handling.
                        if (event.sender !== this.userId || isReplyMessage(event)) {
                            await this.safeEmitAsync('userMessage', event);
                        }
                     }
                 }
            }
            await this.safeEmitAsync('loop');

        } catch (error) {
            console.error('Sync error:', error.message);
            await new Promise(r => setTimeout(r, 5000)); // Backoff
        }
        setImmediate(() => this.loop());
    };

    async hasUserReacted(eventId, key) {
        try {
            const url = `${this.homeserver}/_matrix/client/v1/rooms/${encodeURIComponent(this.roomID)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction?limit=100`;
            const res = await fetchWithRetry(url, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) {
                return false;
            }

            const data = await res.json();
            const chunk = data.chunk || [];
            
            return chunk.some(r => r.sender === this.userId && r.content?.['m.relates_to']?.key === key);
        } catch (error) {
            console.error(`Error checking relations for ${eventId}:`, error.message);
            return false;
        }
    }

    async sendMatrixNotification (messageContent) {
        console.log(`Sending Matrix notification (length: ${messageContent.length})`);
        if (!this.token || !this.roomID) {
            console.error('Missing Matrix config, cannot send notification');
            return null;
        }
        const txnId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const url = `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomID)}/send/m.room.message/${txnId}`;

        try {
            const body = this.formatMessageBody(messageContent);
            const response = await fetchWithRetry(url, {
                method: 'PUT',
                body: JSON.stringify(body),
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            console.log(`Matrix event sent: ${data.event_id}`);
            return data.event_id;
        } catch (error) {
            console.error('Failed to send Matrix notification:', error.message);
            return null;
        }
    }

    async editMessage(eventId, newMessageContent) {
        console.log(`Editing Matrix message ${eventId}`);
        if (!this.token || !this.roomID) {
             console.error('Missing Matrix config, cannot edit message');
             return null;
        }
        
        const txnId = `${Date.now()}_edit_${Math.random().toString(36).substring(2, 9)}`;
        const url = `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomID)}/send/m.room.message/${txnId}`;
 
        try {
             const baseBody = this.formatMessageBody(newMessageContent);
             
             const body = {
                 "m.new_content": baseBody,
                 "m.relates_to": {
                     "rel_type": "m.replace",
                     "event_id": eventId
                 },
                 ...baseBody
             };
 
             const response = await fetchWithRetry(url, {
                 method: 'PUT',
                 body: JSON.stringify(body),
                 headers: {
                     'Authorization': `Bearer ${this.token}`,
                     'Content-Type': 'application/json'
                 }
             });
 
             if (!response.ok) {
                 throw new Error(`HTTP error! status: ${response.status}`);
             }
 
             const data = await response.json();
             console.log(`Matrix event edited: ${data.event_id}`);
             return data.event_id;
        } catch (error) {
             console.error('Failed to edit Matrix message:', error.message);
             return null;
        }
     }

    formatMessageBody(messageContent) {
        return {
            body: messageContent,
            format: "org.matrix.custom.html",
            formatted_body: formatHtmlMessage(messageContent),
            msgtype: "m.text"
        };
    }

    async getNextBatch(timeout = 0, since = null) {
        let url = `${this.homeserver}/_matrix/client/v3/sync?timeout=${timeout}`
        if (since !== null) {
            url += `&since=${since}`
        }
        const res = await fetchWithRetry(url, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        }, {
            baseTimeoutMs: timeout + 5000,
        });

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        const data = await res.json();
        return data;
    }

    async sendReaction(matrixEventId, key = '☑️') {
         const reactionTxnId = `${Date.now()}_react_${Math.random().toString(36).substring(2, 9)}`;
            try {
                const reactRes = await fetchWithRetry(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomID)}/send/m.reaction/${reactionTxnId}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        "m.relates_to": {
                            "rel_type": "m.annotation",
                            "event_id": matrixEventId,
                            "key": key
                        }
                    }),
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (!reactRes.ok) {
                    throw new Error(`HTTP error! status: ${reactRes.status}`);
                }
            } catch (reactErr) {
                console.error('Failed to send confirmation reaction:', reactErr.message);
            }
    }
    async listJoinedRooms() {

        console.log('Fetching joined rooms...');
        try {
            const res = await fetchWithRetry(`${this.homeserver}/_matrix/client/v3/joined_rooms`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            const data = await res.json();

            const rooms = data.joined_rooms || [];
            console.log(`Joined to ${rooms.length} rooms:`);

            for (const roomId of rooms) {
                let name = '';
                try {
                    const nameRes = await fetchWithRetry(`${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, {
                        headers: { 'Authorization': `Bearer ${this.token}` }
                    });
                    if (nameRes.ok) {
                        const nameData = await nameRes.json();
                        name = nameData.name;
                    }
                } catch (err) {
                    console.error(`Failed to fetch name for room ${roomId}:`, err.message)
                }
                console.log(`- ${roomId}${name ? ` (${name})` : ''}`);
            }
        } catch (error) {
            console.error('Failed to fetch joined rooms:', error.message);
        }
    }
}

export { isReplyMessage, MatrixServer };
