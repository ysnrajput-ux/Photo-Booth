# --workers 1 is required, not a tuning choice: _room_connections in app.py
# is a plain in-process Python dict with no shared store (no Redis, etc.)
# behind it. With >1 worker, gunicorn round-robins each new WebSocket
# connection across separate OS processes with separate memory, so the
# host and partner can land in different workers and never see each other
# in _room_connections - showing "1/2 linked" forever on both sides,
# regardless of network conditions. A single gevent worker already handles
# many concurrent connections fine via greenlets (see --worker-connections
# below), so this isn't a capacity tradeoff for a 2-people-per-room app -
# it's what makes room-linking correct at all. If this ever needs to scale
# past one worker/process, _room_connections must first move to a shared
# store (e.g. Redis pub/sub) that every worker can read/write.
web: gunicorn --worker-class gevent --workers 1 --worker-connections 250 --timeout 60 -b 0.0.0.0:$PORT app:app
