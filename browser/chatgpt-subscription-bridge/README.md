# MyChat ChatGPT Subscription Bridge

This Chrome/Chromium Manifest V3 extension connects MyChat's durable long-think queue to the ChatGPT web session that is already signed in in the browser.

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this `browser/chatgpt-subscription-bridge` directory.
4. Open MyChat `/chatgpt-long-think`, generate a pairing token, and copy it.
5. Open the extension options, set the MyChat origin and pairing token, then save.
6. Make sure `https://chatgpt.com/` is signed in with the ChatGPT account/subscription you want to use.

The extension opens a dedicated ChatGPT tab for each long-think turn, waits for generation to finish, returns the answer to MyChat, and closes the tab. The next durable turn is then claimed automatically.

## Stored locally

- MyChat origin
- MyChat pairing token
- Random bridge client ID

The extension does not read, copy, or send ChatGPT authentication cookies to MyChat.
