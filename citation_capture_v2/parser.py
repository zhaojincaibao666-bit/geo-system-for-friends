"""CitationCaptureV2: parse only DOM already scoped to one Doubao answer.

This module deliberately has no browser automation.  The Playwright adapter
provides a minimal answer/sibling snapshot and this parser never broad-scans a
page.  Keeping the boundary here makes its scope guarantees testable offline.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

from scrapling.parser import Selector

CAPTURE_VERSION = "v2"
PARSER_VERSION = "citation-capture-v2/1.0.0"

CAPTURED = "CAPTURED"
NO_CITATION_CONFIRMED = "NO_CITATION_CONFIRMED"
CAPTURED_PARTIAL = "CAPTURED_PARTIAL"
CITATION_REGION_NOT_LOADED = "CITATION_REGION_NOT_LOADED"
CAPTURE_FAILED = "CAPTURE_FAILED"

LEGACY_STATUS = {
    CAPTURED: "success",
    NO_CITATION_CONFIRMED: "empty",
    CAPTURED_PARTIAL: "partial",
    CITATION_REGION_NOT_LOADED: "not_available",
    CAPTURE_FAILED: "failed",
}

TRACKING_PARAMS = {
    "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "spm",
    "_ga", "_gl", "yclid", "igshid",
}
TRACKING_HOSTS = {"doubleclick.net", "googletagmanager.com", "google-analytics.com"}
DOUBAO_UI_PATH = re.compile(r"^/(?:chat|login|settings|user|download)(?:/|$)", re.I)


def _text(value: Any) -> str | None:
    value = str(value or "").strip()
    return value or None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _normalize_url(raw_url: str, page_url: str = "") -> tuple[str | None, str | None, str | None]:
    """Return resolved URL, aggregation URL and hostname without losing raw URL."""
    raw_url = _text(raw_url)
    if not raw_url or raw_url == "#" or raw_url.lower().startswith(("javascript:", "data:", "mailto:")):
        return None, None, None
    resolved = urljoin(page_url, raw_url)
    parsed = urlsplit(resolved)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None, None, None
    host = parsed.hostname.lower()
    if any(host == item or host.endswith(f".{item}") for item in TRACKING_HOSTS):
        return None, None, None
    if host.endswith("doubao.com") and DOUBAO_UI_PATH.match(parsed.path or "/"):
        return None, None, None
    kept_query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)
                  if not key.lower().startswith("utm_") and key.lower() not in TRACKING_PARAMS]
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    normalized = urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, urlencode(kept_query, doseq=True), ""))
    return resolved, normalized, host


def _attribute(node: Any, name: str) -> str | None:
    return _text((node.attrib or {}).get(name))


def _node_title(node: Any) -> str | None:
    attrs = node.attrib or {}
    title = attrs.get("title") or attrs.get("data-title") or attrs.get("aria-label")
    return _text(title) or _text(node.text)


def _reference_title(node: Any) -> str | None:
    # The real list is <a><span>1.</span><div>title...</div></a>.
    # Scrapling's .text alone drops descendant title text.
    text = "".join(str(part) for part in node.xpath(".//text()"))
    text = re.sub(r"^\s*\d+\s*[.、．]\s*", "", text.strip())
    return _text(re.sub(r"\s+", " ", text))


def _channel_for(node: Any, default: str) -> str:
    """Prefer explicit semantic provenance over CSS class names."""
    current = node
    for _ in range(5):
        attrs = getattr(current, "attrib", {}) or {}
        explicit = _text(attrs.get("data-citation-channel"))
        if explicit:
            return explicit
        marker = " ".join(str(attrs.get(name, "")) for name in ("class", "data-source-type", "role")).lower()
        if "reference" in marker:
            return "reference_card"
        if "source" in marker or "citation" in marker:
            return "source_card"
        current = getattr(current, "parent", None)
        if current is None:
            break
    return default


def _scoped_fragments(payload: dict[str, Any]) -> tuple[list[tuple[str, str]], list[dict[str, str]]]:
    """Resolve a scoped DOM without ever accepting an unbounded page fragment.

    A full page can be supplied by a caller for convenience, but it is reduced
    to the node matching answerIdentity plus siblings explicitly bound to that
    identity.  Ambiguous siblings are returned as debug candidates only.
    """
    answer_html = payload.get("answerHtml")
    answer_id = _text(payload.get("answerIdentity"))
    fragments: list[tuple[str, str]] = []
    unscoped: list[dict[str, str]] = []
    if answer_html is not None:
        fragments.append(("answer_body", str(answer_html)))

    scoped_html = payload.get("scopedHtml")
    if scoped_html:
        if not answer_id:
            # The answer body remains usable, but no surrounding fragment can
            # be attributed safely without an answer identity.
            unscoped.append({"channel": "citation_scope", "reason": "missing_answer_identity"})
        else:
            root = Selector(str(scoped_html))
            nodes = root.xpath(f'//*[@data-message-id={json.dumps(answer_id)}]')
            if nodes:
                answer_node = nodes[0]
                fragments.append(("citation_scope", answer_node.html_content))
                # Only explicitly linked sibling cards are admitted. Q1/Q2
                # messages may coexist in a page but cannot cross this guard.
                siblings = answer_node.xpath(
                    f'following-sibling::*[@data-citation-for={json.dumps(answer_id)} '
                    f'or @data-answer-id={json.dumps(answer_id)} or @aria-labelledby={json.dumps(answer_id)}]'
                )
                for sibling in siblings:
                    fragments.append(("adjacent_source", sibling.html_content))
            else:
                unscoped.append({"channel": "citation_scope", "reason": "answer_identity_not_found"})

    source_panel = payload.get("sourcePanelHtml")
    metadata = payload.get("pageMetadata") or {}
    panel_owner = _text(metadata.get("sourcePanelAnswerIdentity"))
    if source_panel:
        if metadata.get("sourcePanelScoped") is True or (answer_id and panel_owner == answer_id):
            fragments.append(("source_panel", str(source_panel)))
        else:
            unscoped.append({"channel": "source_panel", "reason": "source_panel_not_bound_to_answer"})
    return fragments, unscoped


def _checked_channels(payload: dict[str, Any]) -> set[str]:
    explicitly_checked = payload.get("checkedChannels")
    if isinstance(explicitly_checked, list):
        return {str(channel) for channel in explicitly_checked}
    checked: set[str] = set()
    if "answerHtml" in payload:
        checked.add("answer_body")
    if "scopedHtml" in payload:
        checked.add("citation_scope")
    if "sourcePanelHtml" in payload:
        checked.add("source_panel")
    return checked


def parse_capture(payload: dict[str, Any]) -> dict[str, Any]:
    captured_at = _text(payload.get("capturedAt")) or _now()
    metadata = payload.get("pageMetadata") or {}
    expected = set(payload.get("expectedChannels") or ["answer_body", "citation_scope"])
    if metadata.get("sourcePanelExpected") is True:
        expected.add("source_panel")
    checked = _checked_channels(payload)
    errors: list[str] = []
    citations: list[dict[str, Any]] = []
    seen: set[str] = set()

    try:
        if payload.get("forceParserException"):
            raise RuntimeError("forced parser exception")
        fragments, unscoped = _scoped_fragments(payload)
        for default_channel, html in fragments:
            page = Selector(html)
            for link in page.css("a[href]"):
                raw_url = _attribute(link, "href")
                raw_url = raw_url or _attribute(link, "data-resolved-url") or _attribute(link, "data-final-url")
                resolved, normalized, domain = _normalize_url(raw_url or "", _text(payload.get("pageUrl")) or "")
                if not resolved or not normalized:
                    continue
                # A real external destination exposed by the DOM wins over a
                # Doubao redirect href, while rawUrl preserves the evidence.
                destination = _attribute(link, "data-resolved-url") or _attribute(link, "data-final-url")
                if destination:
                    redirected, redirected_normalized, redirected_domain = _normalize_url(destination, _text(payload.get("pageUrl")) or "")
                    if redirected:
                        resolved, normalized, domain = redirected, redirected_normalized, redirected_domain
                reference_list = metadata.get("referenceList") is True
                if normalized in seen and not reference_list:
                    continue
                seen.add(normalized)
                citations.append({
                    "title": _reference_title(link) if reference_list else _node_title(link),
                    "url": resolved,
                    "rawUrl": raw_url,
                    "normalizedUrl": normalized,
                    "domain": domain,
                    "channel": _channel_for(link, default_channel),
                    "anchorText": _text(link.text),
                    "sourceLabel": _attribute(link, "data-source-label"),
                    **({"position": len(citations) + 1, "sourceType": "reference_list"} if reference_list else {}),
                    "confidence": "HIGH" if default_channel == "answer_body" else "MEDIUM",
                })
    except Exception as exc:  # Capture failure must never discard the answer.
        errors.append(str(exc)[:500])
        unscoped = []

    missing = sorted(expected - checked)
    if errors:
        status = CAPTURED_PARTIAL if citations else CAPTURE_FAILED
    elif missing:
        status = CAPTURED_PARTIAL if citations else CITATION_REGION_NOT_LOADED
    elif citations:
        status = CAPTURED
    else:
        status = NO_CITATION_CONFIRMED

    result: dict[str, Any] = {
        "captureVersion": CAPTURE_VERSION,
        "parserVersion": PARSER_VERSION,
        "status": status,
        "legacyStatus": LEGACY_STATUS[status],
        "citationCount": len(citations),
        "citations": citations,
        "checkedChannels": sorted(checked),
        "expectedChannels": sorted(expected),
        "missingChannels": missing,
        "errors": errors,
        "capturedAt": captured_at,
        "answerIdentity": _text(payload.get("answerIdentity")),
        "questionRunId": _text(payload.get("questionRunId")),
        "unscopedCandidates": unscoped,
    }
    if payload.get("debug") is True:
        scope_html = _text(payload.get("scopedHtml")) or _text(payload.get("answerHtml")) or ""
        result["debugEvidence"] = {
            "scopedDomSnapshot": scope_html[:50000],
            "timestamp": captured_at,
            "answerIdentity": result["answerIdentity"],
            "parserVersion": PARSER_VERSION,
        }
    return result


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(parse_capture(payload), ensure_ascii=False))
    except Exception as exc:
        # The caller can still persist a completed answer with CAPTURE_FAILED.
        print(json.dumps({
            "captureVersion": CAPTURE_VERSION,
            "parserVersion": PARSER_VERSION,
            "status": CAPTURE_FAILED,
            "legacyStatus": LEGACY_STATUS[CAPTURE_FAILED],
            "citationCount": 0,
            "citations": [],
            "checkedChannels": [],
            "expectedChannels": [],
            "missingChannels": [],
            "errors": [str(exc)[:500]],
            "capturedAt": _now(),
            "answerIdentity": None,
            "questionRunId": None,
            "unscopedCandidates": [],
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
