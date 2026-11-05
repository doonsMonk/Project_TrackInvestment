"""Investment Tracker backend package.

Makes Python verify HTTPS against the operating system's certificate store, the way a browser does. Some
data sources (NPS Trust, for one) omit an intermediate certificate from their chain; Windows fetches it
itself, Python's own bundle cannot. Falls back silently to Python's bundle when truststore is unavailable.
"""
try:
    import truststore

    truststore.inject_into_ssl()
except Exception:  # noqa: BLE001 - optional dependency; everything else still works
    pass
