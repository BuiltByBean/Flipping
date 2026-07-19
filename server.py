"""Flips server — serves the PWA and a tiny sync API backed by Postgres.

Endpoints:
  GET  /api/health          -> {ok, db, auth}
  POST /api/sync            -> body {since, items:[...]}; upserts pushed items
                               (last-write-wins on the client's updatedAt) and
                               returns every row the server accepted since the
                               client's watermark. Watermark uses SERVER time
                               (synced_at) so device clock skew can't hide rows.

Auth: X-Flips-Key header must match the FLIPS_KEY env var (if set).
Static: whitelisted app files only; index/app.js/sw.js are no-cache so
updates roll out immediately.
"""
import hmac
import json
import os
import threading
import time

from flask import Flask, abort, jsonify, request, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv():
    """Minimal .env loader for local dev; Railway injects real env vars."""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL", "")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]
FLIPS_KEY = os.environ.get("FLIPS_KEY", "")

MAX_BATCH = 1000            # items per push
MAX_ITEM_BYTES = 800_000    # one item incl. photo dataURL

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 48 * 1024 * 1024

# ---------------- database ----------------
_pool = None
_pool_lock = threading.Lock()
_schema_ready = False


def _get_pool():
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg2.pool import SimpleConnectionPool
                _pool = SimpleConnectionPool(1, 6, DATABASE_URL)
    return _pool


def _ensure_schema(conn):
    global _schema_ready
    if _schema_ready:
        return
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS items (
                id         TEXT PRIMARY KEY,
                data       JSONB  NOT NULL,
                updated_at BIGINT NOT NULL,
                deleted    BOOLEAN NOT NULL DEFAULT FALSE,
                synced_at  BIGINT NOT NULL
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_items_synced ON items (synced_at)")
    conn.commit()
    _schema_ready = True


class _Conn:
    """Checkout a pooled connection; retry once if the socket went stale."""

    def __enter__(self):
        self.pool = _get_pool()
        self.conn = self.pool.getconn()
        try:
            _ensure_schema(self.conn)
            with self.conn.cursor() as cur:
                cur.execute("SELECT 1")
        except Exception:
            try:
                self.pool.putconn(self.conn, close=True)
            except Exception:
                pass
            self.conn = self.pool.getconn()
            _ensure_schema(self.conn)
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type:
                self.conn.rollback()
            self.pool.putconn(self.conn)
        except Exception:
            pass
        return False


# ---------------- auth ----------------
def _authed():
    if not FLIPS_KEY:
        return True
    supplied = request.headers.get("X-Flips-Key", "")
    return hmac.compare_digest(supplied, FLIPS_KEY)


# ---------------- api ----------------
@app.route("/api/health")
def health():
    db_ok = False
    if DATABASE_URL:
        try:
            with _Conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    db_ok = cur.fetchone()[0] == 1
        except Exception:
            db_ok = False
    return jsonify(ok=True, db=db_ok, auth=bool(FLIPS_KEY))


@app.route("/api/sync", methods=["POST"])
def sync():
    if not _authed():
        return jsonify(error="bad key"), 401
    if not DATABASE_URL:
        return jsonify(error="no database configured"), 503

    body = request.get_json(silent=True) or {}
    try:
        since = int(body.get("since") or 0)
    except (TypeError, ValueError):
        since = 0
    incoming = body.get("items") or []
    if not isinstance(incoming, list) or len(incoming) > MAX_BATCH:
        return jsonify(error="bad batch"), 400

    now = int(time.time() * 1000)
    rows, skipped = [], 0
    for it in incoming:
        if not isinstance(it, dict) or it.get("demo"):
            skipped += 1
            continue
        item_id = str(it.get("id") or "")[:80]
        try:
            updated = int(it.get("updatedAt") or 0)
        except (TypeError, ValueError):
            updated = 0
        if not item_id or updated <= 0:
            skipped += 1
            continue
        blob = json.dumps(it, separators=(",", ":"))
        if len(blob) > MAX_ITEM_BYTES:
            skipped += 1
            continue
        rows.append((item_id, blob, updated, bool(it.get("deleted")), now))

    try:
        with _Conn() as conn:
            with conn.cursor() as cur:
                if rows:
                    from psycopg2.extras import execute_values
                    execute_values(
                        cur,
                        """
                        INSERT INTO items (id, data, updated_at, deleted, synced_at)
                        VALUES %s
                        ON CONFLICT (id) DO UPDATE SET
                            -- jsonb merge, not replace: keys the pushing client
                            -- doesn't know about (older app versions) survive
                            -- from the stored copy instead of being stripped
                            data       = items.data || EXCLUDED.data,
                            updated_at = EXCLUDED.updated_at,
                            deleted    = EXCLUDED.deleted,
                            synced_at  = EXCLUDED.synced_at
                        WHERE items.updated_at < EXCLUDED.updated_at
                        """,
                        rows,
                        template="(%s, %s::jsonb, %s, %s, %s)",
                    )
                cur.execute(
                    "SELECT data FROM items WHERE synced_at >= %s ORDER BY synced_at",
                    (since,),
                )
                out = [r[0] for r in cur.fetchall()]
            conn.commit()
    except Exception as e:  # noqa: BLE001 — surface as a 500 the client shows as "sync error"
        app.logger.exception("sync failed: %s", e)
        return jsonify(error="db error"), 500

    return jsonify(now=now, items=out, skipped=skipped)


# ---------------- static app ----------------
_ALLOWED = {"index.html", "app.js", "sw.js", "manifest.webmanifest", "favicon.svg"}
_NO_CACHE = {"index.html", "app.js", "sw.js", "manifest.webmanifest"}


def _static(p):
    resp = send_from_directory(ROOT, p)
    if p.endswith(".webmanifest"):
        resp.mimetype = "application/manifest+json"
    if p in _NO_CACHE:
        resp.headers["Cache-Control"] = "no-cache"
    else:
        resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@app.route("/")
def home():
    return _static("index.html")


@app.route("/<path:p>")
def files(p):
    p = p.replace("\\", "/")
    if p in _ALLOWED or (p.startswith("icons/") and p.endswith(".png") and "/" not in p[len("icons/"):]):
        return _static(p)
    abort(404)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 4180)), debug=False)
