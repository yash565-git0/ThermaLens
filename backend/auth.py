"""Demo local accounts + stored user profiles for ThermaLens sign-in.

Store-only v1: credentials + profile are persisted to data/users.json
(hashed passwords, hashed session tokens). No email verification, no
risk-engine personalization — profile is collected, stored and returned.

Stdlib only (hashlib PBKDF2, secrets, hmac) so requirements.txt is unchanged.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
USERS_FILE = os.path.join(ROOT, "data", "users.json")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LEN = 8

AGE_RANGES = ["18-29", "30-44", "45-59", "60+", "prefer-not-to-say"]
AILMENT_OPTIONS = ["none", "hypertension", "cardiac", "diabetes",
                   "asthma-respiratory", "kidney", "pregnancy", "other"]
CITY_OPTIONS = ["Mumbai", "Ahmedabad", "Chennai", "Hyderabad", "Other"]

# Loose India bounding box for sanity-checking geolocation input.
INDIA_BBOX = {"lat_min": 6.0, "lat_max": 38.0, "lon_min": 68.0, "lon_max": 98.0}

_PBKDF2_ITERS = 210_000

# Naive in-process rate limit: {key: [epoch_seconds]}. Demo-grade only.
_RATE = {}
RATE_MAX = 20
RATE_WINDOW_S = 60


def check_rate(key):
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    hits = _RATE.get(key) or []
    hits = [t for t in hits if now - t < RATE_WINDOW_S]
    hits.append(now)
    _RATE[key] = hits[-RATE_MAX - 1:]
    return len(hits) <= RATE_MAX


def _blank_store():
    return {"users": [], "sessions": [], "profiles": {}}


def _load():
    try:
        with open(USERS_FILE) as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return _blank_store()
        d.setdefault("users", [])
        d.setdefault("sessions", [])
        d.setdefault("profiles", {})
        return d
    except (FileNotFoundError, json.JSONDecodeError):
        return _blank_store()


def _save(store):
    os.makedirs(os.path.dirname(USERS_FILE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(USERS_FILE), prefix="users-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(store, f, indent=1)
        os.replace(tmp, USERS_FILE)
    finally:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
    try:
        os.chmod(USERS_FILE, 0o600)
    except OSError:
        pass


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def normalize_email(email):
    return (email or "").strip().lower()


def valid_email(email):
    e = (email or "").strip()
    return len(e) <= 254 and bool(EMAIL_RE.match(e))


def _hash_password(password, salt_hex=None):
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERS)
    return salt.hex(), dk.hex()


def _verify_password(password, salt_hex, hash_hex):
    _, dk = _hash_password(password, salt_hex)
    return hmac.compare_digest(dk, hash_hex)


def _token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def find_user(store, email_lower):
    for u in store["users"]:
        if u.get("email_lower") == email_lower:
            return u
    return None


def user_public(user, profile=None):
    return {
        "user_id": user["id"],
        "email": user.get("email"),
        "created": user.get("created"),
        "profile": profile,
        "profile_complete": bool(profile and profile.get("completed")),
    }


def signup(email, password):
    email = (email or "").strip()
    if not valid_email(email):
        raise ValueError("Enter a valid email address.")
    if not password or len(password) < MIN_PASSWORD_LEN:
        raise ValueError("Password must be at least %d characters." % MIN_PASSWORD_LEN)
    store = _load()
    if find_user(store, normalize_email(email)):
        raise KeyError("An account with this email already exists. Try signing in.")
    salt, phash = _hash_password(password)
    user = {
        "id": secrets.token_hex(8),
        "email": email,
        "email_lower": normalize_email(email),
        "pw_salt": salt,
        "pw_hash": phash,
        "created": _now(),
    }
    store["users"].append(user)
    token = secrets.token_urlsafe(32)
    store["sessions"].append({"token_hash": _token_hash(token),
                              "user_id": user["id"], "created": _now()})
    _save(store)
    return user, token


def signin(email, password):
    email = (email or "").strip()
    if not valid_email(email) or not password:
        raise ValueError("Enter your email and password.")
    store = _load()
    user = find_user(store, normalize_email(email))
    if not user or not _verify_password(password, user.get("pw_salt", ""), user.get("pw_hash", "")):
        raise PermissionError("Incorrect email or password.")
    token = secrets.token_urlsafe(32)
    store["sessions"].append({"token_hash": _token_hash(token),
                              "user_id": user["id"], "created": _now()})
    # cap sessions per user to keep the file small
    mine = [s for s in store["sessions"] if s.get("user_id") == user["id"]]
    if len(mine) > 10:
        keep = set(id(s) for s in mine[-10:])
        store["sessions"] = [s for s in store["sessions"]
                             if s.get("user_id") != user["id"] or id(s) in keep]
    _save(store)
    return user, token


def get_user_by_token(token):
    if not token:
        return None, None
    store = _load()
    th = _token_hash(token)
    sess = next((s for s in store["sessions"] if s.get("token_hash") == th), None)
    if not sess:
        return None, None
    user = next((u for u in store["users"] if u.get("id") == sess.get("user_id")), None)
    if not user:
        return None, None
    return user, store["profiles"].get(user["id"])


def signout(token):
    if not token:
        return
    store = _load()
    th = _token_hash(token)
    store["sessions"] = [s for s in store["sessions"] if s.get("token_hash") != th]
    _save(store)


def validate_profile(body):
    """Validate profile payload. Returns (profile_dict, errors_dict)."""
    body = body if isinstance(body, dict) else {}
    errors = {}

    # ---- location ----
    loc = body.get("location") if isinstance(body.get("location"), dict) else {}
    mode = (loc.get("mode") or "").strip()
    location = None
    if mode not in ("geolocation", "manual") and (loc or body.get("location") is not None):
        # location block present but mode missing/invalid
        if not loc:
            errors["location"] = "Choose how to set your location."
        else:
            errors["location.mode"] = "Mode must be 'geolocation' or 'manual'."
    elif mode == "geolocation":
        try:
            lat = float(loc.get("lat"))
            lon = float(loc.get("lon"))
        except (TypeError, ValueError):
            errors["location"] = "Geolocation did not provide coordinates yet. Allow access or enter manually."
            lat = lon = None
        if "location" not in errors:
            if not (INDIA_BBOX["lat_min"] <= lat <= INDIA_BBOX["lat_max"] and
                    INDIA_BBOX["lon_min"] <= lon <= INDIA_BBOX["lon_max"]):
                errors["location"] = "Coordinates look outside India. Check or enter manually."
            else:
                try:
                    acc = float(loc.get("accuracy_m")) if loc.get("accuracy_m") is not None else None
                except (TypeError, ValueError):
                    acc = None
                location = {"mode": "geolocation", "lat": round(lat, 5), "lon": round(lon, 5),
                            "accuracy_m": acc,
                            "label": str(loc.get("label") or "").strip()[:120] or None,
                            "city": str(loc.get("city") or "").strip()[:60] or None,
                            "ward_id": str(loc.get("ward_id") or "").strip()[:40] or None,
                            "updated_at": _now()}
    elif mode == "manual":
        label = str(loc.get("label") or "").strip()
        city = str(loc.get("city") or "").strip()
        if len(label) < 2:
            errors["location"] = "Enter your area / locality (at least 2 characters)."
        elif len(label) > 120:
            errors["location"] = "Locality text is too long (max 120 characters)."
        elif city and city not in CITY_OPTIONS:
            errors["location.city"] = "City must be one of: %s." % ", ".join(CITY_OPTIONS)
        else:
            location = {"mode": "manual", "lat": None, "lon": None, "accuracy_m": None,
                        "label": label, "city": city or None,
                        "ward_id": str(loc.get("ward_id") or "").strip()[:40] or None,
                        "updated_at": _now()}

    # ---- age range ----
    age_range = body.get("age_range")
    if age_range is not None:
        age_range = str(age_range).strip()
        if age_range not in AGE_RANGES:
            errors["age_range"] = "Age range must be one of: %s." % ", ".join(AGE_RANGES)
        elif age_range == "":
            age_range = None
    else:
        age_range = None

    # ---- ailments ----
    ailments = body.get("ailments")
    if ailments is None:
        ailments = []
    if not isinstance(ailments, list):
        errors["ailments"] = "Ailments must be a list."
        ailments = []
    else:
        ailments = [str(a).strip() for a in ailments if str(a).strip()]
        unknown = [a for a in ailments if a not in AILMENT_OPTIONS]
        if unknown:
            errors["ailments"] = "Unknown option(s): %s. Allowed: %s." % (", ".join(unknown), ", ".join(AILMENT_OPTIONS))
        elif "none" in ailments and len(ailments) > 1:
            errors["ailments"] = "'None' cannot be combined with other conditions."
    note = str(body.get("ailments_note") or "").strip()
    if len(note) > 280:
        errors["ailments_note"] = "Note is too long (max 280 characters)."
    consent = body.get("consent_health_data")
    if ailments and "none" not in ailments and consent is not True:
        errors["consent_health_data"] = "Please consent to storing health info to save ailments."

    if errors:
        return None, errors
    profile = {
        "location": location,
        "age_range": age_range,
        "ailments": ailments,
        "ailments_note": note or None,
        "consent_health_data": bool(consent) if (ailments and "none" not in ailments) else False,
        "updated_at": _now(),
    }
    profile["completed"] = bool(location or age_range or ailments)
    return profile, {}


def upsert_profile(user_id, body):
    profile, errors = validate_profile(body)
    if errors:
        return None, errors
    store = _load()
    store["profiles"][user_id] = profile
    _save(store)
    return profile, {}
