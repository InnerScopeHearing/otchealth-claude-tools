"""Write one row per render to the Notion Avatar Render Log database.

Creates the database on first use if NOTION_RENDER_DB_ID is not set and a
NOTION_PARENT_PAGE_ID is provided. Otherwise expects the DB id in config.
"""
import datetime

import requests

import config

NOTION_VERSION = "2022-06-28"
_BASE = "https://api.notion.com/v1"


def _headers():
    if not config.NOTION_API_KEY:
        raise RuntimeError("NOTION_API_KEY is not set.")
    return {
        "Authorization": f"Bearer {config.NOTION_API_KEY}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


SCHEMA = {
    "Title": {"title": {}},
    "Model": {"select": {}},
    "Backend": {"select": {}},
    "Segments": {"number": {}},
    "GPU Minutes": {"number": {}},
    "Est Cost USD": {"number": {}},
    "Status": {"select": {"options": [
        {"name": "success", "color": "green"},
        {"name": "failed", "color": "red"},
        {"name": "partial", "color": "yellow"},
    ]}},
    "R2 URL": {"url": {}},
    "Artifact": {"rich_text": {}},
    "Created": {"date": {}},
}


def ensure_database():
    """Return a render-log DB id, creating the DB under the parent page if needed."""
    if config.NOTION_RENDER_DB_ID:
        return config.NOTION_RENDER_DB_ID
    if not config.NOTION_PARENT_PAGE_ID:
        raise RuntimeError("Set NOTION_RENDER_DB_ID, or NOTION_PARENT_PAGE_ID to auto-create the DB.")
    resp = requests.post(f"{_BASE}/databases", headers=_headers(), json={
        "parent": {"type": "page_id", "page_id": config.NOTION_PARENT_PAGE_ID},
        "title": [{"type": "text", "text": {"content": "Avatar Render Log"}}],
        "properties": SCHEMA,
    }, timeout=60)
    if not resp.ok:
        raise RuntimeError(f"Notion DB create {resp.status_code}: {resp.text[:300]}")
    return resp.json()["id"]


def log_render(*, title, model, backend, segments, gpu_minutes, est_cost_usd,
               status, r2_url, artifact, db_id=None):
    db_id = db_id or ensure_database()
    props = {
        "Title": {"title": [{"text": {"content": title}}]},
        "Model": {"select": {"name": model}},
        "Backend": {"select": {"name": backend}},
        "Segments": {"number": segments},
        "GPU Minutes": {"number": round(gpu_minutes, 2)},
        "Est Cost USD": {"number": round(est_cost_usd, 2)},
        "Status": {"select": {"name": status}},
        "R2 URL": {"url": r2_url or None},
        "Artifact": {"rich_text": [{"text": {"content": artifact or ""}}]},
        "Created": {"date": {"start": datetime.datetime.utcnow().isoformat() + "Z"}},
    }
    resp = requests.post(f"{_BASE}/pages", headers=_headers(),
                         json={"parent": {"database_id": db_id}, "properties": props}, timeout=60)
    if not resp.ok:
        raise RuntimeError(f"Notion row write {resp.status_code}: {resp.text[:300]}")
    print(f"[notion] logged render '{title}' ({status})")
    return resp.json()["id"]
