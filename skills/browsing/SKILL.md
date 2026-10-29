---
name: browsing
description: Open a website, read a page, fill a form, download a file, search the live web, or get past a sign-in code on the owner's machine. Read the latch skill before the first latch browser call.
---
# Browsing the web on the owner's machine

Browser work goes through `latch browser` on one of the owner's hosts, the way
the latch skill describes: open a session, observe the page, then act on the
refs it returns. Read the latch skill before your first `latch browser` call
this turn, even when the site looks simple. It carries what to do when a site
asks for a code it texted the owner, and when to hand a session to the owner.
Follow its exact steps and arguments.

To see a page, use the browser's own `screenshot`. latch has no way to drive
the owner's other apps or capture their screen, so when a page cannot be done
in latch's browser, say so in one short line instead of working around it.
