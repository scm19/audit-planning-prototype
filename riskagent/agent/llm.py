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


_USE_BETA = True  # turned off for this process if the key's account rejects the beta header


def create(*, system, messages, tools=None, effort="medium", max_tokens=16000):
    """One Messages API call with server-side refusal fallback. Returns the SDK message.

    Tries the beta call first; if the API rejects the beta (not enabled for this key), retries
    as a plain Messages call, then without the effort setting, before giving up.
    """
    global _USE_BETA
    base = dict(model=MODEL, max_tokens=max_tokens, system=system, messages=messages,
                output_config={"effort": effort})
    if tools:
        base["tools"] = tools
    attempts = ([("beta", {**base, "betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"})]
                if _USE_BETA else [])
    attempts += [("plain", base), ("plain", {k: v for k, v in base.items() if k != "output_config"})]
    last = None
    for kind, kwargs in attempts:
        try:
            if kind == "beta":
                return client().beta.messages.create(**kwargs)
            return client().messages.create(**kwargs)
        except (anthropic.BadRequestError, TypeError) as e:
            last = e
            if kind == "beta" and any(w in str(e).lower() for w in ("beta", "fallback")):
                _USE_BETA = False
            continue
        except anthropic.AuthenticationError as e:
            raise ModelUnavailable("The model credential was rejected.") from e
        except (anthropic.NotFoundError, anthropic.PermissionDeniedError) as e:
            raise ModelUnavailable(f"This API key cannot use the model {MODEL}; set MODEL in "
                                   "riskagent/config.py to a model the key can access.") from e
        except anthropic.APIConnectionError as e:
            raise ModelUnavailable("Could not reach the model API.") from e
        except anthropic.RateLimitError as e:
            raise ModelUnavailable("The model API is rate limited right now.") from e
        except anthropic.APIStatusError as e:
            # 4xx/5xx after the SDK's own retries: let callers fall back instead of failing the run.
            raise ModelUnavailable(f"The model API returned an error ({e.status_code}).") from e
    raise ModelUnavailable(f"The model API rejected the request ({getattr(last, 'status_code', 'invalid')}).") from last


def blocks_to_params(content) -> list[dict]:
    """Serialize response content blocks for replay (thinking blocks passed back unchanged)."""
    out = []
    for b in content:
        d = b.to_dict() if hasattr(b, "to_dict") else dict(b)
        out.append(d)
    return out


def text_of(content) -> str:
    return "\n".join(b.text for b in content if getattr(b, "type", None) == "text").strip()
