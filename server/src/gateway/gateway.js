import { WebSocketServer } from 'ws';
import { verifyJwt } from '../auth/core.js';

export const GATEWAY_PATH = '/gateway';

export function createGateway({ server, pool, permissions, getPublicUserProfile }) {
  const { requireChannelAccess } = permissions;
  const wss = new WebSocketServer({ server, path: GATEWAY_PATH });

  // clients: { ws, userId, username, displayName, avatarUrl, channelId }
  const clients = new Set();

  // Presence (in-memory). Refcount allows multiple tabs/devices.
  const onlineRefCount = new Map(); // userId -> count
  function markOnline(userId) {
    const id = String(userId);
    onlineRefCount.set(id, (onlineRefCount.get(id) || 0) + 1);
  }

  function markOffline(userId) {
    const id = String(userId);
    const cur = onlineRefCount.get(id) || 0;
    if (cur <= 1) onlineRefCount.delete(id);
    else onlineRefCount.set(id, cur - 1);
  }

  function isUserOnline(userId) {
    return onlineRefCount.has(String(userId));
  }

  const WS_OPEN = 1; // WebSocket.OPEN

  function safeSend(ws, obj) {
    // In the `ws` library, OPEN is a constant on the WebSocket class, not the instance.
    // Use numeric 1 to avoid ws.OPEN confusion.
    if (ws && ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch (_) {
        // Ignore transient socket errors.
      }
    }
  }

  function broadcast(obj, predicate = () => true) {
    for (const c of clients) {
      if (predicate(c)) safeSend(c.ws, obj);
    }
  }

  function parseQuery(url) {
    const q = {};
    const idx = url.indexOf('?');
    if (idx < 0) return q;
    const s = url.slice(idx + 1);
    for (const part of s.split('&')) {
      const [k, v] = part.split('=');
      if (!k) continue;
      q[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
    return q;
  }

  wss.on('connection', (ws, req) => {
    const q = parseQuery(req.url ?? '');
    const token = q.token;
    if (!token) {
      ws.close(4401, 'missing token');
      return;
    }

    let user;
    try {
      user = verifyJwt(token);
    } catch {
      ws.close(4401, 'bad token');
      return;
    }

    const client = {
      ws,
      userId: String(user.sub),
      username: String(user.username ?? user.sub),
      displayName: null,
      avatarUrl: null,
      channelId: 'general',
    };
    clients.add(client);
    markOnline(client.userId);

    // Validate initial channel access (legacy clients may pass channelId in the URL).
    (async () => {
      const requested = String(q.channelId ?? 'general');
      let acc = await requireChannelAccess(requested, client.userId);
      if (!acc.ok && requested !== 'general') {
        acc = await requireChannelAccess('general', client.userId);
      }
      if (!acc.ok) {
        safeSend(ws, { t: 'ERROR', d: { code: 'FORBIDDEN', message: String(acc.error || 'forbidden') } });
        try {
          ws.close(4403, 'forbidden');
        } catch (_) {}
        clients.delete(client);
        markOffline(client.userId);
        return;
      }
      client.channelId = requested;
      const prof = await getPublicUserProfile(client.userId);
      client.displayName = prof?.displayName ?? null;
      client.avatarUrl = prof?.avatarUrl ?? null;
      safeSend(ws, {
        t: 'READY',
        d: {
          user: {
            id: client.userId,
            username: client.username,
            displayName: client.displayName,
            avatarUrl: client.avatarUrl,
          },
          channelId: client.channelId,
        },
      });
    })().catch(() => {
      try {
        ws.close(1011, 'internal');
      } catch (_) {}
      clients.delete(client);
      markOffline(client.userId);
    });

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      // минимальный протокол:
      // { op: "SUBSCRIBE", d: { channelId } }
      // { op: "TYPING", d: { channelId } }
      if (msg?.op === 'SUBSCRIBE') {
        const nextChannelId = String(msg?.d?.channelId ?? '');
        if (!nextChannelId) {
          safeSend(ws, { t: 'ERROR', d: { code: 'BAD_REQUEST', message: 'channelId required' } });
          return;
        }
        const acc = await requireChannelAccess(nextChannelId, client.userId);
        if (!acc.ok) {
          safeSend(ws, {
            t: 'ERROR',
            d: {
              code: acc.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN',
              message: String(acc.error || 'forbidden'),
              channelId: nextChannelId,
            },
          });
          return;
        }
        client.channelId = nextChannelId;
        safeSend(ws, { t: 'SUBSCRIBED', d: { channelId: client.channelId } });
      } else if (msg?.op === 'TYPING') {
        // Don't allow spoofing typing into arbitrary channels; typing only applies to the subscribed channel.
        const chId = client.channelId;
        broadcast(
          { t: 'TYPING_START', d: { channelId: chId, userId: client.userId } },
          (c) => c.channelId === chId && c.userId !== client.userId
        );
      }
    });

    ws.on('close', async () => {
      clients.delete(client);
      markOffline(client.userId);
      // update last_seen
      if (pool) {
        try {
          await pool.query(`UPDATE users SET last_seen=$2 WHERE id=$1`, [client.userId, Date.now()]);
        } catch (_) {}
      }
    });
  });

  return {
    wss,
    broadcast,
    isUserOnline,
  };
}
