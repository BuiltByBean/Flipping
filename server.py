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


# ---------------- item merge ----------------
# Items are document rows (one JSONB blob per item) synced last-write-wins on
# scalars. Sub-collections (fixes, priceHistory) are APPEND-ONLY LOGS and must
# UNION, never replace: a device holding a stale copy of an item once pushed
# fixes: [] and flattened repairs another device had logged. Entry removal is
# a del:true tombstone so deletions win over stale re-adds.

def _entry_key(e, kind):
    if kind == "fixes":
        if e.get("fid"):
            return ("fid", e.get("fid"))
        return ("legacy", e.get("c"), e.get("note"), e.get("d"))
    return ("ph", e.get("p"), e.get("d"))


def _union(old_list, new_list, kind, prefer_new):
    out, idx = [], {}
    for e in (old_list or []):
        if not isinstance(e, dict):
            continue
        k = _entry_key(e, kind)
        idx[k] = len(out)
        out.append(e)
    for e in (new_list or []):
        if not isinstance(e, dict):
            continue
        k = _entry_key(e, kind)
        if k in idx:
            cur = out[idx[k]]
            if e.get("del"):
                out[idx[k]] = e          # tombstones always win
            elif cur.get("del"):
                pass                      # never resurrect a deleted entry
            elif prefer_new:
                out[idx[k]] = e
        else:
            idx[k] = len(out)
            out.append(e)
    return out


def _merge_item(old, new, new_is_newer):
    old = old if isinstance(old, dict) else {}
    base = dict(old)
    if new_is_newer:
        base.update(new)
    base["fixes"] = _union(old.get("fixes"), new.get("fixes"), "fixes", new_is_newer)
    base["priceHistory"] = _union(old.get("priceHistory"), new.get("priceHistory"), "ph", new_is_newer)
    so, sn = old.get("stats"), new.get("stats")
    if so and sn:
        base["stats"] = sn if str(sn.get("updated") or "") >= str(so.get("updated") or "") else so
    elif so or sn:
        base["stats"] = sn or so
    return base


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
    pending, skipped = [], 0
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
        if len(json.dumps(it, separators=(",", ":"))) > MAX_ITEM_BYTES:
            skipped += 1
            continue
        pending.append((item_id, it, updated))

    try:
        with _Conn() as conn:
            with conn.cursor() as cur:
                if pending:
                    cur.execute(
                        "SELECT id, data, updated_at FROM items WHERE id = ANY(%s)",
                        ([p[0] for p in pending],),
                    )
                    existing = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
                    for item_id, inc, updated in pending:
                        ex = existing.get(item_id)
                        if ex is None:
                            merged, final_updated = inc, updated
                        else:
                            ex_data, ex_updated = ex
                            merged = _merge_item(ex_data, inc, updated > ex_updated)
                            final_updated = max(updated, ex_updated)
                        merged["updatedAt"] = final_updated
                        cur.execute(
                            """
                            INSERT INTO items (id, data, updated_at, deleted, synced_at)
                            VALUES (%s, %s::jsonb, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET
                                data       = EXCLUDED.data,
                                updated_at = EXCLUDED.updated_at,
                                deleted    = EXCLUDED.deleted,
                                synced_at  = EXCLUDED.synced_at
                            """,
                            (item_id, json.dumps(merged, separators=(",", ":")),
                             final_updated, bool(merged.get("deleted")), now),
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
