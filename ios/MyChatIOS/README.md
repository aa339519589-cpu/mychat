# MyChat Native iPhone Client

This directory is the native iOS client. It shares the production backend with
the web client, but it does not embed or import the web UI.

## Release boundary

- Native client branch: `codex/native-ios-client`
- Native commits must be path-limited to `ios/MyChatIOS`.
- Do not merge this branch into or deploy it as the web frontend during native
  iteration.
- A native iteration is complete only after commit, GitHub push, signed device
  build, install, launch, and device-side verification.

## Architecture

- SwiftUI renders the app shell, history, model menu, messages, and composer.
- `URLSession` talks directly to the existing HTTPS API and durable SSE stream.
- Supabase access and refresh tokens are stored in the iOS Keychain.
- There is no `WKWebView`.

## Repeatable device deployment

With the developer iPhone connected and unlocked:

```bash
ios/MyChatIOS/scripts/deploy-device.sh
```

Override the device when necessary:

```bash
MYCHAT_DEVICE_ID="<device identifier>" ios/MyChatIOS/scripts/deploy-device.sh
```
