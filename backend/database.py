import os
from supabase import create_client, Client
from models import Event
from typing import Optional
from datetime import date

from scoring import attach_scores, compute_stats, passes_view, sort_events

# Columns added by the P0 migration in schema.sql. If the deployed DB has not
# run it yet, inserts mentioning them fail — upsert retries without them.
P0_COLUMNS = ("registration_deadline", "cfp_deadline", "mode", "price_inr", "quality_score")


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
    for field in ("start_date", "end_date", "registration_deadline", "cfp_deadline"):
        if isinstance(payload.get(field), date):
            payload[field] = payload[field].isoformat()

    try:
        result = client.table("events").insert(payload).execute()
    except Exception:
        # Pre-migration DB (P0 columns absent) — retry without them so the
        # daily scrape keeps working until schema.sql is applied.
        stripped = {k: v for k, v in payload.items() if k not in P0_COLUMNS}
        if stripped == payload:
            raise
        result = client.table("events").insert(stripped).execute()
    return True, result.data[0]["id"]


# Cities the scraper/LLM extraction inconsistently names differently across
# runs. Filtering by one alias should also match events tagged with the other.
CITY_ALIASES = {
    "bangalore": ["Bangalore", "Bengaluru"],
    "bengaluru": ["Bangalore", "Bengaluru"],
    "delhi": ["Delhi", "New Delhi", "Delhi NCR", "Noida", "Gurgaon", "Gurugram"],
    "delhi ncr": ["Delhi", "New Delhi", "Delhi NCR", "Noida", "Gurgaon", "Gurugram"],
}


def get_events(
    client: Client,
    status: Optional[str] = "upcoming",
    city: Optional[str] = None,
    event_type: Optional[str] = None,
    category: Optional[str] = None,
    is_new: Optional[bool] = None,
    limit: int = 100,
    mode: Optional[str] = None,
    is_free: Optional[bool] = None,
    view: Optional[str] = None,
    sort: Optional[str] = "score",
) -> list[dict]:
    # mode/is_free/view filtering and score-aware sorting happen in Python:
    # quality_score is computed on read, and mode/price filters must keep
    # working on rows written before the P0 columns existed. The SQL filters
    # below only use long-standing columns, so a pre-migration DB still works.
    query = client.table("events").select("*").order("start_date", desc=False)

    if status:
        query = query.eq("status", status)
    if city:
        aliases = CITY_ALIASES.get(city.lower(), [city])
        query = query.or_(",".join(f"city.ilike.%{alias}%" for alias in aliases))
    if event_type:
        query = query.eq("event_type", event_type)
    if category:
        query = query.eq("category", category)
    if is_new is not None:
        query = query.eq("is_new", is_new)

    # Fetch everything matching the SQL filters, then filter/sort/slice in
    # Python (the dataset is hundreds of rows, not millions).
    rows = query.limit(5000).execute().data

    today = date.today()
    attach_scores(rows)

    if mode:
        rows = [r for r in rows if r.get("mode") == mode]
    if is_free:
        rows = [r for r in rows if r.get("is_free") is True or r.get("price_inr") == 0]
    if view:
        rows = [r for r in rows if passes_view(r, view, today)]

    rows = sort_events(rows, sort, today)
    return rows[:limit]


def mark_events_seen(client: Client) -> int:
    """Mark all is_new=True events as seen (is_new=False). Returns count updated."""
    result = client.table("events").update({"is_new": False}).eq("is_new", True).execute()
    return len(result.data)


def refresh_event_statuses(client: Client):
    """Call the SQL function that updates upcoming/ongoing/past based on dates."""
    client.rpc("update_event_status").execute()


def get_stats(client: Client) -> dict:
    # select("*") (not the P0 columns by name) so this works pre-migration.
    rows = client.table("events").select("*").limit(5000).execute().data
    return compute_stats(rows, date.today())
