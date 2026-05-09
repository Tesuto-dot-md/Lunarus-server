import express from 'express';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_HTTP_URL,
  PUBLIC_BASE_URL,
} from '../config.js';

const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

export function createVoiceRouter({ authMiddleware, getPublicBaseUrl }) {
  const router = express.Router();

  // Выдать токен на вход в голосовую комнату (LiveKit)
  router.post('/voice/join', authMiddleware, async (req, res) => {
    const room = String(req.body?.room || 'demo-room');

    // LiveKit participants:
    // - identity should be stable (use user id)
    // - name is what UI should display (use username)
    const identity = String(req.user?.sub || req.user?.username || 'user');
    const name = String(req.user?.username || identity);

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const jwtToken = await at.toJwt();

    // LiveKit clients must connect to a PUBLICLY reachable URL.
    // In docker, LIVEKIT_URL is often set to an internal host (livekit/localhost) which will break clients.
    let url = (process.env.LIVEKIT_PUBLIC_URL || process.env.LIVEKIT_URL || '').toString().replace(/\/$/, '');
    const derived = getPublicBaseUrl(req);
    const looksInternal = /(^|\/\/)(localhost|127\.0\.0\.1|livekit)(:|\/|$)/i.test(url);
    if (!url || looksInternal) {
      // LiveKit is reverse-proxied by Caddy under the SAME domain (see Caddyfile /rtc* /twirp*).
      url = derived || PUBLIC_BASE_URL || url;
    }

    res.json({
      url,
      token: jwtToken,
      room,
    });
  });

  // List participants currently connected to a LiveKit room. Used to render
  // "who is in voice" under the channel list.
  router.get('/voice/rooms/:room/participants', authMiddleware, async (req, res) => {
    try {
      const room = String(req.params.room || '');
      if (!room) return res.status(400).json({ error: 'missing room' });

      const parts = await roomService.listParticipants(room);
      return res.json({
        items: parts.map((p) => ({
          identity: p.identity,
          name: p.name || p.identity,
        })),
      });
    } catch (e) {
      console.error('voice participants error', e);
      return res.status(500).json({ error: 'voice participants failed' });
    }
  });

  return router;
}
