from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime


class Event(BaseModel):
    id: Optional[str] = None
    name: str
    category: Optional[str] = "ai"
    event_type: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    city: Optional[str] = None
    state: Optional[str] = None
    venue: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    organizer: Optional[str] = None
    is_free: Optional[bool] = None
    registration_url: Optional[str] = None
    # P0 fields — registration/CFP deadlines drive the countdown chips,
    # mode + price are filters, quality_score is computed (see scoring.py).
    registration_deadline: Optional[date] = None
    cfp_deadline: Optional[date] = None
    mode: Optional[str] = None  # in_person | online | hybrid
    price_inr: Optional[int] = None  # lowest ticket price in INR; 0 = free
    quality_score: Optional[int] = None
    source_query: Optional[str] = None
    discovered_at: Optional[datetime] = None
    is_new: Optional[bool] = True
    status: Optional[str] = "upcoming"


class EventFilters(BaseModel):
    city: Optional[str] = None
    event_type: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = "upcoming"
    is_new: Optional[bool] = None
    mode: Optional[str] = None
    is_free: Optional[bool] = None
    view: Optional[str] = None  # open | week | new | closing
    sort: Optional[str] = "score"  # score | closing | soonest | newest


class ScrapeResult(BaseModel):
    total_found: int
    new_events: int
    duplicate_events: int
    events: list[Event]
