import os
from supabase import create_client, Client
from models import Event
from typing import Optional
from datetime import date


def get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_KEY"]
    return create_client(url, key)


def upsert_event(client: Client, event: Event) -> tuple[bool, str]:
    """Insert event, skip if URL already exists. Returns (is_new, event_id)."""
    if not event.url:
        return False, ""

    existing = client.table("events").select("id").eq("url", event.url).execute()
    if existing.data:
        return False, existing.data[0]["id"]

    payload = {k: v for k, v in event.model_dump().items()
               if v is not None and k not in ("id", "discovered_at", "is_new", "status")}

    # Serialize dates to ISO strings
    for field in ("start_date", "end_date"):
        if isinstance(payload.get(field), date):
            payload[field] = payload[field].isoformat()

    result = client.table("events").insert(payload).execute()
    return True, result.data[0]["id"]


def get_events(
    client: Client,
    status: Optional[str] = "upcoming",
    city: Optional[str] = None,
    event_type: Optional[str] = None,
    is_new: Optional[bool] = None,
    limit: int = 100,
) -> list[dict]:
    query = client.table("events").select("*").order("start_date", desc=False)

    if status:
        query = query.eq("status", status)
    if city:
        query = query.ilike("city", f"%{city}%")
    if event_type:
        query = query.eq("event_type", event_type)
    if is_new is not None:
        query = query.eq("is_new", is_new)

    result = query.limit(limit).execute()
    return result.data


def mark_events_seen(client: Client) -> int:
    """Mark all is_new=True events as seen (is_new=False). Returns count updated."""
    result = client.table("events").update({"is_new": False}).eq("is_new", True).execute()
    return len(result.data)


def refresh_event_statuses(client: Client):
    """Call the SQL function that updates upcoming/ongoing/past based on dates."""
    client.rpc("update_event_status").execute()


def get_stats(client: Client) -> dict:
    total = client.table("events").select("id", count="exact").execute()
    new = client.table("events").select("id", count="exact").eq("is_new", True).execute()
    upcoming = client.table("events").select("id", count="exact").eq("status", "upcoming").execute()
    return {
        "total": total.count,
        "new": new.count,
        "upcoming": upcoming.count,
    }
