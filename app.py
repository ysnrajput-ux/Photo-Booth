from gevent import monkey
monkey.patch_all()

import os
import json
import time
import secrets
import threading
from datetime import datetime, timedelta, timezone

from flask import Flask, request, jsonify, session, send_from_directory
from flask_sock import Sock
from simple_websocket import ConnectionClosed
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from google.oauth2 import id_token as google_id_token
from google.auth.transport import requests as google_requests

# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FLASK_ENV") != "development",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    # Static JS/CSS were being cached by browsers indefinitely with no
    # cache-busting, so code fixes deployed to the server weren't actually
    # reaching people's phones without a manual hard-refresh. Keep this low
    # (versioned query strings on <script> tags are still the real fix for
    # instant updates; this is just a safety net).
    SEND_FILE_MAX_AGE_DEFAULT=60,
)

sock = Sock(app)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "1053775974665-btmnduh399edehuvqmrjkimjc228rtcd.apps.googleusercontent.com")
ROOM_TTL_MINUTES = 60
ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L ambiguity

# ------------------------------------------------------------------
# DB helpers
# ------------------------------------------------------------------
_pool = None


def _get_pool():
    global _pool
    if _pool is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not set")
        # A pool of warm, already-authenticated connections avoids paying
        # TCP+TLS+auth setup cost (which can take seconds on Render's free
        # Postgres tier) on every single HTTP request and every websocket
        # message. Opening a brand-new connection per call was blocking the
        # single gevent worker long enough to freeze *other* people's
        # websockets in the same process, which is what caused the
        # WORKER TIMEOUT / "0/2 connected" symptom.
        _pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,
            max_size=10,
            kwargs={"row_factory": dict_row, "autocommit": True},
        )
    return _pool


def get_db():
    return _get_pool().connection()


def init_db():
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    google_id TEXT UNIQUE NOT NULL,
                    name TEXT,
                    email TEXT,
                    avatar_url TEXT,
                    created_at TIMESTAMPTZ DEFAULT now()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS rooms (
                    id SERIAL PRIMARY KEY,
                    room_code TEXT UNIQUE NOT NULL,
                    host_user_id INTEGER REFERENCES users(id),
                    partner_user_id INTEGER REFERENCES users(id),
                    mode TEXT NOT NULL DEFAULT 'long_distance',
                    photo_count INTEGER NOT NULL DEFAULT 3,
                    current_photo INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL DEFAULT 'waiting',
                    template_id TEXT DEFAULT 'minimal-white',
                    customization JSONB DEFAULT '{}'::jsonb,
                    photos JSONB DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ DEFAULT now(),
                    expires_at TIMESTAMPTZ NOT NULL
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(room_code);")


_db_ready = False
_db_lock = threading.Lock()


def ensure_db():
    global _db_ready
    if _db_ready:
        return
    with _db_lock:
        if not _db_ready:
            init_db()
            _db_ready = True


@app.before_request
def _before():
    if request.path.startswith("/api/") or request.path.startswith("/ws/"):
        try:
            ensure_db()
        except Exception as e:
            return jsonify({"error": f"Database unavailable: {e}"}), 503


# ------------------------------------------------------------------
# Auth helpers
# ------------------------------------------------------------------
def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    with get_db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id, google_id, name, email, avatar_url FROM users WHERE id=%s", (uid,))
        return cur.fetchone()


def require_auth():
    user = current_user()
    if not user:
        return None, (jsonify({"error": "Authentication required"}), 401)
    return user, None


# ------------------------------------------------------------------
# Room helpers
# ------------------------------------------------------------------
def generate_room_code(length=6):
    return "".join(secrets.choice(ROOM_CODE_CHARS) for _ in range(length))


def create_unique_room_code(cur):
    for _ in range(20):
        code = generate_room_code()
        cur.execute("SELECT 1 FROM rooms WHERE room_code=%s", (code,))
        if not cur.fetchone():
            return code
    raise RuntimeError("Could not generate a unique room code")


def get_room_by_code(cur, code):
    cur.execute("SELECT * FROM rooms WHERE room_code=%s", (code.upper().strip(),))
    return cur.fetchone()


def room_is_expired(room):
    return datetime.now(timezone.utc) > room["expires_at"].replace(tzinfo=timezone.utc)


def public_room(room, include_photos=True):
    data = {
        "room_code": room["room_code"],
        "mode": room["mode"],
        "photo_count": room["photo_count"],
        "current_photo": room["current_photo"],
        "state": room["state"],
        "template_id": room["template_id"],
        "customization": room["customization"],
        "has_partner": room["partner_user_id"] is not None,
    }
    if include_photos:
        data["photos"] = room["photos"]
    return data


# ------------------------------------------------------------------
# Auth routes
# ------------------------------------------------------------------
@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    if not GOOGLE_CLIENT_ID or " " in GOOGLE_CLIENT_ID:
        return jsonify({"error": "Server GOOGLE_CLIENT_ID is not configured correctly. Set a valid Google OAuth Client ID in environment variables."}), 500

    data = request.get_json(silent=True) or {}
    credential = data.get("credential")
    if not credential:
        return jsonify({"error": "Missing credential"}), 400

    try:
        idinfo = google_id_token.verify_oauth2_token(
            credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except Exception:
        return jsonify({"error": "Invalid Google token"}), 401

    google_id = idinfo["sub"]
    name = idinfo.get("name", "")
    email = idinfo.get("email", "")
    avatar_url = idinfo.get("picture", "")

    with get_db() as conn, conn.cursor() as cur:
        cur.execute("SELECT id FROM users WHERE google_id=%s", (google_id,))
        row = cur.fetchone()
        if row:
            uid = row["id"]
            cur.execute(
                "UPDATE users SET name=%s, email=%s, avatar_url=%s WHERE id=%s",
                (name, email, avatar_url, uid),
            )
        else:
            cur.execute(
                "INSERT INTO users (google_id, name, email, avatar_url) VALUES (%s,%s,%s,%s) RETURNING id",
                (google_id, name, email, avatar_url),
            )
            uid = cur.fetchone()["id"]

    session["user_id"] = uid
    session.permanent = True
    return jsonify({"ok": True, "user": {"name": name, "email": email, "avatar_url": avatar_url}})


@app.route("/api/auth/me")
def auth_me():
    user = current_user()
    if not user:
        return jsonify({"authenticated": False})
    return jsonify({"authenticated": True, "user": {
        "name": user["name"], "email": user["email"], "avatar_url": user["avatar_url"]
    }})


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


# ------------------------------------------------------------------
# Room routes
# ------------------------------------------------------------------
@app.route("/api/rooms", methods=["POST"])
def create_room():
    user, err = require_auth()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    mode = data.get("mode")
    if mode not in ("together", "long_distance"):
        return jsonify({"error": "mode must be 'together' or 'long_distance'"}), 400
    photo_count = data.get("photo_count", 3)
    try:
        photo_count = int(photo_count)
    except (TypeError, ValueError):
        photo_count = 3
    photo_count = max(1, min(4, photo_count))

    expires_at = datetime.now(timezone.utc) + timedelta(minutes=ROOM_TTL_MINUTES)
    with get_db() as conn, conn.cursor() as cur:
        code = create_unique_room_code(cur)
        state = "ready" if mode == "together" else "waiting"
        cur.execute("""
            INSERT INTO rooms (room_code, host_user_id, mode, photo_count, state, expires_at)
            VALUES (%s,%s,%s,%s,%s,%s) RETURNING *
        """, (code, user["id"], mode, photo_count, state, expires_at))
        room = cur.fetchone()

    return jsonify({"room": public_room(room), "role": "host"})


@app.route("/api/rooms/<code>", methods=["GET"])
def get_room(code):
    user, err = require_auth()
    if err:
        return err
    with get_db() as conn, conn.cursor() as cur:
        room = get_room_by_code(cur, code)
    if not room:
        return jsonify({"error": "Room not found"}), 404
    if room_is_expired(room):
        return jsonify({"error": "Room expired"}), 410

    role = None
    if room["host_user_id"] == user["id"]:
        role = "host"
    elif room["partner_user_id"] == user["id"]:
        role = "partner"
    return jsonify({"room": public_room(room), "role": role})


@app.route("/api/rooms/<code>/join", methods=["POST"])
def join_room_http(code):
    user, err = require_auth()
    if err:
        return err
    with get_db() as conn, conn.cursor() as cur:
        room = get_room_by_code(cur, code)
        if not room:
            return jsonify({"error": "Invalid room code"}), 404
        if room_is_expired(room):
            return jsonify({"error": "Room expired"}), 410
        if room["mode"] != "long_distance":
            return jsonify({"error": "This room does not support joining"}), 400

        if room["host_user_id"] == user["id"]:
            return jsonify({"room": public_room(room), "role": "host"})

        if room["partner_user_id"] is not None and room["partner_user_id"] != user["id"]:
            return jsonify({"error": "Room is full"}), 409

        if room["partner_user_id"] is None:
            cur.execute(
                "UPDATE rooms SET partner_user_id=%s, state='ready' WHERE id=%s RETURNING *",
                (user["id"], room["id"]),
            )
            room = cur.fetchone()

    # include_photos=False: consistent with every other WS broadcast (see
    # the note above the main ws_room broadcast) — pushed room snapshots
    # never carry photos, only the on-demand GET below does.
    broadcast_to_room(room["room_code"], {"type": "partner_joined", "room": public_room(room, include_photos=False)})
    return jsonify({"room": public_room(room), "role": "partner"})


# ------------------------------------------------------------------
# Realtime room state machine (used by both HTTP fallback + WS)
# ------------------------------------------------------------------
def apply_room_action(cur, room, user_id, action, payload):
    """Server-authoritative state transitions. Returns (room, event_dict) or raises ValueError."""
    is_host = room["host_user_id"] == user_id
    is_partner = room["partner_user_id"] == user_id
    if not (is_host or is_partner):
        raise PermissionError("Not a member of this room")

    if room_is_expired(room):
        raise ValueError("Room expired")

    # "capture" is intentionally NOT host-only: in long-distance mode each
    # participant's own client captures its own local video frame and reports
    # it to the server. The *trigger* (starting the countdown) is host-only;
    # submitting your own captured frame afterward is not a control action.
    host_only = {"start_countdown", "retake", "next_photo", "finish", "set_template", "customize"}
    if action in host_only and not is_host:
        raise PermissionError("Host-only action")

    if action == "start_countdown":
        # Only valid from 'ready' — the room sits here between photos and
        # right after joining, which is the one moment a NEW countdown
        # should ever be allowed to start. Without this guard, a rapid
        # double-tap of the shutter (both taps arriving before the first
        # 'countdown_start' broadcast round-trips back and hides the
        # button — see the matching client-side disable in photobooth.js)
        # used to send two 'start_countdown' actions back-to-back. Each one
        # unconditionally re-set state='countdown' and re-broadcast
        # 'countdown_start', so BOTH clients ran runCountdownLD() twice
        # concurrently — producing two independent captures a beat apart
        # for the same photo, where the second could land after 'next_photo'
        # had already moved current_photo forward and write into the wrong
        # slot. That surfaced as an intermittent, no-visible-error failure
        # specifically on later photos (3rd/4th), since people take photos
        # faster and are more likely to double-tap by then. A duplicate
        # request is now rejected below instead of restarting the countdown.
        if room["state"] != "ready":
            # Raising (rather than returning a None event) reuses the
            # existing ValueError handling path a few frames up in
            # ws_room(): it sends a quiet error back to ONLY the client
            # that double-tapped, touches no room state, and — critically —
            # never broadcasts anything to the other participant, who
            # correctly has no idea a duplicate click even happened.
            raise ValueError("Countdown already in progress")
        cur.execute("UPDATE rooms SET state='countdown' WHERE id=%s RETURNING *", (room["id"],))
        room = cur.fetchone()
        return room, {"type": "countdown_start"}

    if action == "capture":
        photo_data_url = payload.get("photo")
        if not photo_data_url or not isinstance(photo_data_url, str) or not photo_data_url.startswith("data:image/"):
            raise ValueError("Invalid photo payload")
        # 'who' is always derived from the sender's verified role, never trusted from the client
        who = "host" if is_host else "partner"
        idx = room["current_photo"]
        # Whether THIS sender was using their front ("selfie") camera for
        # this shot — recorded per-photo, per-side, alongside the image
        # itself. The stored image is always the TRUE unmirrored camera
        # frame (see the client-side capture comment for why), but the
        # composed/exported image should still visually match what this
        # person saw in their own mirrored preview a moment before they
        # tapped the shutter. Storing it per-capture (rather than assuming
        # "front camera" for everyone) means it stays correct even if
        # someone flips their camera mid-session, or is on the back camera
        # the whole time (where no mirroring should ever be applied).
        mirrored_key = f"{who}_mirrored"
        # Targeted jsonb_set UPDATE, done entirely server-side in Postgres —
        # this used to read the WHOLE photos array into Python, append/
        # overwrite one entry, then json.dumps() and write the WHOLE array
        # back via a plain `photos=%s` UPDATE (and read it all back again
        # via RETURNING *). "Whole array" here means every prior photo's
        # full-size base64 image, for both people — so the write (and the
        # read-back) grew with every capture in a session: photo 1 sent
        # ~1 image's worth, photo 4 sent up to ~7 prior images plus the new
        # one. On Render's free Postgres tier that meant the DB round trip
        # for a single capture kept getting slower and heavier for exactly
        # the same single-gevent-worker process handling every other
        # connection in every other room — a real, worsening tax on later
        # photos in a session, independent of whatever the network was
        # doing. jsonb_set here only ever touches the one
        # [idx]['images'][who] path being written, and RETURNING pulls back
        # only that one changed entry (see below) — so the DB cost of a
        # capture is now a small, constant size no matter how far into the
        # session this is. The CASE handles the (only) two shapes this can
        # start from: the array already has a slot at idx (an entry from
        # the *other* side already landed first), or it doesn't yet and a
        # fresh blank slot needs appending.
        #
        # The mirrored flag is written with a second, nested jsonb_set
        # against the SAME 'images' object the first call just wrote/
        # ensured exists — not a separate top-level key — so it never needs
        # its own "create this container if missing" case.
        cur.execute(
            """
            UPDATE rooms
            SET photos = jsonb_set(
                    jsonb_set(
                        CASE WHEN jsonb_array_length(COALESCE(photos, '[]'::jsonb)) > %(idx)s
                             THEN photos
                             ELSE COALESCE(photos, '[]'::jsonb)
                                  || jsonb_build_array(jsonb_build_object('index', %(idx)s, 'images', '{}'::jsonb))
                        END,
                        ARRAY[%(idx)s::text, 'images', %(who)s],
                        to_jsonb(%(photo)s::text),
                        true
                    ),
                    ARRAY[%(idx)s::text, 'images', %(mirrored_key)s],
                    to_jsonb(%(mirrored)s::boolean),
                    true
                ),
                state = 'review'
            WHERE id = %(room_id)s
            RETURNING id, room_code, host_user_id, partner_user_id, mode, photo_count,
                      current_photo, state, template_id, customization, created_at, expires_at,
                      (photos -> %(idx)s) AS captured_entry
            """,
            {
                "idx": idx, "who": who, "photo": photo_data_url,
                "mirrored_key": mirrored_key, "mirrored": bool(payload.get("mirrored")),
                "room_id": room["id"],
            },
        )
        room = cur.fetchone()
        entry = room.pop("captured_entry")
        # Only the entry that actually changed goes out here — NOT the whole
        # room["photos"] history (see the include_photos note in ws_room).
        # Sending the full accumulated array on every single capture meant
        # the broadcast grew with every photo taken (photo 1 -> ~1 image,
        # photo 4 -> up to 8 images' worth of base64 across both people),
        # and on a slow/free-tier connection a broadcast that big could fail
        # to send or arrive late — which is exactly what caused the host to
        # get stuck on "Waiting for both photos…" specifically on later
        # photos in the session, with no way to proceed. Clients keep their
        # own running cache of earlier photos client-side instead.
        return room, {"type": "photo_captured", "who": who, "index": idx, "photo": entry}

    if action == "retake":
        idx = room["current_photo"]
        # Same targeted-update reasoning as "capture" above: reset just
        # this one index back to an empty entry server-side rather than
        # rewriting the whole array through Python.
        cur.execute(
            """
            UPDATE rooms
            SET photos = CASE
                    WHEN jsonb_array_length(COALESCE(photos, '[]'::jsonb)) > %(idx)s
                    THEN jsonb_set(photos, ARRAY[%(idx)s::text],
                                   jsonb_build_object('index', %(idx)s, 'images', '{}'::jsonb))
                    ELSE COALESCE(photos, '[]'::jsonb)
                END,
                state = 'ready'
            WHERE id = %(room_id)s
            RETURNING id, room_code, host_user_id, partner_user_id, mode, photo_count,
                      current_photo, state, template_id, customization, created_at, expires_at
            """,
            {"idx": idx, "room_id": room["id"]},
        )
        room = cur.fetchone()
        return room, {"type": "retake"}

    if action == "next_photo":
        nxt = room["current_photo"] + 1
        if nxt >= room["photo_count"]:
            cur.execute(
                "UPDATE rooms SET state='customizing' WHERE id=%s RETURNING *",
                (room["id"],),
            )
            room = cur.fetchone()
            return room, {"type": "session_complete"}
        cur.execute(
            "UPDATE rooms SET current_photo=%s, state='ready' WHERE id=%s RETURNING *",
            (nxt, room["id"]),
        )
        room = cur.fetchone()
        return room, {"type": "next_photo", "current_photo": nxt}

    if action == "set_template":
        cur.execute(
            "UPDATE rooms SET template_id=%s WHERE id=%s RETURNING *",
            (payload.get("template_id", room["template_id"]), room["id"]),
        )
        room = cur.fetchone()
        return room, {"type": "template_changed", "template_id": room["template_id"]}

    if action == "customize":
        custom = payload.get("customization", {})
        cur.execute(
            "UPDATE rooms SET customization=%s WHERE id=%s RETURNING *",
            (json.dumps(custom), room["id"]),
        )
        room = cur.fetchone()
        return room, {"type": "customization_changed", "customization": custom}

    if action == "finish":
        cur.execute("UPDATE rooms SET state='completed' WHERE id=%s RETURNING *", (room["id"],))
        room = cur.fetchone()
        return room, {"type": "completed"}

    if action == "chat":
        text = str(payload.get("text", ""))[:300]
        return room, {"type": "chat", "text": text, "who": "host" if is_host else "partner", "ts": time.time()}

    if action in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
        return room, {"type": action, "data": payload.get("data"), "from": "host" if is_host else "partner"}

    if action == "mic_state":
        return room, {"type": "mic_state", "on": bool(payload.get("on")), "who": "host" if is_host else "partner"}

    if action == "reaction":
        # Purely ephemeral, like chat/mic_state above — just relayed to
        # whoever's connected right now, never written to the room row.
        # Keeping it to a small fixed set server-side means a tampered
        # client can't broadcast arbitrary strings/HTML into the other
        # person's screen.
        emoji = str(payload.get("emoji", ""))
        if emoji not in ("❤️", "😂", "😍", "🔥", "👏", "😮"):
            raise ValueError("Unsupported reaction")
        return room, {"type": "reaction", "emoji": emoji, "who": "host" if is_host else "partner"}

    raise ValueError(f"Unknown action: {action}")


# ------------------------------------------------------------------
# WebSocket signaling / room bus
# ------------------------------------------------------------------
_room_connections = {}  # room_code -> set of ws connections
_room_lock = threading.Lock()


def broadcast_to_room(room_code, message, exclude_ws=None):
    with _room_lock:
        conns = list(_room_connections.get(room_code, set()))
    dead = []
    for ws in conns:
        if ws is exclude_ws:
            continue
        try:
            ws.send(json.dumps(message))
        except Exception:
            dead.append(ws)
    if dead:
        with _room_lock:
            for ws in dead:
                _room_connections.get(room_code, set()).discard(ws)


@sock.route("/ws/room/<code>")
def ws_room(ws, code):
    code = code.upper().strip()
    user_id = session.get("user_id")
    if not user_id:
        ws.send(json.dumps({"type": "error", "message": "Not authenticated"}))
        return

    try:
        ensure_db()
        with get_db() as conn, conn.cursor() as cur:
            room = get_room_by_code(cur, code)
        if not room or room_is_expired(room):
            ws.send(json.dumps({"type": "error", "message": "Room not found or expired"}))
            return
        if room["host_user_id"] != user_id and room["partner_user_id"] != user_id:
            ws.send(json.dumps({"type": "error", "message": "Not a member of this room"}))
            return
    except Exception as e:
        ws.send(json.dumps({"type": "error", "message": str(e)}))
        return

    # Before registering this new connection, actively probe every existing
    # connection already registered for this room and drop any that don't
    # actually accept a send. Relying only on the receive-loop's own
    # ping/timeout to notice a dead socket meant stale connections (e.g. a
    # phone locking its screen, backgrounding the app, or hopping between
    # WiFi/mobile data mid-session) could sit in _room_connections for a
    # while, inflating the "linked" count past 2 and making it possible for
    # a broadcast to be attempted against a half-dead socket instead of the
    # live one — a likely contributor to dropped offers/ICE candidates.
    with _room_lock:
        existing = list(_room_connections.get(code, set()))
    for old_ws in existing:
        try:
            old_ws.send(json.dumps({"type": "ping"}))
        except Exception:
            with _room_lock:
                _room_connections.get(code, set()).discard(old_ws)

    with _room_lock:
        _room_connections.setdefault(code, set()).add(ws)

    role = "host" if room["host_user_id"] == user_id else "partner"
    broadcast_to_room(code, {"type": "presence", "who": role, "status": "connected"}, exclude_ws=ws)

    try:
        while True:
            try:
                raw = ws.receive(timeout=12)
            except ConnectionClosed:
                break
            except Exception:
                # Any other receive-side failure (e.g. abrupt network drop
                # while the phone was mid-handoff between WiFi/mobile data)
                # means this socket is dead — stop serving it so it gets
                # removed in the finally block below instead of lingering.
                break
            if raw is None:
                # timeout tick - send lightweight ping to detect dead conns
                try:
                    ws.send(json.dumps({"type": "ping"}))
                except Exception:
                    break
                continue

            # Reject oversized messages before json.loads(). Parsing a
            # multi-MB string is pure CPU and can't yield to gevent, so a
            # huge payload here would block this worker and freeze every
            # other websocket connection it's serving (that's what caused
            # the earlier WORKER TIMEOUT / "0/2 connected" crashes). The
            # client now downsizes photos before sending, but this is a
            # hard backstop regardless of client behavior.
            MAX_WS_MESSAGE_BYTES = 700_000
            if isinstance(raw, (str, bytes)) and len(raw) > MAX_WS_MESSAGE_BYTES:
                try:
                    ws.send(json.dumps({"type": "error", "message": "Message too large"}))
                except Exception:
                    pass
                continue

            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                continue

            action = msg.get("action")
            payload = msg.get("payload", {}) or {}
            if action == "pong":
                continue

            try:
                with get_db() as conn, conn.cursor() as cur:
                    room = get_room_by_code(cur, code)
                    if not room:
                        ws.send(json.dumps({"type": "error", "message": "Room not found"}))
                        continue
                    room, event = apply_room_action(cur, room, user_id, action, payload)
                # The room's `photos` array accumulates full base64 images for
                # every captured photo (both host + partner). NO broadcast may
                # carry it — not even 'session_complete'. 'session_complete'
                # used to be the one exception ("client composes all final
                # images from it, in one shot, at the very end"), but that
                # made the LAST message of every single session the single
                # biggest websocket frame in the whole app (up to
                # photo_count * 2 full-size images, several MB of base64,
                # sent in one shot down each of the two sockets). On a
                # long-distance participant's weaker mobile connection that
                # frame was the one most likely to stall or arrive corrupted
                # — and unlike a mid-session capture there was no retry
                # trigger left afterward, so it silently stranded the host on
                # the "waiting for partner's photo" screen forever with no
                # error and no redirect to the editor. Broadcasts now always
                # stay small (see 'photo_captured' above, same reasoning);
                # the client already keeps its own running cache built up
                # from each 'photo_captured' broadcast during the session,
                # and falls back to a plain HTTP GET of this same room
                # (retryable, not a single fragile frame) if that cache is
                # ever incomplete — see onSessionCompleteLD() in photobooth.js.
                event["room"] = public_room(room, include_photos=False)
                # WebRTC signaling and chat are point-to-point: they must NOT be
                # echoed back to the sender. Doing so previously caused the host
                # to receive its own "webrtc_offer" and process it as if it were
                # the partner's, which threw an invalid-state error on the host's
                # RTCPeerConnection (you can't setRemoteDescription(offer) while
                # already in "have-local-offer") and silently broke the connection.
                # Other actions (start_countdown, retake, next_photo, etc.) are
                # server-authoritative and the initiating client intentionally
                # waits for this same broadcast to update its own UI, so those
                # must keep going to everyone, including the sender.
                if event["type"] in ("webrtc_offer", "webrtc_answer", "webrtc_ice", "chat"):
                    broadcast_to_room(code, event, exclude_ws=ws)
                else:
                    broadcast_to_room(code, event)
            except PermissionError as e:
                ws.send(json.dumps({"type": "error", "message": str(e)}))
            except ValueError as e:
                ws.send(json.dumps({"type": "error", "message": str(e)}))
            except Exception as e:
                ws.send(json.dumps({"type": "error", "message": "Server error"}))
    finally:
        with _room_lock:
            _room_connections.get(code, set()).discard(ws)
        broadcast_to_room(code, {"type": "presence", "who": role, "status": "disconnected"})


# ------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/photobooth")
@app.route("/photobooth/")
def photobooth_page():
    return send_from_directory(".", "photobooth.html")


def get_ice_servers():
    """Build the ICE server list for WebRTC.

    STUN alone only works when at least one peer is behind a simple/open
    NAT. Two people on separate home/mobile networks very often sit behind
    symmetric NAT or CGNAT, where STUN can't establish a direct path at
    all — that's what makes long-distance connections fail while same-network
    testing looks fine. A TURN server relays the media in that case.

    Set these env vars to point at a real TURN provider (Twilio, Cloudflare
    Calls, Xirsys, metered.ca, or a self-hosted coturn instance) for
    production use:
      TURN_URLS        comma-separated list, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
      TURN_USERNAME
      TURN_CREDENTIAL

    If they're not set, this falls back to the Open Relay Project's free
    public TURN server so long-distance mode still works out of the box.
    That free service is rate-limited and shared publicly — swap in real
    credentials before relying on this for real users.
    """
    servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]

    turn_urls = os.environ.get("TURN_URLS")
    turn_username = os.environ.get("TURN_USERNAME")
    turn_credential = os.environ.get("TURN_CREDENTIAL")

    if turn_urls and turn_username and turn_credential:
        # One entry per URL (not one entry with a `urls` array) so each
        # transport is an independent ICE server the browser gathers and
        # times out on separately. Bundled into a single array, a
        # network that silently blackholes UDP or plain-TCP (rather than
        # cleanly rejecting it — common on carrier-grade/mobile firewalls,
        # which is exactly the "different networks, works ~1 in 5 tries"
        # symptom) can burn the whole gathering window waiting on those
        # dead entries instead of falling through to turns:443, which is
        # TLS-wrapped and passes through almost any firewall that allows
        # normal HTTPS. turns:443 is listed first so it's not left
        # competing for gathering time/slots behind entries more likely to
        # stall on a restrictive network; being first doesn't stop the
        # browser from still using a faster UDP path when one is available.
        parsed_urls = [u.strip() for u in turn_urls.split(",") if u.strip()]
        parsed_urls.sort(key=lambda u: not u.startswith("turns:"))
        for url in parsed_urls:
            servers.append({
                "urls": url,
                "username": turn_username,
                "credential": turn_credential,
            })
    else:
        # Free fallback (Open Relay Project) — fine for testing, not for
        # production scale. See docstring above.
        servers.append({
            "urls": [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443",
                "turn:openrelay.metered.ca:443?transport=tcp",
            ],
            "username": "openrelayproject",
            "credential": "openrelayproject",
        })

    return servers


@app.route("/api/rooms/<code>/debug")
def room_debug(code):
    """Diagnostic only: reports how many WebSocket connections the server
    currently has registered for this room. If this shows fewer than 2 while
    both people believe they're on the camera screen, the WebSocket itself
    isn't actually linking the two of you — that's the real problem, not
    WebRTC/TURN (nothing relays through it, including chat, which doesn't
    use WebRTC/ICE/TURN at all)."""
    user, err = require_auth()
    if err:
        return err
    code = code.upper().strip()
    with _room_lock:
        count = len(_room_connections.get(code, set()))
    return jsonify({"room_code": code, "live_connections": count})


@app.route("/api/config")
def api_config():
    return jsonify({
        "google_client_id": GOOGLE_CLIENT_ID,
        "google_client_id_valid": bool(GOOGLE_CLIENT_ID) and " " not in GOOGLE_CLIENT_ID,
        "ice_servers": get_ice_servers(),
    })


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("FLASK_ENV") == "development")
