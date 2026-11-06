"""pydantic v1 / v2 compatibility for the request models.

The PC build runs pydantic v2. The Android build cannot: pydantic v2 needs pydantic-core, a compiled (Rust) library
with no Android build, so there the app runs FastAPI 0.115 (the last line that supports both) with the pure-Python
pydantic v1. The models in main.py
use only two v2-specific decorators; these wrappers give them the same meaning on both.

- field_validator("a", "b")     -> v1 validator("a", "b"); the function is (cls, value) -> value in both
- model_validator(mode="after") -> v1 root_validator(skip_on_failure=True); the function is (self) -> self, reading
                                    and assigning fields; on v1 it runs against a stand-in object whose fields are
                                    copied back into the model's values
"""
import types

try:  # pydantic v2
    from pydantic import field_validator, model_validator  # noqa: F401

    PYDANTIC_V2 = True
except ImportError:  # pydantic v1
    from pydantic import root_validator, validator

    PYDANTIC_V2 = False

    def field_validator(*fields, mode: str = "after"):
        def deco(fn):
            return validator(*fields, pre=(mode == "before"), allow_reuse=True)(fn)
        return deco

    def model_validator(mode: str = "after"):
        if mode != "after":
            raise NotImplementedError("only mode='after' is used by this app")

        def deco(fn):
            def _root(cls, values):
                stand_in = types.SimpleNamespace(**values)
                fn(stand_in)
                values.update(vars(stand_in))
                return values
            _root.__name__ = fn.__name__
            return root_validator(skip_on_failure=True, allow_reuse=True)(_root)
        return deco


def list_limits(min_items: int | None = None, max_items: int | None = None) -> dict:
    """Field() keyword arguments limiting a list's length, under either pydantic version."""
    if PYDANTIC_V2:
        return {k: v for k, v in (("min_length", min_items), ("max_length", max_items)) if v is not None}
    return {k: v for k, v in (("min_items", min_items), ("max_items", max_items)) if v is not None}
