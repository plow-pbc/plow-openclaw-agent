---
name: browsing
description: Open a website, read a page, fill a form, download a file, search the live web, or get past a CAPTCHA on the owner's Mac. Read the Mac's camoufox-browsing skill before the first plow_browser call.
---
# Browsing the web on the owner's Mac

When `latch status` lists their Mac (any host but `cloud`), browse there with
`latch browser` (`latch help browser --examples`), with `--plow-chat`; the rest
of this skill is for Latch's own tools.

Browser work goes through Latch's own browser, plow_browser, the way the owner's
Mac's camoufox-browsing skill describes. That skill is published by the Mac, not
this image, so it is not loaded here: list the Mac's skills (plow_list_skills)
and read it (plow_read_skill) before your first plow_browser call this turn,
even when the site looks simple. Read it for the fallbacks, not the happy path:
it carries what to do when a site blocks the browser or shows a CAPTCHA,
including a Safari `do JavaScript` recipe that works through Safari's own
scripting and needs only the Automation consent. Follow its exact steps and
arguments.

Do not drive Safari or any other app through plow_run_applescript UI scripting
(or osascript through latch),
and do not capture the owner's screen, as a way around a page. That is the
improvising the camoufox-browsing skill tells you to avoid, and it raises
screen-capture and other macOS permission prompts on the owner's Mac. To see a
page, use the browser's own screenshot through plow_browser.

Improvise (screen capture, UI scripting) only when no Latch tool and no fallback
in the skill can do the job. When you do, tell the person what you are doing and
why, in one short line, before you do it.
