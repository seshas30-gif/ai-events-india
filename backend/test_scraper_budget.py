"""Tavily budget guardrails: basic depth, alternating-day rotation under the
1,000 credits/month free cap, and Exa fallback. Run: python -m unittest"""
import os
import unittest
from datetime import date, timedelta
from types import SimpleNamespace

os.environ.pop("SCRAPE_ALL_QUERIES", None)

from scraper import (
    AI_QUERIES, PRODUCT_QUERIES, normalize_event_type, search_events,
    select_queries_for_today,
)

D1 = date(2026, 11, 21)
D2 = D1 + timedelta(days=1)


class TestRotation(unittest.TestCase):
    def test_alternates_and_covers_all_queries_over_two_days(self):
        for queries in (AI_QUERIES, PRODUCT_QUERIES):
            a, b = select_queries_for_today(queries, D1), select_queries_for_today(queries, D2)
            self.assertTrue(set(a).isdisjoint(b))
            self.assertEqual(set(a) | set(b), set(queries))

    def test_daily_tavily_credits_stay_under_free_monthly_cap(self):
        for day in (D1, D2):
            daily = len(select_queries_for_today(AI_QUERIES, day)) + len(select_queries_for_today(PRODUCT_QUERIES, day))
            self.assertLessEqual(daily * 31, 1000)  # basic depth = 1 credit/search

    def test_rotation_can_be_disabled_for_full_sweep(self):
        self.assertEqual(select_queries_for_today(AI_QUERIES, D1, rotate=False), AI_QUERIES)


class _FakeTavily:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def search(self, **kwargs):
        self.calls.append(kwargs)
        if self.fail:
            raise RuntimeError("plan usage limit exceeded")
        return {"results": [{"title": "T", "url": "https://t.example", "content": "x"}]}


class _FakeExa:
    def search(self, query, num_results=10, contents=None):
        r = SimpleNamespace(title="E", url="https://e.example", text="exa text")
        return SimpleNamespace(results=[r])


class TestSearchDepthAndFallback(unittest.TestCase):
    def test_uses_basic_depth(self):
        fake = _FakeTavily()
        search_events("q", fake)
        self.assertEqual(fake.calls[0]["search_depth"], "basic")

    def test_falls_back_to_exa_when_tavily_errors(self):
        results = search_events("q", _FakeTavily(fail=True), _FakeExa())
        self.assertEqual(results[0]["url"], "https://e.example")

    def test_no_fallback_configured_returns_empty(self):
        self.assertEqual(search_events("q", _FakeTavily(fail=True)), [])


class TestEventTypeNormalization(unittest.TestCase):
    def test_allowed_values_pass_through(self):
        for t in ("conference", "meetup", "workshop", "hackathon", "summit", "webinar", "other"):
            self.assertEqual(normalize_event_type(t), t)

    def test_symposium_and_synonyms_map_to_allowed(self):
        self.assertEqual(normalize_event_type("symposium"), "conference")  # the live crash
        self.assertEqual(normalize_event_type("Seminar"), "workshop")
        self.assertEqual(normalize_event_type(" networking "), "meetup")

    def test_unknown_and_missing_become_other(self):
        self.assertEqual(normalize_event_type("unconference"), "other")
        self.assertEqual(normalize_event_type(None), "other")
        self.assertEqual(normalize_event_type(""), "other")


if __name__ == "__main__":
    unittest.main()
