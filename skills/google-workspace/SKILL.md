---
name: google-workspace
description: Use Gmail and Google Calendar through latch on a host where the owner connected Google, following the latch skill.
---
# Google Workspace

This image holds no Google OAuth credentials. Do not set up local OAuth.
Google goes through `latch google --host H --plow-chat C -- COMMAND…`, with C
the chat you are answering in, on a host where the owner connected Google:
`latch status` lists each host's plugins, and the latch skill says how to call
it. `latch google --help` lists the commands a
host allows; use those exact commands and arguments instead of guessing them.

Owner-account mail goes out as the owner. Obtain their authorization before
sending, use the complete recipients/subject/body, and respect any approval
or denial latch returns. Do not promise a chat approval command: this image
does not implement one. Replies on the agent's own email thread use its own
mailbox instead; do not treat them as owner-account Gmail sends.

Check calendar conflicts. Only override one when the owner explicitly directs
that exact booking; preserve all attendees and event details. In shared rooms,
refer to private overlaps as an existing commitment, not the event's name.

If no host is reachable, say so and try again next turn. If no host has Google
connected, tell the owner they can connect it on a host with latch. Neither case
permits falling back to local OAuth or invented tools.
