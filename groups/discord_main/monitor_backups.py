#!/usr/bin/env python3
"""
Backup Monitor for TeeJ's Unraid NAS
- Checks Duplicati backup job status
- Checks Unraid notifications for User Script failures
- Used by scheduled tasks for daily 7:30 AM report and failure alerts
"""

import hashlib
import json
import requests
from datetime import datetime, timezone, timedelta

# Alert cooldown — don't re-alert for the same issue within this many hours
ALERT_COOLDOWN_HOURS = 6
ALERT_STATE_FILE = "/workspace/group/monitor_alert_state.json"


def load_alert_state():
    try:
        with open(ALERT_STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_alert_state(state):
    try:
        with open(ALERT_STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def alert_fingerprint(failures):
    """Create a stable fingerprint for a set of failures."""
    key = "|".join(sorted(f.get("name", "") for f in failures))
    return hashlib.md5(key.encode()).hexdigest()


def should_suppress_alert(failures):
    """Return True if this exact set of failures was already alerted recently."""
    if not failures:
        return True
    state = load_alert_state()
    fp = alert_fingerprint(failures)
    last_alerted = state.get(fp)
    if last_alerted:
        last_dt = datetime.fromisoformat(last_alerted)
        if datetime.now(timezone.utc) - last_dt < timedelta(hours=ALERT_COOLDOWN_HOURS):
            return True
    return False


def record_alert(failures):
    """Record that we just alerted for this set of failures."""
    state = load_alert_state()
    fp = alert_fingerprint(failures)
    state[fp] = datetime.now(timezone.utc).isoformat()
    save_alert_state(state)

DUPLICATI_URL = "https://backup.schmitzplex.com"
DUPLICATI_PASSWORD = "DOdo3569!?"
UNRAID_URL = "http://192.168.1.25:81"
UNRAID_API_KEY = "e3d7f69ccdb6af42adc8d23816ea10ffb2fe4fc2b0dc3c01f6fa428a101af2bc"

# How many hours back to look for recent errors (for failure alerts)
ALERT_WINDOW_HOURS = 25


def duplicati_login():
    """Authenticate to Duplicati and return access token."""
    resp = requests.post(
        f"{DUPLICATI_URL}/api/v1/auth/login",
        json={"Password": DUPLICATI_PASSWORD},
        headers={
            "Content-Type": "application/json",
            "Origin": DUPLICATI_URL,
            "Referer": f"{DUPLICATI_URL}/",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()["AccessToken"]


def get_duplicati_backups(token):
    """Fetch all backup jobs and their metadata."""
    resp = requests.get(
        f"{DUPLICATI_URL}/api/v1/backups",
        headers={"Authorization": f"Bearer {token}", "Origin": DUPLICATI_URL},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def get_unraid_notifications():
    """Fetch recent Unraid notifications."""
    query = """
    {
      notifications {
        list(filter: { type: UNREAD, offset: 0, limit: 200 }) {
          id title description importance timestamp
        }
      }
    }
    """
    resp = requests.post(
        f"{UNRAID_URL}/graphql",
        json={"query": query},
        headers={
            "x-api-key": UNRAID_API_KEY,
            "Content-Type": "application/json",
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("data", {}).get("notifications", {}).get("list", [])


def parse_duplicati_time(ts):
    """Parse Duplicati timestamp like '20260307T060151Z' to datetime."""
    if not ts or ts == "never":
        return None
    try:
        return datetime.strptime(ts, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def check_duplicati(alert_mode=False):
    """
    Check Duplicati backups.
    Returns (summary_lines, failures) where failures is a list of dicts.
    Auth failures are silently skipped (monitoring issue, not a backup failure).
    """
    try:
        token = duplicati_login()
        backups = get_duplicati_backups(token)
    except Exception as e:
        # Silently skip if it's an auth/connectivity issue — don't false-alarm
        return ["⚠️ Duplicati API unavailable (auth or connectivity issue)"], []

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=ALERT_WINDOW_HOURS)

    summary_lines = []
    failures = []

    for item in backups:
        b = item.get("Backup", {})
        meta = b.get("Metadata", {})
        name = b.get("Name", "Unknown")
        last_finished = parse_duplicati_time(meta.get("LastBackupFinished"))
        last_error_date = parse_duplicati_time(meta.get("LastErrorDate"))
        last_error_msg = meta.get("LastErrorMessage", "")

        # Determine status
        if last_error_date and last_error_date > cutoff:
            status_icon = "❌"
            failure = {
                "name": name,
                "error": last_error_msg,
                "last_finished": last_finished,
                "error_date": last_error_date,
            }
            failures.append(failure)
        elif not last_finished:
            status_icon = "⚠️"
        elif last_finished < cutoff:
            status_icon = "⚠️"
        else:
            status_icon = "✅"

        finished_str = last_finished.strftime("%m/%d %H:%M UTC") if last_finished else "never"
        summary_lines.append(f"{status_icon} **{name}** — last run: {finished_str}")
        if last_error_date and last_error_date > cutoff:
            summary_lines.append(f"   ↳ Error: {last_error_msg[:120]}")

    return summary_lines, failures


def check_unraid_user_scripts(alert_mode=False):
    """
    Check Unraid notifications for User Script failures.
    Returns (summary_lines, failures).
    """
    try:
        notifications = get_unraid_notifications()
    except Exception as e:
        return [], [{"name": "Unraid API", "error": str(e)}]

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=ALERT_WINDOW_HOURS)

    script_failures = []
    for n in notifications:
        title = n.get("title", "")
        desc = n.get("description", "")
        importance = n.get("importance", "")
        ts_str = n.get("timestamp", "")

        # Parse timestamp
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        except Exception:
            ts = None

        # Look for user script related notifications with warnings/errors
        is_script = "script" in title.lower() or "user script" in title.lower()
        is_bad = importance in ("WARNING", "ALERT", "ERROR")

        if is_script and is_bad and ts and ts > cutoff:
            script_failures.append({
                "name": title,
                "error": desc,
                "timestamp": ts,
            })

    summary_lines = []
    if script_failures:
        for f in script_failures:
            ts_str = f["timestamp"].strftime("%m/%d %H:%M UTC")
            summary_lines.append(f"❌ **{f['name']}** ({ts_str}): {f['error'][:120]}")
    else:
        summary_lines.append("✅ No User Script failures in Unraid notifications")

    return summary_lines, script_failures


CONFIG_BACKUP_DIR = "/workspace/extra/nas/backups/nanoclaw_backups"


def check_config_backup():
    """
    Check whether today's nanoclaw config backup ran successfully.
    Returns (summary_lines, failures).
    """
    import os
    now = datetime.now(timezone.utc) - timedelta(hours=7)  # MST
    today = now.strftime("%Y-%m-%d")
    backup_path = os.path.join(CONFIG_BACKUP_DIR, today)

    if not os.path.isdir(backup_path):
        line = f"❌ **Nanoclaw Config Backup** — no backup found for {today}"
        return [line], [{"name": "Nanoclaw Config Backup", "error": f"No backup directory found at {backup_path}"}]

    files = os.listdir(backup_path)
    if not files:
        line = f"❌ **Nanoclaw Config Backup** — backup folder exists but is empty ({today})"
        return [line], [{"name": "Nanoclaw Config Backup", "error": "Backup folder is empty"}]

    line = f"✅ **Nanoclaw Config Backup** — {len(files)} file(s) backed up ({today})"
    return [line], []


def build_daily_report():
    """Build the full 7:30 AM daily status report."""
    now = datetime.now(timezone.utc)
    mst = now - timedelta(hours=7)
    date_str = mst.strftime("%A, %B %-d")

    lines = [f"📊 **Daily Backup Report** — {date_str}", ""]

    lines.append("**Duplicati Backups:**")
    dup_summary, dup_failures = check_duplicati()
    lines.extend(dup_summary)

    lines.append("")
    lines.append("**Unraid User Scripts:**")
    script_summary, script_failures = check_unraid_user_scripts()
    lines.extend(script_summary)

    lines.append("")
    lines.append("**Nanoclaw Config Backup:**")
    cfg_summary, cfg_failures = check_config_backup()
    lines.extend(cfg_summary)

    total_failures = len(dup_failures) + len(script_failures) + len(cfg_failures)
    lines.append("")
    if total_failures == 0:
        lines.append("🎉 All systems nominal!")
    else:
        lines.append(f"⚠️ {total_failures} issue(s) need attention.")

    return "\n".join(lines)


def build_failure_alert():
    """Check for recent failures and return alert message, or None if all clear or suppressed."""
    _, dup_failures = check_duplicati(alert_mode=True)
    _, script_failures = check_unraid_user_scripts(alert_mode=True)

    all_failures = dup_failures + script_failures

    if not all_failures:
        return None

    # Suppress if we already alerted for this same set of failures recently
    if should_suppress_alert(all_failures):
        return None

    record_alert(all_failures)

    lines = ["🚨 **Backup Alert** — issue(s) detected in the last 25 hours:", ""]

    for f in dup_failures:
        lines.append(f"❌ **Duplicati: {f['name']}**")
        lines.append(f"   {f['error'][:150]}")

    for f in script_failures:
        ts_str = f["timestamp"].strftime("%m/%d %H:%M UTC")
        lines.append(f"❌ **User Script: {f['name']}** ({ts_str})")
        lines.append(f"   {f['error'][:150]}")

    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "report"

    if mode == "report":
        print(build_daily_report())
    elif mode == "alert":
        msg = build_failure_alert()
        if msg:
            print(msg)
        else:
            print("✅ All clear — no backup failures detected.")
    else:
        print(f"Unknown mode: {mode}. Use 'report' or 'alert'.")
        sys.exit(1)
