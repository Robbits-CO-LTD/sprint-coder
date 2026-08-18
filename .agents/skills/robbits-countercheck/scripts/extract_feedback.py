#!/usr/bin/env python3
"""Claude/Codex JSONLから、本文を含まない反証傾向の集計JSONを作る。"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Iterable


CATEGORY_PATTERNS = {
    "finish_or_closeout_gap": re.compile(
        r"最後まで|忘れ|残って|途中|完了していない|終わっていない|"
        r"マージ.*(?:まだ|完了)|起票して|ラベル.*貼|close|release|cleanup",
        re.IGNORECASE,
    ),
    "stopped_at_judgment_or_plan": re.compile(
        r"判定.*わかった|計画だけ|提案だけ|報告だけ|説明だけ|"
        r"実装できない|止まら|進めて|実施して|やって",
        re.IGNORECASE,
    ),
    "scope_or_test_overreach": re.compile(
        r"過剰|広げすぎ|やりすぎ|車検|"
        r"簡単な.{0,30}(?:だけ|なのに).{0,30}(?:大げさ|過剰|時間)|"
        r"(?:今回|この作業|この修正|そこまで|頼んでいない).{0,40}"
        r"(?:テスト|検証|レビュー|調査|修正|変更|スコープ).{0,25}"
        r"(?:不要|一切|だけを|のみ|広げ|多すぎ|やりすぎ|時間がかか)|"
        r"(?:テスト|検証|レビュー|調査|修正|変更|スコープ).{0,25}"
        r"(?:過剰|多すぎ|やりすぎ|時間がかか)|"
        r"勝手.{0,20}(?:追加|変更|実装|拡張)|"
        r"(?:他|対象外).{0,15}(?:触らない|変更しない)",
        re.IGNORECASE,
    ),
    "weak_or_stale_evidence": re.compile(
        r"なぜ|なんで|原因|根本|再現|ログ|公式|実際|実機|"
        r"推測|根拠|証拠|現物|確認して|live|state|SHA",
        re.IGNORECASE,
    ),
    "ux_or_human_experience": re.compile(
        r"急に|突然|消え|違和感|使い勝手|分かりにく|見切れ|"
        r"飛び飛び|シームレス|不自然|デザイン|自然さ",
        re.IGNORECASE,
    ),
    "human_or_scope_boundary": re.compile(
        r"承認|判断|入力.*しない|保存.*しない|読み取り|"
        r"質問不要|質問せず|確認不要|一任|Fable5はもう使",
        re.IGNORECASE,
    ),
}

FEEDBACK_CONTEXT_PATTERN = re.compile(
    r"違う|そうじゃ|ではなく|じゃなく|まだ|忘れ|漏れ|途中で|最後まで|"
    r"完了していない|終わっていない|過剰|広げすぎ|やりすぎ|勝手に|"
    r"急に|突然|違和感|分かりにく|見切れ|飛び飛び|不自然|おかしい|"
    r"足りない|不足|残って|前にも|また同じ|ちゃんと|しっかり|本当に|"
    r"(?:と言|お願い|依頼).{0,20}(?:のに|はず)|"
    r"(?:しないで|やめて)|"
    r"(?:なぜ|なんで).{0,30}(?:した|しなかった|できない|忘れ|止ま|終わ|残)",
    re.IGNORECASE,
)

EXCLUDED_PREFIXES = (
    "<recommended_plugins>",
    "<environment_context>",
    "<task-notification>",
    "<codex_delegation>",
    "<turn_aborted>",
    "<heartbeat>",
    "<subagent_notification>",
    "The following is the Codex agent history",
)

WRAPPER_PATTERNS = (
    re.compile(r"^<system-reminder>.*?</system-reminder>\s*", re.DOTALL),
    re.compile(r"^<in-app-browser-context\b.*?</in-app-browser-context>\s*", re.DOTALL),
)

MAX_JSONL_LINE_BYTES = 256 * 1024 * 1024


def parse_since(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("--since must be YYYY-MM-DD") from error


def ordered_jsonl(root: Path, stats: dict[str, Any]) -> list[Path]:
    paths: list[Path] = []
    identities: set[tuple[int, int]] = set()

    def record_walk_error(_: OSError) -> None:
        stats["read_errors"] += 1

    try:
        for directory, directory_names, file_names in os.walk(
            root, onerror=record_walk_error, followlinks=False
        ):
            directory_names.sort(key=str.casefold)
            for file_name in sorted(file_names, key=str.casefold):
                if file_name.casefold().endswith(".jsonl"):
                    path = Path(directory, file_name)
                    try:
                        if path.is_symlink():
                            stats["exclusions"]["symlink_file"] += 1
                            continue
                        file_stat = path.stat()
                    except OSError:
                        stats["read_errors"] += 1
                        continue
                    identity = (file_stat.st_dev, file_stat.st_ino)
                    if identity in identities:
                        stats["exclusions"]["duplicate_file_identity"] += 1
                        continue
                    identities.add(identity)
                    paths.append(path)
    except OSError:
        stats["read_errors"] += 1
    return paths


def new_stats() -> dict[str, Any]:
    return {
        "files_enumerated": 0,
        "files_scanned": 0,
        "bytes_enumerated": 0,
        "lines_scanned": 0,
        "human_messages": 0,
        "feedback_messages": 0,
        "read_errors": 0,
        "json_errors": 0,
        "exclusions": Counter(),
        "categories": Counter(),
        "dates": [],
    }


def strip_wrappers(text: str) -> str:
    result = text.lstrip()
    changed = True
    while changed:
        changed = False
        for pattern in WRAPPER_PATTERNS:
            updated = pattern.sub("", result, count=1)
            if updated != result:
                result = updated.lstrip()
                changed = True
    return result


def excluded_reason(text: str) -> str | None:
    stripped = text.lstrip()
    for prefix in EXCLUDED_PREFIXES:
        if stripped.startswith(prefix):
            return prefix.strip("<>").split()[0]
    if "<INSTRUCTIONS>" in stripped or stripped.startswith("# AGENTS.md"):
        return "injected_instructions"
    if re.match(r"^\[\d+\]\s+(assistant|user):", stripped):
        return "embedded_transcript"
    if re.match(r"^\[Team\s+[^:]+:report\]", stripped):
        return "team_report"
    return None


def text_from_content(content: Any, *, reject_tool_results: bool) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    if reject_tool_results and any(
        isinstance(item, dict) and item.get("type") == "tool_result" for item in content
    ):
        return ""
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") in {"text", "input_text", "output_text"}:
            value = item.get("text")
            if isinstance(value, str):
                parts.append(value)
    return "\n".join(parts)


def item_date(item: dict[str, Any]) -> dt.date | None:
    value = item.get("timestamp")
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def record_message(
    text: str,
    item: dict[str, Any],
    stats: dict[str, Any],
    since: dt.date | None,
) -> None:
    text = strip_wrappers(text)
    if not text:
        stats["exclusions"]["empty_or_wrapper_only"] += 1
        return
    reason = excluded_reason(text)
    if reason:
        stats["exclusions"][reason] += 1
        return
    date = item_date(item)
    if since and (date is None or date < since):
        stats["exclusions"]["outside_since"] += 1
        return
    stats["human_messages"] += 1
    if date:
        stats["dates"].append(date)
    if not FEEDBACK_CONTEXT_PATTERN.search(text):
        stats["exclusions"]["non_feedback_context"] += 1
        return
    stats["feedback_messages"] += 1
    for name, pattern in CATEGORY_PATTERNS.items():
        if pattern.search(text):
            stats["categories"][name] += 1


def scan_lines(path: Path, stats: dict[str, Any]) -> Iterable[dict[str, Any]]:
    try:
        with path.open("rb") as stream:
            while True:
                raw = stream.readline(MAX_JSONL_LINE_BYTES + 1)
                if not raw:
                    break
                stats["lines_scanned"] += 1
                if len(raw) > MAX_JSONL_LINE_BYTES:
                    stats["json_errors"] += 1
                    while raw and not raw.endswith(b"\n"):
                        raw = stream.readline(MAX_JSONL_LINE_BYTES + 1)
                    continue
                if not raw.strip():
                    continue
                try:
                    item = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError, MemoryError):
                    stats["json_errors"] += 1
                    continue
                if not isinstance(item, dict):
                    stats["json_errors"] += 1
                    continue
                yield item
    except OSError:
        stats["read_errors"] += 1


def scan_claude(path: Path, stats: dict[str, Any], since: dt.date | None) -> None:
    if "subagents" in {part.casefold() for part in path.parts}:
        stats["exclusions"]["subagent_file"] += 1
        return
    stats["files_scanned"] += 1
    for item in scan_lines(path, stats):
        if item.get("type") != "user" or item.get("isMeta") is True:
            continue
        message = item.get("message")
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, list) and any(
            isinstance(part, dict) and part.get("type") == "tool_result" for part in content
        ):
            stats["exclusions"]["tool_result_message"] += 1
            continue
        text = text_from_content(content, reject_tool_results=True)
        record_message(text, item, stats, since)


def codex_is_user_thread(path: Path, stats: dict[str, Any]) -> bool | None:
    try:
        with path.open("rb") as stream:
            while True:
                raw = stream.readline(MAX_JSONL_LINE_BYTES + 1)
                if not raw:
                    break
                if len(raw) > MAX_JSONL_LINE_BYTES:
                    while raw and not raw.endswith(b"\n"):
                        raw = stream.readline(MAX_JSONL_LINE_BYTES + 1)
                    continue
                if not raw.strip() or b"session_meta" not in raw:
                    continue
                try:
                    item = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(item, dict) or item.get("type") != "session_meta":
                    continue
                payload = item.get("payload")
                if isinstance(payload, dict) and payload.get("thread_source") == "user":
                    return True
                stats["exclusions"]["non_user_thread_file"] += 1
                return False
    except OSError:
        stats["read_errors"] += 1
        return None
    stats["exclusions"]["missing_session_meta"] += 1
    return False


def scan_codex(path: Path, stats: dict[str, Any], since: dt.date | None) -> None:
    is_user_thread = codex_is_user_thread(path, stats)
    if is_user_thread is None:
        return
    if not is_user_thread:
        return
    stats["files_scanned"] += 1
    for item in scan_lines(path, stats):
        if item.get("type") != "response_item":
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        if payload.get("type") != "message" or payload.get("role") != "user":
            continue
        text = text_from_content(payload.get("content"), reject_tool_results=False)
        record_message(text, item, stats, since)


def date_range(dates: list[dt.date]) -> dict[str, str | None]:
    return {
        "first": min(dates).isoformat() if dates else None,
        "last": max(dates).isoformat() if dates else None,
    }


def public_stats(stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "files_enumerated": stats["files_enumerated"],
        "files_scanned": stats["files_scanned"],
        "bytes_enumerated": stats["bytes_enumerated"],
        "lines_scanned": stats["lines_scanned"],
        "human_messages": stats["human_messages"],
        "feedback_messages": stats["feedback_messages"],
        "read_errors": stats["read_errors"],
        "json_errors": stats["json_errors"],
        "date_range": date_range(stats["dates"]),
        "exclusion_reasons": dict(sorted(stats["exclusions"].items())),
        "category_counts": {
            name: stats["categories"].get(name, 0) for name in CATEGORY_PATTERNS
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude-root", type=Path)
    parser.add_argument("--codex-root", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--since", type=parse_since)
    args = parser.parse_args()
    if not args.claude_root and not args.codex_root:
        parser.error("at least one log root is required")

    stats_by_source = {"claude": new_stats(), "codex": new_stats()}
    roots = []
    if args.claude_root:
        roots.append(("claude", args.claude_root))
    roots.extend(("codex", root) for root in args.codex_root)

    normalized_roots = []
    for source, root in roots:
        resolved = root.resolve()
        normalized_roots.append((source, resolved))
    normalized_roots.sort(key=lambda item: (item[0], len(item[1].parts), str(item[1]).casefold()))

    selected_roots: list[tuple[str, Path]] = []
    for source, root in normalized_roots:
        if any(
            source == selected_source and root.is_relative_to(selected_root)
            for selected_source, selected_root in selected_roots
        ):
            continue
        selected_roots.append((source, root))

    for source, root in selected_roots:
        stats = stats_by_source[source]
        if not root.is_dir():
            stats["read_errors"] += 1
            continue
        files = ordered_jsonl(root, stats)
        for path in files:
            stats["files_enumerated"] += 1
            try:
                stats["bytes_enumerated"] += path.stat().st_size
            except OSError:
                stats["read_errors"] += 1
                continue
            if source == "claude":
                scan_claude(path, stats, args.since)
            else:
                scan_codex(path, stats, args.since)

    result = {
        "schema_version": 1,
        "since": args.since.isoformat() if args.since else None,
        "sources": {
            source: public_stats(stats_by_source[source]) for source in ("claude", "codex")
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    errors = sum(
        stats["read_errors"] + stats["json_errors"] for stats in stats_by_source.values()
    )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
