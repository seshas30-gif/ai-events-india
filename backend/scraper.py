import os
import json
import logging
from datetime import datetime
from tavily import TavilyClient
from anthropic import Anthropic
from models import Event, ScrapeResult
from database import get_client, upsert_event

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

SEARCH_QUERIES = [
    "AI conference India 2026",
    "artificial intelligence summit India 2026",
    "machine learning conference India 2026",
    "GenAI conference India 2026",
    "data science summit India 2026",
    "AI workshop India 2026",
    "deep learning conference India 2026",
    "AI hackathon India 2026",
    "NASSCOM AI events 2026",
    "Analytics India Magazine conference 2026",
    "NLP conference India 2026",
    "computer vision conference India 2026",
]

EXTRACTION_PROMPT = """You are extracting structured AI event information from web search results.

Search results:
{results}

Extract all distinct AI/ML/Data Science events happening in India. For each event return a JSON array.
Each item must have these fields (use null if unknown):
- name: full event name (string)
- event_type: one of "conference", "meetup", "workshop", "hackathon", "summit", "webinar", "other"
- start_date: ISO date string YYYY-MM-DD or null
- end_date: ISO date string YYYY-MM-DD or null
- city: city name (string or null)
- state: Indian state name (string or null)
- venue: venue/location name (string or null)
- description: 1-2 sentence summary (string or null)
- url: event website URL (string or null)
- organizer: organizing body name (string or null)
- is_free: true/false/null
- registration_url: direct registration link if different from url (string or null)

Rules:
- Only include events IN INDIA
- Only include events related to AI, ML, Data Science, GenAI, LLM, NLP, Computer Vision, Robotics
- Skip past events (before today: {today})
- If you can't confirm it's in India, skip it
- Return ONLY a valid JSON array, no other text

JSON array:"""


def search_events(query: str, tavily: TavilyClient) -> list[dict]:
    try:
        response = tavily.search(
            query=query,
            search_depth="advanced",
            max_results=10,
            include_answer=False,
        )
        return response.get("results", [])
    except Exception as e:
        log.error(f"Tavily search failed for '{query}': {e}")
        return []


def extract_events(results: list[dict], query: str, claude: Anthropic) -> list[Event]:
    if not results:
        return []

    results_text = "\n\n".join(
        f"Title: {r.get('title', '')}\nURL: {r.get('url', '')}\nContent: {r.get('content', '')[:800]}"
        for r in results
    )

    prompt = EXTRACTION_PROMPT.format(
        results=results_text,
        today=datetime.now().date().isoformat(),
    )

    try:
        response = claude.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()

        # Strip markdown code block if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        events_data = json.loads(raw)
        events = []
        for item in events_data:
            try:
                event = Event(
                    name=item.get("name", ""),
                    event_type=item.get("event_type"),
                    start_date=item.get("start_date"),
                    end_date=item.get("end_date"),
                    city=item.get("city"),
                    state=item.get("state"),
                    venue=item.get("venue"),
                    description=item.get("description"),
                    url=item.get("url"),
                    organizer=item.get("organizer"),
                    is_free=item.get("is_free"),
                    registration_url=item.get("registration_url"),
                    source_query=query,
                )
                if event.name and event.url:
                    events.append(event)
            except Exception as e:
                log.warning(f"Skipping malformed event: {e}")
        return events

    except json.JSONDecodeError as e:
        log.error(f"Claude returned invalid JSON for query '{query}': {e}")
        return []
    except Exception as e:
        log.error(f"Claude extraction failed for query '{query}': {e}")
        return []


def run_scrape(queries: list[str] = None) -> ScrapeResult:
    tavily = TavilyClient(api_key=os.environ["TAVILY_API_KEY"])
    claude = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    db = get_client()

    queries = queries or SEARCH_QUERIES
    all_events: list[Event] = []
    new_count = 0
    dup_count = 0

    for query in queries:
        log.info(f"Searching: {query}")
        results = search_events(query, tavily)
        events = extract_events(results, query, claude)
        log.info(f"  Found {len(events)} events from '{query}'")

        for event in events:
            is_new, _ = upsert_event(db, event)
            if is_new:
                new_count += 1
                all_events.append(event)
            else:
                dup_count += 1

    log.info(f"Scrape complete — {new_count} new, {dup_count} duplicates skipped")

    return ScrapeResult(
        total_found=new_count + dup_count,
        new_events=new_count,
        duplicate_events=dup_count,
        events=all_events,
    )


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    result = run_scrape()
    print(f"\nDone: {result.new_events} new events added, {result.duplicate_events} duplicates skipped")
    for e in result.events:
        print(f"  [{e.event_type}] {e.name} — {e.start_date} — {e.city}")
