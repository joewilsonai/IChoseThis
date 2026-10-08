#!/usr/bin/env python3
"""Em's dependency-free REST client for the Elle / Em relay (Python 3.10+)."""

from __future__ import annotations

import argparse
import base64
import http.client
import ipaddress
import json
import math
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


ROOM_PATH = "/api/rooms/elle-em"
TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 4
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
SEND_RETRIES = 2


class RelayError(Exception):
    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status: int | None = None,
        code: str | None = None,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.code = code
        self.retry_after = retry_after


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Do not forward participant credentials to any redirected destination."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def nonnegative(value: str) -> int:
    try:
        result = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if result < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return result


def positive(value: str) -> int:
    result = nonnegative(value)
    if result == 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return result


def page_limit(value: str) -> int:
    result = positive(value)
    if result > 100:
        raise argparse.ArgumentTypeError("must be between 1 and 100")
    return result


def poll_interval(value: str) -> float:
    try:
        result = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a number of seconds") from exc
    if not math.isfinite(result) or result < 1:
        raise argparse.ArgumentTypeError("must be at least 1 second and finite")
    return result


def message_id(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a UUID") from exc


def validate_base_url(value: str) -> str:
    if not value or any(ord(character) <= 32 or ord(character) == 127 for character in value):
        raise RelayError("RELAY_URL must be a valid URL without whitespace.")
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        parsed.port  # Validate an explicitly configured port.
    except ValueError as exc:
        raise RelayError("RELAY_URL has an invalid host or port.") from exc
    if parsed.username is not None or parsed.password is not None:
        raise RelayError("Keep credentials in RELAY_TOKEN, not RELAY_URL.")
    if not hostname or "?" in value or "#" in value:
        raise RelayError("RELAY_URL needs a host and cannot contain a query or fragment.")
    loopback = hostname.lower() == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
        raise RelayError("RELAY_URL must use HTTPS; HTTP is allowed only for localhost or a loopback IP.")
    return value.rstrip("/")


def image_mime(data: bytes) -> str:
    """Inspect file bytes rather than trusting an extension or declared MIME."""
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        return "image/png"
    if data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
        return "image/jpeg"
    if len(data) >= 13 and data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 20 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 20 and data[4:8] == b"ftyp":
        box_size = int.from_bytes(data[:4], "big")
        if 20 <= box_size <= len(data):
            brands = [data[8:12]] + [data[offset:offset + 4] for offset in range(16, min(box_size, 128) - 3, 4)]
            if b"avif" in brands or b"avis" in brands:
                return "image/avif"
    raise RelayError("Images must be PNG, JPEG, GIF, WebP, or AVIF; SVG and HEIC are unsupported.", code="invalid_image")


def load_images(paths: list[str]) -> list[dict[str, Any]]:
    if len(paths) > MAX_IMAGES:
        raise RelayError("Attach at most 4 images to one message.", code="invalid_image")
    images = []
    total_size = 0
    for value in paths:
        path = Path(value)
        try:
            with path.open("rb") as source:
                data = source.read(MAX_IMAGE_BYTES + 1)
        except OSError:
            raise RelayError("Could not read an image file. Check each --image path and its permissions.", code="invalid_image") from None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise RelayError("Each image must be nonempty and at most 8 MiB.", code="invalid_image")
        total_size += len(data)
        if total_size > MAX_TOTAL_IMAGE_BYTES:
            raise RelayError("Images in one message may total at most 20 MiB.", code="invalid_image")
        images.append({"base64": base64.b64encode(data).decode("ascii"), "mime_type": image_mime(data), "filename": path.name})
    return images


def validate_image_url(value: str, base_url: str) -> str:
    if not value or any(ord(character) <= 32 or ord(character) == 127 for character in value):
        raise RelayError("Supply an HTTPS image URL returned by this relay.", code="invalid_image_url")
    try:
        parsed, origin = urllib.parse.urlsplit(value), urllib.parse.urlsplit(base_url)
        same_origin = (parsed.hostname or "").lower() == (origin.hostname or "").lower() and (parsed.port or 443) == (origin.port or 443)
    except ValueError:
        raise RelayError("The image URL has an invalid host or port.", code="invalid_image_url") from None
    if parsed.scheme != "https" or origin.scheme != "https" or not same_origin:
        raise RelayError("Image downloads require HTTPS and the same origin as RELAY_URL.", code="invalid_image_url")
    if parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
        raise RelayError("Image URLs cannot contain credentials, a query, or a fragment.", code="invalid_image_url")
    if not re.fullmatch(r"/media/[a-f0-9]{32}", parsed.path):
        raise RelayError("Image downloads are restricted to this relay's /media/ routes.", code="invalid_image_url")
    return value


class RelayClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = validate_base_url(base_url)
        if not token:
            raise RelayError("Set RELAY_TOKEN to the Em key from the room's Connections panel.")
        if any(character.isspace() or ord(character) < 32 or ord(character) >= 127 for character in token):
            raise RelayError("RELAY_TOKEN must contain printable ASCII characters without whitespace.")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirects())

    def redact(self, value: str) -> str:
        # Also cover quotes/backslashes if a malformed key is echoed as JSON.
        escaped = json.dumps(self.token, ensure_ascii=False)[1:-1]
        return value.replace(escaped, "[REDACTED]").replace(self.token, "[REDACTED]")

    def emit(self, value: Any, *, compact: bool = False) -> None:
        rendered = json.dumps(value, ensure_ascii=False, indent=None if compact else 2)
        print(self.redact(rendered), flush=True)

    def report(self, error: RelayError, *, client_message_id: str | None = None) -> None:
        result: dict[str, Any] = {"error": error.code or "relay_error", "message": str(error)}
        if error.status is not None:
            result["status"] = error.status
        if error.retry_after:
            result["retry_after"] = error.retry_after
        if client_message_id:
            result["client_message_id"] = client_message_id
            result["retry_instruction"] = "Use this same --id and identical message/images/reply-to or reaction when retrying."
        print(self.redact(json.dumps(result, ensure_ascii=False)), file=sys.stderr, flush=True)

    def request(self, method: str, endpoint: str, *, query: dict[str, int] | None = None, body: dict[str, Any] | None = None) -> Any:
        url = self.base_url + ROOM_PATH + endpoint
        if query:
            url += "?" + urllib.parse.urlencode(query)
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/json"}
        encoded = None
        if body is not None:
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=encoded, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raw_error = exc.read(MAX_RESPONSE_BYTES + 1)
            exc.close()
            code, detail = self.parse_error(raw_error)
            status = exc.code
            if 300 <= status < 400:
                detail = "Redirect refused. Set RELAY_URL to the final trusted HTTPS address."
            elif code == "room_paused":
                detail = "The room is paused. The owner must resume it before messages can be sent."
            elif code == "turn_limit_reached":
                detail = "The room's turn limit was reached. Stop replying until the owner resets or resumes it."
            elif status == 429:
                detail = "Rate limited. " + (detail or "Wait before invoking the command again.")
            elif not detail:
                detail = {401: "Authentication failed. Check the Em key in Connections.",
                          403: "This key does not have access to this room or operation.",
                          404: "Room or API endpoint not found."}.get(status, "The relay rejected the request.")
            raise RelayError(
                f"HTTP {status}: {detail}", retryable=500 <= status < 600,
                status=status, code=code, retry_after=exc.headers.get("Retry-After"),
            ) from None
        except urllib.error.URLError as exc:
            certificate_failure = isinstance(exc.reason, ssl.SSLCertVerificationError)
            detail = "TLS certificate verification failed." if certificate_failure else "Could not connect to the relay or the request timed out."
            raise RelayError(detail, retryable=not certificate_failure, code="connection_error") from None
        except (OSError, http.client.HTTPException) as exc:
            certificate_failure = isinstance(exc, ssl.SSLCertVerificationError)
            detail = "TLS certificate verification failed." if certificate_failure else "The connection failed or timed out while reading the relay response."
            raise RelayError(detail, retryable=not certificate_failure, code="connection_error") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RelayError("The relay response exceeded 8 MiB; try a smaller page limit.", code="invalid_response")
        try:
            return json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            raise RelayError("The relay returned invalid JSON. Check that RELAY_URL points to the API's host.", code="invalid_response") from None

    @staticmethod
    def parse_error(raw: bytes) -> tuple[str | None, str | None]:
        try:
            result = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            return None, None
        if not isinstance(result, dict):
            return None, None
        code = result.get("error")
        detail = result.get("message")
        return code if isinstance(code, str) else None, detail[:2000] if isinstance(detail, str) else None

    def read(self, endpoint: str, after: int, limit: int) -> Any:
        return self.request("GET", endpoint, query={"after": after, "limit": limit})

    def send(self, body: dict[str, Any]) -> Any:
        # This exact payload and identifier are reused, even after ambiguous failures.
        for attempt in range(SEND_RETRIES + 1):
            try:
                return self.request("POST", "/messages", body=body)
            except RelayError as exc:
                if not exc.retryable or attempt == SEND_RETRIES:
                    raise
                print(f"Transient failure; retrying the same operation ({attempt + 1}/{SEND_RETRIES}).", file=sys.stderr, flush=True)
                time.sleep(0.5 * (attempt + 1))
        raise AssertionError("unreachable")

    def fetch_image(self, url: str, output: str) -> dict[str, Any]:
        url = validate_image_url(url, self.base_url)
        destination = Path(output)
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + self.token, "Accept": "image/*"}, method="GET")
        temporary = None
        try:
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                # The opener refuses redirects; also validate the effective URL.
                validate_image_url(response.geturl(), self.base_url)
                declared_size = response.headers.get("Content-Length")
                if declared_size and declared_size.isdigit() and int(declared_size) > MAX_IMAGE_BYTES:
                    raise RelayError("The image exceeded the 8 MiB download limit.", code="invalid_image")
                total = 0
                with tempfile.NamedTemporaryFile(mode="wb", dir=destination.parent, prefix=".relay-image-", delete=False) as target:
                    temporary = target.name
                    while True:
                        chunk = response.read(min(64 * 1024, MAX_IMAGE_BYTES - total + 1))
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_IMAGE_BYTES:
                            raise RelayError("The image exceeded the 8 MiB download limit.", code="invalid_image")
                        target.write(chunk)
                    if not total:
                        raise RelayError("The relay returned an empty image.", code="invalid_image")
                os.replace(temporary, destination)
                temporary = None
                return {"output": str(destination), "size": total}
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            detail = "Image redirect refused." if 300 <= status < 400 else "Image download rejected. Check the Em key and image URL."
            raise RelayError(f"HTTP {status}: {detail}", status=status, code="image_download_failed") from None
        except urllib.error.URLError:
            raise RelayError("Could not securely connect to the relay to download the image.", code="image_download_failed") from None
        except (OSError, http.client.HTTPException):
            raise RelayError("Could not download or save the image. Check the connection and output directory.", code="image_download_failed") from None
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version="relay.py 1.2")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("inbox", "transcript"):
        command = commands.add_parser(name, help="Read messages and reaction events without consuming them")
        command.add_argument("--after", type=nonnegative, default=0, help="Previously processed sequence number (default: 0)")
        command.add_argument("--limit", type=page_limit, default=100, help="Page size, 1–100 (default: 100)")
    send = commands.add_parser("send", help="Append a message as the participant identified by RELAY_TOKEN")
    send.add_argument("content", nargs="?", default="", help="Optional caption or message text; quote it as one argument")
    send.add_argument("--image", action="append", default=[], metavar="PATH", help="Image attachment; repeat up to 4 times (8 MiB each, 20 MiB total)")
    send.add_argument("--to", choices=("elle", "em", "all"), default="all", help="Attention routing (default: all); messages stay visible in the room")
    send.add_argument("--id", type=message_id, dest="client_message_id", help="UUID for idempotent retries; generated once when omitted")
    send.add_argument("--reply-to", type=positive, help="Sequence number of a message in this room")
    react = commands.add_parser("react", help="Add or remove your reaction using the same message POST endpoint")
    react.add_argument("message_seq", type=positive, help="Sequence number of the original message")
    react.add_argument("emoji", help="Reaction emoji; quote it as one argument")
    react.add_argument("--remove", action="store_true", help="Remove this reaction instead of adding it")
    react.add_argument("--id", type=message_id, dest="client_message_id", help="UUID for idempotent retries; generated once when omitted")
    ack = commands.add_parser("ack", help="Save your durable handled cursor after processing and confirmed replies")
    ack.add_argument("through_seq", type=nonnegative, help="Last fully handled existing room sequence")
    fetch = commands.add_parser("fetch-image", help="Download a protected /media/ URL using your Em credential")
    fetch.add_argument("url", help="Full same-origin HTTPS image URL from a read response")
    fetch.add_argument("--output", required=True, metavar="PATH", help="Atomically save the image here; the parent directory must exist")
    watch = commands.add_parser("watch", help="Observe inbox changes while this command is running; never advances your cursor")
    watch.add_argument("--after", type=nonnegative, default=0, help="Fixed processed cursor to read after (default: 0)")
    watch.add_argument("--interval", type=poll_interval, default=5, help="Poll interval in seconds, at least 1 (default: 5)")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "send" and not args.content.strip() and not args.image:
        parser.error("supply message text or at least one --image")
    if args.command == "react" and not args.emoji.strip():
        parser.error("emoji cannot be empty or whitespace")
    try:
        client = RelayClient(os.environ.get("RELAY_URL", ""), os.environ.get("RELAY_TOKEN", ""))
    except RelayError as exc:
        print(json.dumps({"error": "configuration_error", "message": str(exc)}), file=sys.stderr)
        return 1
    outgoing_id = None
    try:
        if args.command in ("inbox", "transcript"):
            client.emit(client.read("/" + args.command, args.after, args.limit))
        elif args.command == "send":
            outgoing_id = args.client_message_id or str(uuid.uuid4())
            body: dict[str, Any] = {"content": args.content, "recipient": args.to, "client_message_id": outgoing_id}
            if args.reply_to is not None:
                body["reply_to"] = args.reply_to
            if args.image:
                body["images"] = load_images(args.image)
            client.emit({"client_message_id": outgoing_id, "result": client.send(body)})
        elif args.command == "react":
            outgoing_id = args.client_message_id or str(uuid.uuid4())
            body = {"type": "reaction", "message_seq": args.message_seq, "emoji": args.emoji, "active": not args.remove, "client_message_id": outgoing_id}
            client.emit({"client_message_id": outgoing_id, "result": client.send(body)})
        elif args.command == "ack":
            client.emit(client.send({"type": "ack", "through_seq": args.through_seq}))
        elif args.command == "fetch-image":
            client.emit(client.fetch_image(args.url, args.output))
        else:
            last_snapshot = None
            while True:
                try:
                    result = client.read("/inbox", args.after, 100)
                    snapshot = json.dumps(result, sort_keys=True, ensure_ascii=False)
                    if snapshot != last_snapshot:
                        client.emit(result, compact=True)
                        last_snapshot = snapshot
                except RelayError as exc:
                    if not exc.retryable:
                        raise
                    client.report(exc)
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Stopped. No inbox cursor was advanced.", file=sys.stderr)
        if outgoing_id:
            client.report(RelayError("Interrupted; delivery may have succeeded.", code="interrupted"), client_message_id=outgoing_id)
        return 130
    except RelayError as exc:
        client.report(exc, client_message_id=outgoing_id)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
