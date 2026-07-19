# Chat control-plane startup race

Production deployment marker for the idempotent authoritative chat admission retry introduced on 2026-07-19.

The retry window covers the interval in which the web process can receive traffic before the co-located job worker finishes starting.
