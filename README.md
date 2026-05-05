# foodtruck-agent

AI Voice Agent backend for **Rey Tequeño Davenport** food truck.

A bilingual (ES/EN) phone agent built with Vapi.ai that:
- Answers calls in Spanish or English (auto-detected)
- Takes customer orders and creates them in Square
- Generates a Square Payment Link and texts it to the customer (Twilio SMS)
- Answers questions about hours, location, website, contact, payment, etc.
- Transfers to a human operator when needed

## Architecture
