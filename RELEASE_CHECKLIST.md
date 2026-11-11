# Release checklist

- [ ] `npm ci` succeeds on a clean checkout.
- [ ] `npm test` passes.
- [ ] `npm run verify:release` passes.
- [ ] ChatGPT tunnel connects from the real PC Bridge app.
- [ ] `bridge_status` succeeds from a normal ChatGPT chat.
- [ ] Claude persistent connector survives an app restart.
- [ ] `bridge_status` succeeds from a normal Claude chat.
- [ ] No credentials, real connector URLs or local state are committed.
- [ ] Tutorial video contains no private account data.
- [ ] README screenshots/video match the current UI.
- [ ] Third-party notices are intact.
- [ ] Public repository diff contains no live pairing key, private local address, credentials, personal application state or private screenshot.
