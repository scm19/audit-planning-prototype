"""Thin wrapper over the Anthropic SDK: one place for model, fallbacks and refusal handling.

The API key is read by the SDK from the server's environment (ANTHROPIC_API_KEY); it is never
logged, returned to the browser, or written to disk.
"""
from __future__ import annotations

import os

import anthropic

from riskagent.config import MODEL

_client: anthropic.Anthropic | None = None


class ModelUnavailable(RuntimeError):
    pass


def model_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def client() -> anthropic.Anthropic:
    global _client
    if not model_available():
        raise ModelUnavailable("No ANTHROPIC_API_KEY in the server environment.")
    if _client is None:
        _client = anthropic.Anthropic(timeout=180.0, max_retries=2)
    return _client


def create(*, system, messages, tools=None, effort="medium", max_tokens=16000):
    """One Messages API call with server-side refusal fallback. Returns the SDK message."""
    kwargs = dict(model=MODEL, max_tokens=max_tokens, system=system, messages=messages,
                  output_config={"effort": effort},
                  betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    if tools:
        kwargs["tools"] = tools
    try:
        return client().beta.messages.create(**kwargs)
    except anthropic.AuthenticationError as e:
        raise ModelUnavailable("The model credential was rejected.") from e
    except anthropic.APIConnectionError as e:
        raise ModelUnavailable("Could not reach the model API.") from e
    except anthropic.RateLimitError as e:
        raise ModelUnavailable("The model API is rate limited right now.") from e
    except anthropic.APIStatusError as e:
        # 4xx/5xx after the SDK's own retries: let callers fall back instead of failing the run.
        raise ModelUnavailable(f"The model API returned an error ({e.status_code}).") from e


def blocks_to_params(content) -> list[dict]:
    """Serialize response content blocks for replay (thinking blocks passed back unchanged)."""
    out = []
    for b in content:
        d = b.to_dict() if hasattr(b, "to_dict") else dict(b)
        out.append(d)
    return out


def text_of(content) -> str:
    return "\n".join(b.text for b in content if getattr(b, "type", None) == "text").strip()
