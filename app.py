from __future__ import annotations

import csv
import io
import random
import re
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

from flask import Flask, Response, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "family_ledger.db"

app = Flask(__name__)
app.secret_key = "family-ledger-local-dev-secret"
IDLE_TIMEOUT_SECONDS = 30 * 60
CHINESE_NAME_RE = re.compile(r"^[\u4e00-\u9fff]{2,12}$")
ENGLISH_USERNAME_RE = re.compile(r"^[A-Za-z]{3,24}$")


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_: object) -> None:
    db = g.pop("db", None)
    if db is not None:
        db.close()


@app.after_request
def add_no_store_headers(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def rows(sql: str, params: tuple = ()) -> list[dict]:
    return [dict(row) for row in get_db().execute(sql, params).fetchall()]


def one(sql: str, params: tuple = ()) -> dict | None:
    row = get_db().execute(sql, params).fetchone()
    return dict(row) if row else None


def month_range(month: str) -> tuple[str, str]:
    start = f"{month}-01"
    end = (datetime.strptime(start, "%Y-%m-%d").date().replace(day=28) + timedelta(days=4)).replace(day=1).isoformat()
    return start, end


def init_db() -> None:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            balance REAL NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#38bdf8'
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('expense', 'income')),
            color TEXT NOT NULL DEFAULT '#38bdf8'
        );

        CREATE TABLE IF NOT EXISTS members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '成员'
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
            amount REAL NOT NULL,
            category_id INTEGER,
            account_id INTEGER NOT NULL,
            to_account_id INTEGER,
            member_id INTEGER NOT NULL,
            note TEXT,
            occurred_on TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(category_id) REFERENCES categories(id),
            FOREIGN KEY(account_id) REFERENCES accounts(id),
            FOREIGN KEY(to_account_id) REFERENCES accounts(id),
            FOREIGN KEY(member_id) REFERENCES members(id)
        );

        CREATE TABLE IF NOT EXISTS budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            month TEXT NOT NULL,
            category_id INTEGER,
            amount REAL NOT NULL,
            UNIQUE(month, category_id),
            FOREIGN KEY(category_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS recurring_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('expense', 'income', 'transfer')),
            amount REAL NOT NULL,
            category_id INTEGER,
            account_id INTEGER NOT NULL,
            to_account_id INTEGER,
            member_id INTEGER NOT NULL,
            day_of_month INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            note TEXT,
            FOREIGN KEY(category_id) REFERENCES categories(id),
            FOREIGN KEY(account_id) REFERENCES accounts(id),
            FOREIGN KEY(to_account_id) REFERENCES accounts(id),
            FOREIGN KEY(member_id) REFERENCES members(id)
        );

        CREATE TABLE IF NOT EXISTS assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('asset', 'liability')),
            amount REAL NOT NULL DEFAULT 0,
            note TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            household_id INTEGER,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            member_id INTEGER,
            role TEXT NOT NULL DEFAULT 'editor',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS households (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    ensure_household_columns(db)
    ensure_default_household(db)

    if db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0:
        seed(db)
    else:
        seed_new_modules(db)
    ensure_common_categories(db)
    ensure_default_household(db)
    seed_default_user(db)
    db.commit()
    db.close()


def ensure_column(db: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = [row["name"] for row in db.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in columns:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def ensure_household_columns(db: sqlite3.Connection) -> None:
    for table in ("accounts", "categories", "members", "transactions", "budgets", "recurring_transactions", "assets", "users"):
        ensure_column(db, table, "household_id", "INTEGER")
    ensure_column(db, "users", "member_id", "INTEGER")
    ensure_column(db, "users", "role", "TEXT NOT NULL DEFAULT 'editor'")


def ensure_default_household(db: sqlite3.Connection) -> None:
    household = db.execute("SELECT id FROM households ORDER BY id LIMIT 1").fetchone()
    if not household:
        cur = db.execute(
            "INSERT INTO households (name, created_at) VALUES (?, ?)",
            ("默认家庭", datetime.now().isoformat(timespec="seconds")),
        )
        household_id = cur.lastrowid
    else:
        household_id = household["id"]
    for table in ("accounts", "categories", "members", "transactions", "budgets", "recurring_transactions", "assets", "users"):
        db.execute(f"UPDATE {table} SET household_id = ? WHERE household_id IS NULL", (household_id,))


def ensure_common_categories(db: sqlite3.Connection) -> None:
    common = [
        ("运动", "expense", "#22c55e"),
        ("通勤", "expense", "#06b6d4"),
    ]
    households = db.execute("SELECT id FROM households").fetchall()
    for household in households:
        for name, category_type, color in common:
            exists = db.execute(
                "SELECT id FROM categories WHERE household_id = ? AND name = ? AND type = ?",
                (household["id"], name, category_type),
            ).fetchone()
            if not exists:
                db.execute(
                    "INSERT INTO categories (household_id, name, type, color) VALUES (?, ?, ?, ?)",
                    (household["id"], name, category_type, color),
                )


def seed(db: sqlite3.Connection) -> None:
    db.executemany(
        "INSERT INTO accounts (name, type, balance, color) VALUES (?, ?, ?, ?)",
        [
            ("家庭银行卡", "debit", 28600, "#38bdf8"),
            ("微信钱包", "wallet", 1820, "#5eead4"),
            ("信用卡", "credit", -3260, "#818cf8"),
            ("现金", "cash", 950, "#facc15"),
        ],
    )
    db.executemany(
        "INSERT INTO members (name, role) VALUES (?, ?)",
        [("我", "管理员"), ("伴侣", "成员"), ("父母", "成员")],
    )
    db.executemany(
        "INSERT INTO categories (name, type, color) VALUES (?, ?, ?)",
        [
            ("餐饮", "expense", "#38bdf8"),
            ("交通", "expense", "#5eead4"),
            ("住房", "expense", "#818cf8"),
            ("购物", "expense", "#f472b6"),
            ("医疗", "expense", "#fb7185"),
            ("教育", "expense", "#facc15"),
            ("娱乐", "expense", "#a78bfa"),
            ("工资", "income", "#22c55e"),
            ("理财", "income", "#14b8a6"),
        ],
    )
    today = date.today()
    txs = [
        ("income", 18000, 8, 1, None, 1, "本月工资", today.replace(day=1).isoformat()),
        ("expense", 128, 1, 2, None, 1, "晚餐和水果", today.isoformat()),
        ("expense", 42, 2, 2, None, 2, "地铁通勤", (today - timedelta(days=1)).isoformat()),
        ("expense", 3200, 3, 1, None, 1, "房租", today.replace(day=3).isoformat()),
        ("expense", 680, 4, 3, None, 2, "家用品补货", (today - timedelta(days=4)).isoformat()),
        ("expense", 260, 6, 1, None, 3, "课程资料", (today - timedelta(days=6)).isoformat()),
        ("income", 420, 9, 1, None, 1, "基金分红", (today - timedelta(days=8)).isoformat()),
    ]
    db.executemany(
        """
        INSERT INTO transactions
        (type, amount, category_id, account_id, to_account_id, member_id, note, occurred_on, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [(item + (datetime.now().isoformat(timespec="seconds"),)) for item in txs],
    )
    month = today.strftime("%Y-%m")
    db.executemany(
        "INSERT INTO budgets (month, category_id, amount) VALUES (?, ?, ?)",
        [(month, None, 12000), (month, 1, 3200), (month, 4, 1800), (month, 3, 4200)],
    )
    db.executemany(
        """
        INSERT INTO recurring_transactions
        (name, type, amount, category_id, account_id, member_id, day_of_month, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            ("房租", "expense", 3200, 3, 1, 1, 3, "每月固定房租"),
            ("宽带会员", "expense", 99, 7, 3, 1, 15, "家庭订阅"),
        ],
    )
    db.executemany(
        "INSERT INTO assets (name, type, amount, note) VALUES (?, ?, ?, ?)",
        [("应急备用金", "asset", 30000, "活期和货币基金"), ("信用卡待还", "liability", 3260, "下月还款")],
    )


def seed_new_modules(db: sqlite3.Connection) -> None:
    if db.execute("SELECT COUNT(*) FROM recurring_transactions").fetchone()[0] == 0:
        db.executemany(
            """
            INSERT INTO recurring_transactions
            (name, type, amount, category_id, account_id, member_id, day_of_month, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                ("房租", "expense", 3200, 3, 1, 1, 3, "每月固定房租"),
                ("宽带会员", "expense", 99, 7, 3, 1, 15, "家庭订阅"),
            ],
        )
    if db.execute("SELECT COUNT(*) FROM assets").fetchone()[0] == 0:
        db.executemany(
            "INSERT INTO assets (name, type, amount, note) VALUES (?, ?, ?, ?)",
            [("应急备用金", "asset", 30000, "活期和货币基金"), ("信用卡待还", "liability", 3260, "下月还款")],
        )


def seed_default_user(db: sqlite3.Connection) -> None:
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        member = db.execute("SELECT id FROM members ORDER BY id LIMIT 1").fetchone()
        household = db.execute("SELECT id FROM households ORDER BY id LIMIT 1").fetchone()
        db.execute(
            "INSERT INTO users (username, password_hash, display_name, member_id, household_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "admin",
                generate_password_hash("admin123"),
                "家庭管理员",
                member["id"] if member else None,
                household["id"] if household else 1,
                "super_admin",
                datetime.now().isoformat(timespec="seconds"),
            ),
        )
    else:
        db.execute("UPDATE users SET role = 'super_admin' WHERE username = 'admin'")
    if db.execute("SELECT COUNT(*) FROM users WHERE member_id IS NOT NULL").fetchone()[0] == 0:
        member = db.execute("SELECT id FROM members ORDER BY id LIMIT 1").fetchone()
        if member:
            db.execute("UPDATE users SET member_id = ? WHERE username = 'admin'", (member["id"],))


def seed_household_defaults(db: sqlite3.Connection, household_id: int, member_name: str) -> int:
    member_cur = db.execute(
        "INSERT INTO members (household_id, name, role) VALUES (?, ?, ?)",
        (household_id, member_name, "管理员"),
    )
    db.executemany(
        "INSERT INTO accounts (household_id, name, type, balance, color) VALUES (?, ?, ?, ?, ?)",
        [
            (household_id, "家庭银行卡", "debit", 0, "#38bdf8"),
            (household_id, "微信钱包", "wallet", 0, "#5eead4"),
            (household_id, "信用卡", "credit", 0, "#818cf8"),
            (household_id, "现金", "cash", 0, "#facc15"),
        ],
    )
    db.executemany(
        "INSERT INTO categories (household_id, name, type, color) VALUES (?, ?, ?, ?)",
        [
            (household_id, "餐饮", "expense", "#38bdf8"),
            (household_id, "通勤", "expense", "#06b6d4"),
            (household_id, "交通", "expense", "#5eead4"),
            (household_id, "住房", "expense", "#818cf8"),
            (household_id, "购物", "expense", "#f472b6"),
            (household_id, "医疗", "expense", "#fb7185"),
            (household_id, "教育", "expense", "#facc15"),
            (household_id, "运动", "expense", "#22c55e"),
            (household_id, "娱乐", "expense", "#a78bfa"),
            (household_id, "工资", "income", "#22c55e"),
            (household_id, "理财", "income", "#14b8a6"),
        ],
    )
    return int(member_cur.lastrowid)


def ensure_user_member_column(db: sqlite3.Connection) -> None:
    columns = [row["name"] for row in db.execute("PRAGMA table_info(users)").fetchall()]
    if "member_id" not in columns:
        db.execute("ALTER TABLE users ADD COLUMN member_id INTEGER")


def current_household_id() -> int:
    return int(session.get("household_id") or 1)


def current_role() -> str:
    return session.get("role") or "viewer"


def is_super_admin() -> bool:
    return current_role() == "super_admin"


def is_household_admin() -> bool:
    return current_role() in {"super_admin", "household_admin"}


def can_write_data() -> bool:
    return current_role() in {"super_admin", "household_admin", "editor"}


def forbidden(message: str = "forbidden"):
    return jsonify({"error": message}), 403


def valid_chinese_name(value: str) -> bool:
    return bool(CHINESE_NAME_RE.fullmatch(value or ""))


def valid_english_username(value: str) -> bool:
    return bool(ENGLISH_USERNAME_RE.fullmatch(value or ""))


def set_login_session(user: dict) -> None:
    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    session["display_name"] = user["display_name"]
    session["member_id"] = user["member_id"]
    session["household_id"] = user["household_id"] or 1
    session["role"] = user["role"]
    session["last_active_at"] = datetime.now().isoformat(timespec="seconds")


def session_expired() -> bool:
    last_active_at = session.get("last_active_at")
    if not last_active_at:
        return False
    try:
        last_active = datetime.fromisoformat(last_active_at)
    except ValueError:
        return True
    return datetime.now() - last_active > timedelta(seconds=IDLE_TIMEOUT_SECONDS)


def session_timeout_response() -> Response:
    session.clear()
    if request.path.startswith("/api/"):
        return jsonify({"error": "session expired"}), 401
    target = "adminlogin" if request.path.startswith("/admin") else "login"
    return redirect(url_for(target, next=request.full_path if request.query_string else request.path))


def is_open_endpoint() -> bool:
    return request.endpoint in {"login", "adminlogin", "api_login", "captcha", "static"}


def is_mobile_request() -> bool:
    if request.args.get("desktop") == "1":
        return False
    user_agent = request.headers.get("User-Agent", "").lower()
    mobile_marks = ("iphone", "android", "mobile", "micromessenger", "ipad", "ipod")
    return any(mark in user_agent for mark in mobile_marks)


@app.before_request
def require_login() -> Response | None:
    if is_open_endpoint():
        return None
    if session.get("user_id"):
        if session_expired():
            return session_timeout_response()
        if "member_id" not in session or "household_id" not in session or "role" not in session:
            user = one("SELECT id, username, display_name, member_id, household_id, role FROM users WHERE id = ?", (session["user_id"],))
            if user:
                session["username"] = user["username"]
                session["display_name"] = user["display_name"]
                session["member_id"] = user["member_id"]
                session["household_id"] = user["household_id"] or 1
                session["role"] = user["role"]
        session["last_active_at"] = datetime.now().isoformat(timespec="seconds")
        return None
    if request.path.startswith("/api/"):
        return jsonify({"error": "unauthorized"}), 401
    target = "adminlogin" if request.path.startswith("/admin") else "login"
    return redirect(url_for(target, next=request.full_path if request.query_string else request.path))


def make_captcha_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(alphabet) for _ in range(4))


def apply_account_effect(db: sqlite3.Connection, tx_type: str, amount: float, account_id: int, to_account_id: int | None = None) -> None:
    household_id = current_household_id()
    if tx_type == "income":
        db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ? AND household_id = ?", (amount, account_id, household_id))
    elif tx_type == "expense":
        db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ? AND household_id = ?", (amount, account_id, household_id))
    elif tx_type == "transfer" and to_account_id:
        db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ? AND household_id = ?", (amount, account_id, household_id))
        db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ? AND household_id = ?", (amount, to_account_id, household_id))


def transaction_select(where: str = "", params: tuple = (), limit: int = 200) -> list[dict]:
    sql = f"""
        SELECT t.*, c.name AS category_name, c.color AS category_color,
               a.name AS account_name, ta.name AS to_account_name, m.name AS member_name
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id AND c.household_id = t.household_id
        JOIN accounts a ON a.id = t.account_id AND a.household_id = t.household_id
        LEFT JOIN accounts ta ON ta.id = t.to_account_id AND ta.household_id = t.household_id
        JOIN members m ON m.id = t.member_id AND m.household_id = t.household_id
        WHERE t.household_id = ?
        {where}
        ORDER BY t.occurred_on DESC, t.id DESC
        LIMIT ?
    """
    return rows(sql, (current_household_id(),) + params + (limit,))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        captcha = request.form.get("captcha", "").strip().upper()
        expected = session.get("captcha_code", "")
        user = one("SELECT * FROM users WHERE username = ?", (username,))
        if not expected or captcha != expected:
            error = "验证码不正确，请重新输入。"
        elif not user or not check_password_hash(user["password_hash"], password):
            error = "用户名或密码不正确。"
        elif user["role"] == "super_admin":
            return redirect(url_for("adminlogin"))
        else:
            set_login_session(user)
            return redirect(request.args.get("next") or url_for("index"))
        session["captcha_code"] = make_captcha_code()
    elif "captcha_code" not in session:
        session["captcha_code"] = make_captcha_code()
    return render_template("login.html", error=error)


@app.route("/adminlogin", methods=["GET", "POST"])
def adminlogin():
    error = ""
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        captcha = request.form.get("captcha", "").strip().upper()
        expected = session.get("captcha_code", "")
        user = one("SELECT * FROM users WHERE username = ?", (username,))
        if not expected or captcha != expected:
            error = "验证码不正确，请重新输入。"
        elif not user or not check_password_hash(user["password_hash"], password):
            error = "用户名或密码不正确。"
        elif user["role"] != "super_admin":
            error = "该入口仅支持超级管理员登录。"
        else:
            set_login_session(user)
            return redirect(request.args.get("next") or url_for("admin"))
        session["captcha_code"] = make_captcha_code()
    elif "captcha_code" not in session:
        session["captcha_code"] = make_captcha_code()
    return render_template("admin_login.html", error=error)


@app.route("/captcha.svg")
def captcha():
    code = make_captcha_code()
    session["captcha_code"] = code
    noise = "".join(
        f'<circle cx="{random.randint(8, 132)}" cy="{random.randint(8, 42)}" r="{random.randint(1, 2)}" fill="rgba(29,127,184,.28)"/>'
        for _ in range(18)
    )
    chars = "".join(
        f'<text x="{18 + index * 28}" y="{random.randint(30, 36)}" transform="rotate({random.randint(-10, 10)} {18 + index * 28},30)">{char}</text>'
        for index, char in enumerate(code)
    )
    svg = f"""
    <svg xmlns="http://www.w3.org/2000/svg" width="148" height="52" viewBox="0 0 148 52">
      <rect width="148" height="52" rx="14" fill="rgba(255,255,255,.78)"/>
      <path d="M8 36 C32 8, 56 44, 82 18 S124 10, 140 34" fill="none" stroke="#38bdf8" stroke-width="2" opacity=".45"/>
      {noise}
      <g font-family="Menlo, Consolas, monospace" font-size="25" font-weight="800" fill="#0f2742">{chars}</g>
    </svg>
    """
    return Response(svg, mimetype="image/svg+xml", headers={"Cache-Control": "no-store, max-age=0"})


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    user = one("SELECT * FROM users WHERE username = ?", (username,))
    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "invalid credentials"}), 401
    set_login_session(user)
    return jsonify(
        {
            "id": user["id"],
            "username": user["username"],
            "display_name": user["display_name"],
            "role": user["role"],
        }
    )


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/adminlogout", methods=["POST"])
def adminlogout():
    session.clear()
    return redirect(url_for("adminlogin"))


@app.route("/")
@app.route("/<page>")
def index(page: str = "dashboard"):
    if is_super_admin():
        return redirect(url_for("admin"))
    allowed = {"dashboard", "entry", "records", "budget", "accounts", "categories", "members", "settings", "recurring", "assets", "import-export"}
    if page == "settings":
        page = "categories"
    if page == "create-household-account" and not is_super_admin():
        page = "dashboard"
    if is_mobile_request():
        return render_template("mobile.html", username=session.get("display_name"))
    return render_template(
        "index.html",
        page=page if page in allowed else "dashboard",
        username=session.get("display_name"),
        user_role=current_role(),
    )


@app.route("/mobile")
def mobile():
    return render_template("mobile.html", username=session.get("display_name"))


@app.route("/admin")
def admin():
    if not is_super_admin():
        return redirect(url_for("login"))
    return render_template("admin.html", username=session.get("display_name"))


@app.route("/api/bootstrap")
def bootstrap():
    month = request.args.get("month") or date.today().strftime("%Y-%m")
    household_id = current_household_id()
    household = one("SELECT * FROM households WHERE id = ?", (household_id,))
    return jsonify(
        {
            "household": household,
            "accounts": rows("SELECT * FROM accounts WHERE household_id = ? ORDER BY id", (household_id,)),
            "categories": rows("SELECT * FROM categories WHERE household_id = ? ORDER BY type, id", (household_id,)),
            "members": rows("SELECT * FROM members WHERE household_id = ? ORDER BY id", (household_id,)),
            "currentUser": {
                "id": session.get("user_id"),
                "username": session.get("username"),
                "display_name": session.get("display_name"),
                "member_id": session.get("member_id"),
                "household_id": household_id,
                "role": current_role(),
            },
            "users": rows(
                """
                SELECT u.id, u.username, u.display_name, u.member_id, u.role, m.name AS member_name, m.role AS member_role
                FROM users u
                LEFT JOIN members m ON m.id = u.member_id
                WHERE u.household_id = ?
                ORDER BY u.id
                """
                ,
                (household_id,),
            ),
            "householdAdmins": rows(
                """
                SELECT u.id, u.username, u.display_name, u.role, u.household_id, h.name AS household_name
                FROM users u
                JOIN households h ON h.id = u.household_id
                WHERE u.role = 'household_admin'
                ORDER BY u.id DESC
                """
            ) if is_super_admin() else [],
            "budgets": rows("SELECT * FROM budgets WHERE household_id = ? AND month = ? ORDER BY category_id IS NOT NULL, category_id", (household_id, month)),
            "recurring": rows(
                """
                SELECT r.*, c.name AS category_name, a.name AS account_name, m.name AS member_name
                FROM recurring_transactions r
                LEFT JOIN categories c ON c.id = r.category_id
                JOIN accounts a ON a.id = r.account_id
                JOIN members m ON m.id = r.member_id
                WHERE r.household_id = ?
                ORDER BY r.day_of_month, r.id
                """,
                (household_id,),
            ),
            "assets": rows("SELECT * FROM assets WHERE household_id = ? ORDER BY type, id", (household_id,)),
        }
    )


@app.route("/api/admin/bootstrap")
def admin_bootstrap():
    if not is_super_admin():
        return forbidden()
    return jsonify(
        {
            "currentUser": {
                "id": session.get("user_id"),
                "username": session.get("username"),
                "display_name": session.get("display_name"),
                "role": current_role(),
            },
            "householdAdmins": rows(
                """
                SELECT u.id, u.username, u.display_name, u.role, u.household_id, h.name AS household_name, h.created_at
                FROM users u
                JOIN households h ON h.id = u.household_id
                WHERE u.role = 'household_admin'
                ORDER BY h.id DESC
                """
            ),
        }
    )


@app.route("/api/summary")
def summary():
    month = request.args.get("month") or date.today().strftime("%Y-%m")
    household_id = current_household_id()
    start, end = month_range(month)
    category_totals = rows(
        """
        SELECT t.type, COALESCE(c.name, '转账') AS category, COALESCE(c.color, '#93c5fd') AS color, SUM(t.amount) AS total
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE t.household_id = ? AND t.occurred_on >= ? AND t.occurred_on < ?
        GROUP BY t.type, c.name, c.color
        ORDER BY total DESC
        """,
        (household_id, start, end),
    )
    member_totals = rows(
        """
        SELECT m.name, SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END) AS expense
        FROM members m
        LEFT JOIN transactions t ON t.member_id = m.id AND t.household_id = ? AND t.occurred_on >= ? AND t.occurred_on < ?
        WHERE m.household_id = ?
        GROUP BY m.id
        ORDER BY expense DESC
        """,
        (household_id, start, end, household_id),
    )
    income = sum(row["total"] for row in category_totals if row["type"] == "income")
    expense = sum(row["total"] for row in category_totals if row["type"] == "expense")
    budget = one("SELECT amount FROM budgets WHERE household_id = ? AND month = ? AND category_id IS NULL", (household_id, month))
    asset_total = one("SELECT COALESCE(SUM(amount), 0) AS total FROM assets WHERE household_id = ? AND type = 'asset'", (household_id,))["total"]
    liability_total = one("SELECT COALESCE(SUM(amount), 0) AS total FROM assets WHERE household_id = ? AND type = 'liability'", (household_id,))["total"]
    account_total = one("SELECT COALESCE(SUM(balance), 0) AS total FROM accounts WHERE household_id = ?", (household_id,))["total"]
    return jsonify(
        {
            "month": month,
            "income": income,
            "expense": expense,
            "net": income - expense,
            "budget": budget["amount"] if budget else 0,
            "categoryTotals": category_totals,
            "memberTotals": member_totals,
            "recent": transaction_select(limit=8),
            "trend": rows(
                """
                SELECT occurred_on, type, SUM(amount) AS total
                FROM transactions
                WHERE household_id = ? AND occurred_on >= ? AND occurred_on < ?
                GROUP BY occurred_on, type
                ORDER BY occurred_on
                """,
                (household_id, start, end),
            ),
            "netWorth": account_total + asset_total - liability_total,
            "assetTotal": asset_total,
            "liabilityTotal": liability_total,
        }
    )


@app.route("/api/transactions", methods=["GET", "POST"])
def transactions():
    if request.method == "POST" and not can_write_data():
        return forbidden()
    db = get_db()
    household_id = current_household_id()
    if request.method == "POST":
        data = request.get_json(force=True)
        tx_type = data.get("type", "expense")
        amount = float(data["amount"])
        category_id = data.get("category_id") or None
        account_id = int(data["account_id"])
        to_account_id = int(data["to_account_id"]) if data.get("to_account_id") else None
        member_id = int(data["member_id"])
        occurred_on = data.get("occurred_on") or date.today().isoformat()
        note = (data.get("note") or "").strip()
        cur = db.execute(
            """
            INSERT INTO transactions
            (household_id, type, amount, category_id, account_id, to_account_id, member_id, note, occurred_on, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (household_id, tx_type, amount, category_id, account_id, to_account_id, member_id, note, occurred_on, datetime.now().isoformat(timespec="seconds")),
        )
        apply_account_effect(db, tx_type, amount, account_id, to_account_id)
        db.commit()
        return jsonify({"id": cur.lastrowid}), 201

    clauses = []
    params: list = []
    for key, column in [("type", "t.type"), ("category_id", "t.category_id"), ("account_id", "t.account_id"), ("member_id", "t.member_id")]:
        value = request.args.get(key)
        if value:
            clauses.append(f"{column} = ?")
            params.append(value)
    if request.args.get("start"):
        clauses.append("t.occurred_on >= ?")
        params.append(request.args["start"])
    if request.args.get("end"):
        clauses.append("t.occurred_on <= ?")
        params.append(request.args["end"])
    if request.args.get("q"):
        clauses.append("(t.note LIKE ? OR c.name LIKE ? OR a.name LIKE ? OR m.name LIKE ?)")
        keyword = f"%{request.args['q']}%"
        params.extend([keyword, keyword, keyword, keyword])
    where = f"AND {' AND '.join(clauses)}" if clauses else ""
    return jsonify(transaction_select(where, tuple(params), limit=500))


@app.route("/api/budgets", methods=["POST"])
def budgets():
    if not can_write_data():
        return forbidden()
    data = request.get_json(force=True)
    household_id = current_household_id()
    month = data.get("month") or date.today().strftime("%Y-%m")
    category_id = data.get("category_id") or None
    amount = float(data["amount"])
    db = get_db()
    if category_id is None:
        existing = db.execute("SELECT id FROM budgets WHERE household_id = ? AND month = ? AND category_id IS NULL", (household_id, month)).fetchone()
        if existing:
            db.execute("UPDATE budgets SET amount = ? WHERE id = ?", (amount, existing["id"]))
        else:
            db.execute("INSERT INTO budgets (household_id, month, category_id, amount) VALUES (?, ?, NULL, ?)", (household_id, month, amount))
    else:
        existing = db.execute("SELECT id FROM budgets WHERE household_id = ? AND month = ? AND category_id = ?", (household_id, month, category_id)).fetchone()
        if existing:
            db.execute("UPDATE budgets SET amount = ? WHERE id = ?", (amount, existing["id"]))
        else:
            db.execute("INSERT INTO budgets (household_id, month, category_id, amount) VALUES (?, ?, ?, ?)", (household_id, month, category_id, amount))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/accounts", methods=["POST"])
def accounts():
    if not can_write_data():
        return forbidden()
    data = request.get_json(force=True)
    cur = get_db().execute(
        "INSERT INTO accounts (household_id, name, type, balance, color) VALUES (?, ?, ?, ?, ?)",
        (current_household_id(), data["name"].strip(), data.get("type", "wallet"), float(data.get("balance", 0)), data.get("color", "#38bdf8")),
    )
    get_db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/categories", methods=["POST"])
def categories():
    if not can_write_data():
        return forbidden()
    data = request.get_json(force=True)
    cur = get_db().execute(
        "INSERT INTO categories (household_id, name, type, color) VALUES (?, ?, ?, ?)",
        (current_household_id(), data["name"].strip(), data.get("type", "expense"), data.get("color", "#38bdf8")),
    )
    get_db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/members", methods=["POST"])
def members():
    if not is_household_admin():
        return forbidden()
    data = request.get_json(force=True)
    cur = get_db().execute(
        "INSERT INTO members (household_id, name, role) VALUES (?, ?, ?)",
        (current_household_id(), data["name"].strip(), data.get("role", "成员")),
    )
    get_db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/members/<int:member_id>", methods=["DELETE"])
def delete_member(member_id: int):
    if not is_household_admin():
        return forbidden()
    household_id = current_household_id()
    db = get_db()
    member = db.execute("SELECT id FROM members WHERE id = ? AND household_id = ?", (member_id, household_id)).fetchone()
    if not member:
        return jsonify({"error": "not found"}), 404
    usage = db.execute("SELECT COUNT(*) AS total FROM transactions WHERE member_id = ? AND household_id = ?", (member_id, household_id)).fetchone()["total"]
    if usage:
        return jsonify({"error": "member in use"}), 409
    db.execute("DELETE FROM users WHERE member_id = ? AND household_id = ?", (member_id, household_id))
    db.execute("DELETE FROM recurring_transactions WHERE member_id = ? AND household_id = ?", (member_id, household_id))
    db.execute("DELETE FROM members WHERE id = ? AND household_id = ?", (member_id, household_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/member-accounts", methods=["POST"])
def member_accounts():
    if not is_household_admin():
        return forbidden()
    data = request.get_json(force=True)
    household_id = current_household_id()
    username = data["username"].strip()
    display_name = (data.get("display_name") or "").strip()
    password = data["password"]
    member_id = int(data["member_id"])
    role = data.get("role") or "viewer"
    if not valid_chinese_name(display_name):
        return jsonify({"error": "display name must be chinese"}), 400
    if not valid_english_username(username):
        return jsonify({"error": "username must be english"}), 400
    if role not in {"household_admin", "editor", "viewer"}:
        return jsonify({"error": "invalid role"}), 400
    member = one("SELECT * FROM members WHERE id = ? AND household_id = ?", (member_id, household_id))
    if not member:
        return jsonify({"error": "member not found"}), 404
    if len(password) < 6:
        return jsonify({"error": "password too short"}), 400
    if one("SELECT id FROM users WHERE username = ?", (username,)):
        return jsonify({"error": "username exists"}), 409
    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (household_id, username, password_hash, display_name, member_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (household_id, username, generate_password_hash(password), display_name, member_id, role, datetime.now().isoformat(timespec="seconds")),
        )
    except sqlite3.IntegrityError:
        return jsonify({"error": "username exists"}), 409
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/member-accounts/<int:user_id>", methods=["DELETE"])
def delete_member_account(user_id: int):
    if not is_household_admin():
        return forbidden()
    if user_id == session.get("user_id"):
        return jsonify({"error": "cannot delete self"}), 409
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id = ? AND household_id = ?", (user_id, current_household_id())).fetchone()
    if not user:
        return jsonify({"error": "not found"}), 404
    if user["role"] == "super_admin":
        return jsonify({"error": "cannot delete super admin"}), 409
    db.execute("DELETE FROM users WHERE id = ? AND household_id = ?", (user_id, current_household_id()))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/households", methods=["POST"])
def households():
    if not is_super_admin():
        return forbidden()
    data = request.get_json(force=True)
    household_name = data["name"].strip()
    member_name = (data.get("member_name") or "我").strip()
    display_name = (data.get("display_name") or "").strip()
    username = data["username"].strip()
    password = data["password"]
    if not valid_chinese_name(display_name):
        return jsonify({"error": "display name must be chinese"}), 400
    if not valid_english_username(username):
        return jsonify({"error": "username must be english"}), 400
    if len(password) < 6:
        return jsonify({"error": "password too short"}), 400
    if one("SELECT id FROM users WHERE username = ?", (username,)):
        return jsonify({"error": "username exists"}), 409
    db = get_db()
    try:
        household_cur = db.execute(
            "INSERT INTO households (name, created_at) VALUES (?, ?)",
            (household_name, datetime.now().isoformat(timespec="seconds")),
        )
        household_id = int(household_cur.lastrowid)
        member_id = seed_household_defaults(db, household_id, member_name)
        user_cur = db.execute(
            "INSERT INTO users (household_id, username, password_hash, display_name, member_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (household_id, username, generate_password_hash(password), display_name, member_id, "household_admin", datetime.now().isoformat(timespec="seconds")),
        )
    except sqlite3.IntegrityError:
        db.rollback()
        return jsonify({"error": "username exists"}), 409
    db.commit()
    return jsonify({"id": household_id, "user_id": user_cur.lastrowid}), 201


@app.route("/api/households/<int:household_id>", methods=["DELETE"])
def delete_household(household_id: int):
    if not is_super_admin():
        return forbidden()
    if household_id in {1, current_household_id()}:
        return jsonify({"error": "protected household"}), 409
    db = get_db()
    household = db.execute("SELECT id FROM households WHERE id = ?", (household_id,)).fetchone()
    if not household:
        return jsonify({"error": "not found"}), 404
    for table in ("transactions", "budgets", "recurring_transactions", "assets", "accounts", "categories", "users", "members"):
        db.execute(f"DELETE FROM {table} WHERE household_id = ?", (household_id,))
    db.execute("DELETE FROM households WHERE id = ?", (household_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/household", methods=["PATCH"])
def update_household():
    if not is_household_admin():
        return forbidden()
    data = request.get_json(force=True)
    name = data["name"].strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    get_db().execute("UPDATE households SET name = ? WHERE id = ?", (name, current_household_id()))
    get_db().commit()
    return jsonify({"ok": True})


@app.route("/api/recurring", methods=["POST"])
def recurring():
    if not can_write_data():
        return forbidden()
    data = request.get_json(force=True)
    cur = get_db().execute(
        """
        INSERT INTO recurring_transactions
        (household_id, name, type, amount, category_id, account_id, to_account_id, member_id, day_of_month, active, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            current_household_id(),
            data["name"].strip(),
            data.get("type", "expense"),
            float(data["amount"]),
            data.get("category_id") or None,
            int(data["account_id"]),
            int(data["to_account_id"]) if data.get("to_account_id") else None,
            int(data["member_id"]),
            int(data.get("day_of_month", 1)),
            1 if data.get("active", True) else 0,
            data.get("note", ""),
        ),
    )
    get_db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/recurring/<int:item_id>/generate", methods=["POST"])
def generate_recurring(item_id: int):
    if not can_write_data():
        return forbidden()
    household_id = current_household_id()
    item = one("SELECT * FROM recurring_transactions WHERE id = ? AND household_id = ?", (item_id, household_id))
    if not item:
        return jsonify({"error": "not found"}), 404
    data = request.get_json(silent=True) or {}
    month = data.get("month") or date.today().strftime("%Y-%m")
    day = min(max(int(item["day_of_month"]), 1), 28)
    occurred_on = f"{month}-{day:02d}"
    db = get_db()
    cur = db.execute(
        """
        INSERT INTO transactions
        (household_id, type, amount, category_id, account_id, to_account_id, member_id, note, occurred_on, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            household_id,
            item["type"],
            item["amount"],
            item["category_id"],
            item["account_id"],
            item["to_account_id"],
            item["member_id"],
            item["note"] or item["name"],
            occurred_on,
            datetime.now().isoformat(timespec="seconds"),
        ),
    )
    apply_account_effect(db, item["type"], item["amount"], item["account_id"], item["to_account_id"])
    db.commit()
    return jsonify({"id": cur.lastrowid, "occurred_on": occurred_on}), 201


@app.route("/api/assets", methods=["POST"])
def assets():
    if not can_write_data():
        return forbidden()
    data = request.get_json(force=True)
    cur = get_db().execute(
        "INSERT INTO assets (household_id, name, type, amount, note) VALUES (?, ?, ?, ?, ?)",
        (current_household_id(), data["name"].strip(), data.get("type", "asset"), float(data.get("amount", 0)), data.get("note", "")),
    )
    get_db().commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/export/transactions.csv")
def export_transactions():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["date", "type", "amount", "category", "account", "member", "note"])
    for item in transaction_select(limit=5000):
        writer.writerow([item["occurred_on"], item["type"], item["amount"], item["category_name"] or "", item["account_name"], item["member_name"], item["note"] or ""])
    return Response(
        output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=family-ledger-transactions.csv"},
    )


@app.route("/api/import/transactions", methods=["POST"])
def import_transactions():
    if not can_write_data():
        return forbidden()
    payload = request.get_json(force=True)
    content = payload.get("csv", "")
    reader = csv.DictReader(io.StringIO(content))
    db = get_db()
    household_id = current_household_id()
    created = 0
    defaults = {
        "account_id": one("SELECT id FROM accounts WHERE household_id = ? ORDER BY id LIMIT 1", (household_id,))["id"],
        "member_id": one("SELECT id FROM members WHERE household_id = ? ORDER BY id LIMIT 1", (household_id,))["id"],
    }
    for row in reader:
        tx_type = row.get("type") or "expense"
        amount = float(row.get("amount") or 0)
        if amount <= 0:
            continue
        category_id = None
        if row.get("category"):
            category = db.execute("SELECT id FROM categories WHERE household_id = ? AND name = ? AND type = ?", (household_id, row["category"], tx_type)).fetchone()
            if category:
                category_id = category["id"]
        account_id = defaults["account_id"]
        if row.get("account"):
            account = db.execute("SELECT id FROM accounts WHERE household_id = ? AND name = ?", (household_id, row["account"])).fetchone()
            if account:
                account_id = account["id"]
        member_id = defaults["member_id"]
        if row.get("member"):
            member = db.execute("SELECT id FROM members WHERE household_id = ? AND name = ?", (household_id, row["member"])).fetchone()
            if member:
                member_id = member["id"]
        db.execute(
            """
            INSERT INTO transactions
            (household_id, type, amount, category_id, account_id, member_id, note, occurred_on, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (household_id, tx_type, amount, category_id, account_id, member_id, row.get("note", ""), row.get("date") or date.today().isoformat(), datetime.now().isoformat(timespec="seconds")),
        )
        apply_account_effect(db, tx_type, amount, account_id)
        created += 1
    db.commit()
    return jsonify({"created": created})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5050, debug=True)
