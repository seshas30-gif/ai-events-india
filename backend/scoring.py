"""P0 quality scoring, view filters, sorting and stats — pure functions over
event dicts (Supabase rows), so existing rows are scored on read even before
the schema migration / next scrape fills the new P0 columns."""
from datetime import date, datetime
from urllib.parse import urlparse

PART_MAXIMA = {"completeness": 30, "source_trust": 25, "organizer": 25, "price_clarity": 20}

# Domains that mean "someone wrote about the event" rather than the event's
# own page — low source trust. Checked as substrings of the hostname.
_LOW_TRUST = (
    "twitter.com", "x.com", "linkedin.com", "facebook.com", "instagram.com",
    "youtube.com", "youtu.be", "medium.com", "substack.com", "wordpress.com",
    "blogspot.", "dev.to", "hashnode.", "reddit.com", "timesofindia",
    "economictimes", "yourstory.com", "inc42.com", "analyticsindiamag.com/news",
)
# Ticketing / listing platforms — a real registration page, just not bespoke.
_AGGREGATORS = (
    "eventbrite.", "meetup.com", "lu.ma", "luma.com", "townscript.com",
    "bookmyshow.com", "allevents.in", "explara.com", "insider.in",
    "unstop.com", "devfolio.co", "skillenza.com", "konfhub.com", "hasgeek.com",
)
# Organizers with an established India track record get a floor, so a first
# sighting of a NASSCOM event doesn't score like an unknown one-off.
_KNOWN_ORGANIZERS = (
    "nasscom", "analytics india", "producttank", "t-hub", "hasgeek",
    "fractal", "india ai", "iit", "iim", "microsoft", "google", "aws",
    "amazon", "meta", "openai", "anthropic", "gdg", "google developer",
)


def parse_date(value) -> date | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
        except ValueError:
            return None


def days_until(value, today: date) -> int | None:
    d = parse_date(value)
    return None if d is None else (d - today).days


def _host(url: str | None) -> str:
    if not url:
        return ""
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def score_parts(event: dict, organizer_count: int = 1) -> dict:
    # Completeness /30
    completeness = 0
    if event.get("start_date"):
        completeness += 8
    if event.get("city"):
        completeness += 6
    if event.get("venue"):
        completeness += 5
    if event.get("description"):
        completeness += 4
    if event.get("organizer"):
        completeness += 4
    if event.get("registration_url") or event.get("url"):
        completeness += 3

    # Source trust /25
    host = _host(event.get("url"))
    full = (event.get("url") or "").lower()
    if not host:
        source_trust = 0
    elif any(t in host or t in full for t in _LOW_TRUST):
        source_trust = 6
    elif any(a in host for a in _AGGREGATORS):
        source_trust = 17
    else:
        source_trust = 21
    if source_trust and event.get("registration_url") and event.get("registration_url") != event.get("url"):
        source_trust = min(25, source_trust + 4)

    # Organizer track record /25
    org = (event.get("organizer") or "").strip()
    if not org:
        organizer = 5
    elif organizer_count >= 5:
        organizer = 25
    elif organizer_count >= 3:
        organizer = 21
    elif organizer_count == 2:
        organizer = 17
    else:
        organizer = 12
    if org and any(k in org.lower() for k in _KNOWN_ORGANIZERS):
        organizer = max(organizer, 20)

    # Price clarity /20
    if event.get("is_free") is True or event.get("price_inr") == 0:
        price_clarity = 20
    elif event.get("price_inr"):
        price_clarity = 18
    elif event.get("is_free") is False:
        price_clarity = 10
    else:
        price_clarity = 4

    return {
        "completeness": min(PART_MAXIMA["completeness"], completeness),
        "source_trust": source_trust,
        "organizer": organizer,
        "price_clarity": price_clarity,
    }


def compute_quality_score(event: dict, organizer_count: int = 1) -> int:
    return sum(score_parts(event, organizer_count).values())


def attach_scores(events: list[dict]) -> list[dict]:
    """Attach quality_score + score_parts to each row in place, using the
    organizer frequency within this result set (plus the full-set counts the
    caller may have pre-seeded via event['_organizer_total'])."""
    counts: dict[str, int] = {}
    for e in events:
        key = (e.get("organizer") or "").strip().lower()
        if key:
            counts[key] = counts.get(key, 0) + 1
    for e in events:
        key = (e.get("organizer") or "").strip().lower()
        total = max(counts.get(key, 0), int(e.get("_organizer_total") or 0))
        parts = score_parts(e, organizer_count=total)
        e["score_parts"] = parts
        e["quality_score"] = sum(parts.values())
        e.pop("_organizer_total", None)
    return events


def next_deadline_days(event: dict, today: date) -> int | None:
    vals = [d for d in (days_until(event.get("registration_deadline"), today),
                        days_until(event.get("cfp_deadline"), today)) if d is not None and d >= 0]
    return min(vals) if vals else None


def passes_view(event: dict, view: str | None, today: date) -> bool:
    if not view:
        return True
    if view == "closing":
        d = next_deadline_days(event, today)
        return d is not None and d <= 7
    if view == "week":
        d = days_until(event.get("start_date"), today)
        return d is not None and 0 <= d <= 7
    if view == "new":
        found = parse_date(event.get("discovered_at"))
        return found is not None and 0 <= (today - found).days <= 7
    if view == "open":
        r = days_until(event.get("registration_deadline"), today)
        return event.get("status") in ("upcoming", "ongoing", None) and (r is None or r >= 0)
    return True


def sort_events(events: list[dict], sort: str | None, today: date) -> list[dict]:
    far = date.max

    def start(e):
        return parse_date(e.get("start_date")) or far

    if sort == "closing":
        return sorted(events, key=lambda e: (next_deadline_days(e, today) if next_deadline_days(e, today) is not None else 9999,
                                             -(e.get("quality_score") or 0)))
    if sort == "soonest":
        return sorted(events, key=start)
    if sort == "newest":
        return sorted(events, key=lambda e: (parse_date(e.get("discovered_at")) or date.min,
                                             e.get("quality_score") or 0), reverse=True)
    # default: score
    return sorted(events, key=lambda e: (-(e.get("quality_score") or 0), start(e)))


def compute_stats(rows: list[dict], today: date) -> dict:
    open_rows = [r for r in rows if r.get("status") in ("upcoming", "ongoing", None)
                 and (days_until(r.get("registration_deadline"), today) is None
                      or days_until(r.get("registration_deadline"), today) >= 0)]
    cities = {str(r["city"]).strip() for r in rows if r.get("city")}
    return {
        # legacy keys (existing frontend / API consumers)
        "total": len(rows),
        "new": sum(1 for r in rows if r.get("is_new")),
        "upcoming": sum(1 for r in rows if r.get("status") == "upcoming"),
        # P0-1 hero counters
        "open_now": len(open_rows),
        "starting_7d": sum(1 for r in rows if passes_view(r, "week", today) and r.get("status") != "past"),
        "new_7d": sum(1 for r in rows if passes_view(r, "new", today)),
        "closing_7d": sum(1 for r in rows if passes_view(r, "closing", today) and r.get("status") != "past"),
        "cities": len(cities),
        "ongoing": sum(1 for r in rows if r.get("status") == "ongoing"),
    }
