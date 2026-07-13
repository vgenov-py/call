import os
import sqlite3
import secrets

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "voip.db")

def get_secret_key():
    """A stable key is required: with more than one process (e.g. multiple
    gunicorn workers), each process importing this module must produce the
    SAME key, or a session cookie signed by one worker will be rejected by
    another ('Invalid session' errors). Prefer an env var in production;
    fall back to a key persisted on disk so it still survives restarts."""
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    key_path = os.path.join(BASE_DIR, ".secret_key")
    if os.path.exists(key_path):
        with open(key_path, "r") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(key_path, "w") as f:
        f.write(key)
    return key


app = Flask(__name__)
app.config["SECRET_KEY"] = get_secret_key()
socketio = SocketIO(app, cors_allowed_origins="*")

# In-memory presence/call state. Fine for a single-process minimal app.
online_users = {}   # username -> sid
active_calls = {}   # username -> peer_username


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS call_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            caller TEXT NOT NULL,
            callee TEXT NOT NULL,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP
        )"""
    )
    conn.commit()
    conn.close()


# ---------- pages / auth ----------

@app.route("/")
def index():
    if "username" not in session:
        return redirect(url_for("login"))
    return render_template("index.html", username=session["username"])


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if not username or not password:
            return render_template("register.html", error="Username and password required")
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, generate_password_hash(password, method="pbkdf2:sha256")),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            conn.close()
            return render_template("register.html", error="Username already taken")
        conn.close()
        session["username"] = username
        return redirect(url_for("index"))
    return render_template("register.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        conn = get_db()
        user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        conn.close()
        if user and check_password_hash(user["password_hash"], password):
            session["username"] = username
            return redirect(url_for("index"))
        return render_template("login.html", error="Invalid username or password")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.pop("username", None)
    return redirect(url_for("login"))


@app.route("/api/users")
def api_users():
    if "username" not in session:
        return jsonify([]), 401
    me = session["username"]
    return jsonify(sorted(u for u in online_users if u != me))


# ---------- realtime signaling + audio relay ----------

@socketio.on("connect")
def handle_connect():
    username = session.get("username")
    if not username:
        return False  # reject unauthenticated socket connections
    online_users[username] = request.sid
    emit("presence", {}, broadcast=True)


@socketio.on("disconnect")
def handle_disconnect():
    username = session.get("username")
    if not username:
        return
    online_users.pop(username, None)
    peer = active_calls.pop(username, None)
    if peer:
        active_calls.pop(peer, None)
        peer_sid = online_users.get(peer)
        if peer_sid:
            emit("call_ended", {"reason": "peer disconnected"}, to=peer_sid)
    emit("presence", {}, broadcast=True)


@socketio.on("call_request")
def handle_call_request(data):
    caller = session.get("username")
    callee = (data or {}).get("to")
    if not caller or not callee:
        return
    if caller in active_calls or callee in active_calls:
        emit("call_failed", {"reason": "user busy"})
        return
    callee_sid = online_users.get(callee)
    if not callee_sid:
        emit("call_failed", {"reason": "user offline"})
        return
    emit("incoming_call", {"from": caller}, to=callee_sid)


@socketio.on("call_accept")
def handle_call_accept(data):
    callee = session.get("username")
    caller = (data or {}).get("caller")
    if not callee or not caller:
        return
    caller_sid = online_users.get(caller)
    if not caller_sid or caller not in online_users:
        return
    active_calls[caller] = callee
    active_calls[callee] = caller

    conn = get_db()
    conn.execute("INSERT INTO call_logs (caller, callee) VALUES (?, ?)", (caller, callee))
    conn.commit()
    conn.close()

    emit("call_started", {"peer": callee}, to=caller_sid)
    emit("call_started", {"peer": caller})


@socketio.on("call_reject")
def handle_call_reject(data):
    callee = session.get("username")
    caller = (data or {}).get("caller")
    caller_sid = online_users.get(caller)
    if caller_sid:
        emit("call_rejected", {"by": callee}, to=caller_sid)


@socketio.on("hangup")
def handle_hangup():
    username = session.get("username")
    if not username:
        return
    peer = active_calls.pop(username, None)
    if peer:
        active_calls.pop(peer, None)
        peer_sid = online_users.get(peer)
        if peer_sid:
            emit("call_ended", {"reason": "peer hung up"}, to=peer_sid)


@socketio.on("audio_chunk")
def handle_audio_chunk(data):
    """Relay a raw PCM binary chunk to whoever the sender is currently in a call with."""
    username = session.get("username")
    if not username:
        return
    peer = active_calls.get(username)
    if not peer:
        return
    peer_sid = online_users.get(peer)
    if peer_sid:
        emit("audio_chunk", data, to=peer_sid)


if __name__ == "__main__":
    init_db()
    socketio.run(app, host="0.0.0.0", port=8022, debug=True)
