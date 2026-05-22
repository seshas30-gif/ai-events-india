import os
from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from dotenv import load_dotenv

from database import get_client, get_events, get_stats, mark_events_seen, refresh_event_statuses
from scraper import run_scrape
from models import ScrapeResult

load_dotenv()

app = FastAPI(title="AI Events India API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tighten this to your Netlify domain in production
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

CITIES = ["Bangalore", "Mumbai", "Delhi", "Hyderabad", "Chennai", "Pune", "Kolkata", "Ahmedabad", "Noida", "Gurgaon"]
EVENT_TYPES = ["conference", "meetup", "workshop", "hackathon", "summit", "webinar", "other"]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/events")
def list_events(
    status: Optional[str] = Query(default="upcoming", description="upcoming | ongoing | past"),
    city: Optional[str] = Query(default=None),
    event_type: Optional[str] = Query(default=None),
    is_new: Optional[bool] = Query(default=None),
    limit: int = Query(default=100, le=500),
):
    db = get_client()
    refresh_event_statuses(db)
    events = get_events(db, status=status, city=city, event_type=event_type, is_new=is_new, limit=limit)
    return {"events": events, "count": len(events)}


@app.get("/events/new")
def list_new_events():
    db = get_client()
    events = get_events(db, status=None, is_new=True, limit=50)
    return {"events": events, "count": len(events)}


@app.get("/stats")
def stats():
    db = get_client()
    refresh_event_statuses(db)
    return get_stats(db)


@app.get("/filters")
def filters():
    return {"cities": CITIES, "event_types": EVENT_TYPES}


@app.post("/events/mark-seen")
def mark_seen():
    db = get_client()
    count = mark_events_seen(db)
    return {"marked_seen": count}


_scrape_running = False


@app.post("/scrape", response_model=ScrapeResult)
def trigger_scrape(background_tasks: BackgroundTasks):
    global _scrape_running
    if _scrape_running:
        raise HTTPException(status_code=409, detail="Scrape already in progress")

    def _run():
        global _scrape_running
        _scrape_running = True
        try:
            run_scrape()
        finally:
            _scrape_running = False

    background_tasks.add_task(_run)
    return ScrapeResult(total_found=0, new_events=0, duplicate_events=0, events=[])


@app.get("/scrape/status")
def scrape_status():
    return {"running": _scrape_running}
