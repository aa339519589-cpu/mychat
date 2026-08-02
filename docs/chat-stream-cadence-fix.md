# Chat streaming cadence fix

The Chat delivery path now keeps active event polling between 35 ms and 80 ms, limits durable text coalescing to 64 characters, flushes queued text every 12 ms, and caps each append batch at 16 events.

Verification includes a 2200-character response reconstructed from more than 50 text events with no simulated polling wait above 80 ms.
