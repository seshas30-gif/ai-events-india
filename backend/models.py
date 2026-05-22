from pydantic import BaseModel
from typing import Optional
from datetime import date, datetime


class Event(BaseModel):
    id: Optional[str] = None
    name: str
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
    source_query: Optional[str] = None
    discovered_at: Optional[datetime] = None
    is_new: Optional[bool] = True
    status: Optional[str] = "upcoming"


class EventFilters(BaseModel):
    city: Optional[str] = None
    event_type: Optional[str] = None
    status: Optional[str] = "upcoming"
    is_new: Optional[bool] = None


class ScrapeResult(BaseModel):
    total_found: int
    new_events: int
    duplicate_events: int
    events: list[Event]
